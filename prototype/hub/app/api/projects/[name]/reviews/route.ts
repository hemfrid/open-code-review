// SPDX-License-Identifier: Apache-2.0
// /api/projects/[name]/reviews — start a PR review (POST), list recent (GET).
// Gate: workspaceGate (session → project → membership) then canRunReview
// (owner, or collaborator with can_run_review). Flag off → 404. Thin: gate + delegate.
import { NextResponse } from 'next/server';
import { getProjectByName } from '@/lib/projects';
import { isOwner } from '@/lib/admin-auth';
import { isSuperadmin } from '@/lib/project-membership';
import { canRunReview, reviewsAdminOnly, reviewsEnabled } from '@/lib/review-membership';
import { takeAiLaneToken } from '@/lib/ai-lane-rate-limit';
import {
  listReviewJobs,
  redactJob,
  ReviewConflictError,
  ReviewRejectedError,
  startReview,
} from '@/orchestration/reviews';
import { workspaceGate } from '../workspace/gate';

export const dynamic = 'force-dynamic';

const START_PER_MIN = 5;
const RL_WINDOW_MS = 60_000;

export async function POST(req: Request, { params }: { params: { name: string } }) {
  if (!reviewsEnabled()) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const g = await workspaceGate(params);
  if (g instanceof NextResponse) return g;
  const admin = (await isSuperadmin(g.email)) || isOwner(g.email);
  if (reviewsAdminOnly() && !admin) {
    return NextResponse.json({ error: 'forbidden — reviews are currently restricted to administrators' }, { status: 403 });
  }
  if (!(await canRunReview(g.email, g.project))) {
    return NextResponse.json({ error: 'forbidden — owners, or collaborators with review permission' }, { status: 403 });
  }
  if (!(await takeAiLaneToken(`review-start:${g.email}`, START_PER_MIN, RL_WINDOW_MS))) {
    return NextResponse.json({ error: 'too many requests, slow down' }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as { prNumber?: unknown };
  const prNumber = Number(body?.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return NextResponse.json({ error: 'prNumber must be a positive integer' }, { status: 400 });
  }
  const project = await getProjectByName(g.project);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    const job = await startReview(project, g.email, prNumber);
    return NextResponse.json(
      { jobId: job.id, status: job.status, statusUrl: `/api/projects/${encodeURIComponent(g.project)}/reviews/${job.id}` },
      { status: 202 },
    );
  } catch (e) {
    if (e instanceof ReviewConflictError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof ReviewRejectedError) {
      const status = e.message === 'no_seat' ? 412 : 422;
      return NextResponse.json({ error: e.message }, { status });
    }
    const msg = e instanceof Error ? e.message : 'review start failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  if (!reviewsEnabled()) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const g = await workspaceGate(params);
  if (g instanceof NextResponse) return g;
  const project = await getProjectByName(g.project);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const jobs = await listReviewJobs(project.id, 20);
  // Listings never carry the envelope; the job route serves it.
  return NextResponse.json({ jobs: jobs.map((j) => ({ ...redactJob(j, false), result: undefined })) });
}
