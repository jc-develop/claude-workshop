import { NextResponse } from "next/server";
import { requireRole } from "@/modules/auth/lib/role-guard";
import { guardFailure } from "@/modules/auth/lib/guard-response";
import { getServiceClient } from "@/shared/db/client";
import { toErrorResponse } from "@/shared/lib/error-response";
import { loadEventOr403 } from "@/modules/events/lib/event-service";
import { sendEventSurvey } from "@/modules/surveys/lib/survey-service";

const NOT_SENT_MESSAGES: Record<string, string> = {
  not_enabled: "Enable surveys for this event before sending",
  not_finished: "The event has not ended yet",
  no_recipients: "There are no registered attendees to survey",
  expired: "This survey is past its 14-day window and can no longer be sent",
};

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getServiceClient();

  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  try {
    const event = await loadEventOr403(supabase, Number(id), guard.user, "survey");
    const result = await sendEventSurvey(supabase, event);
    if (!result.ok) {
      return NextResponse.json({ error: NOT_SENT_MESSAGES[result.reason] }, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
