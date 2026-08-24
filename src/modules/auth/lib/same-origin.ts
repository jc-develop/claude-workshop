/**
 * Whether a state-changing request came from somewhere other than this app.
 *
 * The session travels in a cookie, so a form on another site can POST to these
 * routes and the browser will attach it. `Origin` is set by the browser on
 * cross-site requests and cannot be forged by page script, which makes a
 * mismatch against `Host` the cheap half of a CSRF defence. A missing header is
 * allowed through: same-origin GET-like navigations and non-browser callers
 * omit it, and refusing those would break more than it protects — SameSite
 * cookies cover that case.
 *
 * Kept in one place because it is a security check that was copied by hand into
 * each route that needed it, and the copy that was never made is how
 * `/api/auth/email/send` ended up without one.
 */
export function isCrossSite(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).host !== req.headers.get("host");
  } catch {
    // An unparseable Origin is not one this app sent.
    return true;
  }
}
