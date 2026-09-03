// SPDX-License-Identifier: Apache-2.0
// PR review orchestrator — composes the one-shot `ocr review` pod, its
// per-job credentials and the result callback. Routes stay thin and call
// these. Spec: spec-hub-direct-relay-review.md Part I (§3.3, §3.5, §3.9, §4, §5).
//
// Shape follows orchestration/workspaces.ts deliberately: same hardening,
// same secret/label conventions, same "k8sRequest never throws" assumptions.
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, lt } from 'drizzle-orm';
import {
  applyWorkspaceSecret,
  createWorkspacePod,
  deleteWorkspacePod,
  deleteWorkspaceSecret,
  execWorkspacePodRead,
  getWorkspacePod,
  getWorkspaceSecretData,
  listWorkspacePods,
  type V1WorkspacePod,
} from '@/orchestration/platform/k8s-workspace';
import { k8sRequest } from '@/orchestration/platform/k8s';
import { adminRevokeGitCredential, issueGitCredential } from '@/lib/git-credentials';
import { getInstallationOctokit } from '@/orchestration/platform/github-app';
import { claudeCredsSecretName, userHash } from '@/orchestration/workspaces';
import { storeSeatProfileCredentials } from '@/orchestration/seat-profiles';
import { resolveRepo } from '@/lib/projects';
import { db } from '@/lib/db';
import { auditLog, projects, reviewJobs, type ReviewJobStatus } from '@/lib/schema';
import { parseEnvelope, type OcrEnvelope } from '@/lib/review/envelope';
import { runStages, type Stage } from '@/lib/review/postprocess';
import { postReview } from '@/lib/review/poster';

// ── constants ──────────────────────────────────────────────────────────────
const PROJECT_NAME_MAX = 30; // matches the ws-* families (workspaces.ts:34)
const CLAUDE_CREDS_FILE = '.credentials.json';
const RESTORE_DIR = '/restore/claude'; // read-only projected secret (init reads it)
const SEAT_DIR = '/run/keyto-seat'; // writable emptyDir the sidecar refreshes into
const SEAT_CREDS_POD_PATH = `${SEAT_DIR}/${CLAUDE_CREDS_FILE}`;
const REVIEW_PROFILE_DEFAULT = 'review';
const BACKGROUND_MAX_BYTES = 16 * 1024;
const RESULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const FINISHED_POD_GRACE_MS = 10 * 60 * 1000;
const NO_CALLBACK_GRACE_MS = 10 * 60 * 1000;

export type ReviewJob = typeof reviewJobs.$inferSelect;

export type ReviewConfig = {
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  concurrency?: number;
  tokenBudget?: number;
  routeSeverityBelow?: 'critical' | 'high' | 'medium' | 'low' | '';
  llmOverride?: { url: string; tokenSecretRef: string; model: string };
};

export type ReviewCallback = {
  exit_code: number;
  stderr: string;
  result: unknown | null;
};

export class ReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export class ReviewRejectedError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// ── names ──────────────────────────────────────────────────────────────────
export function reviewPodName(project: string, jobId: number): string {
  return `rv-${project.slice(0, PROJECT_NAME_MAX)}-${jobId}`;
}
export function reviewCredSecretName(project: string, jobId: number): string {
  return `rv-cred-${project.slice(0, PROJECT_NAME_MAX)}-${jobId}`;
}

