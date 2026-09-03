// SPDX-License-Identifier: Apache-2.0
// POST /api/internal/reviews/[jobId]/result — the review pod's callback.
// Auth is the per-job one-time bearer (sha256 stored on the row, constant-time
// compare), NOT a session: this is pod-to-hub. Single use: the job must be
// `running`, and completeReview moves it terminal. Body capped at 8 MB.
import { createHash, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { reviewJobs } from '@/lib/schema';
import { takeToken } from '@/lib/rate-limit';
import { completeReview, ReviewConflictError, type ReviewCallback } from '@/orchestration/reviews';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CALLBACKS_PER_MINUTE = 60;
const RL_WINDOW_MS = 60_000;

function bearer(header: string | null): string {
  return header?.startsWith('Bearer ') ? header.slice(7) : '';
}

function tokenMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(createHash('sha256').update(presented).digest('hex'));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request, { params }: { params: { jobId: string } }) {
  const jobId = Number(params.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (!takeToken('reviews-result', CALLBACKS_PER_MINUTE, RL_WINDOW_MS)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }
  const presented = bearer(req.headers.get('authorization'));
  if (!presented) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const [job] = await db
    .select({ status: reviewJobs.status, callbackTokenHash: reviewJobs.callbackTokenHash })
    .from(reviewJobs)
    .where(eq(reviewJobs.id, jobId))
    .limit(1);
  // Same 401 for unknown job and bad token: the pod learns nothing about other jobs.
  if (!job || !tokenMatches(presented, job.callbackTokenHash)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (job.status !== 'running') {
    return NextResponse.json({ error: 'job is not running' }, { status: 409 });
  }

  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  }
  const raw = await req.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  }
  let cb: ReviewCallback;
  try {
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as Partial<ReviewCallback>;
    cb = {
      exit_code: Number.isInteger(parsed.exit_code) ? (parsed.exit_code as number) : 1,
      stderr: typeof parsed.stderr === 'string' ? parsed.stderr.slice(0, 64 * 1024) : '',
      result: parsed.result ?? null,
    };
  } catch {
    return NextResponse.json({ error: 'body must be JSON {exit_code, stderr, result}' }, { status: 400 });
  }
  try {
    await completeReview(jobId, cb);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ReviewConflictError) return NextResponse.json({ error: e.message }, { status: 409 });
    console.error(`reviews/result ${jobId}:`, e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'completion failed' }, { status: 500 });
  }
}
