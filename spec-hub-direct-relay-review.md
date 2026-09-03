---
title: PR code review on keyto-hub via open-code-review, hub-native seat relay
status: draft for review
date: 2026-09-03
author: OCR agent, for Sean
implements: intent.md (P1–P10, D1–D6)
constraint: keyto-hub and keyto-aios have no runtime connection of any kind
template: keyto-hub/docs/superpowers/specs/2026-08-11-seat-credential-lifecycle-design.md (Phase 2, "port the seat-proxy shape into the Hub")
target_repo: keyto-hub (this file should move to keyto-hub/docs/superpowers/specs/)
depends_on:
  - keyto-talos-k8s: nothing for v1; project.yaml schema change deferred to v1.1
---

# PR code review on keyto-hub, hub-native seat relay

Every claim below that names a file or function was read from the code on
2026-09-03. Line numbers are approximate and will drift. Nothing here calls,
reads from, or depends on keyto-aios at runtime. Two pieces of *knowledge*
are ported from its seat-proxy (the OAuth refresh exchange and the request
fix-ups the subscription endpoint needs); both are also called out as the
plan in the hub's own lifecycle design, Phase 2.

## 1. Summary

A deploy manager presses "Review PR" on a project page in the hub. The hub
creates a one-shot pod in `keyto-workspaces` with two containers: `review`
(git plus the stock `ocr` binary) and `seat-relay` (a small hub-owned
loopback proxy that turns the deploy manager's stored Claude seat credential
into an Anthropic Messages endpoint on `127.0.0.1:8890`). The review
container clones the repo through the hub git proxy with full history,
fetches the PR head and base, runs `ocr review` against the sidecar, and
posts the result JSON back to the hub over an authenticated callback. The
hub stores the run, posts inline comments and a sticky summary to the PR as
the bot GitHub App, and shows status, coverage and token usage. No fork of
OCR. No webhook automation in v1. No aios.

```
deploy manager ──POST /api/projects/{name}/reviews {prNumber}──▶ hub
   hub: gate → PR metadata via App Octokit → review_jobs row (pending)
        → rv-cred secret (git token, callback token, background.md)
        → review pod: [seat-relay sidecar] + [review container]
   seat-relay: reads /restore/claude/<profile>.credentials.json (deploy manager's Claude seat)
               refreshes near expiry; serves 127.0.0.1:8890 → api.anthropic.com with
               Bearer <access token>, anthropic-beta oauth, Claude Code identity system block
   review:     git clone (full) via /git/hemfrid/{project}.git → fetch base + refs/pull/N/head
               ocr review --from origin/{base} --to origin/pr-N --format json --audience agent
                          --rule /etc/keyto-review/rule.json --background-file … --output /work/result.json
               (OCR_LLM_URL=http://127.0.0.1:8890, OCR_LLM_PROTOCOL=anthropic)
               POST {hub}/api/internal/reviews/{jobId}/result  (Bearer callback token, body = result.json)
   hub:  validate → store envelope → post-process (v1: severity routing only)
         → poster: inline comments + sticky summary as bot App → row = succeeded|partial|failed
         → snapshot refreshed credential back to claude-creds-<userhash> (existing machinery)
   sweeper (CronJob → internal route, every 10 min): time out stuck jobs, delete finished pods, revoke creds
   UI:   poll GET /api/projects/{name}/reviews/{jobId}
```

## 2. Decisions and their reasons

