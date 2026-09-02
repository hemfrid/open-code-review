---
title: PR code review on keyto-hub via open-code-review and seat-proxy (direct relay)
status: draft for review
date: 2026-09-03
author: OCR agent, for Sean
implements: intent.md (P1–P10, D1–D6)
template: keyto-aios/docs/superpowers/specs/2026-08-18-pod-rides-os-seat-design.md
target_repos:
  - keyto-hub (this file should move to keyto-hub/docs/superpowers/specs/)
  - keyto-aios (facet action + label parameter, §4.1)
depends_on:
  - keyto-aios: SEAT_PROXY_CLUSTER_URL set (rollout step 4)
  - keyto-talos-k8s: nothing for v1; project.yaml schema change deferred to v1.1
---

# PR code review on keyto-hub, direct relay build

Every claim below that names a file or function was read from the code on
2026-09-03. Line numbers are approximate and will drift.

## 1. Summary

The design is the "build pods ride the OS seat" pattern applied to a review
pod. A deploy manager asks the OS to review a PR. The OS mints a per-project
review leash off the deploy manager's seat and calls the hub, exactly as it
does today for `ensure_workspace`. The hub creates a one-shot pod in
`keyto-workspaces` that clones the repo through the hub git proxy with full
history, fetches the PR head and base, runs the stock `ocr review` binary
against seat-proxy over the Anthropic protocol, and posts the result JSON back
to the hub over an authenticated callback. The hub stores the run, posts
inline comments and a sticky summary to the PR as the bot GitHub App, and
shows status, coverage and token usage. No fork of OCR. No webhook automation
in v1.

```
deploy manager (in the OS) ── "review PR 42 on <project>" ──▶ aios facet run_review
   aios: mintPodSeat(project, 'review:<project>') → {baseUrl, token}
         → hub MCP tool run_review {project, pr_number, anthropic_base_url, anthropic_token}
   hub:  gate → PR metadata via App Octokit → review_jobs row (pending)
         → rv-cred secret (git token, llm url/token/model, callback token, background.md)
         → review pod (image: git + ocr)
   pod:  git clone (full) via /git/hemfrid/{project}.git → fetch base + refs/pull/N/head
         ocr review --from origin/{base} --to origin/pr-N --format json --audience agent
                    --rule /etc/keyto-review/rule.json --background-file … --output /work/result.json
         POST {hub}/api/internal/reviews/{jobId}/result  (Bearer callback token, body = result.json)
   hub:  validate → store envelope → post-process (v1: severity routing only)
         → poster: inline comments + sticky summary as bot App → row = succeeded|partial|failed
   sweeper (CronJob → internal route, every 10 min): time out stuck jobs, delete finished pods, revoke creds
   UI:   hub project page polls GET /api/projects/{name}/reviews/{jobId}; OS chat gets the summary back
```

## 2. Decisions and their reasons

