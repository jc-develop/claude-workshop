import { NextResponse } from "next/server";
import { getRouteClient } from "@/shared/db/route-client";
import { getServiceClient } from "@/shared/db/client";
import { appBaseUrl } from "@/shared/lib/app-url";
import { isAuthToken } from "@/modules/auth/lib/auth-token";
import { isCrossSite } from "@/modules/auth/lib/same-origin";
import { confirmPasswordReset } from "@/modules/auth/lib/password-reset";
import { logAuditEvent } from "@/modules/audit/lib/log-audit-event";
import * as userDao from "@/shared/db/dao/user.dao";

/**
 * Spends the emailed token and sets the new password.
 *
 * A form POST rather than fetch, for the same reason the invitation is one: the
 * token stays in a request body instead of a URL, where a referrer header or a
 * proxy log could carry it away, and the page works before JavaScript loads.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (isCrossSite(req)) {
    return failed("invalid_reset");
  }

  const form = await req.formData();
  const token = form.get("token");
  const password = form.get("password");
  const confirm = form.get("confirm");

  if (!isAuthToken(token) || typeof password !== "string") {
    return failed("invalid_reset");
  }

  // Checked before the token is spent, so a mistyped confirmation costs a retry
  // on the same link rather than a whole second reset email.
  if (password !== confirm) {
    return failed("mismatch", token);
  }

  const supabase = await getRouteClient();
  const result = await confirmPasswordReset(supabase, token, password);

  if (!result.ok) {
    // personal_password is deliberately not retryable: it can only be judged
    // after the token has been verified, and verifying is what spends it.
    const error =
      result.reason === "weak_password"
        ? "weak_password"
        : result.reason === "personal_password"
          ? "personal_password"
          : "invalid_reset";
    return failed(error, token);
  }

  // Service client: the audit trail is written under the app's own identity,
  // not the session the reset just created.
  const service = getServiceClient();
  const user = await userDao.findByAuthId(service, result.authUserId);
  if (user) {
    await logAuditEvent(service, user.id, "auth.password_reset_completed", "user", user.id);
  }

  // 303 so the browser follows with a GET: refreshing the destination must not
  // resubmit a token that has already been spent.
  return NextResponse.redirect(`${appBaseUrl()}/events`, 303);
}

/** Recoverable at the form, because the token is still unspent in these cases. */
const RETRYABLE = new Set(["weak_password", "mismatch"]);

/**
 * A retryable failure bounces back to the form with the token intact. Anything
 * else lands on sign-in, because an invalid or already-spent token has no form
 * left to return to.
 */
function failed(error: string, token?: string): NextResponse {
  const target =
    RETRYABLE.has(error) && token
      ? `${appBaseUrl()}/reset-password?token=${token}&error=${error}`
      : `${appBaseUrl()}/sign-in?error=${error}`;
  return NextResponse.redirect(target, 303);
}
