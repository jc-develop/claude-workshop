import { NextResponse } from "next/server";
import { requireRole } from "@/modules/auth/lib/role-guard";
import { guardFailure } from "@/modules/auth/lib/guard-response";
import { isCrossSite } from "@/modules/auth/lib/same-origin";
import { getRouteClient } from "@/shared/db/route-client";

// No body: the caller's session identifies them. Idempotent by construction —
// sheet 01's helper deletes whatever token rows exist for the caller and clears
// the pending fields, so a repeat cancel is a no-op that still answers ok.
export async function POST(request: Request) {
  if (isCrossSite(request)) {
    return NextResponse.json({ ok: false, error: { status: 400, message: "Bad request" } }, { status: 400 });
  }

  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  const rb = await getRouteClient();
  const { error } = await rb.rpc("cancel_pending_email_change");
  if (error) {
    return NextResponse.json({ ok: false, error: { status: 500, message: error.message } }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
