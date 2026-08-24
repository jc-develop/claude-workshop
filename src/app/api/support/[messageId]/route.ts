import { ROLES } from "@/shared/lib/roles";
import { NextResponse } from "next/server";
import { requireRole } from "@/modules/auth/lib/role-guard";
import { guardFailure } from "@/modules/auth/lib/guard-response";
import { getServiceClient } from "@/shared/db/client";
import * as chatDao from "@/shared/db/dao/chat.dao";
import * as supportSessionDao from "@/shared/db/dao/support-session.dao";
import { hasMinRole } from "@/shared/lib/role-hierarchy";
import type { AuthUser } from "@/modules/auth/lib/types";
import type { DbClient } from "@/shared/db/dao/types";

type MessageWithUser = NonNullable<Awaited<ReturnType<typeof chatDao.findMessageWithUser>>>;

/**
 * A message id the caller may not read is answered exactly as one that is not
 * there. The ids are sequential, so a 403 that meant "exists, not yours" next
 * to a 404 that meant "no such row" let anyone count upwards and learn how much
 * support traffic the project carries and roughly when each case ran — without
 * ever seeing a word of the contents.
 */
const notFound = () => NextResponse.json({ error: "Message not found" }, { status: 404 });

/**
 * Either side of the conversation may read it; otherwise only admin+ or the
 * facilitator assigned to the case. Read visibility matches DELETE's, so a
 * panel's INSERT-triggered fetch of a message it already saw cannot be probed.
 */
async function authorizeMessageRead(supabase: DbClient, message: MessageWithUser, user: AuthUser): Promise<boolean> {
  const participant = message.user_id === user.id || message.recipient_user_id === user.id;
  if (participant || hasMinRole(user.role, ROLES.ADMIN)) {
    return true;
  }
  const session = message.session_id ? await supportSessionDao.findById(supabase, message.session_id) : null;
  return session?.assigned_to === user.id;
}

export async function GET(_req: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await params;
  const supabase = getServiceClient();

  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  const message = await chatDao.findMessageWithUser(supabase, Number(messageId));
  if (!message || !(await authorizeMessageRead(supabase, message, guard.user))) {
    return notFound();
  }

  return NextResponse.json(message);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await params;
  const supabase = getServiceClient();

  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  const message = await chatDao.findMessageWithUser(supabase, Number(messageId));
  if (!message || !(await authorizeMessageRead(supabase, message, guard.user))) {
    return notFound();
  }

  const ok = await chatDao.deleteMessagesByIds(supabase, [Number(messageId)]);

  if (!ok) {
    return NextResponse.json({ error: "Failed to delete message" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
