import { ROLES } from "@/shared/lib/roles";
import { NextResponse } from "next/server";
import { requireRole, requireMinRole } from "@/modules/auth/lib/role-guard";
import { guardFailure } from "@/modules/auth/lib/guard-response";
import { requireModuleAccess } from "@/modules/courses/lib/course-access";
import { getServiceClient } from "@/shared/db/client";
import { toErrorResponse } from "@/shared/lib/error-response";
import { qaMessageSchema } from "@/modules/courses/qa/lib/schemas";
import { findQaModule, listQuestions, sendQuestion, setModuleLock } from "@/modules/courses/qa/lib/service";
import { badRequest } from "@/shared/lib/api-response";

export async function GET(_req: Request, { params }: { params: Promise<{ moduleId: string }> }) {
  const { moduleId } = await params;
  const supabase = getServiceClient();

  // Existence gate ahead of auth: a missing module 404s without prompting for
  // a session. Reading stays allowed once a Q&A is locked, so only existence
  // is enforced here, never the type or lock checks.
  try {
    await findQaModule(supabase, Number(moduleId));
  } catch (err) {
    return toErrorResponse(err);
  }

  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  try {
    const { messages } = await listQuestions(supabase, Number(moduleId), guard.user);
    return NextResponse.json({ messages });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ moduleId: string }> }) {
  const { moduleId } = await params;
  const body = await req.json();
  const parsed = qaMessageSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error);
  }

  const supabase = getServiceClient();

  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  try {
    const message = await sendQuestion(supabase, Number(moduleId), guard.user, parsed.data.message);
    return NextResponse.json(message, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ moduleId: string }> }) {
  const { moduleId } = await params;
  const guard = await requireMinRole(ROLES.SPEAKER);
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  const access = await requireModuleAccess(Number(moduleId), guard.user.id, guard.user.role);
  if (access) {
    return access;
  }

  const supabase = getServiceClient();
  const body = await req.json();

  if (body.is_locked === undefined) {
    return NextResponse.json({ error: "is_locked is required" }, { status: 400 });
  }

  try {
    const mod = await setModuleLock(supabase, Number(moduleId), body.is_locked);
    return NextResponse.json(mod);
  } catch (err) {
    return toErrorResponse(err);
  }
}