// ── env ────────────────────────────────────────────────────────────────────
function hubOrigin(): string {
  const url = process.env.NEXTAUTH_URL ?? '';
  if (!url) throw new Error('NEXTAUTH_URL is not configured');
  return new URL(url).origin;
}
function reviewImage(): string {
  const img = process.env.KEYTO_REVIEW_IMAGE ?? '';
  if (!img) throw new Error('KEYTO_REVIEW_IMAGE is not configured');
  return img;
}
function seatRelayImage(): string {
  const img = process.env.KEYTO_SEAT_RELAY_IMAGE ?? '';
  if (!img) throw new Error('KEYTO_SEAT_RELAY_IMAGE is not configured');
  return img;
}
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function defaults(cfg: ReviewConfig) {
  return {
    model: cfg.model || process.env.KEYTO_REVIEW_DEFAULT_MODEL || 'claude-sonnet-5',
    effort: cfg.effort || (process.env.KEYTO_REVIEW_DEFAULT_EFFORT as ReviewConfig['effort']) || 'medium',
    concurrency: cfg.concurrency || envInt('KEYTO_REVIEW_DEFAULT_CONCURRENCY', 4),
    tokenBudget: cfg.tokenBudget || envInt('KEYTO_REVIEW_TOKEN_BUDGET', 400_000),
    timeoutMin: envInt('KEYTO_REVIEW_TIMEOUT_MIN', 15),
    seatProfile: process.env.KEYTO_REVIEW_SEAT_PROFILE || REVIEW_PROFILE_DEFAULT,
  };
}
/** activeDeadlineSeconds: ocr's own per-task timeout × rounds (≤3) + slack. */
export function reviewDeadlineSeconds(timeoutMin: number): number {
  return (timeoutMin * 3 + 10) * 60;
}

// ── pod spec ───────────────────────────────────────────────────────────────
export type ReviewPodOpts = {
  project: string;
  email: string;
  jobId: number;
  credentialId: number;
  prNumber: number;
  baseRef: string;
  headSha: string;
  /** Seat profile whose credential the sidecar uses; null = llmOverride (no sidecar). */
  seatProfile: string | null;
  timeoutMin: number;
};

// Copies the projected (read-only) profile credential into a writable emptyDir
// so the sidecar can persist a refreshed token, then exits. The profile key is
// already projected as `.credentials.json` by the volume `items` mapping below.
const SEAT_INIT_SCRIPT = `set -eu
umask 077
cp ${RESTORE_DIR}/${CLAUDE_CREDS_FILE} ${SEAT_DIR}/${CLAUDE_CREDS_FILE}
`;

