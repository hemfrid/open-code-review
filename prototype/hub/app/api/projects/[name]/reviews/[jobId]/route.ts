// SPDX-License-Identifier: Apache-2.0
// /api/projects/[name]/reviews/[jobId] — job status + findings (GET), cancel (DELETE).
// GET strips `thinking` from findings unless the caller is an owner/superadmin
// and asks for ?full=1 (spec §5). DELETE is owner/superadmin only.
import { NextResponse } from 'next/server';
import { getProjectByName } from '@/lib/projects';
import { isOwner } from '@/lib/admin-auth';
import { getProjectRole, isSuperadmin } from '@/lib/project-membership';
import { reviewsEnabled } from '@/lib/review-membership';
import { cancelReview, getReviewJob, redactJob } from '@/orchestration/reviews';
import { workspaceGate } from '../../workspace/gate';

export const dynamic = 'force-dynamic';

async function ownerLike(email: string, project: string): Promise<boolean> {
  const [role, superadmin] = await Promise.all([getProjectRole(email, project), isSuperadmin(email)]);
  return role === 'owner' || superadmin || isOwner(email);
}

function parseJobId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(req: Request, { params }: { params: { name: string; jobId: string } }) {
  if (!reviewsEnabled()) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const g = await workspaceGate(params);
  if (g instanceof NextResponse) return g;
  const jobId = parseJobId(params.jobId);
  if (!jobId) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const project = await getProjectByName(g.project);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const job = await getReviewJob(project.id, jobId);
  if (!job) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const wantFull = new URL(req.url).searchParams.get('full') === '1';
  const full = wantFull && (await ownerLike(g.email, g.project));
  return NextResponse.json(redactJob(job, full));
}

export async function DELETE(_req: Request, { params }: { params: { name: string; jobId: string } }) {
  if (!reviewsEnabled()) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const g = await workspaceGate(params);
  if (g instanceof NextResponse) return g;
  if (!(await ownerLike(g.email, g.project))) {
    return NextResponse.json({ error: 'forbidden — owners only' }, { status: 403 });
  }
  const jobId = parseJobId(params.jobId);
  if (!jobId) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const project = await getProjectByName(g.project);
  if (!project) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const job = await getReviewJob(project.id, jobId);
  if (!job) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(await cancelReview(jobId));
}
