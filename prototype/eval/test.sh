#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Smoke test for run-eval.sh with a fake ocr. Usage: sh prototype/eval/test.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq is required"; exit 0; }
T="$(mktemp -d)"
fails=0
check() { if [ "$1" -eq 0 ]; then echo "PASS: $2"; else echo "FAIL: $2"; fails=$((fails + 1)); fi; }

cat > "$T/ocr" <<'EOF'
#!/bin/sh
out=""; prev=""; to=""
for a in "$@"; do
  if [ "$prev" = "--output" ]; then out="$a"; fi
  if [ "$prev" = "--to" ]; then to="$a"; fi
  prev="$a"
done
case "$to" in
  broken) echo '{"status":"failed","message":"boom"}' >&2; exit 1 ;;
  partial) printf '%s' '{"status":"completed_with_warnings","summary":{"files_reviewed":3,"comments":2,"total_tokens":300,"input_tokens":250,"output_tokens":50,"elapsed":"2m"},"comments":[],"manifest":{"terminal_state":"partial"}}' > "$out"; exit 0 ;;
  *) printf '%s' '{"status":"success","summary":{"files_reviewed":5,"comments":4,"total_tokens":1200,"input_tokens":1000,"output_tokens":200,"elapsed":"1m12s"},"comments":[],"manifest":{"terminal_state":"complete"}}' > "$out"; exit 0 ;;
esac
EOF
chmod +x "$T/ocr"

printf '%s\n' '# base head label' 'origin/main origin/pr-1 one' 'origin/main partial two' 'origin/main broken three' '' > "$T/prs.txt"

OCR_BIN="$T/ocr" REPO_DIR="$T" RESULTS_DIR="$T/results" sh "$HERE/run-eval.sh" "$T/prs.txt" 2> "$T/run.log"
check $? "runner exits 0 even when one review fails"
test -f "$T/results/summary.tsv"; check $? "summary.tsv written"
test "$(wc -l < "$T/results/summary.tsv" | tr -d ' ')" = "3"; check $? "header + 2 parseable rows (failed review has no json)"
grep -q "^one	success	complete	5	4	1200	1000	200	1m12s$" "$T/results/summary.tsv"; check $? "success row has every column"
grep -q "^two	completed_with_warnings	partial	3	2	300" "$T/results/summary.tsv"; check $? "partial row carries terminal_state"
grep -q 'ocr exited 1' "$T/run.log"; check $? "failed review reported on stderr"
test -s "$T/results/three.stderr.log"; check $? "failed review stderr captured"

rm -rf "$T"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails FAILED"; exit 1; fi