export function buildReviewPodSpec(o: ReviewPodOpts): object {
  const restricted = { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } };
  const secret = reviewCredSecretName(o.project, o.jobId);
  const ref = (key: string, optional = false) => ({
    valueFrom: { secretKeyRef: { name: secret, key, ...(optional ? { optional: true } : {}) } },
  });
  const withSidecar = o.seatProfile !== null;
  const reviewContainer = {
    name: 'review',
    image: reviewImage(),
    // ENTRYPOINT is review.sh; every input arrives as env, never argv.
    env: [
      { name: 'HOME', value: '/home/review' },
      { name: 'PROJECT', value: o.project },
      { name: 'PR_NUMBER', value: String(o.prNumber) },
      { name: 'BASE_REF', value: o.baseRef },
      { name: 'HEAD_SHA', value: o.headSha },
      { name: 'HUB_GIT_BASE', value: hubOrigin() },
      { name: 'HUB_CALLBACK_URL', value: `${hubOrigin()}/api/internal/reviews/${o.jobId}/result` },
      { name: 'OCR_LLM_PROTOCOL', value: 'anthropic' },
      { name: 'OCR_LLM_TIMEOUT', value: '300' },
      { name: 'REVIEW_TIMEOUT_MIN', value: String(o.timeoutMin) },
      { name: 'REVIEW_SIDECAR', value: withSidecar ? '1' : '0' },
      { name: 'GIT_TOKEN', ...ref('token') },
      { name: 'CALLBACK_TOKEN', ...ref('callback_token') },
      { name: 'REVIEW_BACKGROUND', ...ref('background', true) },
      { name: 'OCR_LLM_URL', ...ref('llm_url') },
      { name: 'OCR_LLM_TOKEN', ...ref('llm_token') },
      { name: 'OCR_LLM_MODEL', ...ref('llm_model') },
      { name: 'REVIEW_CONCURRENCY', ...ref('concurrency', true) },
      { name: 'REVIEW_EFFORT', ...ref('effort', true) },
      { name: 'REVIEW_TOKEN_BUDGET', ...ref('token_budget', true) },
    ],
    volumeMounts: [
      { name: 'home', mountPath: '/home/review' },
      { name: 'work', mountPath: '/work' },
    ],
    resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '2', memory: '3Gi' } },
    securityContext: restricted,
  };
  const sidecarContainer = withSidecar
    ? {
        name: 'seat-relay',
        image: seatRelayImage(),
        command: ['node', '/opt/seat-relay/relay.mjs'],
        env: [
          { name: 'RELAY_PORT', value: '8890' },
          { name: 'RELAY_CREDENTIALS_FILE', value: SEAT_CREDS_POD_PATH },
          { name: 'RELAY_ALLOW_REFRESH', value: '1' },
          // The same per-job secret value ocr presents as OCR_LLM_TOKEN.
          { name: 'RELAY_LOCAL_TOKEN', ...ref('llm_token') },
        ],
        volumeMounts: [{ name: 'seat', mountPath: SEAT_DIR }],
        resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '200m', memory: '256Mi' } },
        securityContext: restricted,
        readinessProbe: { httpGet: { path: '/healthz', port: 8890, host: '127.0.0.1' }, initialDelaySeconds: 1, periodSeconds: 2 },
      }
    : null;
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: reviewPodName(o.project, o.jobId),
      labels: {
        'keyto.io/review': 'true',
        'keyto.io/project': o.project,
        'keyto.io/user-hash': userHash(o.email),
        'keyto.io/review-job': String(o.jobId),
        ...(o.seatProfile ? { 'keyto.io/seat-profile': o.seatProfile } : {}),
      },
      annotations: {
        'keyto.io/user-email': o.email,
        'keyto.io/git-credential-id': String(o.credentialId),
      },
    },
    spec: {
      automountServiceAccountToken: false,
      restartPolicy: 'Never',
      activeDeadlineSeconds: reviewDeadlineSeconds(o.timeoutMin),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1001,
        runAsGroup: 1001,
        fsGroup: 1001,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      imagePullSecrets: [{ name: 'acr-pull' }],
      initContainers: withSidecar
        ? [
            {
              name: 'seat-init',
              image: seatRelayImage(),
              command: ['/bin/sh', '-c', SEAT_INIT_SCRIPT],
              volumeMounts: [
                { name: 'claude-creds', mountPath: RESTORE_DIR, readOnly: true },
                { name: 'seat', mountPath: SEAT_DIR },
              ],
              resources: { requests: { cpu: '50m', memory: '32Mi' }, limits: { cpu: '200m', memory: '64Mi' } },
              securityContext: restricted,
            },
          ]
        : [],
      containers: [...(sidecarContainer ? [sidecarContainer] : []), reviewContainer],
      volumes: [
        { name: 'home', emptyDir: { sizeLimit: '4Gi' } },
        { name: 'work', emptyDir: { sizeLimit: '512Mi' } },
        ...(withSidecar
          ? [
              { name: 'seat', emptyDir: { sizeLimit: '8Mi' } },
              {
                // ONE profile key, projected under the plain file name. Never the
                // whole secret: other profiles must not enter this pod.
                name: 'claude-creds',
                secret: {
                  secretName: claudeCredsSecretName(o.email),
                  items: [{ key: `${o.seatProfile}.${CLAUDE_CREDS_FILE}`, path: CLAUDE_CREDS_FILE }],
                },
              },
            ]
          : []),
      ],
    },
  };
}

// ── seat profile selection (mirrors seat-profiles.ts key layout) ───────────
const ACTIVE_KEY = 'active';
const credsKey = (p: string) => `${p}.${CLAUDE_CREDS_FILE}`;

/** `review` profile if present, else the active profile, else null. */
export function pickSeatProfile(
  data: Record<string, string> | null,
  preferred: string,
): string | null {
  if (!data) return null;
  if (data[credsKey(preferred)]) return preferred;
  const active = data[ACTIVE_KEY];
  if (active && data[credsKey(active)]) return active;
  // Legacy single-key secret (bare .credentials.json) reads as 'default'.
  if (data[CLAUDE_CREDS_FILE]) return 'default';
  return null;
}

