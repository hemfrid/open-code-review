// SPDX-License-Identifier: Apache-2.0
// Who may start a PR review on a project (spec Part I S8). Mirrors
// canPromote() in lib/project-membership.ts:193 — the single place the
// rule lives, so the UI route and any future MCP lane cannot drift:
//
//   superadmin   → always
//   owner        → always
//   collaborator → only when project_members.can_run_review is true
//   viewer / non-member → never
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { projects, projectMembers } from './schema';
import { isSuperadmin } from './project-membership';

export async function canRunReview(email: string, projectName: string): Promise<boolean> {
  const lowered = email.toLowerCase();
  if (await isSuperadmin(lowered)) return true;
  const rows = await db
    .select({ role: projectMembers.role, canReview: projectMembers.canRunReview })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projects.name, projectName), eq(projectMembers.email, lowered)))
    .limit(1);
  if (rows.length === 0) return false;
  const { role, canReview } = rows[0];
  if (role === 'owner') return true;
  if (role === 'collaborator') return canReview;
  return false;
}

/** Feature flags, same shape as orchestration/workspace-flags.ts. */
export function reviewsEnabled(): boolean {
  return (process.env.KEYTO_REVIEWS_ENABLED || '').toLowerCase() === 'true';
}
export function reviewsAdminOnly(): boolean {
  return (process.env.KEYTO_REVIEWS_ADMIN_ONLY || '').toLowerCase() === 'true';
}
