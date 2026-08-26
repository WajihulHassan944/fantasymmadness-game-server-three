#!/usr/bin/env bash
# Fire the scheduled jobs by hand. Use this to verify CRON_SECRET is wired up
# before trusting the schedule, or to settle a card immediately mid-event.
#
#   CRON_SECRET=... ./run-cron.sh                       # all jobs
#   CRON_SECRET=... ./run-cron.sh team-contests/settle   # one job
#
# API_BASE defaults to production; override for a preview deployment.

set -euo pipefail

API_BASE="${API_BASE:-https://fantasymmadness-game-server-three.vercel.app}"

if [ -z "${CRON_SECRET:-}" ]; then
  echo "CRON_SECRET is not set. Every job will return 503 without it." >&2
  exit 1
fi

ALL_JOBS=(
  "cron/team-contests/settle"
  "cron/challenges/expire"
  "cron/seasons/advance"
  "update-shadow-open-status"
  "cron-job"
  "cron/owner-integrity"
)

run_job() {
  local job="$1"
  printf '\n── %s\n' "$job"
  local code
  code=$(curl -sS -o /tmp/fmm-cron-out -w '%{http_code}' \
    --max-time 180 \
    -H "x-cron-secret: ${CRON_SECRET}" \
    "${API_BASE}/api/${job}")
  cat /tmp/fmm-cron-out; echo
  if [ "$code" != "200" ]; then
    echo "   ^ HTTP $code" >&2
    return 1
  fi
}

if [ "$#" -gt 0 ]; then
  run_job "$1"
else
  failed=0
  for job in "${ALL_JOBS[@]}"; do
    run_job "$job" || failed=1
  done
  exit "$failed"
fi