// ── start ──────────────────────────────────────────────────────────────────
type ProjectRow = { id: number; name: string; githubRepo?: string | null; reviewConfig?: unknown };

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function startReview(
  project: ProjectRow,
  email: string,
  prNumber: number,
): Promise<ReviewJob> {
  const requester = email.toLowerCase();
  const cfg = (project.reviewConfig ?? {}) as ReviewConfig;
  const d = defaults(cfg);
  const { owner, repo } = resolveRepo(project.name, project.githubRepo);

  // 1. PR metadata as the bot App.
  const octokit = getInstallationOctokit();
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (pr.state !== 'open') throw new ReviewRejectedError('pull request is not open');
  if (pr.head.repo?.full_name?.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    throw new ReviewRejectedError('fork pull requests are not reviewed in v1');
  }

  // 2. LLM source: llmOverride → seat profile (review → active) → no_seat.
  let llmSource: string;
  let seatProfile: string | null = null;
  let llm: { url: string; token: string; model: string };
  if (cfg.llmOverride) {
    const token = await readOverrideToken(cfg.llmOverride.tokenSecretRef);
    llm = { url: cfg.llmOverride.url, token, model: cfg.llmOverride.model || d.model };
    llmSource = 'api_key';
  } else {
    const creds = await getWorkspaceSecretData(claudeCredsSecretName(requester));
    seatProfile = pickSeatProfile(creds, d.seatProfile);
    if (!seatProfile) throw new ReviewRejectedError('no_seat');
    // The sidecar ignores the token value but requires it to match RELAY_LOCAL_TOKEN;
    // one random value serves both sides from the same secret key.
    llm = { url: 'http://127.0.0.1:8890', token: randomBytes(24).toString('base64url'), model: d.model };
    llmSource = `seat:${seatProfile}`;
  }

  // 3. Refusals: one live job per (project, PR) and per (requester, profile).
  const live = await db
    .select({ id: reviewJobs.id, prNumber: reviewJobs.prNumber, requestedBy: reviewJobs.requestedBy, llmSource: reviewJobs.llmSource })
    .from(reviewJobs)
    .where(and(eq(reviewJobs.projectId, project.id), inArray(reviewJobs.status, ['pending', 'running'])));
  if (live.some((j) => j.prNumber === prNumber)) {
    throw new ReviewConflictError('a review is already running for this pull request');
  }
  if (seatProfile && live.some((j) => j.requestedBy === requester && j.llmSource === llmSource)) {
    throw new ReviewConflictError('a review is already running on this seat profile');
  }

  // 4. Row + one-time callback token (hash stored; value only in the secret).
  const callbackToken = randomBytes(32).toString('base64url');
  const [row] = await db
    .insert(reviewJobs)
    .values({
      projectId: project.id,
      requestedBy: requester,
      prNumber,
      baseRef: pr.base.ref,
      headSha: pr.head.sha,
      status: 'pending',
      callbackTokenHash: sha256(callbackToken),
      llmSource,
      llmModel: llm.model,
    })
    .returning();

  // 5. Fetch-only git credential, revoked at completion.
  const cred = await issueGitCredential(requester, 'workspace');
  await db.update(reviewJobs).set({ gitCredentialId: cred.id }).where(eq(reviewJobs.id, row.id));

  // 6. Per-job secret. No seat credential here — that arrives via the projected volume.
  const background = `${pr.title ?? ''}\n\n${pr.body ?? ''}`.slice(0, BACKGROUND_MAX_BYTES);
  await applyWorkspaceSecret(reviewCredSecretName(project.name, row.id), {
    token: cred.token,
    callback_token: callbackToken,
    background,
    llm_url: llm.url,
    llm_token: llm.token,
    llm_model: llm.model,
    concurrency: String(d.concurrency),
    effort: d.effort,
    token_budget: String(d.tokenBudget),
  });

  // 7. Pod.
  const podName = reviewPodName(project.name, row.id);
  const res = await createWorkspacePod(
    buildReviewPodSpec({
      project: project.name,
      email: requester,
      jobId: row.id,
      credentialId: cred.id,
      prNumber,
      baseRef: pr.base.ref,
      headSha: pr.head.sha,
      seatProfile,
      timeoutMin: d.timeoutMin,
    }),
  );
  if (res && !res.ok && res.status !== 409) {
    await failJob(row.id, `review pod create failed: ${res.status}`);
    await cleanupJob(row.id, project.name, cred.id, false);
    throw new Error(`review pod create failed: ${res.status}`);
  }
  const [running] = await db
    .update(reviewJobs)
    .set({ status: 'running', podName, startedAt: new Date() })
    .where(eq(reviewJobs.id, row.id))
    .returning();

  // 8. Audit.
  await db.insert(auditLog).values({
    userEmail: requester,
    action: 'review.start',
    projectId: project.id,
    payload: { jobId: row.id, prNumber, headSha: pr.head.sha, llmSource },
  });
  return running;
}

