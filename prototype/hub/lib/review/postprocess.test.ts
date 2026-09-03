// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStages, severityFloor, verifierPass, dedupe, validateSuggestions } from './postprocess.ts';
import type { OcrEnvelope } from './envelope.ts';

const env: OcrEnvelope = {
  status: 'success',
  comments: [
    { path: 'a.go', content: 'crit', start_line: 1, end_line: 1, severity: 'critical' },
    { path: 'a.go', content: 'med', start_line: 5, end_line: 6, severity: 'medium' },
    { path: 'b.go', content: 'low', start_line: 9, end_line: 9, severity: 'low' },
    { path: 'b.go', content: 'no severity', start_line: 12, end_line: 12 },
    { path: 'c.go', content: 'unanchored low', start_line: 0, end_line: 0, severity: 'low' },
  ],
};
const ctx = { projectName: 'p', prNumber: 1, jobId: 7 };

test('severityFloor routes at-or-below findings without deleting them, leaves unanchored alone', async () => {
  const out = await runStages(env, ctx, [severityFloor('low')]);
  assert.deepEqual(out.comments.map((c) => c.content), ['crit', 'med', 'unanchored low']);
  assert.deepEqual(out.routed_to_summary!.map((r) => r.comment.content), ['low', 'no severity']);
  assert.match(out.routed_to_summary![0].reason, /floor low/);
  assert.equal(env.comments.length, 5, 'input not mutated');
  const medium = await runStages(env, ctx, [severityFloor('medium')]);
  assert.deepEqual(medium.comments.map((c) => c.content), ['crit', 'unanchored low']);
  const off = await runStages(env, ctx, [severityFloor('')]);
  assert.equal(off, env);
});

test('runStages chains stages in order', async () => {
  const out = await runStages(env, ctx, [severityFloor('low'), (e) => ({ ...e, status: 'tagged' })]);
  assert.equal(out.status, 'tagged');
  assert.equal(out.comments.length, 3);
});

test('v1.1 stages are explicit stubs', () => {
  for (const s of [verifierPass({ model: 'm', call: async () => '' }), dedupe(), validateSuggestions()]) {
    assert.throws(() => s(env, ctx), /not implemented/);
  }
});
