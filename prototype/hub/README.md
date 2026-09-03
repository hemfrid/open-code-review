# prototype/hub — drop-in Phase 1 code for keyto-hub

Written against keyto-hub as read on 2026-09-04. These files were NOT typechecked
(they import hub modules that only exist in that repo). Copy them in, run
`npx tsc --noEmit` and `npm test`, and expect small fixes where a hub signature
has moved. Spec: `../../spec-hub-direct-relay-review.md` Part I.

## Drop-in map

| Prototype path | Hub path | Action |
|---|---|---|
| `lib/schema.review.ts` | `lib/schema.ts` | paste the enum + table; add `canRunReview` next to `canPromoteProd` (`:331`) and `reviewConfig: jsonb('review_config')` on `projects` |
| `drizzle/0031_review_jobs.sql` | `drizzle/0031_*.sql` | regenerate with `npm run drizzle:generate` and diff against this expected output; keep the generated `meta/` |
| `lib/review-membership.ts` | same | new |
| `orchestration/reviews.ts` | same | new |
| `app/api/projects/[name]/reviews/route.ts` | same | new |
| `app/api/projects/[name]/reviews/[jobId]/route.ts` | same | new |
| `app/api/internal/reviews/[jobId]/result/route.ts` | same | new |
| `app/api/internal/reviews/sweep/route.ts` | same | new |
| `../seat-relay/relay.mjs` | `seat-relay/relay.mjs` + Dockerfile | new image `KEYTO_SEAT_RELAY_IMAGE`, built like `workspace-agent/` |
| (spec §3.1) | `review-image/` (Dockerfile, `review.sh`, `rule.json`) | new image `KEYTO_REVIEW_IMAGE` |

Pure modules the orchestrator imports and that must exist (another lane owns them):

- `@/lib/review/envelope`: `parseEnvelope(value: unknown): OcrEnvelope` (zod; throws on shape errors, keeps unknown fields) and `type OcrEnvelope = { status: string; llm?: {provider?: string; model: string}; summary?: {files_reviewed?: number; comments?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number; elapsed?: string}; comments: Array<{path: string; content: string; start_line: number; end_line: number; existing_code?: string; suggestion_code?: string; category?: string; severity?: string; thinking?: string}>; warnings?: unknown[]; manifest?: {terminal_state?: 'complete'|'partial'|'failed'|'skipped'; coverage?: unknown}; session_id?: string; retry_report?: unknown }`.
- `@/lib/review/postprocess`: `runStages(env, ctx: {projectName, prNumber, jobId}, stages: Stage[])`; `severityFloor(floor)` exists but v1 passes an empty stage list because the vendored poster does its own severity routing and does not render `routed_to_summary` (spec §3.7; wire stages in with the TS poster in v1.1).
- `@/lib/review/poster`: `postReview({octokit, owner, repo, prNumber, jobId, envelope, stderr?, jobUrl?, routeSeverityBelow?, incremental?, ...}): Promise<{total, inline, skipped, routed, failed, summaryUrl, batches, outputs}>` wrapping the vendored `scripts/github-actions/post-review-comments.js` from open-code-review (Apache-2.0); the caller passes `getInstallationOctokit()`. `jobId` becomes the idempotency run tag in comment bodies, so a retry must reuse the job id. Pacing knobs are read from `process.env` (`OCR_READ_SUCCESS_DELAY`, `OCR_MAX_RETRIES`, `OCR_SUCCESS_DELAY`, `OCR_FAILURE_DELAY`, `OCR_LOW_REMAINING_*`); set them deliberately in values.yaml.
- Both modules and `@/lib/review/envelope` are implemented in `prototype/hub/lib/review/` with tests (`node --experimental-strip-types --test prototype/hub/lib/review/*.test.ts prototype/hub/lib/review/poster.test.mjs`). They import each other with explicit `.ts` extensions for Node's type stripping; drop the extensions when moving into the hub's bundler-resolved tree.

## Hub helpers relied on (verified by reading)

