import { NextResponse } from "next/server";
import { getRouteClient } from "@/shared/db/route-client";
import { appBaseUrl } from "@/shared/lib/app-url";
import { isAuthToken } from "@/modules/auth/lib/auth-token";
import { isCrossSite } from "@/modules/auth/lib/same-origin";

/**
 * Accepts the invitation the page at /invite offers.
 *
 * Under /api/auth because that prefix is the one the middleware leaves open:
 * an invitee has no session yet, which is the entire point of the request.
 */
export async function POST(req: Request): Promise<NextResponse> {
  // A cross-site form could otherwise submit an invitation of the attacker's
  // choosing and leave the victim's browser signed in as somebody else. The
  // token is unguessable, so this is the only exposure the POST adds.
  if (isCrossSite(req)) {
    return invalid();
  }

  const form = await req.formData();
  const token = form.get("token");

  if (!isAuthToken(token)) {
    return invalid();
  }

  const supabase = await getRouteClient();

  // Verifying here rather than redirecting the browser to Supabase keeps the
  // token in a request body instead of a URL, where a referrer header or a
  // proxy log could carry it away.
  const { error } = await supabase.auth.verifyOtp({ type: "invite", token_hash: token });

  if (error) {
    return invalid();
  }

  // 303, so the browser follows with a GET: a refresh of the destination must
  // not resubmit a token that has already been spent.
  return NextResponse.redirect(`${appBaseUrl()}/email-verified`, 303);
}

function invalid(): NextResponse {
  return NextResponse.redirect(`${appBaseUrl()}/sign-in?error=invalid_invite`, 303);
}
