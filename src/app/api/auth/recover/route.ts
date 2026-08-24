import { NextResponse } from "next/server";
import { getServiceClient } from "@/shared/db/client";
import { emailDeliveryIsLocal } from "@/shared/integrations/email";
import { preparePasswordReset, type RecoverStatus } from "@/modules/auth/lib/password-reset";
import { isCrossSite } from "@/modules/auth/lib/same-origin";

/**
 * Requests a password reset link.
 *
 * Under /api/auth because that prefix is the one the middleware leaves open: a
 * locked-out user has no session, which is the entire point of the request.
 *
 * This route reports whether the address owns an account, which makes it an
 * enumeration oracle by design — a caller can ask it who is registered. The
 * per-IP limit in `preparePasswordReset` is what keeps that from scaling to a
 * mailbox list, so it is applied before the lookup rather than after.
 *
 * Delivery failure is reported as `delivery_failed` (the mail simply did not
 * go) rather than `failed` (the link was never minted). Only the dev console
 * provider hands a `devResetUrl` back, and only when it is the configured
 * transport — a production reply never carries a token.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (isCrossSite(req)) {
    return answer("invalid_request");
  }

  let email: unknown;
  try {
    ({ email } = await req.json());
  } catch {
    return answer("invalid_request");
  }

  if (typeof email !== "string" || !email.includes("@")) {
    return answer("invalid_request");
  }

  // Cloudflare sets this at the edge and it cannot be spoofed by the client;
  // it is absent under `next dev`, where the per-email limit still applies.
  const ip = req.headers.get("cf-connecting-ip");

  const outcome = await preparePasswordReset(getServiceClient(), email, ip);

  if (outcome.status !== "ready") return answer(outcome.status);

  // Awaited, not deferred: the reply now tells the visitor whether the mail
  // went out, which is a fact only the send knows. Deferral once hid the
  // registration-timing oracle, but the body already distinguishes unknown
  // from sent, so nothing awaits adds that the reply does not already say.
  const result = await outcome.deliver();
  if (!result.success) {
    console.error("Password reset delivery failed:", result.error);
    return answer("delivery_failed");
  }

  // The console provider (dev, no capture box configured) mailed no one, so
  // the link is handed back for the form to show instead.
  return answer("sent", emailDeliveryIsLocal() ? { devResetUrl: outcome.resetUrl } : {});
}

function answer(status: RecoverStatus, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ status, ...extra });
}
