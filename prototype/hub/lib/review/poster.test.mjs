// SPDX-License-Identifier: Apache-2.0
// Run with: node --experimental-strip-types --test prototype/hub/lib/review/poster.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The vendored script paces paginated reads with sleeps; zero them for tests.
process.env.OCR_READ_SUCCESS_DELAY = '0';
process.env.OCR_SUCCESS_DELAY = '0';
process.env.OCR_FAILURE_DELAY = '0';
process.env.OCR_MAX_RETRIES = '0';

const { postReview, SUMMARY_MARKER } = await import('./poster.ts');

function fakeOctokit() {
  const calls = [];
  const rec = (name, fn) => async (args) => { calls.push({ name, args }); return fn(args); };
  let nextId = 100;
  const octokit = {
    rest: {
      pulls: {
        get: rec('pulls.get', () => ({ data: { head: { sha: 'f'.repeat(40) } } })),
        createReview: rec('pulls.createReview', () => ({ data: { id: nextId++ }, headers: {} })),
        listReviewComments: rec('pulls.listReviewComments', () => ({ data: [], headers: {} })),
        listReviews: rec('pulls.listReviews', () => ({ data: [], headers: {} })),
      },
      issues: {
        listComments: rec('issues.listComments', () => ({ data: [], headers: {} })),
        createComment: rec('issues.createComment', ({ body }) => ({ data: { id: nextId++, html_url: `https://github.com/hemfrid/r/pull/9#issuecomment-${nextId}`, body } })),
        updateComment: rec('issues.updateComment', ({ comment_id, body }) => ({ data: { id: comment_id, html_url: `https://github.com/hemfrid/r/pull/9#issuecomment-${comment_id}`, body } })),
      },
      users: { getAuthenticated: rec('users.getAuthenticated', () => ({ data: { login: 'keyto-hub-bot[bot]' } })) },
    },
  };
  return { octokit, calls };
}

const envelope = {
  status: 'success',
  llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
  summary: { files_reviewed: 2, comments: 2, total_tokens: 1000, input_tokens: 900, output_tokens: 100, elapsed: '30s' },
  comments: [
    { path: 'src/foo.go', content: 'Concurrent map access without a lock.', start_line: 42, end_line: 47, existing_code: 'm[k] = v', severity: 'high', category: 'bug' },
    { path: 'src/bar.go', content: 'Unanchored remark about bar.', start_line: 0, end_line: 0, severity: 'medium', category: 'maintainability' },
  ],
  warnings: [],
  manifest: { terminal_state: 'complete', coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] } },
};

test('postReview posts anchored findings inline and folds unanchored ones into the summary', async () => {
  const { octokit, calls } = fakeOctokit();
  const res = await postReview({ octokit, owner: 'hemfrid', repo: 'r', prNumber: 9, jobId: 7, envelope, incremental: true, log: () => {} });

  const reviews = calls.filter((c) => c.name === 'pulls.createReview');
  assert.equal(reviews.length, 1, 'one batch review');
  assert.equal(reviews[0].args.comments.length, 1);
  assert.equal(reviews[0].args.comments[0].path, 'src/foo.go');
  assert.equal(reviews[0].args.comments[0].start_line, 42);
  assert.equal(reviews[0].args.comments[0].line, 47);
  assert.equal(reviews[0].args.commit_id, 'f'.repeat(40), 'head sha from pulls.get');
  assert.match(reviews[0].args.body, /ocr-review-run:7-1/, 'hub job id is the idempotency run tag');

  const summaryWrites = calls.filter((c) => c.name === 'issues.createComment' || c.name === 'issues.updateComment');
  assert.ok(summaryWrites.length >= 1);
  const finalBody = summaryWrites[summaryWrites.length - 1].args.body;
  assert.ok(finalBody.includes(SUMMARY_MARKER));
  assert.match(finalBody, /Unanchored remark about bar\./, 'no-line finding folded into summary');
  assert.doesNotMatch(finalBody, /Concurrent map access/, 'inline finding not duplicated in summary');

  assert.equal(res.total, 2);
  assert.equal(res.inline, 1);
  assert.equal(res.failed, 0);
  assert.equal(res.routed, 0);
  assert.match(res.summaryUrl, /issuecomment/);
  assert.deepEqual(res.batches, { total: 1, attempted: 1, succeeded: 1, reconciled: 0 });
  assert.ok(calls.some((c) => c.name === 'users.getAuthenticated'), 'incremental mode resolves the bot login');
});

test('postReview routes low severity to the summary when asked', async () => {
  const { octokit, calls } = fakeOctokit();
  const env2 = { ...envelope, comments: [...envelope.comments, { path: 'src/baz.go', content: 'Nit: rename.', start_line: 3, end_line: 3, severity: 'low', category: 'style' }] };
  const res = await postReview({ octokit, owner: 'hemfrid', repo: 'r', prNumber: 9, jobId: 8, envelope: env2, routeSeverityBelow: 'low', incremental: false, log: () => {} });
  const review = calls.find((c) => c.name === 'pulls.createReview');
  assert.equal(review.args.comments.length, 1, 'low finding not posted inline');
  assert.equal(res.routed, 1);
  const finalBody = calls.filter((c) => c.name === 'issues.updateComment' || c.name === 'issues.createComment').at(-1).args.body;
  assert.match(finalBody, /Nit: rename\./);
});

test('postReview with zero comments posts a looks-good summary and no review', async () => {
  const { octokit, calls } = fakeOctokit();
  const res = await postReview({ octokit, owner: 'hemfrid', repo: 'r', prNumber: 9, jobId: 9, envelope: { ...envelope, comments: [], message: 'No comments generated. Looks good to me.' }, log: () => {} });
  assert.equal(calls.filter((c) => c.name === 'pulls.createReview').length, 0);
  assert.match(calls.find((c) => c.name === 'issues.createComment').args.body, /Looks good to me/);
  assert.equal(res.total, 0);
  assert.equal(res.batches, null);
});
