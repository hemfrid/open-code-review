#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Contract test for review.sh: runs it against fake git/ocr/curl shims (real jq).
# Usage: sh prototype/review-image/test.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq is required"; exit 0; }

T="$(mktemp -d)"
SHIM="$T/shim"
mkdir -p "$SHIM"
fails=0

cat > "$SHIM/git" <<'EOF'
#!/bin/sh
echo "git $*" >> "$CAPTURE/git.log"
case "$1" in
  clone) eval "last=\${$#}"; mkdir -p "$last" ;;
  rev-parse) printf '%s\n' "$FAKE_HEAD" ;;
esac
exit 0
EOF

cat > "$SHIM/ocr" <<'EOF'
#!/bin/sh
echo "ocr $*" >> "$CAPTURE/ocr.log"
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--output" ]; then out="$a"; fi
  prev="$a"
done
case "${FAKE_OCR_MODE:-success}" in
  success)
    printf '%s' '{"status":"success","llm":{"model":"fake"},"summary":{"files_reviewed":2,"comments":1,"total_tokens":100,"input_tokens":80,"output_tokens":20,"elapsed":"1s"},"comments":[{"path":"a.go","content":"x","start_line":1,"end_line":1,"severity":"high","category":"bug"}],"manifest":{"terminal_state":"complete"}}' > "$out"
    exit 0 ;;
  fail)
    printf '%s' '{"status":"failed","message":"fatal: cannot resolve LLM endpoint"}' >&2
    exit 1 ;;
esac
EOF

cat > "$SHIM/curl" <<'EOF'
#!/bin/sh
echo "curl $*" >> "$CAPTURE/curl.log"
url=""; data=""
for a in "$@"; do
  case "$a" in
    http://*|https://*) url="$a" ;;
    @*) data="${a#@}" ;;
  esac
done
case "$url" in
  */healthz) if [ "${FAKE_HEALTH:-ok}" = "ok" ]; then exit 0; else exit 22; fi ;;
  */shutdown) echo shutdown >> "$CAPTURE/shutdown.log"; exit 0 ;;
  *) if [ -n "$data" ]; then cp "$data" "$CAPTURE/callback.posted"; fi; exit 0 ;;
esac
EOF
chmod +x "$SHIM/git" "$SHIM/ocr" "$SHIM/curl"

# run_case <name> ; env for the case is exported by the caller. Sets $rc and $CAPTURE.
run_case() {
  name="$1"
  CAPTURE="$T/cap-$name"; export CAPTURE
  mkdir -p "$CAPTURE"
  HOME="$T/home-$name"; export HOME
  REVIEW_WORK_DIR="$T/work-$name"; export REVIEW_WORK_DIR
  PATH="$SHIM:$PATH" sh "$HERE/review.sh" >"$CAPTURE/stdout" 2>"$CAPTURE/stderr"
  rc=$?
}
ok()   { echo "PASS: $1"; }
bad()  { echo "FAIL: $1"; fails=$((fails + 1)); }
check() { if [ "$1" -eq 0 ]; then ok "$2"; else bad "$2"; fi; }

export GIT_TOKEN=tok HUB_GIT_BASE=https://hub.example PROJECT=demo PR_NUMBER=7 BASE_REF=main
export OCR_LLM_URL=http://127.0.0.1:8890 OCR_LLM_TOKEN=localsecret OCR_LLM_MODEL=claude-sonnet-5
export HUB_CALLBACK_URL=https://hub.example/api/internal/reviews/1/result CALLBACK_TOKEN=cbtoken
export REVIEW_RULE_FILE="$HERE/rule.json" REVIEW_SIDECAR_WAIT_SECS=1 REVIEW_BACKGROUND="PR title"

# (a) success path
export FAKE_HEAD=abc HEAD_SHA=abc FAKE_OCR_MODE=success FAKE_HEALTH=ok REVIEW_SIDECAR=1
run_case success
check "$rc" "a: review.sh exits 0 on success (got $rc)"
test -f "$CAPTURE/callback.posted"; check $? "a: callback was POSTed"
test "$(jq -r .exit_code "$CAPTURE/callback.posted" 2>/dev/null)" = "0"; check $? "a: callback exit_code is 0"
test "$(jq -r .result.status "$CAPTURE/callback.posted" 2>/dev/null)" = "success"; check $? "a: callback carries the ocr envelope"
grep -q 'clone --no-single-branch https://hub.example/git/hemfrid/demo.git' "$CAPTURE/git.log"; check $? "a: full clone through the hub git proxy"
grep -q 'fetch origin +refs/heads/main:refs/remotes/origin/main +refs/pull/7/head:refs/remotes/origin/pr-7' "$CAPTURE/git.log"; check $? "a: fetches base and PR head refs"
grep -q -- '--from origin/main --to origin/pr-7 --format json --audience agent' "$CAPTURE/ocr.log"; check $? "a: ocr invoked in range mode with json/agent output"
grep -q -- "--rule $HERE/rule.json" "$CAPTURE/ocr.log"; check $? "a: org rule file passed"
test -f "$CAPTURE/shutdown.log"; check $? "a: sidecar shutdown requested"
grep -q 'Authorization: Bearer cbtoken' "$CAPTURE/curl.log"; check $? "a: callback uses the bearer token"
grep -q 'x-api-key: localsecret' "$CAPTURE/curl.log"; check $? "a: shutdown presents the relay token"
test "$(cat "$REVIEW_WORK_DIR/background.md")" = "PR title"; check $? "a: background file written"

# (b) ocr fails with stderr JSON
export FAKE_OCR_MODE=fail
run_case ocrfail
check "$rc" "b: review.sh still exits 0 when ocr fails (callback carries it) (got $rc)"
test "$(jq -r .exit_code "$CAPTURE/callback.posted" 2>/dev/null)" = "1"; check $? "b: callback exit_code is 1"
test "$(jq -r .result "$CAPTURE/callback.posted" 2>/dev/null)" = "null"; check $? "b: callback result is null"
jq -r .stderr "$CAPTURE/callback.posted" 2>/dev/null | grep -q 'cannot resolve LLM endpoint'; check $? "b: ocr stderr captured in callback"

# (c) moved head refused before ocr runs
export FAKE_OCR_MODE=success HEAD_SHA=def
run_case movedhead
test "$rc" -eq 71; check $? "c: moved head exits 71 (got $rc)"
test ! -f "$CAPTURE/ocr.log"; check $? "c: ocr not invoked after moved head"
test ! -f "$CAPTURE/callback.posted"; check $? "c: no callback posted on moved head"

# (d) sidecar never healthy
export HEAD_SHA=abc FAKE_HEALTH=down
run_case sidecardown
test "$rc" -eq 70; check $? "d: sidecar health timeout exits 70 (got $rc)"
test ! -f "$CAPTURE/ocr.log"; check $? "d: ocr not invoked without a healthy sidecar"

# (e) API-key lane: no sidecar wait, no shutdown
export REVIEW_SIDECAR=0
run_case nosidecar
check "$rc" "e: REVIEW_SIDECAR=0 skips the health wait (got $rc)"
test ! -f "$CAPTURE/shutdown.log"; check $? "e: no shutdown call without a sidecar"
test "$(jq -r .result.status "$CAPTURE/callback.posted" 2>/dev/null)" = "success"; check $? "e: callback still delivered"

rm -rf "$T"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails FAILED"; exit 1; fi
