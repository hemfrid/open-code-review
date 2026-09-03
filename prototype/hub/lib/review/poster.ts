// SPDX-License-Identifier: Apache-2.0
// Hub poster: wraps the vendored OCR GitHub Action poster (spec §3.6, decision S7).
//
// The vendored script was written for actions/github-script, so it expects four
// injected objects: `github` (an Octokit with `.rest`), `context` (repo, issue number,
// runId/runAttempt, eventName), `core` (info/warning/setOutput), and `fs` (it reads
// the OCR result file and an optional stderr file). This module builds those shims
// around an in-memory envelope and translates the script's `setOutput` calls back
// into a typed result. Nothing in the vendored file is edited.
//
// Assumptions of the vendored script that leak into the hub (note in the spec):
//   - context.runId / runAttempt become idempotency tags embedded in every comment
//     body (`<!-- ocr-review-run:<id>-<attempt> -->`). We pass the hub job id and 1,
//     so a retried job must reuse the same job id to be recognised as the same run.
//   - Its read pacing sleeps 500 ms after each paginated read (OCR_READ_SUCCESS_DELAY)
//     and honours OCR_MAX_RETRIES / OCR_*_DELAY env vars; the hub inherits those knobs
//     via process.env. Tests set them to 0.
//   - Checkpoint (cross-push) features are off unless checkpointEnabled is passed.

import { createRequire } from 'node:module';
import type { OcrEnvelope, Severity } from './envelope.ts';

const require = createRequire(import.meta.url);
// CommonJS module; loaded via require so the file stays byte-identical to upstream.
const vendored = require('./vendor/post-review-comments.js') as {
  runPostReviewComments: (opts: Record<string, unknown>) => Promise<void>;
  SUMMARY_MARKER: string;
};

export type PosterOctokit = { rest: Record<string, Record<string, (...args: any[]) => Promise<any>>> };

export type PostReviewOptions = {
  octokit: PosterOctokit;
  owner: string;
  repo: string;
  prNumber: number;
  /** Hub review_jobs.id; becomes the idempotency run tag inside comment bodies. */
  jobId: number;
  envelope: OcrEnvelope;
  /** Link rendered nowhere by the vendored script today; kept for the hub summary header (v1.1). */
  jobUrl?: string;
  routeSeverityBelow?: Severity | '';
  routeCategories?: string;
  incremental?: boolean;
  incrementalOverlapThreshold?: number;
  stickySummary?: boolean;
  reviewCommentBatchSize?: number;
  /** Raw ocr stderr, rendered by the script when the result cannot be parsed. */
  stderr?: string;
  log?: (msg: string) => void;
};

export type PostReviewResult = {
  total: number;
  inline: number;
  skipped: number;
  routed: number;
  failed: number;
  summaryUrl: string;
  batches: { total: number; attempted: number; succeeded: number; reconciled: number } | null;
  outputs: Record<string, string>;
};

const RESULT_PATH = '/hub/ocr-result.json';
const STDERR_PATH = '/hub/ocr-stderr.log';

function memFs(files: Record<string, string>) {
  return {
    readFileSync(p: string, _enc?: string): string {
      if (p in files) return files[p];
      const e: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e;
    },
    existsSync(p: string): boolean { return p in files; },
  };
}

/** Post an OCR envelope to a PR as inline comments plus a sticky summary. */
export async function postReview(o: PostReviewOptions): Promise<PostReviewResult> {
  const outputs: Record<string, string> = {};
  const log = o.log ?? (() => {});
  const files: Record<string, string> = { [RESULT_PATH]: JSON.stringify(o.envelope) };
  if (o.stderr) files[STDERR_PATH] = o.stderr;

  await vendored.runPostReviewComments({
    github: o.octokit,
    context: {
      repo: { owner: o.owner, repo: o.repo },
      issue: { number: o.prNumber },
      runId: o.jobId,
      runAttempt: 1,
      eventName: 'keyto-hub-review',   // anything but pull_request_target → the script fetches head sha via pulls.get
      payload: {},
    },
    core: {
      info: log,
      warning: log,
      setOutput: (name: string, value: string) => { outputs[name] = value; },
    },
    fs: memFs(files),
    resultPath: RESULT_PATH,
    stderrPath: STDERR_PATH,
    stickySummary: o.stickySummary ?? true,
    incremental: o.incremental ?? true,
    incrementalOverlapThreshold: o.incrementalOverlapThreshold ?? 0.6,
    reviewCommentBatchSize: o.reviewCommentBatchSize ?? 50,
    routeSeverityBelow: o.routeSeverityBelow ?? '',
    routeCategories: o.routeCategories ?? '',
  });

  const n = (k: string) => Number(outputs[k] ?? 0) || 0;
  let batches: PostReviewResult['batches'] = null;
  if (outputs.batches_total !== undefined) {
    batches = { total: n('batches_total'), attempted: n('batches_attempted'), succeeded: n('batches_succeeded'), reconciled: n('batches_reconciled') };
  }
  return {
    total: n('comments_total'),
    inline: n('comments_inline'),
    skipped: n('comments_skipped'),
    routed: n('comments_routed'),
    failed: n('comments_failed'),
    summaryUrl: outputs.summary_comment_url ?? '',
    batches,
    outputs,
  };
}

export const SUMMARY_MARKER: string = vendored.SUMMARY_MARKER;
