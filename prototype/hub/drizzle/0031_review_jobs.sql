-- SPDX-License-Identifier: Apache-2.0
-- PR review jobs (spec Part I §3.4). Regenerate with `npm run drizzle:generate`
-- after pasting schema.review.ts into lib/schema.ts; this file shows the
-- expected output so the review can happen before the generator runs.

CREATE TYPE "public"."review_job_status" AS ENUM(
  'pending', 'running', 'succeeded', 'partial', 'failed', 'timed_out', 'cancelled'
);
--> statement-breakpoint
CREATE TABLE "review_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "project_id" integer NOT NULL,
  "requested_by" text NOT NULL,
  "pr_number" integer NOT NULL,
  "base_ref" text NOT NULL,
  "head_sha" text NOT NULL,
  "status" "review_job_status" DEFAULT 'pending' NOT NULL,
  "pod_name" text,
  "git_credential_id" integer,
  "callback_token_hash" text NOT NULL,
  "llm_source" text NOT NULL,
  "llm_model" text,
  "ocr_status" text,
  "terminal_state" text,
  "files_reviewed" integer,
  "comments_total" integer,
  "comments_posted" integer,
  "input_tokens" integer,
  "output_tokens" integer,
  "total_tokens" integer,
  "elapsed_ms" integer,
  "result" jsonb,
  "post_summary_url" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "review_jobs" ADD CONSTRAINT "review_jobs_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "review_jobs" ADD CONSTRAINT "review_jobs_git_credential_id_git_credentials_id_fk"
  FOREIGN KEY ("git_credential_id") REFERENCES "public"."git_credentials"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "review_jobs_project_idx" ON "review_jobs" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "review_jobs_project_pr_idx" ON "review_jobs" USING btree ("project_id", "pr_number");
--> statement-breakpoint
ALTER TABLE "project_members" ADD COLUMN "can_run_review" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "review_config" jsonb;
