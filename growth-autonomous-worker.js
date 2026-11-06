'use strict';
// Long-lived external timer over the EXISTING authenticated isolated cron API.
// Jobs/claims/receipts live in MongoDB on the engine, never in worker memory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ISOLATED_HOST = 'fantasymmadness-growth-isolated-tes.vercel.app';
function workerConfig(env = process.env) {
  const deliveryMode = env.GROWTH_WORKER_DELIVERY_MODE || 'sandbox';
  if (!['sandbox','approved-delivery'].includes(deliveryMode)) throw Error('invalid_worker_delivery_mode');
  if (env.GROWTH_WORKER_ENABLED !== 'true' || env.GROWTH_STAGING_MODE !== 'isolated' || (deliveryMode === 'sandbox' ? env.GROWTH_OUTBOUND_ENABLED !== 'false' : env.GROWTH_OUTBOUND_ENABLED !== 'true' || env.GROWTH_WORKER_LIVE_APPROVED !== 'true')) throw Error('worker_requires_explicit_isolated_non_delivering_mode');
  const u = new URL(env.GROWTH_WORKER_ENGINE_URL || `https://${ISOLATED_HOST}`);
  const loopback = ['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol === 'http:' && env.GROWTH_WORKER_LOOPBACK_TEST === 'true';
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || (!loopback && (u.protocol !== 'https:' || u.hostname !== ISOLATED_HOST || u.port))) throw Error('worker_target_is_not_the_approved_isolated_engine');
  const secret = String(env.GROWTH_WORKER_CRON_SECRET || '');
  if (secret.length < 16) throw Error('scoped_worker_cron_secret_required');
  if (!loopback && (env.HTTPS_PROXY || env.HTTP_PROXY || env.https_proxy || env.http_proxy) && env.NODE_USE_ENV_PROXY !== '1' && !process.execArgv.includes('--use-env-proxy')) throw Error('use_node24_env_proxy_support_when_proxy_is_configured');
  const intervalMs = Number(env.GROWTH_WORKER_INTERVAL_MS || 900000);
  if (!Number.isInteger(intervalMs) || intervalMs < (loopback ? 100 : 60000) || intervalMs > 1800000) throw Error('invalid_worker_interval');
  const id = String(env.GROWTH_WORKER_ID || `worker-${crypto.randomUUID()}`);
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(id)) throw Error('invalid_worker_identifier');
  return { origin: u.origin, loopback, deliveryMode, secret, intervalMs, id, healthFile: env.GROWTH_WORKER_HEALTH_FILE || '' };
}
function assertHealth(h, cfg) {
  if (!h || h.ok !== true || h.service !== 'growth-engine-isolated' || h.mode !== 'isolated' || h.database?.name !== 'fmgrowthtest') throw Error('isolated_health_not_verified');
  if (cfg.deliveryMode === 'approved-delivery') {
    if (h.autonomy?.liveApproved !== true || !(h.delivery?.realDelivery === true || h.social?.realPublishing === true)) throw Error('owner_and_provider_live_authorization_not_verified');
  } else if (h.delivery?.realDelivery !== false || !['sandbox-capture','sandbox-smtp','none'].includes(h.delivery?.provider) || h.social?.provider !== 'sandbox' || h.social?.realPublishing !== false) throw Error('isolated_non_delivering_health_not_verified');
  if (!cfg.loopback && (h.database.kind !== 'atlas' || h.database.hostPinned !== true || h.resource?.projectId !== 'prj_Hpe9UjGrBBJOm3boxHsL9lHesWLl' || h.resource?.storeId !== 'store_5mRLkf9U8eKGIaaO')) throw Error('dedicated_atlas_host_not_pinned');
}
function writeHealth(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
const wait = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
});
async function runWorker({ env = process.env, fetchImpl = globalThis.fetch, signal, onEvent = x => process.stdout.write(JSON.stringify(x) + '\n'), sleep = wait, clock = () => new Date() } = {}) {
  const cfg = workerConfig(env);
  let failures = 0;
  const state = { worker: cfg.id, startedAt: clock().toISOString(), lastSuccessAt: null, lastFailureAt: null, failures: 0, ticks: 0, stopped: false };
  writeHealth(cfg.healthFile, state);
  async function get(endpoint, credential = false) {
    const timeout = AbortSignal.timeout(120000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const r = await fetchImpl(`${cfg.origin}/api/growth${endpoint}`, { method: 'GET', headers: { Accept: 'application/json', ...(credential ? { Authorization: `Bearer ${cfg.secret}` } : {}) }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: combined });
    if (!r.ok) throw Error(`engine_http_${r.status}`);
    const text = await r.text();
    if (text.length > 1000000) throw Error('engine_response_too_large');
    return JSON.parse(text);
  }
  while (!signal?.aborted) {
    const began = clock().getTime();
    try {
      const health = await get('/health'); assertHealth(health, cfg);
      if (signal?.aborted) break;
      const result = await get(`/cron/tick?worker=${encodeURIComponent(cfg.id)}`, true);
      if (result.ok !== true || !result.summary || result.summary.errors?.length) throw Error('engine_cycle_reported_failure');
      failures = 0; state.ticks++; state.lastSuccessAt = clock().toISOString(); state.failures = 0;
      onEvent({ type: 'growth_worker_tick', worker: cfg.id, at: state.lastSuccessAt, runId: result.summary.runId || null, skipped: result.summary.skipped || null });
    } catch (_) {
      if (signal?.aborted) break;
      failures++; state.failures = failures; state.lastFailureAt = clock().toISOString();
      // Never print HTTP bodies, credentials, full headers or provider errors.
      onEvent({ type: 'growth_worker_failure', worker: cfg.id, at: state.lastFailureAt, consecutiveFailures: failures, reason: 'isolated_cycle_not_verified' });
    }
    writeHealth(cfg.healthFile, state);
    const backoff = Math.min(cfg.intervalMs, 1000 * 2 ** Math.min(failures, 10));
    await sleep(failures ? backoff : Math.max(100, cfg.intervalMs - (clock().getTime() - began)), signal);
  }
  state.stopped = true; writeHealth(cfg.healthFile, state);
  onEvent({ type: 'growth_worker_stopped', worker: cfg.id, at: clock().toISOString() });
  return state;
}
if (require.main === module) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
  runWorker({ signal: controller.signal }).catch(() => { console.error('Growth worker refused startup: verify isolated target, scoped secret, proxy and activation settings.'); process.exitCode = 1; });
}
module.exports = { workerConfig, assertHealth, runWorker, writeHealth };