/** llmOverride.tokenSecretRef = "<k8s secret name>/<key>" in the workspace namespace. */
async function readOverrideToken(ref: string): Promise<string> {
  const [name, key] = ref.split('/');
  const data = name && key ? await getWorkspaceSecretData(name) : null;
  const token = data?.[key];
  if (!token) throw new ReviewRejectedError('llmOverride token secret is not readable');
  return token;
}

// ── complete ───────────────────────────────────────────────────────────────
export function statusFromTerminalState(state: string | undefined): ReviewJobStatus {
  if (state === 'complete') return 'succeeded';
  if (state === 'partial') return 'partial';
  return 'failed';
}

/** First line of the stderr JSON `message` if ocr wrote one, else the stderr head. */
export function errorFromStderr(stderr: string, exitCode: number): string {
  if (exitCode === 70) return 'seat_reauth_required';
  const line = stderr.split('\n').find((l) => l.trim().startsWith('{'));
  if (line) {
    try {
      const j = JSON.parse(line) as { message?: string; error?: string };
      if (j.message) return String(j.message).slice(0, 500);
      if (j.error) return String(j.error).slice(0, 500);
    } catch {
      /* fall through */
    }
  }
  return stderr.trim().slice(0, 500) || `ocr exited ${exitCode}`;
}

