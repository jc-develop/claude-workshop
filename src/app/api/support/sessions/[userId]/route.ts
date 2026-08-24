import { ROLES } from "@/shared/lib/roles";
import { NextResponse } from "next/server";
import { requireRole } from "@/modules/auth/lib/role-guard";
import { forbidden, guardFailure } from "@/modules/auth/lib/guard-response";
import { getServiceClient } from "@/shared/db/client";
import { hasMinRole } from "@/shared/lib/role-hierarchy";
import * as chatDao from "@/shared/db/dao/chat.dao";

/**
 * Erases a user's support history: every session of theirs, and every message
 * they sent or received. The deletes are hard, so there is nothing to restore
 * afterwards.
 *
 * That makes it the most destructive action in this slice, and it used to be
 * the least guarded one — a facilitator floor with no ownership test at all,
 * while claiming or ending a single case checks `assigned_to` and the sibling
 * POST already reserves acting on another user for an admin. Anyone may clear
 * their own history; doing it to somebody else is an admin's call.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId: targetUserId } = await params;

  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  const target = Number(targetUserId);
  if (!Number.isInteger(target) || target <= 0) {
    return NextResponse.json({ error: "userId must be a positive integer" }, { status: 400 });
  }

  if (target !== guard.user.id && !hasMinRole(guard.user.role, ROLES.ADMIN)) {
    return forbidden();
  }

  const supabase = getServiceClient();

  await chatDao.deleteSession(supabase, target);

  await chatDao.deleteMessagesByUser(supabase, target);

  await chatDao.deleteMessagesByRecipient(supabase, target);

  return NextResponse.json({ ok: true });
}
