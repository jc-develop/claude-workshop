import { NextResponse } from "next/server";
import { requireRole } from "@/modules/auth/lib/role-guard";
import { forbidden, guardFailure } from "@/modules/auth/lib/guard-response";
import { getServiceClient } from "@/shared/db/client";
import { toErrorResponse } from "@/shared/lib/error-response";
import type { UserRole } from "@/shared/types";
import * as courseDao from "@/shared/db/dao/course.dao";
import { canManageEvent } from "@/modules/courses/lib/course-access";
import { resolveCourseGrant } from "@/modules/courses/lib/course-entitlement";
import { clearCourseHighlight, getCourseHighlight, setCourseHighlight } from "@/modules/courses/lib/live-session-service";

async function requireHighlightAccess(
  supabase: ReturnType<typeof getServiceClient>,
  courseId: number,
  userId: number,
  userRole: UserRole,
): Promise<NextResponse | null> {
  const course = await courseDao.findCourseEvent(supabase, courseId);
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  if (!(await canManageEvent(supabase, userId, userRole, course.event_id))) {
    return NextResponse.json({ error: "Only assigned staff can update the live highlight" }, { status: 403 });
  }
  return null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const supabase = getServiceClient();

  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  // Which lesson a session is on is part of the room, so reading it takes the
  // same grant as being in the room. Only the writes were ever guarded here,
  // which left the state of every live event legible from any account.
  if (!(await resolveCourseGrant(supabase, guard.user, Number(courseId)))) {
    return forbidden();
  }

  try {
    const state = await getCourseHighlight(supabase, Number(courseId));
    return NextResponse.json(state);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const supabase = getServiceClient();

  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  const denied = await requireHighlightAccess(supabase, Number(courseId), guard.user.id, guard.user.role);
  if (denied) return denied;

  const body = await req.json();
  const lessonId = body.lesson_id ?? null;

  try {
    const state = await setCourseHighlight(supabase, Number(courseId), lessonId, { id: guard.user.id });
    return NextResponse.json(state);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const supabase = getServiceClient();

  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  const denied = await requireHighlightAccess(supabase, Number(courseId), guard.user.id, guard.user.role);
  if (denied) return denied;

  try {
    const result = await clearCourseHighlight(supabase, Number(courseId), { id: guard.user.id });
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
