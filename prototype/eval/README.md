# Twenty-PR eval runner

Measures the OCR engine on historical PRs so the noise gate, effort and
concurrency settings are chosen from data (intent.md success criteria: precision,
median tokens, median wall time; spec §8 step 4).

## Inputs

`prs.txt`, one PR per line: `<base_ref> <head_ref_or_sha> <label>`. Refs must
exist in the checkout at `REPO_DIR` (fetch them first; range mode needs full
history for `merge-base`). Lines starting with `#` are ignored.

```
# base            head                          label
origin/main       origin/pr-412                 hub-412-workspace-reaper
origin/main       9f3c1d2e                      hub-418-git-proxy
```

## Run

```
OCR_LLM_URL=http://127.0.0.1:8890 OCR_LLM_TOKEN=local OCR_LLM_PROTOCOL=anthropic \
OCR_LLM_MODEL=claude-sonnet-5 OCR_BIN=/path/to/ocr REPO_DIR=/path/to/repo \
EFFORT=medium CONCURRENCY=4 RESULTS_DIR=results/medium \
sh prototype/eval/run-eval.sh prs.txt
```

Run once per setting you want to compare (`EFFORT=low|medium|high`), into
separate `RESULTS_DIR`s. Each review writes `<label>.json` (the full OCR
envelope) and `<label>.stderr.log`; the run ends with `summary.tsv`:

| column | source |
|---|---|
| status | `envelope.status` |
| terminal_state | `envelope.manifest.terminal_state` (complete / partial / failed / skipped) |
| files_reviewed, comments | `envelope.summary` |
| total_tokens, input_tokens, output_tokens | `envelope.summary` |
| elapsed | `envelope.summary.elapsed` |

## Labelling precision

Precision needs a human. For each `<label>.json`, walk `comments[]` and mark each
finding `true`, `false`, or `nit` in a sidecar file `<label>.labels.tsv`
(`index<TAB>verdict`). Precision for a setting is `true / (true + false)` over all
PRs; `nit` is reported separately as the noise share. Compare against the same
PRs' Kodus output where it exists.

## Smoke test

`sh prototype/eval/test.sh` runs the runner against a fake `ocr` and checks the
TSV. No network, no seat.
