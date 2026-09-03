// SPDX-License-Identifier: Apache-2.0
// POST /api/internal/reviews/sweep — review sweeper entry point, called by the
// platform CronJob every 10 min (same shape as app/api/internal/workspaces/reap).
// Auth is the shared INTERNAL secret (constant-time compare), NOT a session.
// Fail closed when unconfigured. Rate-limited as a backstop.
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { takeToken } from '@/lib/rate-limit';
import { sweepReviews } from '@/orchestration/reviews';

export const dynamic = 'force-dynamic';

const SWEEP_PER_MINUTE = 4;
const SWEEP_WINDOW_MS = 60_000;

function bearerMatches(header: string | null, secret: string): boolean {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const secret = process.env.KEYTO_WORKSPACE_INTERNAL_SECRET ?? '';
  if (!secret) {
    return NextResponse.json({ error: 'sweeper not configured' }, { status: 503 });
  }
  if (!bearerMatches(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!takeToken('reviews-sweep', SWEEP_PER_MINUTE, SWEEP_WINDOW_MS)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }
  return NextResponse.json(await sweepReviews());
}
