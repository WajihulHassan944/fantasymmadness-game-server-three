'use strict';
const fs = require('node:fs');
try {
  const s = JSON.parse(fs.readFileSync(process.env.GROWTH_WORKER_HEALTH_FILE || '/run/growth-worker/state.json', 'utf8'));
  const elapsed = Date.now() - Date.parse(s.lastSuccessAt);
  if (s.stopped || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > 35 * 60000 || s.failures > 3) process.exitCode = 1;
} catch { process.exitCode = 1; }
