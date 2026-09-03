// SPDX-License-Identifier: Apache-2.0
// Drop-in for keyto-hub/lib/schema.ts — PR review jobs (spec Part I §3.4).
// Paste the enum + table into lib/schema.ts (single schema file; drizzle.config.ts
// points at it) and add the two columns shown in the comment block below.
// Style mirrors gitCredentials / auditLog: snake_case SQL, camelCase TS, serial id,
// timestamptz defaults, index() in the third argument.

import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { gitCredentials, projects } from './schema';

// Lifecycle of one `ocr review` run:
//   pending    — row inserted, pod not yet created
//   running    — pod created; waiting for the callback
//   succeeded  — callback received, manifest.terminal_state === 'complete'
//   partial    — callback received, manifest.terminal_state === 'partial'
//   failed     — ocr exit != 0, malformed envelope, or terminal_state failed/skipped
//   timed_out  — sweeper found no callback within the deadline
//   cancelled  — owner DELETEd the job
export const reviewJobStatusEnum = pgEnum('review_job_status', [
  'pending',
  'running',
  'succeeded',
  'partial',
  'failed',
  'timed_out',
  'cancelled',
]);

export const reviewJobs = pgTable(
  'review_jobs',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requestedBy: text('requested_by').notNull(),
    prNumber: integer('pr_number').notNull(),
    baseRef: text('base_ref').notNull(),
    headSha: text('head_sha').notNull(),
    status: reviewJobStatusEnum('status').notNull().default('pending'),
    podName: text('pod_name'),
    gitCredentialId: integer('git_credential_id').references(() => gitCredentials.id, {
      onDelete: 'set null',
    }),
    // sha256 of the one-time bearer the pod presents on the result callback.
    // The raw value lives only in the per-job k8s Secret.
    callbackTokenHash: text('callback_token_hash').notNull(),
    // 'seat:<profile>' (sidecar on a hub seat profile) | 'api_key' (llmOverride)
    llmSource: text('llm_source').notNull(),
    llmModel: text('llm_model'),
    ocrStatus: text('ocr_status'), // envelope.status
    terminalState: text('terminal_state'), // envelope.manifest.terminal_state
    filesReviewed: integer('files_reviewed'),
    commentsTotal: integer('comments_total'),
    commentsPosted: integer('comments_posted'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    totalTokens: integer('total_tokens'),
    elapsedMs: integer('elapsed_ms'),
    // Full OCR JSON envelope. Contains code snippets + model reasoning:
    // nulled after 90 days by the sweeper (spec §5), summary columns kept.
    result: jsonb('result'),
    postSummaryUrl: text('post_summary_url'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    projectIdx: index('review_jobs_project_idx').on(t.projectId),
    prIdx: index('review_jobs_project_pr_idx').on(t.projectId, t.prNumber),
  }),
);

export type ReviewJobStatus = (typeof reviewJobStatusEnum.enumValues)[number];

// ── Column additions to EXISTING tables (edit lib/schema.ts in place) ─────
//
// projectMembers — next to canPromoteProd (lib/schema.ts:331). Same shape:
// a per-member capability flag, meaningful only for role='collaborator';
// owners always may, viewers never.
//
//     // Only meaningful when role='collaborator'. Owners always run reviews.
//     canRunReview: boolean('can_run_review').notNull().default(false),
//
// projects — after the existing jsonb columns. Shape (validated in
// lib/review-config.ts, see README):
//   { model?, effort?: 'low'|'medium'|'high', concurrency?, tokenBudget?,
//     routeSeverityBelow?: 'critical'|'high'|'medium'|'low'|'',
//     llmOverride?: { url: string; tokenSecretRef: string; model: string } }
//
//     reviewConfig: jsonb('review_config'),
