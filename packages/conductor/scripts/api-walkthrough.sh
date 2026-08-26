#!/usr/bin/env bash
# Smoke aid for the Inventio control server (DESIGN §12).
#
#   BASE=http://127.0.0.1:4700 ./scripts/api-walkthrough.sh [slug]
#
# Walks health → runtime → create → snapshot → directive → list against an
# ALREADY RUNNING conductor (`npm run dev -w @inventio/conductor`).
# Every step must succeed; the first failure aborts with a non-zero status.
set -euo pipefail

BASE=${BASE:-http://127.0.0.1:4700}
SLUG=${1:-demo-$(date +%s)}
JQ=$(command -v jq || true)

section() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
show() { if [ -n "$JQ" ]; then "$JQ" .; else cat; echo; fi; }
die() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

section "GET /api/health"
curl -sf "$BASE/api/health" | show || die "health"

section "GET /api/runtime"
curl -sf "$BASE/api/runtime" | show || die "runtime"

section "POST /api/projects  (slug: $SLUG)"
curl -sf -X POST "$BASE/api/projects" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"API walkthrough $SLUG\",\"slug\":\"$SLUG\",
       \"statement\":\"Show that the walkthrough script reaches the conductor.\",
       \"config\":{\"budget\":{\"totalTokens\":300000}}}" | show || die "create project"

section "GET /api/projects/$SLUG  (snapshot)"
if [ -n "$JQ" ]; then
  curl -sf "$BASE/api/projects/$SLUG" \
    | "$JQ" '{seq, phase: .state.phase, paused: .state.paused, autonomy: .state.config.autonomy,
              title: .state.title, waves: (.state.waveOrder | length)}' || die "snapshot"
else
  curl -sf "$BASE/api/projects/$SLUG" >/dev/null || die "snapshot"
  echo "(snapshot fetched; install jq for a readable summary)"
fi

section "POST /api/projects/$SLUG/directives"
curl -sf -X POST "$BASE/api/projects/$SLUG/directives" \
  -H 'content-type: application/json' \
  -d '{"text":"Walkthrough directive: prefer the shortest argument.","urgent":false}' | show \
  || die "directive"

section "GET /api/projects  (list)"
curl -sf "$BASE/api/projects" | show || die "list"

section "GET /api/projects/$SLUG/events?since=0  (SSE, 2s sample)"
curl -sfN --max-time 2 "$BASE/api/projects/$SLUG/events?since=0" | head -20 || true

printf '\n\033[32mOK — walkthrough complete for %s\033[0m\n' "$SLUG"