- `orchestration/platform/k8s-workspace.ts`: `createWorkspacePod` (:47), `getWorkspacePod` (:57), `listWorkspacePods` (:67, selector is `keyto.io/workspace=true`, so review pods are invisible to the workspace reaper), `deleteWorkspacePod` (:80), `applyWorkspaceSecret` (:94, SSA, prunes unlisted keys), `getWorkspaceSecretData` (:138), `deleteWorkspaceSecret` (:155), `execWorkspacePodRead` (:267, default container `term` — see invented helpers).
- `orchestration/platform/k8s.ts`: `k8sRequest` (used for the review-pod label selector list).
- `orchestration/workspaces.ts`: `userHash` (:99), `claudeCredsSecretName` (:113), pod hardening copied from `buildWorkspacePodSpec` (:341-439), snapshot pattern from `snapshotClaudeCreds` (:734).
- `orchestration/seat-profiles.ts`: key layout `active` / `<profile>.credentials.json` / `.credentials.json` mirror (:7-11), `storeSeatProfileCredentials` (:186).
- `lib/git-credentials.ts`: `issueGitCredential(email, 'workspace')` (:41, 7-day TTL), `adminRevokeGitCredential(id)` (:308).
- `orchestration/platform/github-app.ts`: `getInstallationOctokit()` (:55).
- `lib/projects.ts`: `getProjectByName` (:237), `resolveRepo(name, githubRepo)` (:44).
- `lib/project-membership.ts`: `isSuperadmin`, `getProjectRole`, `canPromote` pattern (:193).
- `app/api/projects/[name]/workspace/gate.ts`: `workspaceGate` (:17) — reused as the session → project → membership gate; reviews add `canRunReview` on top.
- `app/api/internal/workspaces/reap/route.ts`: template for the sweep route.
- `lib/rate-limit.ts` `takeToken`, `lib/ai-lane-rate-limit.ts` `takeAiLaneToken`.
- `lib/schema.ts`: `auditLog` insert shape (`lib/admin.ts:118` precedent).

## Helpers invented here (flag for review)

- `pickSeatProfile(data, preferred)` in `orchestration/reviews.ts`: seat-profiles.ts keeps `profileNames`/`activeName` private, so the selection is re-implemented against the documented key layout. Consider exporting the originals instead.
- `listReviewPods()` in `orchestration/reviews.ts`: `listWorkspacePods` hardcodes the workspace selector; this issues the same request with `keyto.io/review=true`. Consider adding a `labelSelector` parameter to `listWorkspacePods` instead.
- `execWorkspacePodRead` defaults to container `term`; a review pod has `seat-relay` + `review`. `snapshotSeatCredential` reads `/run/keyto-seat/.credentials.json`, which is mounted in **both** containers only if you also mount the `seat` volume into `review` — the spec does not; the simplest fix is to extend `execWorkspacePodRead` with an `opts.container` passthrough (`execWorkspacePodRun` already accepts it) and call it with `'seat-relay'`. **Do this before the snapshot works.**
- `readOverrideToken(ref)`: `llmOverride.tokenSecretRef = "<secret>/<key>"` read from the workspace namespace via `getWorkspaceSecretData`. Platform-lane secrets live elsewhere (ESO into the backend namespace); if the API-key fallback is wanted in v1, decide where that secret lands.
- `reviewsEnabled()` / `reviewsAdminOnly()` in `lib/review-membership.ts`: mirror `orchestration/workspace-flags.ts`; move them there if preferred.

## Env vars to add

`values.yaml` → `keyto-catalog.services.backend.envValues.<env>.env` (uat block from `:34`, prod from `:90`), documented in `AGENTS.md` per the no-undocumented-env-vars rule:

```
KEYTO_REVIEWS_ENABLED: "true"
KEYTO_REVIEWS_ADMIN_ONLY: "true"            # first exposure, like KEYTO_WORKSPACES_ADMIN_ONLY
KEYTO_REVIEW_IMAGE: "<acr>/keyto-review@sha256:…"
KEYTO_SEAT_RELAY_IMAGE: "<acr>/keyto-seat-relay@sha256:…"
KEYTO_REVIEW_DEFAULT_MODEL: "claude-sonnet-5"
KEYTO_REVIEW_DEFAULT_EFFORT: "medium"
KEYTO_REVIEW_DEFAULT_CONCURRENCY: "4"
KEYTO_REVIEW_TOKEN_BUDGET: "400000"
KEYTO_REVIEW_TIMEOUT_MIN: "15"
KEYTO_REVIEW_SEAT_PROFILE: "review"
```

Reused: `KEYTO_WORKSPACE_INTERNAL_SECRET` (sweep bearer), `KEYTO_WORKSPACE_NAMESPACE`, `NEXTAUTH_URL` (callback + git base), `KEYTO_HUB_BOT_*` (Octokit). No new secrets in v1 unless `llmOverride` is used.

## Platform: CronJob for the sweeper

Clone the reap CronJob in keyto-talos-k8s (every 10 min, `POST https://<hub>/api/internal/reviews/sweep`, `Authorization: Bearer $KEYTO_WORKSPACE_INTERNAL_SECRET`). Same image, same secret, different path.

