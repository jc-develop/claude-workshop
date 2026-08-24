import { NextResponse } from "next/server";
import { requireRole } from "@/modules/auth/lib/role-guard";
import { guardFailure } from "@/modules/auth/lib/guard-response";
import { isCrossSite } from "@/modules/auth/lib/same-origin";
import { checkEmailChangeSendLimit } from "@/modules/auth/lib/email-change-limit";
import { getServiceClient } from "@/shared/db/client";
import { getRouteClient } from "@/shared/db/route-client";
import { sendTemplatedEmail } from "@/shared/integrations/email/send-templated";
import { emailChangeAlertTemplate } from "@/shared/integrations/email/templates";
import { appBaseUrl } from "@/shared/lib/app-url";
import { rateLimitSecondsFrom } from "@/shared/lib/auth-error-message";
import { isSameEmail, resendCooldownRemaining } from "@/shared/lib/email";

// The browser used to call GoTrue directly, so the only thing keeping a reload
// or a second tab from re-firing a send into the hourly budget was a countdown
// that died with the page. Reading GoTrue's own pending-change record here makes
// the cooldown authoritative: a send of the address that already has an unread
// link out is refused for the same 60s wherever it comes from.
//
// That cooldown is a double-submit guard, not a rate limit, and was mistaken
// for one. It fires only when the requested address matches the pending one and
// it reads a column that Cancel nulls, so naming a different address or
// pressing Cancel walked past it — and every send that walks past it spends
// from a mail budget the whole project shares. `checkEmailChangeSendLimit` is
// the actual limit, on a ledger of our own that neither trick touches.
export async function POST(request: Request) {
  // The session rides in a cookie, so a form on another site could otherwise
  // start an address change against the signed-in user and spend from the mail
  // budget doing it. Same check the recovery and invite POSTs make.
  if (isCrossSite(request)) {
    return NextResponse.json({ ok: false, error: { status: 400, message: "Bad request" } }, { status: 400 });
  }

  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  let body: { email?: unknown };
  try {
    body = (await request.json()) as { email?: unknown };
  } catch {
    body = {};
  }
  if (typeof body.email !== "string") {
    return NextResponse.json({ ok: false, error: { status: 400, message: "Bad request" } }, { status: 400 });
  }

  const target = body.email.trim();
  // The form refuses this first, but a caller that skips the form must not be
  // let to spend a send on a change that cannot happen.
  if (isSameEmail(target, guard.user.email)) {
    return NextResponse.json(
      { ok: false, error: { status: 400, message: "This is already your email address." } },
      { status: 400 },
    );
  }

  const rb = await getRouteClient();
  const { data } = await rb.auth.getUser();

  const pending = data.user?.new_email?.trim() ?? "";
  if (pending && isSameEmail(pending, target)) {
    // Carried to the client so it can name the wait instead of saying "later".
    // Only this cooldown can: the provider's own hourly window answers a bare
    // 429 with no countdown in it, and the two are otherwise indistinguishable.
    const retryAfter = resendCooldownRemaining(data.user?.email_change_sent_at);
    if (retryAfter > 0) {
      // The empty message is deliberate: the client's error helper maps a 429
      // before it ever reads the body, so nothing here can render as "{ }".
      return NextResponse.json(
        { ok: false, error: { status: 429, message: "", retryAfter } },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  }

  // Past the double-submit guard above, which only knows about the address
  // already pending. This one counts what the caller has actually asked for,
  // whatever addresses they named and whether or not they pressed Cancel in
  // between — the two ways the old gate could be walked around. It sits after
  // the cheap check so an honest double-click costs no ledger row, and before
  // the send so a refusal spends no mail.
  //
  // Cloudflare sets this at the edge and it cannot be spoofed by the client; it
  // is absent under `next dev`, where the per-user limit still applies.
  const ip = request.headers.get("cf-connecting-ip");
  const verdict = await checkEmailChangeSendLimit(getServiceClient(), guard.user.id, ip);
  if (!verdict.allowed) {
    return NextResponse.json(
      { ok: false, error: { status: 429, message: "", retryAfter: verdict.retryAfter } },
      { status: 429, headers: { "Retry-After": String(verdict.retryAfter) } },
    );
  }

  // GoTrue folds `emailRedirectTo` into the confirmation links it mails, so the
  // browser's click ends on the app callback, which exchanges the code and
  // mirrors the confirmed address onto the USER row. Without it the links
  // redirect to bare GOTRUE_SITE_URL and the app row goes stale.
  const { error } = await rb.auth.updateUser({ email: target }, { emailRedirectTo: `${appBaseUrl()}/api/auth/callback` });
  if (error) {
    const status = error.status ?? 400;
    // GoTrue keeps its own gates behind this call — a minimum interval between
    // mails and an hourly budget — and refuses both with a bare 429. Neither
    // reaches the cooldown above, which only ever guards a re-send of the
    // address already pending. `code` tells the two apart and the message
    // carries the interval's countdown, so both travel on rather than arriving
    // as an unexplained "too many attempts".
    const retryAfter = status === 429 ? (rateLimitSecondsFrom(error.message) ?? undefined) : undefined;
    if (status === 429) {
      // The toast can only ever generalise. Which limit fired, and its exact
      // wording, is what says whether to wait or to go raise the project's
      // hourly budget — and the budget is set in the Supabase dashboard, not
      // in this repo, so there is nowhere else to read it off.
      console.warn(`Auth mail refused by GoTrue [${error.code ?? "no code"}]: ${error.message}`);
    }
    return NextResponse.json(
      { ok: false, error: { status, message: error.message, code: error.code, retryAfter } },
      { status, headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined },
    );
  }

  // The new address owns the confirm link now (single-confirm, sheet 03), so
  // the old mailbox only learns of the change from this notice. It must not
  // carry a link: a clickable old-address email is what takeover phishing
  // fakes. A notice that fails to send must not undo an accept that already
  // landed.
  try {
    await sendTemplatedEmail(
      emailChangeAlertTemplate,
      { name: guard.user.full_name || "there", newEmail: target },
      { email: guard.user.email, name: guard.user.full_name || "there" },
    );
  } catch (err) {
    console.error("Old-address email-change notice failed:", err);
  }

  return NextResponse.json({ ok: true });
}
