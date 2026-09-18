'use strict';

const { getVercelOidcToken } = require('@vercel/oidc');

const DEFAULT_MODEL = 'gpt-5';

function getLocalWorkerConfig() {
  const openAiApiKey = String(process.env.OPENAI_API_KEY || '').trim();
  const gatewayToken = String(process.env.AI_GATEWAY_API_KEY || '').trim();
  const runningOnVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
  const apiKey = openAiApiKey || gatewayToken;
  const provider = openAiApiKey ? 'openai' : ((gatewayToken || runningOnVercel) ? 'vercel_ai_gateway' : 'unconfigured');
  const enabled = String(process.env.SWARM_LOCAL_WORKER_ENABLED || 'true').toLowerCase() !== 'false';
  return {
    enabled: enabled && (Boolean(apiKey) || runningOnVercel),
    requested: enabled,
    apiKey,
    runningOnVercel,
    provider,
    endpoint: provider === 'vercel_ai_gateway'
      ? 'https://ai-gateway.vercel.sh/v1/responses'
      : 'https://api.openai.com/v1/responses',
    model: provider === 'vercel_ai_gateway'
      ? String(process.env.AI_GATEWAY_SWARM_MODEL || 'openai/gpt-5.4').trim()
      : String(process.env.OPENAI_SWARM_MODEL || process.env.OPENAI_JARVIS_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL).trim(),
    // Leave enough time for campaign aggregation and the frontend proxy to
    // return a structured error instead of a Vercel function-timeout page.
    timeoutMs: positiveInt(process.env.SWARM_LOCAL_WORKER_TIMEOUT_MS, 40000),
    freeFallbackEnabled: String(process.env.SWARM_FREE_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false',
  };
}

function localWorkerHealth() {
  const config = getLocalWorkerConfig();
  return {
    enabled: config.enabled,
    requested: config.requested,
    provider: config.provider,
    authenticationConfigured: Boolean(config.apiKey) || config.runningOnVercel,
    openAiConfigured: config.provider === 'openai',
    vercelAiGatewayConfigured: config.provider === 'vercel_ai_gateway',
    freeFallbackEnabled: config.freeFallbackEnabled,
    model: config.model,
  };
}

async function runLocalJob({ axios, mongoose, models, normalized, localJob, submitReason, fallbackError }) {
  const config = getLocalWorkerConfig();
  if (!config.enabled) {
    const error = new Error(config.requested ? 'No OpenAI key or Vercel AI Gateway identity is available for the local Swarm worker.' : 'The local Swarm worker is disabled.');
    error.code = 'LOCAL_SWARM_DISABLED';
    error.httpStatus = 503;
    throw error;
  }

  const authToken = config.apiKey || await getVercelOidcToken();
  if (!authToken) {
    const error = new Error('Vercel could not provide an OIDC token for the self-contained worker.');
    error.code = 'LOCAL_SWARM_AUTH_UNAVAILABLE';
    error.httpStatus = 503;
    throw error;
  }

  const now = new Date();
  localJob.status = 'running';
  localJob.startedAt = localJob.startedAt || now;
  localJob.jobId = localJob.jobId || `local_${localJob._id}`;
  localJob.metadata = {
    ...(localJob.metadata || {}),
      executionEngine: config.provider === 'vercel_ai_gateway' ? 'vercel_ai_gateway' : 'local_openai',
    externalFallbackUsed: Boolean(fallbackError),
    externalFallbackError: fallbackError || undefined,
  };
  localJob.statusHistory.push({ status: 'running', at: now, reason: fallbackError ? 'ionos-unavailable-local-failover' : (submitReason || 'local-worker-started') });
  await localJob.save();

  try {
    const response = await requestGenerationWithRetry({
      axios,
      config,
      authToken,
      data: {
        model: config.model,
        instructions: buildInstructions(normalized),
        input: JSON.stringify(buildSafeInput(normalized)),
        max_output_tokens: 2200,
      },
    });

    const detail = response.data?.error?.message || response.data?.message || `OpenAI returned HTTP ${response.status}.`;
    const useFreeFallback = config.freeFallbackEnabled && isGatewayBillingRequired(response.status, detail);
    if (!useFreeFallback && (response.status < 200 || response.status >= 300)) {
      const error = new Error(String(detail).slice(0, 1000));
      error.code = 'LOCAL_SWARM_OPENAI_ERROR';
      error.httpStatus = response.status;
      throw error;
    }

    const freePayload = useFreeFallback ? buildFreeFallbackPayload(normalized) : null;
    const text = freePayload ? JSON.stringify(freePayload) : extractResponseText(response.data);
    if (!text) throw new Error('The local Swarm worker received no generated content.');
    const parsed = freePayload || parseGeneratedPayload(text);
    const executionEngine = freePayload
      ? 'deterministic_template'
      : (config.provider === 'vercel_ai_gateway' ? 'vercel_ai_gateway' : 'local_openai');
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
      provenance: { engine: executionEngine, model: freePayload ? 'free-rule-based-v1' : config.model, generatedAt: completedAt.toISOString(), fallbackFromIonos: Boolean(fallbackError), fallbackFromPaidGateway: Boolean(freePayload) },
      quality: { requiresHumanReview: true, automaticallyPublished: false },
      metadata: { ...(normalized.metadata || {}), executionEngine, freeFallbackUsed: Boolean(freePayload) },
    });

    localJob.artifactId = artifactId;
    localJob.artifact = { artifactId, title: artifact.title, reviewStatus: artifact.reviewStatus };
    localJob.status = 'awaiting_review';
    localJob.completedAt = completedAt;
    localJob.error = undefined;
    localJob.metadata = { ...(localJob.metadata || {}), executionEngine, freeFallbackUsed: Boolean(freePayload) };
    localJob.statusHistory.push({ status: 'awaiting_review', at: completedAt, reason: freePayload ? 'free-template-fallback-completed' : 'local-worker-completed' });
    await localJob.save();

    return {
      localJob: localJob.toObject ? localJob.toObject() : localJob,
      swarmResult: {
        ok: true,
        created: true,
        source: executionEngine,
        engine: executionEngine,
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

function isGatewayBillingRequired(status, detail) {
  const message = String(detail || '').toLowerCase();
  return status === 402
    || message.includes('valid credit card')
    || message.includes('payment required')
    || message.includes('unlock your free credits');
}

function buildFreeFallbackPayload(normalized = {}) {
  const jobType = String(normalized.jobType || 'automation.task');
  const group = jobType.split('.')[0];
  const input = normalized.input || {};
  const subject = input.title || input.topic || input.eventName || input.matchName || normalized.sourceEntity?.label || readableJobType(jobType);
  const cta = 'Make your picks on FantasyMMAdness.com before the event starts.';
  const base = {
    title: `${subject} — free automation draft`,
    summary: `Rule-based ${readableJobType(jobType)} prepared without a paid AI service. Review and customize before approval.`,
    recommendations: ['Confirm names, dates, records, and fight details.', 'Add the final approved link and artwork.', 'Review tone before publishing.'],
    actions: ['Review draft', 'Add verified fight details', 'Approve or edit', 'Schedule manually'],
    metadata: { generator: 'free-rule-based-v1', paidAiUsed: false, jobType, requiresHumanReview: true },
  };

  if (group === 'social') return {
    ...base,
    content: [
      `FIGHT FANS: ${subject}`,
      'Think you know what happens when the action starts? Predict the rounds, key fight statistics, and the moments that decide the contest.',
      cta,
      '#FantasyMMAdness #CombatSports #FightNight #FightPredictions',
    ].join('\n\n'),
  };
  if (group === 'seo') return {
    ...base,
    content: `SEO checklist for ${subject}: create a unique title under 60 characters; write a clear description under 160 characters; confirm one canonical URL; add fight, fighter, event, and sport terms naturally; link to the active fight page, how-to-play guide, leaderboard, and related approved content; validate OpenGraph image and structured data.`,
  };
  if (group === 'content') return {
    ...base,
    content: [`Headline: ${subject}`, 'Opening: Explain why this fight or campaign matters now.', 'Fight context: Add only verified names, date, organization, weight class, and rules.', 'Prediction experience: Explain what fans can predict and how scoring works.', `Call to action: ${cta}`, 'Final review: Verify every factual claim before approval.'].join('\n\n'),
  };
  if (group === 'analytics') return {
    ...base,
    content: `Growth plan for ${subject}: track page visits, account starts, completed registrations, fight entries, affiliate joins, return visits, and cost per acquired user. Compare each campaign link and platform weekly. Keep the channels that produce completed registrations, not only clicks.`,
  };
  if (group === 'data') return {
    ...base,
    content: `Data operations checklist for ${subject}: verify event date/time and timezone; confirm fighter identities and images; check card order; flag duplicates; confirm contest status; record the source and last verification time; route uncertain fields to admin review.`,
  };
  if (group === 'media') return {
    ...base,
    content: `Creative brief for ${subject}: premium combat-sports arena lighting, Fantasy MMAdness red/blue brand palette, mobile-first composition, clear fighter separation, strong prediction-game CTA area, no gore, no invented belts or sponsor marks, and room for verified event text.`,
  };
  if (group === 'notification') return {
    ...base,
    content: `${subject} is ready for review. Verify the fight details, open the campaign draft, and schedule only after approval.`,
  };
  return { ...base, content: `Operational checklist for ${subject}: verify inputs, review current status, complete the required admin actions, record the outcome, and keep all publishing approval-first.` };
}

async function requestGenerationWithRetry({ axios, config, authToken, data }) {
  const attempts = 2;
  const attemptTimeoutMs = Math.min(config.timeoutMs, 18000);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await axios({
        method: 'POST',
        url: config.endpoint,
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        timeout: attemptTimeoutMs,
        validateStatus: () => true,
        data,
      });
      const retryableStatus = response.status === 429 || response.status >= 500;
      if (!retryableStatus || attempt === attempts) return response;
      lastError = new Error(`AI worker returned transient HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
      if (!isTransientGenerationError(error) || attempt === attempts) throw error;
    }
    await delay(250 * attempt);
  }

  throw lastError || new Error('AI worker request failed after retry.');
}

function isTransientGenerationError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'EPROTO'].includes(code)
    || message.includes('ssl')
    || message.includes('tls')
    || message.includes('socket hang up')
    || message.includes('network');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