export async function completeReview(jobId: number, cb: ReviewCallback): Promise<void> {
  const [job] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, jobId)).limit(1);
  if (!job || job.status !== 'running') throw new ReviewConflictError('job is not running');
  const [project] = await db.select().from(projects).where(eq(projects.id, job.projectId)).limit(1);
  const cfg = ((project?.reviewConfig ?? {}) as ReviewConfig);

  // 1. Validate.
  let envelope: OcrEnvelope | null = null;
  let error: string | null = null;
  if (cb.exit_code !== 0 || cb.result === null) {
    error = errorFromStderr(cb.stderr ?? '', cb.exit_code);
  } else {
    const parsed = parseEnvelope(cb.result);
    if (parsed.ok) envelope = parsed.envelope;
    else error = `malformed envelope: ${parsed.error}`;
  }

  // 2 + 3. Persist, post-process, post.
  let posted = 0;
  let summaryUrl: string | null = null;
  let status: ReviewJobStatus = 'failed';
  if (envelope) {
    status = statusFromTerminalState(envelope.manifest?.terminal_state);
    // v1 runs no stages: severity routing is done by the vendored poster itself
    // (routeSeverityBelow), which also renders the routed findings in the summary.
    // severityFloor/verifierPass/dedupe plug in here once the TS poster (v1.1) can
    // render `routed_to_summary`. Spec §3.7.
    const stages: Stage[] = [];
    const processed = await runStages(envelope, { projectName: project!.name, prNumber: job.prNumber, jobId }, stages);
    try {
      const { owner, repo } = resolveRepo(project!.name, project!.githubRepo);
      const r = await postReview({
        octokit: getInstallationOctokit(),
        owner,
        repo,
        prNumber: job.prNumber,
        jobId,
        envelope: processed,
        stderr: cb.stderr ?? '',
        routeSeverityBelow: cfg.routeSeverityBelow ?? 'low',
        incremental: true,
        jobUrl: `${hubOrigin()}/projects/${encodeURIComponent(project!.name)}/reviews/${jobId}`,
      });
      posted = r.inline;
      summaryUrl = r.summaryUrl;
    } catch (e) {
      error = `${error ? error + '; ' : ''}post failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const finishedAt = new Date();
  await db
    .update(reviewJobs)
    .set({
      status,
      finishedAt,
      elapsedMs: job.startedAt ? finishedAt.getTime() - job.startedAt.getTime() : null,
      error,
      ocrStatus: envelope?.status ?? null,
      terminalState: envelope?.manifest?.terminal_state ?? null,
      filesReviewed: envelope?.summary?.files_reviewed ?? null,
      commentsTotal: envelope?.comments.length ?? null,
      commentsPosted: envelope ? posted : null,
      inputTokens: envelope?.summary?.input_tokens ?? null,
      outputTokens: envelope?.summary?.output_tokens ?? null,
      totalTokens: envelope?.summary?.total_tokens ?? null,
      result: (envelope ?? (cb.result as object | null)) as object | null,
      postSummaryUrl: summaryUrl,
    })
    .where(eq(reviewJobs.id, jobId));

  // 5. Snapshot the (possibly refreshed) seat credential, then release creds.
  if (job.podName && job.llmSource.startsWith('seat:')) {
    await snapshotSeatCredential(job.podName, job.requestedBy, job.llmSource.slice('seat:'.length));
  }
  await cleanupJob(jobId, project!.name, job.gitCredentialId, false);
}

/** Read the sidecar's refreshed blob and write it back to the profile if it changed.
 *  Same "snapshot on teardown" step workspaces do (workspaces.ts:734). */
async function snapshotSeatCredential(podName: string, email: string, profile: string): Promise<void> {
  const content = await execWorkspacePodRead(podName, SEAT_CREDS_POD_PATH);
  if (!content) return;
  const current = await getWorkspaceSecretData(claudeCredsSecretName(email));
  if (current?.[credsKey(profile)] === content) return;
  await storeSeatProfileCredentials(email, profile, content, {});
}

async function failJob(jobId: number, error: string, status: ReviewJobStatus = 'failed'): Promise<void> {
  await db
    .update(reviewJobs)
    .set({ status, error, finishedAt: new Date() })
    .where(and(eq(reviewJobs.id, jobId), inArray(reviewJobs.status, ['pending', 'running'])));
}

/** Revoke the git credential and delete the per-job secret; optionally the pod. */
async function cleanupJob(jobId: number, project: string, credId: number | null, deletePod: boolean): Promise<void> {
  await deleteWorkspaceSecret(reviewCredSecretName(project, jobId));
  if (credId) await adminRevokeGitCredential(credId);
  if (deletePod) await deleteWorkspacePod(reviewPodName(project, jobId));
}

// ── cancel ─────────────────────────────────────────────────────────────────
export async function cancelReview(jobId: number): Promise<{ cancelled: boolean }> {
  const [job] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, jobId)).limit(1);
  if (!job || !['pending', 'running'].includes(job.status)) return { cancelled: false };
  const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, job.projectId)).limit(1);
  await failJob(jobId, 'cancelled by owner', 'cancelled');
  await cleanupJob(jobId, project.name, job.gitCredentialId, true);
  return { cancelled: true };
}

// ── sweeper ────────────────────────────────────────────────────────────────
function podTerminationMessage(pod: V1WorkspacePod): string {
  const statuses = pod.status?.containerStatuses ?? [];
  for (const s of statuses) {
    const term = s.state?.terminated as { reason?: string; message?: string; exitCode?: number } | undefined;
    if (term && term.exitCode !== 0) return `${s.name}: ${term.reason ?? 'terminated'} exit ${term.exitCode}`;
  }
  return pod.status?.phase ?? 'unknown';
}

/** Review pods carry keyto.io/review=true; the workspace reaper's selector
 *  (keyto.io/workspace=true, k8s-workspace.ts:70) never sees them. */
async function listReviewPods(): Promise<V1WorkspacePod[]> {
  const ns = process.env.KEYTO_WORKSPACE_NAMESPACE || 'keyto-workspaces';
  const res = await k8sRequest(
    'GET',
    `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent('keyto.io/review=true')}`,
  );
  if (!res || !res.ok) return [];
  try {
    return (JSON.parse(res.body).items ?? []) as V1WorkspacePod[];
  } catch {
    return [];
  }
}

export async function sweepReviews(): Promise<{ timedOut: number[]; cleaned: number[]; pruned: number }> {
  const now = Date.now();
  const timedOut: number[] = [];
  const cleaned: number[] = [];
  const pods = await listReviewPods();
  const byJob = new Map<number, V1WorkspacePod>();
  for (const p of pods) {
    const id = Number(p.metadata?.labels?.['keyto.io/review-job']);
    if (Number.isFinite(id)) byJob.set(id, p);
  }

  const running = await db.select().from(reviewJobs).where(inArray(reviewJobs.status, ['pending', 'running']));
  for (const job of running) {
    const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, job.projectId)).limit(1);
    const pod = byJob.get(job.id);
    const started = job.startedAt?.getTime() ?? job.createdAt?.getTime() ?? now;
    const deadlineMs = (reviewDeadlineSeconds(envInt('KEYTO_REVIEW_TIMEOUT_MIN', 15)) * 1000) + 5 * 60 * 1000;
    const podDone = pod?.status?.phase === 'Failed' || pod?.status?.phase === 'Succeeded';
    const overdue = now - started > deadlineMs;
    const doneNoCallback = podDone && now - started > NO_CALLBACK_GRACE_MS;
    if (overdue || doneNoCallback) {
      try {
        await failJob(job.id, pod ? podTerminationMessage(pod) : 'pod not found', overdue ? 'timed_out' : 'failed');
        if (pod && job.llmSource.startsWith('seat:') && job.podName) {
          await snapshotSeatCredential(job.podName, job.requestedBy, job.llmSource.slice('seat:'.length));
        }
        await cleanupJob(job.id, project.name, job.gitCredentialId, true);
        timedOut.push(job.id);
      } catch (e) {
        console.error(`sweepReviews: job ${job.id}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  // Terminal jobs whose pod is still around: keep logs readable for a while, then delete.
  for (const [jobId, pod] of byJob) {
    const [job] = await db.select({ status: reviewJobs.status, finishedAt: reviewJobs.finishedAt, projectId: reviewJobs.projectId }).from(reviewJobs).where(eq(reviewJobs.id, jobId)).limit(1);
    if (!job || ['pending', 'running'].includes(job.status)) continue;
    const finished = job.finishedAt?.getTime() ?? 0;
    if (now - finished > FINISHED_POD_GRACE_MS && pod.metadata?.name) {
      await deleteWorkspacePod(pod.metadata.name);
      cleaned.push(jobId);
    }
  }

  // Retention: null the envelope after 90 days, keep summary columns (spec §5).
  const pruned = await db
    .update(reviewJobs)
    .set({ result: null })
    .where(and(lt(reviewJobs.finishedAt, new Date(now - RESULT_RETENTION_MS))))
    .returning({ id: reviewJobs.id });

  return { timedOut, cleaned, pruned: pruned.length };
}

// ── reads for routes ───────────────────────────────────────────────────────
export async function listReviewJobs(projectId: number, limit = 20): Promise<ReviewJob[]> {
  return db.select().from(reviewJobs).where(eq(reviewJobs.projectId, projectId)).orderBy(reviewJobs.id).limit(limit);
}
export async function getReviewJob(projectId: number, jobId: number): Promise<ReviewJob | null> {
  const rows = await db.select().from(reviewJobs).where(and(eq(reviewJobs.id, jobId), eq(reviewJobs.projectId, projectId))).limit(1);
  return rows[0] ?? null;
}

/** Strip model reasoning from findings for non-owner viewers (spec §5). */
export function redactJob(job: ReviewJob, full: boolean): ReviewJob {
  if (full || !job.result) return job;
  const r = job.result as { comments?: Array<Record<string, unknown>> };
  if (!Array.isArray(r.comments)) return job;
  return { ...job, result: { ...r, comments: r.comments.map(({ thinking: _t, ...rest }) => rest) } };
}
