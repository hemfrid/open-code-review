#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Review-pod entrypoint (spec §3.1). All inputs arrive as environment variables;
# nothing is interpolated into a command unquoted.
#
# Required: GIT_TOKEN HUB_GIT_BASE PROJECT PR_NUMBER BASE_REF HEAD_SHA
#           OCR_LLM_URL OCR_LLM_TOKEN OCR_LLM_MODEL HUB_CALLBACK_URL CALLBACK_TOKEN
# Optional: REVIEW_BACKGROUND REVIEW_CONCURRENCY REVIEW_EFFORT REVIEW_TIMEOUT_MIN
#           REVIEW_TOKEN_BUDGET REVIEW_RULE_FILE REVIEW_WORK_DIR
#           REVIEW_SIDECAR (1 = wait for / shut down the seat-relay sidecar; 0 = API-key lane)
#           REVIEW_SIDECAR_URL (default http://127.0.0.1:8890) REVIEW_SIDECAR_WAIT_SECS (default 60)
#
# Exit codes: 0 = callback delivered (review outcome is inside it)
#             70 = sidecar never became healthy, 71 = PR head moved since the job was created,
#             anything else = a setup step failed (git, callback POST).
set -eu
umask 077

: "${HOME:=/home/review}"
export HOME
WORK="${REVIEW_WORK_DIR:-/work}"
SIDECAR="${REVIEW_SIDECAR:-1}"
SIDECAR_URL="${REVIEW_SIDECAR_URL:-http://127.0.0.1:8890}"
WAIT_SECS="${REVIEW_SIDECAR_WAIT_SECS:-60}"
RULE_FILE="${REVIEW_RULE_FILE:-/etc/keyto-review/rule.json}"
APP="$HOME/app"
mkdir -p "$WORK" "$HOME"

# --- git: credential via helper store, never on a command line -------------
printf 'https://keyto:%s@%s\n' "$GIT_TOKEN" "${HUB_GIT_BASE#https://}" > "$HOME/.git-credentials"
git config --global credential.helper store
git config --global user.email "review@keyto"
git config --global user.name "keyto-review"

# Full clone: range mode needs merge-base, which a shallow clone cannot provide.
git clone --no-single-branch "$HUB_GIT_BASE/git/hemfrid/$PROJECT.git" "$APP"
cd "$APP"
git fetch origin \
  "+refs/heads/$BASE_REF:refs/remotes/origin/$BASE_REF" \
  "+refs/pull/$PR_NUMBER/head:refs/remotes/origin/pr-$PR_NUMBER"

# Refuse to review a head that moved since the hub recorded the job.
actual_head="$(git rev-parse "origin/pr-$PR_NUMBER")"
if [ "$actual_head" != "$HEAD_SHA" ]; then
  printf 'PR head moved: expected %s, found %s\n' "$HEAD_SHA" "$actual_head" >&2
  exit 71
fi

printf '%s' "${REVIEW_BACKGROUND:-}" > "$WORK/background.md"

# --- sidecar readiness (it refreshes the seat token on start) --------------
if [ "$SIDECAR" = "1" ]; then
  i=0
  until curl -fsS "$SIDECAR_URL/healthz" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt "$WAIT_SECS" ]; then
      printf 'seat-relay sidecar not healthy after %ss\n' "$WAIT_SECS" >&2
      exit 70
    fi
    sleep 1
  done
fi

# --- review ---------------------------------------------------------------
: > "$WORK/stderr.log"
rm -f "$WORK/result.json"
set +e
ocr review --repo "$APP" \
  --from "origin/$BASE_REF" --to "origin/pr-$PR_NUMBER" \
  --format json --audience agent --output "$WORK/result.json" \
  --rule "$RULE_FILE" --background-file "$WORK/background.md" \
  --concurrency "${REVIEW_CONCURRENCY:-4}" --effort "${REVIEW_EFFORT:-medium}" \
  --timeout "${REVIEW_TIMEOUT_MIN:-15}" --max-tokens-budget "${REVIEW_TOKEN_BUDGET:-400000}" \
  2> "$WORK/stderr.log"
rc=$?
set -e

# --- callback payload: {exit_code, stderr, result|null} --------------------
if [ -s "$WORK/result.json" ] && jq -e . "$WORK/result.json" >/dev/null 2>&1; then
  jq -n --arg rc "$rc" --rawfile stderr "$WORK/stderr.log" --slurpfile result "$WORK/result.json" \
    '{exit_code: ($rc|tonumber), stderr: $stderr, result: $result[0]}' > "$WORK/callback.json"
else
  jq -n --arg rc "$rc" --rawfile stderr "$WORK/stderr.log" \
    '{exit_code: ($rc|tonumber), stderr: $stderr, result: null}' > "$WORK/callback.json"
fi

curl -fsS --retry 5 --retry-all-errors --retry-delay 2 -X POST "$HUB_CALLBACK_URL" \
  -H "Authorization: Bearer $CALLBACK_TOKEN" -H 'content-type: application/json' \
  --data-binary @"$WORK/callback.json"

# Let the pod reach Succeeded: ask the sidecar to exit. Best effort.
if [ "$SIDECAR" = "1" ]; then
  curl -fsS -X POST "$SIDECAR_URL/shutdown" -H "x-api-key: $OCR_LLM_TOKEN" >/dev/null 2>&1 || true
fi
exit 0
