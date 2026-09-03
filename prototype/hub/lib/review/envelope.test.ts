// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope, deriveJobStatus, summarizeForRow, parseGoDuration, stripThinking, normalizeCategory, normalizeSeverity } from './envelope.ts';

// Shape from pages/src/content/docs/en/cli-reference.md plus manifest fields from internal/session/manifest.go.
const realistic = {
  status: 'completed_with_warnings',
  llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
  trace_id: 'abc',
  summary: { files_reviewed: 3, comments: 2, total_tokens: 21344, input_tokens: 18012, output_tokens: 3332, cache_read_tokens: 500, elapsed: '1m12s' },
  tool_calls: { total: 9, by_tool: { file_read: 5, code_comment: 2, task_done: 2 } },
  comments: [
    { path: 'src/foo.go', content: 'Concurrent map access without a lock.', start_line: 42, end_line: 47, existing_code: 'm[k] = v', suggestion_code: 'mu.Lock(); defer mu.Unlock(); m[k] = v', thinking: 'Looking at line 42', category: 'Bug', severity: 'HIGH' },
    { path: 'src/bar.go', content: 'Unanchored remark.', start_line: 0, end_line: 0, category: 'weird', severity: 'urgent' },
  ],
  warnings: [{ file: 'big.go', message: 'token threshold exceeded', type: 'token_threshold_exceeded' }],
  session_id: 'sess-1',
  manifest: { schema_version: '1', run_id: 'r1', operation: 'review', terminal_state: 'partial', input: { resolved_head: 'a'.repeat(40) }, execution: { model: 'claude-sonnet-5' }, coverage: { selected: [{ path: 'src/foo.go' }], completed: [{ path: 'src/foo.go' }], failed: [{ path: 'big.go', reason: 'token' }] }, elapsed_ms: 72000 },
  retry_report: { schema: 'ocr.llm-retry-report/v1' },
  some_future_field: { kept: true },
};

test('parseEnvelope accepts a realistic envelope, normalises enums, keeps unknown fields', () => {
  const r = parseEnvelope(realistic);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.envelope.comments[0].category, 'bug');
  assert.equal(r.envelope.comments[0].severity, 'high');
  assert.equal(r.envelope.comments[1].category, 'other');
  assert.equal(r.envelope.comments[1].severity, 'low');
  assert.deepEqual((r.envelope as any).some_future_field, { kept: true });
  assert.equal(r.envelope.retry_report && (r.envelope.retry_report as any).schema, 'ocr.llm-retry-report/v1');
});

test('parseEnvelope rejects malformed input with a reason', () => {
  assert.deepEqual(parseEnvelope(null), { ok: false, error: 'envelope is not an object' });
  assert.equal(parseEnvelope({ comments: [] }).ok, false);
  assert.equal(parseEnvelope({ status: 'success' }).ok, false);
  assert.equal(parseEnvelope({ status: 'success', comments: [{ path: 'x' }] }).ok, false, 'content required');
  assert.equal(parseEnvelope({ status: 'success', comments: [{ path: 'x', content: 'c', start_line: -1, end_line: 0 }] }).ok, false);
  assert.equal(parseEnvelope({ status: 'success', comments: [], manifest: { terminal_state: 'done' } }).ok, false);
  assert.equal(parseEnvelope({ status: 'skipped', message: 'No supported files changed.', llm: { model: 'm' }, comments: [] }).ok, true, 'skipped envelope has no summary');
});

test('normalizers', () => {
  assert.equal(normalizeCategory(' Security '), 'security');
  assert.equal(normalizeCategory(undefined), 'other');
  assert.equal(normalizeSeverity('Critical'), 'critical');
  assert.equal(normalizeSeverity(3), 'low');
});

test('parseGoDuration', () => {
  assert.equal(parseGoDuration('1m12s'), 72_000);
  assert.equal(parseGoDuration('45s'), 45_000);
  assert.equal(parseGoDuration('2h3m'), 7_380_000);
  assert.equal(parseGoDuration('1.5s'), 1500);
  assert.equal(parseGoDuration('250ms'), 250);
  assert.equal(parseGoDuration('0'), 0);
  assert.equal(parseGoDuration('soon'), null);
  assert.equal(parseGoDuration(undefined), null);
});

test('deriveJobStatus follows spec §3.5 step 4', () => {
  const env = (ts?: string, status = 'success') => parseEnvelope({ status, comments: [], ...(ts ? { manifest: { terminal_state: ts } } : {}) });
  const get = (r: ReturnType<typeof parseEnvelope>) => (r.ok ? r.envelope : null);
  assert.equal(deriveJobStatus(0, get(env('complete'))), 'succeeded');
  assert.equal(deriveJobStatus(0, get(env('partial'))), 'partial');
  assert.equal(deriveJobStatus(0, get(env('failed'))), 'failed');
  assert.equal(deriveJobStatus(0, get(env('skipped'))), 'succeeded');
  assert.equal(deriveJobStatus(1, get(env('complete'))), 'failed', 'exit 1 wins');
  assert.equal(deriveJobStatus(70, null), 'failed', 'exit 70 = seat_reauth_required, no envelope');
  assert.equal(deriveJobStatus(0, null), 'failed');
  assert.equal(deriveJobStatus(0, get(env(undefined, 'success'))), 'succeeded', 'no manifest: envelope status');
  assert.equal(deriveJobStatus(0, get(env(undefined, 'completed_with_errors'))), 'partial');
});

test('summarizeForRow derives the review_jobs columns', () => {
  const r = parseEnvelope(realistic);
  assert.ok(r.ok); if (!r.ok) return;
  const row = summarizeForRow(r.envelope);
  assert.deepEqual(row, { ocrStatus: 'completed_with_warnings', terminalState: 'partial', filesReviewed: 3, commentsTotal: 2, inputTokens: 18012, outputTokens: 3332, totalTokens: 21344, elapsedMs: 72000, llmModel: 'claude-sonnet-5', sessionId: 'sess-1' });
  const noManifest = parseEnvelope({ ...realistic, manifest: undefined });
  assert.ok(noManifest.ok); if (!noManifest.ok) return;
  assert.equal(summarizeForRow(noManifest.envelope).elapsedMs, 72_000, 'falls back to Go duration string');
});

test('stripThinking removes reasoning everywhere', () => {
  const r = parseEnvelope(realistic);
  assert.ok(r.ok); if (!r.ok) return;
  const withRouted = { ...r.envelope, routed_to_summary: [{ comment: r.envelope.comments[0], reason: 'x' }] };
  const s = stripThinking(withRouted);
  assert.equal('thinking' in s.comments[0], false);
  assert.equal('thinking' in s.routed_to_summary![0].comment, false);
  assert.equal(s.comments[0].content, r.envelope.comments[0].content);
  assert.ok('thinking' in r.envelope.comments[0], 'input not mutated');
});
