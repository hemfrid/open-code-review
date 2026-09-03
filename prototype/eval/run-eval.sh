#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Twenty-PR eval runner (intent.md success criteria; spec §8 step 4).
#
# Usage: sh prototype/eval/run-eval.sh <prs.txt>
#   prs.txt lines: <base_ref> <head_ref_or_sha> <label>   ('#' starts a comment)
# Env:   OCR_BIN (default: ocr)  REPO_DIR (default: .)  RESULTS_DIR (default: results)
#        EFFORT (default: medium)  CONCURRENCY (default: 4)  TOKEN_BUDGET (default: 400000)
#        OCR_LLM_URL OCR_LLM_TOKEN OCR_LLM_MODEL OCR_LLM_PROTOCOL  (passed through to ocr)
# Output: $RESULTS_DIR/<label>.json, <label>.stderr.log, summary.tsv
set -eu

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: run-eval.sh <prs.txt>" >&2
  exit 2
fi
PRS="$1"
OCR_BIN="${OCR_BIN:-ocr}"
REPO_DIR="${REPO_DIR:-.}"
OUT="${RESULTS_DIR:-results}"
EFFORT="${EFFORT:-medium}"
CONCURRENCY="${CONCURRENCY:-4}"
TOKEN_BUDGET="${TOKEN_BUDGET:-400000}"
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }
mkdir -p "$OUT"

n=0
while IFS=' ' read -r base head label _rest; do
  [ -z "$base" ] && continue
  case "$base" in \#*) continue ;; esac
  if [ -z "$head" ] || [ -z "$label" ]; then
    echo "skip malformed line: $base $head $label" >&2
    continue
  fi
  n=$((n + 1))
  echo "[$n] $label: $base..$head" >&2
  set +e
  "$OCR_BIN" review --repo "$REPO_DIR" --from "$base" --to "$head" \
    --format json --audience agent --effort "$EFFORT" --concurrency "$CONCURRENCY" \
    --max-tokens-budget "$TOKEN_BUDGET" --output "$OUT/$label.json" 2> "$OUT/$label.stderr.log"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then echo "    warn: ocr exited $rc (see $OUT/$label.stderr.log)" >&2; fi
done < "$PRS"

printf 'label\tstatus\tterminal_state\tfiles_reviewed\tcomments\ttotal_tokens\tinput_tokens\toutput_tokens\telapsed\n' > "$OUT/summary.tsv"
for f in "$OUT"/*.json; do
  [ -f "$f" ] || continue
  label="$(basename "$f" .json)"
  jq -r --arg l "$label" '[$l, (.status // "missing"), (.manifest.terminal_state // ""), (.summary.files_reviewed // ""), (.summary.comments // ""), (.summary.total_tokens // ""), (.summary.input_tokens // ""), (.summary.output_tokens // ""), (.summary.elapsed // "")] | @tsv' "$f" >> "$OUT/summary.tsv" \
    || printf '%s\tunparseable\t\t\t\t\t\t\t\n' "$label" >> "$OUT/summary.tsv"
done
echo "wrote $OUT/summary.tsv ($n reviews)" >&2
