'use strict';

const DEFAULT_MODEL = 'gpt-5';

function getLocalWorkerConfig() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  const enabled = String(process.env.SWARM_LOCAL_WORKER_ENABLED || 'true').toLowerCase() !== 'false';
  return {
    enabled: enabled && Boolean(apiKey),
    requested: enabled,
    apiKey,
    model: String(process.env.OPENAI_SWARM_MODEL || process.env.OPENAI_JARVIS_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL).trim(),
    timeoutMs: positiveInt(process.env.SWARM_LOCAL_WORKER_TIMEOUT_MS, 55000),
  };
}

function localWorkerHealth() {
  const config = getLocalWorkerConfig();
  return {
    enabled: config.enabled,
    requested: config.requested,
    openAiConfigured: Boolean(config.apiKey),
    model: config.model,
  };
}

async function runLocalJob({ axios, mongoose, models, normalized, localJob, submitReason, fallbackError }) {
  const config = getLocalWorkerConfig();
  if (!config.enabled) {
    const error = new Error(config.requested ? 'OPENAI_API_KEY is not configured for the local Swarm worker.' : 'The local Swarm worker is disabled.');
    error.code = 'LOCAL_SWARM_DISABLED';
    error.httpStatus = 503;
    throw error;
  }

  const now = new Date();
  localJob.status = 'running';
  localJob.startedAt = localJob.startedAt || now;
  localJob.jobId = localJob.jobId || `local_${localJob._id}`;
  localJob.metadata = {
    ...(localJob.metadata || {}),
    executionEngine: 'local_openai',
    externalFallbackUsed: Boolean(fallbackError),
    externalFallbackError: fallbackError || undefined,
  };
  localJob.statusHistory.push({ status: 'running', at: now, reason: fallbackError ? 'ionos-unavailable-local-failover' : (submitReason || 'local-worker-started') });
  await localJob.save();

  try {
    const response = await axios({
      method: 'POST',
      url: 'https://api.openai.com/v1/responses',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      timeout: config.timeoutMs,
      validateStatus: () => true,
      data: {
        model: config.model,
        instructions: buildInstructions(normalized),
        input: JSON.stringify(buildSafeInput(normalized)),
        max_output_tokens: 2200,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      const detail = response.data?.error?.message || response.data?.message || `OpenAI returned HTTP ${response.status}.`;
      const error = new Error(String(detail).slice(0, 1000));
      error.code = 'LOCAL_SWARM_OPENAI_ERROR';
      error.httpStatus = response.status;
      throw error;
    }

    const text = extractResponseText(response.data);
    if (!text) throw new Error('The local Swarm worker received no generated content.');
    const parsed = parseGeneratedPayload(text);
    const artifactId = `artifact_local_${new mongoose.Types.ObjectId()}`;
    const completedAt = new Date();
    const artifact = await models.SwarmBackendArtifact.create({
      artifactId,
      jobId: localJob.jobId,
      vertical: normalized.vertical,
      jobType: normalized.jobType,
      artifactType: inferArtifactType(normalized.jobType),
      title: parsed.title || normalized.input?.title || normalized.input?.topic || readableJobType(normalized.jobType),
      summary: parsed.summary || String(text).slice(0, 300),
      reviewStatus: 'AWAITING_REVIEW',
      payload: { ...parsed, content: parsed.content || parsed.text || text, rawText: text },
      provenance: { engine: 'local_openai', model: config.model, generatedAt: completedAt.toISOString(), fallbackFromIonos: Boolean(fallbackError) },
      quality: { requiresHumanReview: true, automaticallyPublished: false },
      metadata: { ...(normalized.metadata || {}), executionEngine: 'local_openai' },
    });

    localJob.artifactId = artifactId;
    localJob.artifact = { artifactId, title: artifact.title, reviewStatus: artifact.reviewStatus };
    localJob.status = 'awaiting_review';
    localJob.completedAt = completedAt;
    localJob.error = undefined;
    localJob.statusHistory.push({ status: 'awaiting_review', at: completedAt, reason: 'local-worker-completed' });
    await localJob.save();

    return {
      localJob: localJob.toObject ? localJob.toObject() : localJob,
      swarmResult: {
        ok: true,
        created: true,
        source: 'local_openai',
        engine: 'local_openai',
        fallbackFromIonos: Boolean(fallbackError),
        job: { jobId: localJob.jobId, artifactId, status: 'awaiting_review', jobType: normalized.jobType, vertical: normalized.vertical },
        artifact: { artifactId, reviewStatus: 'AWAITING_REVIEW' },
      },
    };
  } catch (error) {
    localJob.status = 'failed';
    localJob.error = summarize(error);
    localJob.completedAt = new Date();
    localJob.statusHistory.push({ status: 'failed', at: localJob.completedAt, reason: 'local-worker-failed' });
    await localJob.save();
    throw error;
  }
}

function buildInstructions(normalized) {
  return `You are one specialist worker inside Fantasy MMAdness, a combat-sports fantasy platform. Complete the requested automation accurately and conservatively. Job type: ${normalized.jobType}. Vertical: ${normalized.vertical}. Sport: ${normalized.sport}. Return one valid JSON object with: title, summary, content, recommendations (array), actions (array), metadata (object). For social jobs, create drafts only. Never claim that anything was published, emailed, paid, deleted, or changed. For data or analytics jobs, clearly label estimates and missing live data. For SEO jobs, provide implementation-ready recommendations. For fight content, do not invent results, records, dates, odds, or injuries not present in the input. Human approval is required.`;
}

function buildSafeInput(normalized) {
  return {
    jobType: normalized.jobType,
    vertical: normalized.vertical,
    sport: normalized.sport,
    mode: normalized.mode,
    sourceEntity: normalized.sourceEntity,
    input: normalized.input,
    metadata: normalized.metadata,
  };
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text.trim();
  return (Array.isArray(payload?.output) ? payload.output : [])
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((item) => item?.type === 'output_text' && typeof item?.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim();
}

function parseGeneratedPayload(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { content: cleaned };
  } catch (_error) {
    return { content: cleaned, text: cleaned };
  }
}

function inferArtifactType(jobType) {
  const group = String(jobType || '').split('.')[0];
  return ({ content: 'content_draft', social: 'social_draft', seo: 'seo_plan', data: 'data_report', analytics: 'analytics_report', media: 'media_brief', notification: 'notification_draft', automation: 'automation_report', system: 'system_report', wrestling: 'wrestling_report' })[group] || 'automation_artifact';
}

function readableJobType(value) {
  return String(value || 'Automation result').replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function summarize(error) {
  return { code: error?.code, message: String(error?.message || 'Local Swarm worker failed.').slice(0, 1000) };
}

module.exports = { getLocalWorkerConfig, localWorkerHealth, runLocalJob };