| # | Decision | Reason |
|---|----------|--------|
| S1 | One-shot pod with **callback**, not exec | `execWorkspacePodRun` defaults to a 10 s timeout and buffers stdout unbounded in memory (`orchestration/platform/k8s-workspace.ts:10,248`). A review runs 1–5 min and its JSON can be hundreds of KB. Holding a WebSocket exec inside a Next.js request for minutes is fragile. The house pattern is "DB row + pull-based polling" and "CronJob, not in-pod timer" (`.claude/skills/keyto-hub-provisioning-campaign/SKILL.md:133`). The pod already reaches the hub origin for the git clone, so a callback adds no new network path. |
| S2 | New pod builder `buildReviewPodSpec`, not a `buildWorkspacePodSpec` option | `buildWorkspacePodSpec` has no image or command parameter (`orchestration/workspaces.ts:224-234`); the only variant precedent is `buildSeatPodSpec` (`:467`). A review pod is a sibling builder that reuses the same security posture, labels and secret conventions. |
| S3 | **Seat access via a hub-owned loopback sidecar fed by the hub's own seat profiles** | The hub already holds each user's Claude seat credential (`claude-creds-<userhash>`, keys `<profile>.credentials.json`, `active`, mirror `.credentials.json`; `orchestration/seat-profiles.ts:186-220`) and already restores it into that user's pods at `/restore/claude` (`workspaces.ts:418-437`). OCR needs an HTTP endpoint, not a credentials file, so a sidecar does the translation on `127.0.0.1` inside the same pod. This is the hub's own Phase 2 plan: "Port the seat-proxy shape into the Hub … the Hub reads token expiry and holds the refresh token … Tokens never leave the Hub except into the owner's own pod" (`docs/superpowers/specs/2026-08-11-seat-credential-lifecycle-design.md:76-95`). Loopback-only matches the posture seat-proxy itself insists on. No shared relay Service: a token would then leave the owner's pod, which the seats doctrine forbids. |
| S4 | Full clone, not shallow | Range mode reviews `merge-base(base, head)..head`; OCR documents "Cannot find merge-base" for shallow clones (`pages/src/content/docs/en/integrations/ci.md:294`). The workspace init clones default branch only (`workspaces.ts:155`); the review init adds `--no-single-branch` and a PR-ref fetch. |
| S5 | Per-job credentials in a per-job secret | Mirrors `ws-cred-<project>-<userhash>` (`workspaces.ts:117-119`), keeps tokens out of the pod spec (`secretKeyRef` only, as `workspaces.test.ts` "never embeds the git token" asserts). Git credential kind `workspace`, 7-day TTL (`lib/git-credentials.ts:10`), revoked on completion. |
| S6 | Poster runs in the hub, not in the pod | The pod holds a fetch-only git token and no GitHub token. The hub already has `getInstallationOctokit()` and `mintScopedInstallationToken({repo, permissions})` (`orchestration/platform/github-app.ts:55-80,139-145`) and already requests `pull_requests:write` for push tokens (`orchestration/git-proxy.ts:161-164`). |
| S7 | Vendor OCR's GitHub poster for v1 | `scripts/github-actions/post-review-comments.js` (Apache-2.0) exports `runPostReviewComments({github, context, core, fs, resultPath, …})` and needs only an Octokit plus `{repo:{owner,repo}, issue:{number}, runId, runAttempt}`. It already handles batching (50), the 422 hunk fallback, sticky summary, incremental IoU de-dup and severity/category routing. A TS rewrite is v1.1. |
| S8 | Authorisation = owner, or collaborator with a new `can_run_review` flag | No "deploy manager" role exists; roles are `owner|collaborator|viewer` (`lib/schema.ts:43-47`). `project_members.can_promote_prod` is the precedent for a per-member capability boolean (`lib/schema.ts:330-333`, `canPromote()` in `lib/project-membership.ts:193-213`). |
| S9 | Pod lives in `keyto-workspaces` for v1 | NetworkPolicy is greenfield cluster-wide (`docs/agent-workers-investigation.md:335-341`). OCR does not execute PR code, only `git` and file reads, so the untrusted-worker sibling namespace (`:149-166`) is deferred until webhook-triggered fork PRs are in scope. The sidecar egresses only to `api.anthropic.com`. |
| S10 | Console API key is a config swap, not a code path | OCR reads `OCR_LLM_URL`/`OCR_LLM_TOKEN`/`OCR_LLM_PROTOCOL` identically for both. `projects.review_config.llmOverride` (url, token secret ref, model) replaces the sidecar when set, and the sidecar container is simply omitted from the pod. This is the hub doctrine's "shared-audience case stays API-key" lane. |
| S11 | Reviews use a **dedicated seat profile** per deploy manager | Seat profiles exist precisely to spread quota across accounts, up to `MAX_PROFILES` (5) per user (`seat-profiles.ts`, `docs/superpowers/specs/2026-08-13-seat-credential-profiles-design.md:20-28`). Using a profile named `review` avoids two processes (a running workspace's Claude Code and the review sidecar) refreshing the same OAuth credential concurrently, which is the revocation hazard the hub's own designs warn about. If no `review` profile exists, the job uses the active profile and the UI says so. |

## 3. Components

### 3.1 Images

**Review image** (`keyto-review`):

```dockerfile
FROM golang:1.26 AS build
ARG OCR_REF=v<pinned>
RUN git clone --depth 1 --branch ${OCR_REF} https://github.com/alibaba/open-code-review /src \
 && cd /src && CGO_ENABLED=0 go build -ldflags="-s -w" -o /ocr ./cmd/opencodereview
FROM alpine:3.20
RUN apk add --no-cache git ca-certificates jq curl && adduser -D -u 1001 review
COPY --from=build /ocr /usr/local/bin/ocr
COPY rule.json /etc/keyto-review/rule.json          # org rules, §3.7
COPY review.sh /usr/local/bin/review.sh
USER 1001
ENTRYPOINT ["/usr/local/bin/review.sh"]
```

Pin `OCR_REF` to a tag (git ≥ 2.41 is a hard OCR requirement; alpine 3.20 ships 2.45). Push to ACR; reference via `KEYTO_REVIEW_IMAGE`, full-SHA tag like `KEYTO_WORKSPACE_AGENT_IMAGE` (`values.yaml:135`).

**Seat-relay image** (`keyto-seat-relay`): Node 22 on `node:22-alpine`, one file `relay.mjs` (~200 lines), no dependencies beyond `node:http`/`node:https`. Lives in `keyto-hub/seat-relay/` beside `workspace-agent/` and `workspace-gateway/`, which are the existing hub-owned pod images. Referenced via `KEYTO_SEAT_RELAY_IMAGE`.

`review.sh` (all inputs from env, none interpolated unquoted):

```sh
#!/bin/sh
set -eu
umask 077
export HOME=/home/review
printf 'https://keyto:%s@%s\n' "$GIT_TOKEN" "${HUB_GIT_BASE#https://}" > "$HOME/.git-credentials"
git config --global credential.helper store
git config --global user.email "review@keyto"; git config --global user.name "keyto-review"
git clone --no-single-branch "$HUB_GIT_BASE/git/hemfrid/$PROJECT.git" "$HOME/app"
cd "$HOME/app"
git fetch origin "+refs/heads/$BASE_REF:refs/remotes/origin/$BASE_REF" \
                 "+refs/pull/$PR_NUMBER/head:refs/remotes/origin/pr-$PR_NUMBER"
test "$(git rev-parse "origin/pr-$PR_NUMBER")" = "$HEAD_SHA"   # refuse to review a moved head
printf '%s' "$REVIEW_BACKGROUND" > /work/background.md
# wait for the sidecar (it refreshes the seat token on start)
i=0; until curl -fsS "http://127.0.0.1:8890/healthz" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && exit 70; sleep 1; done
set +e
ocr review --repo "$HOME/app" \
  --from "origin/$BASE_REF" --to "origin/pr-$PR_NUMBER" \
  --format json --audience agent --output /work/result.json \
  --rule /etc/keyto-review/rule.json --background-file /work/background.md \
  --concurrency "${REVIEW_CONCURRENCY:-4}" --effort "${REVIEW_EFFORT:-medium}" \
  --timeout "${REVIEW_TIMEOUT_MIN:-15}" --max-tokens-budget "${REVIEW_TOKEN_BUDGET:-400000}" \
  2> /work/stderr.log
rc=$?
set -e
jq -n --arg rc "$rc" --rawfile stderr /work/stderr.log \
      --slurpfile result /work/result.json 2>/dev/null \
      '{exit_code: ($rc|tonumber), stderr: $stderr, result: ($result[0] // null)}' > /work/callback.json \
 || jq -n --arg rc "$rc" --rawfile stderr /work/stderr.log '{exit_code: ($rc|tonumber), stderr: $stderr, result: null}' > /work/callback.json
curl -fsS --retry 5 --retry-all-errors -X POST "$HUB_CALLBACK_URL" \
  -H "Authorization: Bearer $CALLBACK_TOKEN" -H 'content-type: application/json' \
  --data-binary @/work/callback.json
curl -fsS -X POST "http://127.0.0.1:8890/shutdown" >/dev/null 2>&1 || true   # let the pod complete
```

OCR writes exactly one JSON document to `--output`; on fatal error it writes a second JSON document to **stderr**, so `stderr.log` is kept. `--background-file` avoids shell-interpolating PR text.

Environment for `review` (via `secretKeyRef` from the per-job secret, except constants): `GIT_TOKEN`, `HUB_GIT_BASE`, `PROJECT`, `PR_NUMBER`, `BASE_REF`, `HEAD_SHA`, `REVIEW_BACKGROUND`, `OCR_LLM_URL=http://127.0.0.1:8890`, `OCR_LLM_TOKEN=local` (the sidecar ignores it; OCR requires a non-empty token), `OCR_LLM_MODEL`, `OCR_LLM_PROTOCOL=anthropic`, `OCR_LLM_TIMEOUT=300`, `HUB_CALLBACK_URL`, `CALLBACK_TOKEN`, `REVIEW_CONCURRENCY`, `REVIEW_EFFORT`, `REVIEW_TIMEOUT_MIN`, `REVIEW_TOKEN_BUDGET`, optional `OCR_ENABLE_TELEMETRY` + `OTEL_EXPORTER_OTLP_ENDPOINT`.

### 3.2 Seat-relay sidecar: `keyto-hub/seat-relay/relay.mjs`

Responsibilities, each a few lines:

1. **Load** `/restore/claude/.credentials.json` at start (the mirror of the profile the hub selected for this job, §4). Parse the Claude Code blob: `claudeAiOauth.{accessToken, refreshToken, expiresAt}`. If the profile has no OAuth section, exit non-zero with a clear message; the review container's health wait then fails with exit 70 → job `error='no_seat'`.
2. **Refresh** when `expiresAt - now < 5 min`, and on any 401 from upstream once: `POST <token URL>` with `{grant_type:'refresh_token', refresh_token, client_id}` using Claude Code's public client id (`9d1c250a-e61b-44d9-88ed-5944d1962f5e`), replacing the access token and, if returned, the refresh token. Write the updated blob back to `/restore/claude/.credentials.json` so the hub's existing teardown snapshot persists it. 400/401/403 on refresh = seat dead → `/healthz` reports `seat_reauth_required` and the job fails with that error string; other statuses are transient and retried with backoff. The token URL and the exact exchange are the ones already documented as "the working exchange to port" in the lifecycle design.
3. **Serve** `127.0.0.1:8890` (bind loopback only; the pod has no Service). Accept `POST /v1/messages` (and pass through any other `/v1/*` path). Drop the incoming `x-api-key`/`authorization`, set `Authorization: Bearer <access token>`, set `anthropic-beta: oauth-2025-04-20` (merging with any client-supplied beta list), keep `anthropic-version`, `content-type`, `accept`.
4. **Body fix-ups** the subscription endpoint requires, identical to what OCR's traffic needs: delete top-level `context_management` if present; ensure `system` is a list whose first block is `{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}` (string → two blocks; list → prepend unless already first). Nothing else is touched, so OCR's `tools`, `tool_choice`, `max_tokens`, `thinking` and `cache_control` pass through.
5. **Stream** the upstream response back with status and headers (minus hop-by-hop). Count requests, input/output tokens from `usage` when the body is non-streaming JSON, and expose them on `GET /metrics` for the review container to include in the callback (optional; OCR's own `summary` already has token totals).
6. `GET /healthz` → `{ok, seat: 'ready'|'refreshing'|'seat_reauth_required'}`; `POST /shutdown` → exit 0 so the pod reaches `Succeeded` once the review container has posted its callback (no sidecar-lifecycle native support is assumed).

Security posture: same container hardening as every hub pod container; read-write mount only on `/restore/claude` (an emptyDir the init step populates from the secret, as workspaces do) so a refreshed token can be written; egress only to `api.anthropic.com` and the token URL. The hub never sees a token in a request or a log: the sidecar logs status codes and byte counts only.

### 3.3 Pod builder: `orchestration/reviews.ts` (new, hub)

```ts
export type ReviewPodOpts = {
  project: string; email: string; jobId: number; credentialId: number;
  prNumber: number; baseRef: string; headSha: string;
  seatProfile: string | null;           // null when llmOverride is set (no sidecar)
};
export function reviewPodName(project: string, jobId: number): string   // rv-<project≤30>-<jobId>
export function reviewCredSecretName(project: string, jobId: number)    // rv-cred-<project≤30>-<jobId>
export function buildReviewPodSpec(o: ReviewPodOpts): object
export async function startReview(project: Project, email: string, prNumber: number): Promise<ReviewJob>
export async function completeReview(jobId: number, cb: ReviewCallback): Promise<void>
export async function sweepReviews(): Promise<{ timedOut: number[]; cleaned: number[] }>
```

`buildReviewPodSpec` copies the invariants `workspaces.test.ts` asserts: `automountServiceAccountToken:false`, `restartPolicy:'Never'`, `runAsNonRoot` uid/gid/fsGroup 1001, seccomp `RuntimeDefault`, per-container `allowPrivilegeEscalation:false` + `drop:['ALL']`, `imagePullSecrets:[{name:'acr-pull'}]`, requests and limits on every container (`review`: requests `500m/1Gi`, limits `2/3Gi`; `seat-relay`: requests `50m/64Mi`, limits `200m/256Mi`). Volumes: `home` emptyDir 4Gi, `work` emptyDir 512Mi, `claude-restore` emptyDir 8Mi, and `claude-creds` = secret `claudeCredsSecretName(email)` narrowed with `items` to the chosen profile's `<profile>.credentials.json` projected as `.credentials.json`, mounted read-only on an init container that copies it into `claude-restore` (so the sidecar can write the refreshed token). `activeDeadlineSeconds = (REVIEW_TIMEOUT_MIN × 3 + 10) × 60`.

Labels: `keyto.io/review: "true"`, `keyto.io/project`, `keyto.io/user-hash`, `keyto.io/review-job`, `keyto.io/seat-profile`. Annotations: `keyto.io/user-email`, `keyto.io/git-credential-id`. The workspace reaper selects `keyto.io/workspace=true` (`k8s-workspace.ts:70`) and ignores review pods; the review sweeper selects `keyto.io/review=true`.

`startReview(project, email, prNumber)`:

1. `getInstallationOctokit().pulls.get(...)` → `base.ref`, `head.sha`, `head.repo.full_name`, `title`, `body`, `state`. Reject closed PRs and, in v1, fork PRs (head repo ≠ project repo; see S9).
2. Resolve LLM: `projects.review_config.llmOverride` → API key lane (no sidecar, `llm_source='api_key'`); else read `getWorkspaceSecretData(claudeCredsSecretName(email))`, pick profile `review` if present else `active` (`llm_source='seat:<profile>'`); if neither exists → fail with `error='no_seat'` and the UI links to the existing "Connect Claude" flow (`app/api/me/workspace/claude-auth/*`). Model from `review_config.model`, default `KEYTO_REVIEW_DEFAULT_MODEL`.
3. Refuse if another job is `running` for the same (email, profile): one live user of a credential at a time (S11). Refuse if a job is `running` for the same (project, PR).
4. Insert `review_jobs` row (`pending`), generate a 32-byte callback token, store its sha256.
5. `issueGitCredential(email, 'workspace')` (`lib/git-credentials.ts:41`).
6. `applyWorkspaceSecret(reviewCredSecretName, {token, callback_token, background, llm_url?, llm_token?, llm_model})`; `background` = title + blank line + body, truncated to 16 KB. Seat credentials are **not** copied here; they come from the user's own secret via the projected volume.
7. `createWorkspacePod(buildReviewPodSpec(...))`; row → `running`, `pod_name`, `started_at`.
8. Audit log `review.start`.

### 3.4 Database: `lib/schema.ts` additions, migration `drizzle/0031_review_jobs.sql`

```ts
export const reviewJobStatusEnum = pgEnum('review_job_status',
  ['pending','running','succeeded','partial','failed','timed_out','cancelled']);

export const reviewJobs = pgTable('review_jobs', {
  id: serial('id').primaryKey(),
  projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  requestedBy: text('requested_by').notNull(),
  prNumber: integer('pr_number').notNull(),
  baseRef: text('base_ref').notNull(),
  headSha: text('head_sha').notNull(),
  status: reviewJobStatusEnum('status').notNull().default('pending'),
  podName: text('pod_name'),
  gitCredentialId: integer('git_credential_id').references(() => gitCredentials.id, { onDelete: 'set null' }),
  callbackTokenHash: text('callback_token_hash').notNull(),
  llmSource: text('llm_source').notNull(),            // 'seat:<profile>' | 'api_key'
  llmModel: text('llm_model'),
  ocrStatus: text('ocr_status'),                       // envelope.status
  terminalState: text('terminal_state'),               // envelope.manifest.terminal_state
  filesReviewed: integer('files_reviewed'),
  commentsTotal: integer('comments_total'),
  commentsPosted: integer('comments_posted'),
  inputTokens: integer('input_tokens'), outputTokens: integer('output_tokens'), totalTokens: integer('total_tokens'),
  elapsedMs: integer('elapsed_ms'),
  result: jsonb('result'),                             // full OCR envelope; retention §5
  postSummaryUrl: text('post_summary_url'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => ({
  projectIdx: index('review_jobs_project_idx').on(t.projectId),
  prIdx: index('review_jobs_project_pr_idx').on(t.projectId, t.prNumber),
}));
```

Plus `project_members.can_run_review boolean not null default false` next to `can_promote_prod`, and `projects.review_config jsonb` for `{model, effort, concurrency, tokenBudget, llmOverride?: {url, tokenSecretRef, model}, routeSeverityBelow}`. Generated with `npm run drizzle:generate`; applied by the PreSync migrate Job.

### 3.5 API routes

| Route | Method | Auth | Behaviour |
|---|---|---|---|
| `app/api/projects/[name]/reviews/route.ts` | POST `{prNumber}` | `workspaceGate(params)` + `canRunReview(email, project)` (owner, or collaborator with `can_run_review`); `KEYTO_REVIEWS_ENABLED`; `takeAiLaneToken` | `startReview`; 202 `{jobId}`; 409 when a job is already running for the PR or the credential |
| same | GET | gate | last 20 jobs |
| `app/api/projects/[name]/reviews/[jobId]/route.ts` | GET | gate | row minus `result.comments[].thinking`; `?full=1` for owners |
| same | DELETE | gate + owner | cancel: delete pod, `cancelled`, revoke cred |
| `app/api/internal/reviews/[jobId]/result/route.ts` | POST | `Authorization: Bearer <callback token>`, `timingSafeEqual` on sha256; job must be `running`; body ≤ 8 MB; no session | `completeReview` |
| `app/api/internal/reviews/sweep/route.ts` | POST | Bearer `KEYTO_WORKSPACE_INTERNAL_SECRET`, mirrors `app/api/internal/workspaces/reap/route.ts` | `sweepReviews` |

`completeReview(jobId, cb)`:

1. Validate `cb.result` with a zod schema of the OCR envelope: `status`, `llm`, `summary?`, `comments[]` (`path`, `content`, `start_line`, `end_line`, `existing_code?`, `suggestion_code?`, `category?`, `severity?`), `warnings?`, `manifest?`, `session_id?`, `retry_report?`. Unknown fields kept. If `cb.exit_code !== 0` or `result` null → `failed`; `error` = `message` from the stderr JSON, or `seat_reauth_required` when exit code is 70.
2. Persist summary columns and the envelope.
3. Post-process (§3.7), then post (§3.6). Posting failure does not fail the job; it sets `commentsPosted` and appends to `error`.
4. Status: `succeeded` if `manifest.terminal_state === 'complete'`, `partial` if `partial`, else `failed`. `finished_at`, `elapsed_ms`.
5. **Snapshot the refreshed seat credential**: read `/restore/claude/.credentials.json` from the pod with `execWorkspacePodRead` (small file, well within the 10 s default) and, if it differs from the stored profile blob, write it back with `storeSeatProfileCredentials(email, profile, blob, {})`. This is the same "snapshot on teardown" step workspaces do. Then revoke the git credential (`adminRevokeGitCredential`) and delete the per-job secret. Pod deletion is left to the sweeper so logs stay readable for 10 minutes.

### 3.6 Poster: `lib/review/poster.ts`

Wrap the vendored `lib/review/vendor/post-review-comments.js` (unchanged, Apache-2.0 header kept; its `.test.js` runs under vitest's node environment):

```ts
const octokit = getInstallationOctokit();   // or mintScopedInstallationToken({repo, permissions:{pull_requests:'write'}})
await runPostReviewComments({
  github: octokit,
  context: { repo: { owner: 'hemfrid', repo }, issue: { number: prNumber }, runId: jobId, runAttempt: 1 },
  core: { info: log.info, warning: log.warn, setOutput: capture },
  fs: memfsWith('/tmp/ocr-result.json', JSON.stringify(envelope)),
  resultPath: '/tmp/ocr-result.json', stderrPath: '/tmp/empty',
  stickySummary: true, incremental: true, incrementalOverlapThreshold: 0.6,
  reviewCommentBatchSize: 50,
  routeSeverityBelow: cfg.routeSeverityBelow ?? 'low', routeCategories: '',
});
```

The summary comment shows status, `manifest.coverage` counts, model, tokens, elapsed, requester, and a link to the hub job page. Findings with `start_line === 0` fold into the summary. `incremental: true` means a re-run on the same PR does not repeat comments the bot already posted.

### 3.7 Post-processing seam: `lib/review/postprocess.ts`

`type Stage = (env: OcrEnvelope, ctx) => Promise<OcrEnvelope>`; `run(stages)`. v1 ships `severityFloor` only. The Kodus-derived stages are v1.1 and plug in here without touching pod or poster: `verifierPass` (one seat call judging each finding against its diff hunk, made through the same sidecar as a second `review.sh` step so the token never leaves the pod), `dedupe` (same `path` + normalised `existing_code`), `validateSuggestions` (apply `suggestion_code` in a scratch checkout, annotate the envelope).

### 3.8 Rules

- `rule.json` in the review image = org rules, written in our own words, `merge_system_rule: true` where we only add to OCR's built-in language docs. Changing org rules rebuilds the image; acceptable because OCR already honours `<repo>/.opencodereview/rule.json` as layer 2, so repo-owned rules need no image change.
- v1.1: `projects.review_config.rules` → per-job secret → mounted at `/etc/keyto-review/rule.json`. Later a `review:` block in project.yaml via the 5-step process in `orchestration/project-yaml/README.md:19-25`.

### 3.9 Sweeper: `sweepReviews()`

Selects `keyto.io/review=true`. If the row is `running` and `now - started_at > REVIEW_TIMEOUT_MIN × 3 + 15 min`, or the pod is `Failed`/`Succeeded` with no callback within 10 min → `timed_out`/`failed` with the pod's termination message, snapshot the credential if readable, revoke cred, delete secret. Delete pods whose job is terminal and `finished_at` older than 10 min. Platform CronJob every 10 min → `POST /api/internal/reviews/sweep`, identical to the reap CronJob.

### 3.10 UI

Project page: "Reviews" card listing recent jobs (PR, status, coverage `x/y`, tokens, elapsed, requester, seat profile used, summary link) and a "Review PR #" input enabled by S8. If the user has no `review` profile, the card shows a one-line hint with a link to add one via the existing seat-profile UI. Job page polls every 5 s via `lib/use-live-refresh.ts` while `pending|running`, then shows findings by file with severity and category, coverage from `manifest`, warnings, and the `seat_reauth_required` state with a "Reconnect Claude" link when that is the error.

## 4. Seat flow, precisely

1. The deploy manager has connected a Claude seat in the hub (existing flow: `startClaudeLogin` / `submitClaudeLoginCode` in `orchestration/workspace-claude-auth.ts:70,117`, stored by `storeSeatProfileCredentials`). Recommended: add a second profile named `review` on a second account, so review quota and interactive quota are separate 5-hour windows, which is what profiles were built for.
2. `startReview` selects the profile (`review` → `active`), records it on the row, and projects only that profile's `credentials.json` into the pod. The hub reads nothing inside the blob; the sidecar does.
3. The sidecar refreshes near expiry with Claude Code's public OAuth client and writes the new blob into `/restore/claude`. Refresh-token rotation is therefore contained to one process at a time per profile, enforced by the one-running-job-per-(email, profile) rule and by using a profile no workspace pod is running with.
4. OCR's Anthropic client sends `x-api-key: local` to `http://127.0.0.1:8890`; the Anthropic SDK appends `/v1/messages`. The sidecar replaces auth with the seat bearer, adds the OAuth beta header and the identity system block, and forwards. OCR's `system` is a list of text blocks with `cache_control` on the last (`internal/llm/client.go:1241-1350`), so prepending preserves caching. OCR never sends `context_management`.
5. A 429 from Anthropic is passed through verbatim with `retry-after`; the SDK inside OCR retries up to 5 times and records every attempt in the envelope's `retry_report`. Usage lands on the profile's account. Per-run token totals come from OCR's `summary`.
6. On completion the hub snapshots the refreshed blob back to the profile (§3.5 step 5), exactly as workspace teardown does, so the next review or workspace starts with a live token.
7. Fallback: `projects.review_config.llmOverride` with a Console API key in a platform-lane secret. The pod is built without the sidecar; OCR points at `https://api.anthropic.com` directly; `llm_source='api_key'` so cost reports separate seat from API spend.

Relation to the hub's Phase 2 plan: the sidecar is the per-pod half of "the Hub reads token expiry and drives refresh". When Phase 2 lands hub-side enrollment and a CronJob refresher, the sidecar keeps working unchanged and simply finds a fresher token in the blob; its own refresh becomes the fallback path.

## 5. Security and data handling

- Pod: no ServiceAccount token, non-root, all capabilities dropped, writable only on emptyDirs, fetch-only git token scoped to one repo through the proxy (`contents:read`), no GitHub token. The seat credential is present, as it is in every workspace pod for that user, but only the sidecar reads it, and it is bound to loopback.
- Callback: 32-byte random token, hashed at rest, single use (row must be `running`), body size limit, no session cookie path.
- Stored envelope contains code snippets and model reasoning (`thinking`). Retain `result` 90 days, then null it and keep summary columns. Strip `thinking` from non-owner responses.
- OCR session JSONL (`$HOME/.opencodereview/sessions`) contains reviewed source and full model output; it dies with the pod. Not shipped anywhere in v1.
- PR body is untrusted text reaching the model as `{{requirement_background}}`. Injection can only shape review comments a human reads; tools are git and file reads.
- The sidecar logs status codes and byte counts only, never headers or bodies. Telemetry off by default; if enabled, `OCR_CONTENT_LOGGING` stays unset.
- Doctrine check against `2026-08-11-seat-credential-lifecycle-design.md:91-95`: one user, one seat, injected only into that user's pods; no shared or service seats on this path. A review pod is the requesting deploy manager's pod. Shared-audience use is the API-key lane (S10).

## 6. Configuration

`values.yaml` `envValues.<env>.env`: `KEYTO_REVIEWS_ENABLED`, `KEYTO_REVIEWS_ADMIN_ONLY` (mirrors `KEYTO_WORKSPACES_ADMIN_ONLY`), `KEYTO_REVIEW_IMAGE`, `KEYTO_SEAT_RELAY_IMAGE`, `KEYTO_REVIEW_DEFAULT_MODEL: "claude-sonnet-5"`, `KEYTO_REVIEW_DEFAULT_EFFORT: "medium"`, `KEYTO_REVIEW_DEFAULT_CONCURRENCY: "4"`, `KEYTO_REVIEW_TOKEN_BUDGET: "400000"`, `KEYTO_REVIEW_SEAT_PROFILE: "review"`. Optional secret `KEYTO_REVIEW_API_KEY_FALLBACK` via the platform lane. Reuses `KEYTO_WORKSPACE_INTERNAL_SECRET`, `KEYTO_WORKSPACE_NAMESPACE`, `NEXTAUTH_URL`. All documented in AGENTS.md per the no-undocumented-env-vars rule.

## 7. Tests

- `seat-relay/relay.test.mjs`: refresh triggered near expiry and on 401; 400/401/403 on refresh → `seat_reauth_required`; identity block prepended to string and list `system`, not duplicated; `context_management` stripped; `tools`/`thinking`/`cache_control` untouched; auth headers replaced; `retry-after` passed through; blob written back after refresh; binds loopback only.
- `orchestration/reviews.test.ts`: mock `@/orchestration/platform/k8s-workspace` via `vi.hoisted` as `workspaces.test.ts:13-26` does; assert the same pod-spec invariants plus `activeDeadlineSeconds`, two containers with limits, projected secret narrowed to one profile key, no sidecar when `llmOverride` set, `KEYTO_REVIEW_IMAGE`/`KEYTO_SEAT_RELAY_IMAGE` required. `startReview`: rejects closed/fork PRs; profile selection order; `no_seat`; 409 on concurrent PR or credential; exact secret key set (no seat token inside).
- `app/api/projects/[name]/reviews/route.test.ts`: gate rejects viewer and collaborator without `can_run_review`; owner passes; flag off → 404.
- `app/api/internal/reviews/[jobId]/result/route.test.ts`: wrong token 401, terminal job 409, oversized body 413, valid envelope → status mapping, malformed envelope → `failed`, exit 70 → `seat_reauth_required`.
- `lib/review/poster.test.ts`: fake Octokit records `pulls.createReview` batches; `start_line: 0` folded into summary; `incremental` skips overlaps. Vendored `post-review-comments.test.js` runs as-is.
- `review.sh`: bats with fake `ocr` and a fake sidecar on PATH (OCR's own `action-contract.yml` does this): exit 0, exit 1 with stderr JSON, moved-head refusal, health-wait timeout → 70.
- Manual e2e before enabling: one run on a small UAT PR with a `review` profile; confirm comments, summary, coverage, tokens on the job page; confirm the stored profile blob changed only when a refresh happened.

## 8. Rollout

1. **Prove the relay first, locally.** Run `relay.mjs` on a laptop against a real `~/.claude/.credentials.json`, then `OCR_LLM_URL=http://127.0.0.1:8890 OCR_LLM_TOKEN=local OCR_LLM_PROTOCOL=anthropic OCR_LLM_MODEL=claude-sonnet-5 ocr review` in any repo. One hour; settles the only unverified link.
2. Build and push both images; add env vars to UAT values.
3. Migration `0031`; deploy hub with `KEYTO_REVIEWS_ADMIN_ONLY`.
4. Eval: the 20 historical PRs from `intent.md` through `startReview` against re-created branches, labelled by a human; record precision, tokens, elapsed. Tune `effort`, `concurrency`, `routeSeverityBelow`.
5. Enable for owners; grant `can_run_review` to deploy managers; ask them to add a `review` profile.
6. Watch the `intent.md` control bands for two weeks before considering webhook triggers.

## 9. Out of scope for v1 (tracked)

- Webhook-triggered reviews and fork PRs (needs the sibling agent namespace and NetworkPolicy from `docs/agent-workers-investigation.md`).
- `--resume` across pushes (needs the session JSONL persisted; it contains source).
- Verifier pass, dedup, suggestion validation (§3.7 seam).
- Project-level rules UI and project.yaml `review:` block.
- OpenAI/Codex seats: the hub has no Codex credential store today, and OCR's Responses client is non-streaming while the Codex backend appears to require streaming. Revisit if a Codex profile type is added to seat-profiles.
- Hub-side enrollment and CronJob refresher (lifecycle Phase 2 proper); the sidecar is compatible with it.
- Azure DevOps or GitLab posters. Hosted session viewer.

## 10. Estimate

| Piece | Size |
|---|---|
| `seat-relay/` sidecar + tests + image | 2 days |
| Review image + `review.sh` + bats | 1 day |
| `orchestration/reviews.ts` + schema + migration + tests | 2 days |
| Routes (4) + gate flag + tests | 1 day |
| Poster wrapper around vendored script + tests | 1 day |
| Sweeper + CronJob wiring | 0.5 day |
| UI card + job page + profile hint | 1.5 days |
| UAT e2e + eval run on 20 PRs | 2 days |

About eleven working days for one engineer, all inside keyto-hub. Nothing is owed by keyto-aios.