## Review pod: what `review.sh` must honour

`REVIEW_SIDECAR=1` → wait for `http://127.0.0.1:8890/healthz` (exit 70 after 60 s → `seat_reauth_required` on the row); `REVIEW_SIDECAR=0` → skip the wait and call `OCR_LLM_URL` directly. On exit, `POST $HUB_CALLBACK_URL` with `{exit_code, stderr, result}` and then `POST http://127.0.0.1:8890/shutdown` with `x-api-key: $OCR_LLM_TOKEN` (the relay's `RELAY_LOCAL_TOKEN` is the same secret key) so the pod reaches `Succeeded`.

## Tests to write (vitest, co-located, spec §7)

- `orchestration/reviews.test.ts` — mock `@/orchestration/platform/k8s-workspace`, `@/orchestration/platform/k8s`, `@/lib/db`, `@/lib/git-credentials`, `@/orchestration/platform/github-app` via `vi.hoisted` + `vi.mock` as `orchestration/workspaces.test.ts:13-26` does. Assert on `buildReviewPodSpec`: `automountServiceAccountToken === false`; `restartPolicy === 'Never'`; `activeDeadlineSeconds === reviewDeadlineSeconds(timeoutMin)`; every container and init container declares cpu+memory requests AND limits; pod securityContext runAsNonRoot/1001/RuntimeDefault; every container `allowPrivilegeEscalation:false` + `drop:['ALL']`; labels `keyto.io/review`, `keyto.io/project`, `keyto.io/user-hash`, `keyto.io/review-job`; annotations `user-email` + `git-credential-id`; **no env has a literal `value` for GIT_TOKEN / CALLBACK_TOKEN / OCR_LLM_TOKEN** (all `secretKeyRef`); `claude-creds` volume projects exactly one key `<profile>.credentials.json`; with `seatProfile: null` there is no sidecar, no init container, no `claude-creds` volume, and `REVIEW_SIDECAR=0`; `KEYTO_REVIEW_IMAGE` / `KEYTO_SEAT_RELAY_IMAGE` missing → throws. `pickSeatProfile`: preferred → active → legacy → null. `startReview`: closed PR → `ReviewRejectedError`; fork PR → rejected; no profile → `no_seat`; live job same PR → `ReviewConflictError`; live job same requester+profile → conflict; secret keys are exactly `{token, callback_token, background, llm_url, llm_token, llm_model, concurrency, effort, token_budget}`; pod create 403/500 → row `failed`, secret deleted, credential revoked. `completeReview`: `terminal_state` complete/partial/other → succeeded/partial/failed; `exit_code 70` → `seat_reauth_required`; malformed result → failed with `malformed envelope`; poster throwing does not change status; snapshot only when the blob differs. `sweepReviews`: overdue running → `timed_out`; pod `Failed` with no callback for 10 min → `failed`; terminal job with pod older than 10 min → pod deleted; results older than 90 days nulled.
- `lib/review-membership.test.ts` — superadmin, owner, collaborator with/without flag, viewer, non-member.
- `app/api/projects/[name]/reviews/route.test.ts` — flag off 404; viewer 403; collaborator without flag 403; owner 202; admin-only flag; bad `prNumber` 400; conflict 409; `no_seat` 412.
- `app/api/internal/reviews/[jobId]/result/route.test.ts` — no bearer 401; wrong token 401 (same body as unknown job); terminal job 409; oversized 413; bad JSON 400; happy path calls `completeReview` once.
- `app/api/internal/reviews/sweep/route.test.ts` — clone of the reap route test.

## Verification checklist in the hub repo

1. `npx tsc --noEmit` clean after the paste (expect: `db.select().orderBy` needs `desc()` for newest-first; `pr.head.repo` nullability; `redactJob` generic).
2. `npm test` — existing suites unaffected (no shared files edited except `lib/schema.ts`).
3. `npm run drizzle:generate` produces `0031` equivalent to the checked-in SQL; the PreSync migrate Job applies it in UAT.
4. Deploy with `KEYTO_REVIEWS_ADMIN_ONLY=true`; run one review on a small UAT PR; confirm: pod has 2 containers + 1 init, no SA token, callback lands, row `succeeded`, comments + sticky summary on the PR, `manifest.coverage` on the job page, `review:<profile>` credential blob unchanged unless a refresh happened.
5. Confirm the workspace reaper (`/api/internal/workspaces/reap`) leaves review pods alone (label selector differs) and the review sweeper deletes finished pods after 10 min.
