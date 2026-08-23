import { ROLES } from "@/shared/lib/roles";
import { NextResponse } from "next/server";
import { requireMinRole } from "@/modules/auth/lib/role-guard";
import { guardFailure } from "@/modules/auth/lib/guard-response";
import { getServiceClient } from "@/shared/db/client";
import * as emailDao from "@/shared/db/dao/email.dao";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireMinRole(ROLES.ADMIN);
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  const { id } = await params;
  const supabase = getServiceClient();

  const log = await emailDao.findById(supabase, Number(id));

  if (!log) {
    return NextResponse.json({ error: "Log not found" }, { status: 404 });
  }

  return NextResponse.json(log);
}