| # | Decision | Reason |
|---|----------|--------|
| S1 | One-shot pod with **callback**, not exec | `execWorkspacePodRun` defaults to a 10 s timeout and buffers stdout unbounded in memory (`orchestration/platform/k8s-workspace.ts:10,248`). A review runs 1–5 min and its JSON can be hundreds of KB. Holding a WebSocket exec inside a Next.js request for minutes is fragile. The house pattern is "DB row + pull-based polling" and "CronJob, not in-pod timer" (`.claude/skills/keyto-hub-provisioning-campaign/SKILL.md:133`). The pod already reaches the hub origin for the git clone, so a callback adds no new network path. |
| S2 | New pod builder `buildReviewPodSpec`, not a `buildWorkspacePodSpec` option | `buildWorkspacePodSpec` has no image or command parameter (`orchestration/workspaces.ts:224-234`); the only variant precedent is `buildSeatPodSpec` (`:467`). A review pod is a sibling builder that reuses the same security posture, labels and secret conventions. |
| S3 | **Leash minted by the OS and delivered on the call, aios as template** | The hub cannot mint: seat-proxy control-plane endpoints are loopback-only inside the aios pod (`seat-proxy/src/seatproxy/app.py:103-118`). The existing flow already solves this for workspaces: `overseer.ts:1934-1968` `mintPodSeatForChat` POSTs `/siblings` with `{handle, label:'pod:<project>'}` and the facet passes `{baseUrl, token}` into the hub's `ensure_workspace` MCP tool (`workspace-actions.ts:126-128`; hub side `app/api/mcp/route.ts:350-375`, `lib/mcp-workspace-tools.ts:66-93`). A review is the same shape with label `review:<project>`, so review and workspace leashes rotate independently. Secondary path for a hub-UI button: reuse the stored `relay-env` (§4.3). |
| S4 | Full clone, not shallow | Range mode reviews `merge-base(base, head)..head`; OCR documents "Cannot find merge-base" for shallow clones (`pages/src/content/docs/en/integrations/ci.md:294`). The workspace init clones default branch only (`workspaces.ts:155`); the review init adds `--no-single-branch` and a PR-ref fetch. |
| S5 | Per-job credentials in a per-job secret | Mirrors `ws-cred-<project>-<userhash>` (`workspaces.ts:117-119`), keeps tokens out of the pod spec (`secretKeyRef` only, as `workspaces.test.ts` "never embeds the git token" asserts). Git credential kind `workspace`, 7-day TTL (`lib/git-credentials.ts:10`), revoked on completion. |
| S6 | Poster runs in the hub, not in the pod | The pod holds a fetch-only git token and no GitHub token. The hub already has `getInstallationOctokit()` and `mintScopedInstallationToken({repo, permissions})` (`orchestration/platform/github-app.ts:55-80,139-145`) and already requests `pull_requests:write` for push tokens (`orchestration/git-proxy.ts:161-164`). |
| S7 | Vendor OCR's GitHub poster for v1 | `scripts/github-actions/post-review-comments.js` (Apache-2.0) exports `runPostReviewComments({github, context, core, fs, resultPath, …})` and only needs an Octokit plus `{repo:{owner,repo}, issue:{number}, runId, runAttempt}`. It already handles batching (50), the 422 hunk fallback, sticky summary, incremental IoU de-dup and severity/category routing. A TS rewrite is v1.1 once behaviour is understood. |
| S8 | Authorisation = owner, or collaborator with a new `can_run_review` flag | No "deploy manager" role exists; roles are `owner|collaborator|viewer` (`lib/schema.ts:43-47`). `project_members.can_promote_prod` is the precedent for a per-member capability boolean (`lib/schema.ts:330-333`, `canPromote()` in `lib/project-membership.ts:193-213`). The same check applies whether the call arrives via the OS facet (bound to the caller's email, as `ensure_workspace` is) or the hub UI. |
| S9 | Pod lives in `keyto-workspaces` for v1 | NetworkPolicy is greenfield cluster-wide (`docs/agent-workers-investigation.md:335-341`), so any namespace reaches `keyto-aios-seat-proxy:8890` today. OCR does not execute PR code, only `git` and file reads, so the untrusted-worker sibling namespace (`:149-166`) is deferred until webhook-triggered fork PRs are in scope. |
| S10 | Console API key is a config swap, not a code path | OCR reads `OCR_LLM_URL`/`OCR_LLM_TOKEN`/`OCR_LLM_PROTOCOL` identically for both. `projects.review_config.llmOverride` (url, token secret ref, model) replaces the leash when set. |

## 3. Components

### 3.1 Review image

`Dockerfile`:

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

Pin `OCR_REF` to a tag (git ≥ 2.41 is a hard OCR requirement; alpine 3.20 ships 2.45). Push to ACR; reference via `KEYTO_REVIEW_IMAGE` in `values.yaml` under `keyto-catalog.services.backend.envValues.<env>.env`, full-SHA tag like `KEYTO_WORKSPACE_AGENT_IMAGE` (`values.yaml:135`).

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
```

OCR writes exactly one JSON document to `--output`; on fatal error it writes a second JSON document to **stderr**, so `stderr.log` is kept. `--background-file` avoids shell-interpolating PR text, the same concern OCR's own CI doc raises.

Environment the pod receives (via `secretKeyRef` from the per-job secret, except constants): `GIT_TOKEN`, `HUB_GIT_BASE`, `PROJECT`, `PR_NUMBER`, `BASE_REF`, `HEAD_SHA`, `REVIEW_BACKGROUND`, `OCR_LLM_URL`, `OCR_LLM_TOKEN`, `OCR_LLM_MODEL`, `OCR_LLM_PROTOCOL=anthropic`, `OCR_LLM_TIMEOUT=300`, `HUB_CALLBACK_URL`, `CALLBACK_TOKEN`, `REVIEW_CONCURRENCY`, `REVIEW_EFFORT`, `REVIEW_TIMEOUT_MIN`, `REVIEW_TOKEN_BUDGET`, optional `OCR_ENABLE_TELEMETRY` + `OTEL_EXPORTER_OTLP_ENDPOINT`.

### 3.2 Pod builder: `orchestration/reviews.ts` (new, hub)

```ts
export type ReviewSeat = { baseUrl: string; token: string };
export type ReviewPodOpts = {
  project: string; email: string; jobId: number; credentialId: number;
  prNumber: number; baseRef: string; headSha: string;
};
export function reviewPodName(project: string, jobId: number): string   // rv-<project≤30>-<jobId>
export function reviewCredSecretName(project: string, jobId: number)    // rv-cred-<project≤30>-<jobId>
export function buildReviewPodSpec(o: ReviewPodOpts): object
export async function startReview(project: Project, email: string, prNumber: number,
                                  seat: ReviewSeat | null): Promise<ReviewJob>
export async function completeReview(jobId: number, cb: ReviewCallback): Promise<void>
export async function sweepReviews(): Promise<{ timedOut: number[]; cleaned: number[] }>
```

`buildReviewPodSpec` copies the invariants `workspaces.test.ts` asserts: `automountServiceAccountToken:false`, `restartPolicy:'Never'`, `runAsNonRoot` uid/gid/fsGroup 1001, seccomp `RuntimeDefault`, per-container `allowPrivilegeEscalation:false` + `drop:['ALL']`, `imagePullSecrets:[{name:'acr-pull'}]`, requests and limits on every container (review: requests `500m/1Gi`, limits `2/3Gi`), volumes `home` emptyDir 4Gi and `work` emptyDir 512Mi. Single container `review` using `KEYTO_REVIEW_IMAGE`. `activeDeadlineSeconds = (REVIEW_TIMEOUT_MIN × 3 + 10) × 60`.

Labels: `keyto.io/review: "true"`, `keyto.io/project`, `keyto.io/user-hash`, `keyto.io/review-job`. Annotations: `keyto.io/user-email`, `keyto.io/git-credential-id`. The workspace reaper selects `keyto.io/workspace=true` (`k8s-workspace.ts:70`) and ignores review pods; the review sweeper selects `keyto.io/review=true`.

`startReview(project, email, prNumber, seat)`:

1. `getInstallationOctokit().pulls.get(...)` → `base.ref`, `head.sha`, `head.repo.full_name`, `title`, `body`, `state`. Reject closed PRs and, in v1, fork PRs (head repo ≠ project repo; see S9).
2. Resolve LLM, in order: `seat` argument (facet path) → `projects.review_config.llmOverride` → stored `relay-env` (hub-UI path, §4.3) → fail with `error='no_seat'`. Model from `review_config.model`, default `KEYTO_REVIEW_DEFAULT_MODEL`.
3. Insert `review_jobs` row (`pending`), generate a 32-byte callback token, store its sha256.
4. `issueGitCredential(email, 'workspace')` (`lib/git-credentials.ts:41`).
5. `applyWorkspaceSecret(reviewCredSecretName, {token, llm_url, llm_token, llm_model, callback_token, background})`; `background` = title + blank line + body, truncated to 16 KB.
6. `createWorkspacePod(buildReviewPodSpec(...))`; row → `running`, `pod_name`, `started_at`.
7. Audit log `review.start`.

### 3.3 Database: `lib/schema.ts` additions, migration `drizzle/0031_review_jobs.sql`

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
  llmSource: text('llm_source').notNull(),            // 'facet_seat' | 'relay_env' | 'api_key'
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

### 3.4 Entry points and routes

| Entry | Auth | Behaviour |
|---|---|---|
| **MCP tool `run_review`** in `app/api/mcp/route.ts`, args `{project, pr_number, anthropic_base_url, anthropic_token}` | same binding as `ensure_workspace` (gate email from the MCP session), then `canRunReview` | one running job per (project, pr) → error; else `startReview(..., seat)`; returns `{jobId, statusUrl}`; on completion the OS can poll the status tool `get_review` |
| **MCP tool `get_review`** `{project, job_id}` | gate | job summary (status, coverage, counts, summary comment URL, top findings) so the OS chat can relay it |
| `app/api/projects/[name]/reviews/route.ts` POST `{prNumber}` | `workspaceGate(params)` + `canRunReview`; `KEYTO_REVIEWS_ENABLED`; `takeAiLaneToken` | hub-UI path: `startReview(..., null)` → uses `relay-env`; 202 `{jobId}` |
| same GET | gate | last 20 jobs |
| `app/api/projects/[name]/reviews/[jobId]/route.ts` GET | gate | row minus `result.comments[].thinking`; `?full=1` for owners |
| same DELETE | gate + owner | cancel: delete pod, `cancelled`, revoke cred |
| `app/api/internal/reviews/[jobId]/result/route.ts` POST | `Authorization: Bearer <callback token>`, `timingSafeEqual` on sha256; job must be `running`; body ≤ 8 MB; no session | `completeReview` |
| `app/api/internal/reviews/sweep/route.ts` POST | Bearer `KEYTO_WORKSPACE_INTERNAL_SECRET`, mirrors `app/api/internal/workspaces/reap/route.ts` | `sweepReviews` |

`completeReview(jobId, cb)`:

1. Validate `cb.result` with a zod schema of the OCR envelope: `status`, `llm`, `summary?`, `comments[]` (`path`, `content`, `start_line`, `end_line`, `existing_code?`, `suggestion_code?`, `category?`, `severity?`), `warnings?`, `manifest?`, `session_id?`, `retry_report?`. Unknown fields kept. If `cb.exit_code !== 0` or `result` null → `failed`, `error` = `message` from the stderr JSON or the stderr head.
2. Persist summary columns and the envelope.
3. Post-process (§3.6), then post (§3.5). Posting failure does not fail the job; it sets `commentsPosted` and appends to `error`.
4. Status: `succeeded` if `manifest.terminal_state === 'complete'`, `partial` if `partial`, else `failed`. `finished_at`, `elapsed_ms`.
5. Revoke the git credential (`adminRevokeGitCredential`), delete the per-job secret. Pod deletion is left to the sweeper so logs stay readable for 10 minutes.

### 3.5 Poster: `lib/review/poster.ts`

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

### 3.6 Post-processing seam: `lib/review/postprocess.ts`

`type Stage = (env: OcrEnvelope, ctx) => Promise<OcrEnvelope>`; `run(stages)`. v1 ships `severityFloor` only. The Kodus-derived stages are v1.1 and plug in here without touching pod or poster: `verifierPass` (one seat call judging each finding against its diff hunk), `dedupe` (same `path` + normalised `existing_code`), `validateSuggestions` (apply `suggestion_code` in a scratch checkout; runs as a second `review.sh` step that annotates the envelope).

### 3.7 Rules

- `rule.json` in the image = org rules, written in our own words, `merge_system_rule: true` where we only add to OCR's built-in language docs. Changing org rules rebuilds the image; acceptable because OCR already honours `<repo>/.opencodereview/rule.json` as layer 2, so repo-owned rules need no image change.
- v1.1: `projects.review_config.rules` → per-job secret → mounted at `/etc/keyto-review/rule.json`. Later a `review:` block in project.yaml via the 5-step process in `orchestration/project-yaml/README.md:19-25`.

### 3.8 Sweeper: `sweepReviews()`

Selects `keyto.io/review=true`. If the row is `running` and `now - started_at > REVIEW_TIMEOUT_MIN × 3 + 15 min`, or the pod is `Failed`/`Succeeded` with no callback within 10 min → `timed_out`/`failed` with the pod's termination message, revoke cred, delete secret. Delete pods whose job is terminal and `finished_at` older than 10 min. Platform CronJob every 10 min → `POST /api/internal/reviews/sweep`, identical to the reap CronJob.

### 3.9 UI

Hub project page: "Reviews" card listing recent jobs (PR, status, coverage `x/y`, tokens, elapsed, requester, summary link) and a "Review PR #" input enabled by S8. Job page polls every 5 s via `lib/use-live-refresh.ts` while `pending|running`, then shows findings by file with severity and category, coverage from `manifest`, warnings. In the OS, the facet returns the `get_review` summary into the chat when the job finishes (the OS agent polls, as it does for workspace readiness).

## 4. Seat and credential flow

### 4.1 aios side (template: `mintPodSeatForChat`)

- `overseer.ts:1934-1968` `mintPodSeatForChat(config, project)` → generalise to `mintPodSeat(config, project, label = \`pod:${project}\`)`; the facet's `run_review` passes `review:${project}`. Body to seat-proxy stays `POST ${SEAT_PROXY_URL}/siblings {handle: config.apiToken, label}` (`overseer.ts:1948-1953`), response `{handle, seat_id, label, rotated}` (`app.py:650-651`); return `{baseUrl: \`${SEAT_PROXY_CLUSTER_URL}/anthropic\`, token: handle}` (`overseer.ts:1963`).
- `packages/gatekeeper-keytohub`: new action `run_review(project, prNumber)` beside `ensure_workspace` in `workspace-actions.ts:126-128`, on the **confirmed** path only, calling the hub MCP tool with `{project, pr_number, anthropic_base_url, anthropic_token}`. A `get_review(project, jobId)` action for status.
- Same guard as today: the model must be seat-backed Anthropic whose `apiUrl === ${SEAT_PROXY_URL}/anthropic` (`overseer.ts:1943-1947`); otherwise the action tells the user to attach a seat.
- One label = one live leash: minting `review:<project>` again revokes the previous review leash for that seat (`store.py:243-253`), which is the intended lifetime. Running reviews on the same project by the same deploy manager therefore serialise; the hub's one-job-per-PR rule plus a one-job-per-(project, user) rule enforce that.

### 4.2 Hub side

1. `run_review` arrives with `anthropic_base_url` + `anthropic_token`; `startReview` writes them straight into the job secret as `OCR_LLM_URL` / `OCR_LLM_TOKEN` (`llm_source='facet_seat'`). The hub never calls seat-proxy and never sees a real OAuth token.
2. OCR's Anthropic client sends the handle as `x-api-key`; the relay accepts that (`relay.py:124-133`). The Anthropic SDK appends `/v1/messages` to the base URL, so `/anthropic` → `/anthropic/v1/messages` → `https://api.anthropic.com/v1/messages`.
3. The relay prepends the Claude Code identity block to OCR's `system` list and strips `context_management`; OCR sends neither, and its `cache_control` on the last system block survives (`relay.py:30-62`; OCR `internal/llm/client.go:1241-1350`).
4. Usage counts on the presented handle (`relay.py:226-232`) and lands on the deploy manager's active seat (`relay.py:159-166`). `GET /enroll/{provider}/seats/{id}/handles` lists `review:<project>` with `requests` and `last_used` for accounting, in the OS. A 429 passes through with `retry-after`; the SDK inside OCR retries up to 5 times and records every attempt in the envelope's `retry_report`.
5. On completion the hub deletes the job secret. The leash itself is revoked by the next mint or by the deploy manager in the OS; a leaked handle is worth only "call the relay as this seat", the same class as today's `pod:` leash.

### 4.3 Secondary path: hub-UI button

The UI route has no seat argument, so `startReview` falls back to the stored `relay-env` (`claude-creds-<userhash>`, key `relay-env`, JSON `{baseUrl, token}` written by `storeRelayEnv`, `orchestration/seat-profiles.ts:231-243`), `llm_source='relay_env'`. Caveat: that leash is labelled `pod:<project>` and rotates on every `workspaceEnsure`, so a workspace reopen during a review 401s the run with "Your subscription seat needs to be reconnected." The UI explains that string and offers "run from the OS instead". Requires `SEAT_PROXY_CLUSTER_URL` to be set in aios, otherwise `relay-env` never exists (`overseer.ts:1936`).

### 4.4 Fallback: Console API key

`projects.review_config.llmOverride` with a key held in a platform-lane secret sets `OCR_LLM_URL=https://api.anthropic.com`, `OCR_LLM_TOKEN=<key>`, `llm_source='api_key'`, so cost reports separate seat from API spend. No other change.

## 5. Security and data handling

- Pod: no ServiceAccount token, non-root, all capabilities dropped, writable only on two emptyDirs, fetch-only git token scoped to one repo through the proxy (`contents:read`), no GitHub token, no seat OAuth token (only a handle). Compromise class equals today's workspace pod minus terminal access.
- Callback: 32-byte random token, hashed at rest, single use (row must be `running`), body size limit, no session cookie path.
- Stored envelope contains code snippets and model reasoning (`thinking`). Retain `result` 90 days, then null it and keep summary columns. Strip `thinking` from non-owner responses.
- OCR session JSONL (`$HOME/.opencodereview/sessions`) contains reviewed source and full model output; it dies with the pod. Not shipped anywhere in v1.
- PR body is untrusted text reaching the model as `{{requirement_background}}`. Injection can only shape review comments a human reads; tools are git and file reads. Same exposure as OCR's own GitHub Action.
- Telemetry off by default; if enabled, `OCR_CONTENT_LOGGING` stays unset.

## 6. Configuration

`values.yaml` `envValues.<env>.env`: `KEYTO_REVIEWS_ENABLED`, `KEYTO_REVIEWS_ADMIN_ONLY` (mirrors `KEYTO_WORKSPACES_ADMIN_ONLY`), `KEYTO_REVIEW_IMAGE`, `KEYTO_REVIEW_DEFAULT_MODEL: "claude-sonnet-5"`, `KEYTO_REVIEW_DEFAULT_EFFORT: "medium"`, `KEYTO_REVIEW_DEFAULT_CONCURRENCY: "4"`, `KEYTO_REVIEW_TOKEN_BUDGET: "400000"`. Optional secret `KEYTO_REVIEW_API_KEY_FALLBACK` via the platform lane. Reuses `KEYTO_WORKSPACE_INTERNAL_SECRET`, `KEYTO_WORKSPACE_NAMESPACE`, `NEXTAUTH_URL`. aios: `SEAT_PROXY_CLUSTER_URL` set.

## 7. Tests

- `orchestration/reviews.test.ts`: mock `@/orchestration/platform/k8s-workspace` via `vi.hoisted` as `workspaces.test.ts:13-26` does; assert the same pod-spec invariants plus `activeDeadlineSeconds`, single container, `KEYTO_REVIEW_IMAGE` required. `startReview`: rejects closed/fork PRs; LLM resolution order (seat arg → override → relay-env → `no_seat`); 409 on concurrent job; exact secret key set.
- `app/api/mcp/route.test.ts`: `run_review` binds to the session email, rejects a viewer, passes seat through untouched, never logs the token.
- `app/api/projects/[name]/reviews/route.test.ts`: gate rejects viewer and collaborator without `can_run_review`; owner passes; flag off → 404.
- `app/api/internal/reviews/[jobId]/result/route.test.ts`: wrong token 401, terminal job 409, oversized body 413, valid envelope → status mapping, malformed envelope → `failed`.
- `lib/review/poster.test.ts`: fake Octokit records `pulls.createReview` batches; `start_line: 0` folded into summary; `incremental` skips overlaps. Vendored `post-review-comments.test.js` runs as-is.
- `review.sh`: bats with a fake `ocr` on PATH (OCR's own `action-contract.yml` does this): exit 0, exit 1 with stderr JSON, moved-head refusal.
- aios: `workspace-actions.test.ts` gains `run_review` cases mirroring `:300-312`; `overseer` test for the label parameter and rotation.
- Manual e2e before enabling: one seat-backed run from the OS on a small UAT PR; confirm comments, summary, coverage, tokens on the hub job page, and `review:<project>` listed with `requests > 0` on the seat's handle listing.

## 8. Rollout

1. aios: set `SEAT_PROXY_CLUSTER_URL` in UAT; ship `mintPodSeat` label parameter and the `run_review` / `get_review` facet actions.
2. Build and push the review image; add env vars to UAT values.
3. Migration `0031`; deploy hub with `KEYTO_REVIEWS_ADMIN_ONLY`.
4. Eval: the 20 historical PRs from `intent.md` through `startReview` against re-created branches, labelled by a human; record precision, tokens, elapsed. Tune `effort`, `concurrency`, `routeSeverityBelow`.
5. Enable for owners; grant `can_run_review` to deploy managers.
6. Watch the `intent.md` control bands for two weeks before considering webhook triggers.

## 9. Out of scope for v1 (tracked)

- Webhook-triggered reviews and fork PRs (needs the sibling agent namespace and NetworkPolicy from `docs/agent-workers-investigation.md`).
- `--resume` across pushes (needs the session JSONL persisted; it contains source).
- Verifier pass, dedup, suggestion validation (§3.6 seam).
- Project-level rules UI and project.yaml `review:` block.
- Codex seats (`OCR_LLM_PROTOCOL=openai-responses` against `/openai`; OCR's Responses client is non-streaming and the Codex backend may require streaming; one live test decides).
- Azure DevOps or GitLab posters. Hosted session viewer.

## 10. Estimate

| Piece | Size |
|---|---|
| aios: label param + `run_review`/`get_review` facet actions + tests | 1 day |
| Review image + `review.sh` + bats | 1 day |
| `orchestration/reviews.ts` + schema + migration + tests | 2 days |
| Hub MCP tools + routes (4) + gate flag + tests | 1.5 days |
| Poster wrapper around vendored script + tests | 1 day |
| Sweeper + CronJob wiring | 0.5 day |
| UI card + job page | 1.5 days |
| UAT e2e + eval run on 20 PRs | 2 days |

About ten and a half working days for one engineer across the two repos, excluding the `SEAT_PROXY_CLUSTER_URL` rollout, which is a config change owned in aios.
