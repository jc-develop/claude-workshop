import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { requireRole, getRouteClient, routeAuth, sendTemplatedEmail, checkEmailChangeSendLimit, getServiceClient } = vi.hoisted(
  () => {
    const routeAuth = { getUser: vi.fn(), updateUser: vi.fn() };
    return {
      requireRole: vi.fn(),
      getRouteClient: vi.fn(async () => ({ auth: routeAuth })),
      routeAuth,
      sendTemplatedEmail: vi.fn(),
      checkEmailChangeSendLimit: vi.fn(),
      getServiceClient: vi.fn(() => ({ service: true })),
    };
  },
);

vi.mock("@/modules/auth/lib/role-guard", () => ({ requireRole }));
vi.mock("@/modules/auth/lib/email-change-limit", () => ({ checkEmailChangeSendLimit }));
vi.mock("@/shared/db/client", () => ({ getServiceClient }));
vi.mock("@/shared/db/route-client", () => ({ getRouteClient }));
vi.mock("@/shared/integrations/email/send-templated", () => ({ sendTemplatedEmail }));

import { POST } from "@/app/api/auth/email/send/route";
import { emailChangeAlertTemplate } from "@/shared/integrations/email/templates";

const USER = {
  id: 1,
  role: ROLES.ATTENDEE,
  full_name: "Ada",
  email: "ada@example.com",
  profile_image_url: null,
};

function send(email: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.test/api/auth/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ email }),
  });
}

function goTrueUser(overrides: Record<string, unknown> = {}) {
  return { id: "auth_1", email: USER.email, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ allowed: true, error: null, user: USER });
  routeAuth.getUser.mockResolvedValue({ data: { user: goTrueUser() }, error: null });
  routeAuth.updateUser.mockResolvedValue({ error: null, data: { user: goTrueUser() } });
  sendTemplatedEmail.mockResolvedValue({ success: true });
  checkEmailChangeSendLimit.mockResolvedValue({ allowed: true });
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("POST /api/auth/email/send", () => {
  it("refuses an anonymous caller", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthenticated" });
    expect(routeAuth.updateUser).not.toHaveBeenCalled();
    expect(sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it("rejects a request without a usable email before touching GoTrue", async () => {
    const res = await POST(send(undefined));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ ok: false, error: { status: 400, message: "Bad request" } });
    expect(routeAuth.getUser).not.toHaveBeenCalled();
    expect(routeAuth.updateUser).not.toHaveBeenCalled();
    expect(sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it("treats an unparseable body as a bad request instead of crashing the route", async () => {
    const res = await POST(
      new Request("https://app.test/api/auth/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ ok: false, error: { status: 400, message: "Bad request" } });
    expect(routeAuth.getUser).not.toHaveBeenCalled();
    expect(routeAuth.updateUser).not.toHaveBeenCalled();
    expect(sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it("refuses the address already on the account, whatever the casing or padding", async () => {
    for (const typed of [USER.email, "  ADA@example.com  "]) {
      const res = await POST(send(typed));

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        ok: false,
        error: { status: 400, message: "This is already your email address." },
      });
      expect(routeAuth.updateUser).not.toHaveBeenCalled();
      expect(sendTemplatedEmail).not.toHaveBeenCalled();
    }
  });

  it("429s a re-send of a pending address inside the cooldown window", async () => {
    routeAuth.getUser.mockResolvedValue({
      data: {
        user: goTrueUser({
          new_email: "new@example.com",
          email_change_sent_at: new Date(Date.now() - 10_000).toISOString(),
        }),
      },
      error: null,
    });

    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(429);
    // ~50s left of the 60s window; carried so the client can name the wait.
    await expect(res.json()).resolves.toEqual({ ok: false, error: { status: 429, message: "", retryAfter: 50 } });
    expect(res.headers.get("Retry-After")).toBe("50");
    expect(routeAuth.updateUser).not.toHaveBeenCalled();
    expect(sendTemplatedEmail).not.toHaveBeenCalled();
  });

  // The elapsed seconds are measured from a field GoTrue does not always send.
  // Reading a missing one as zero gated the address for good: the window never
  // widened, and only a cancel clears the pending record it was gating on.
  it("sends when the pending change has no recorded send time", async () => {
    routeAuth.getUser.mockResolvedValue({
      data: { user: goTrueUser({ new_email: "new@example.com" }) },
      error: null,
    });

    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(200);
    expect(routeAuth.updateUser).toHaveBeenCalled();
  });

  it("sends when the recorded send time cannot be parsed", async () => {
    routeAuth.getUser.mockResolvedValue({
      data: { user: goTrueUser({ new_email: "new@example.com", email_change_sent_at: "not-a-date" }) },
      error: null,
    });

    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(200);
    expect(routeAuth.updateUser).toHaveBeenCalled();
  });

  it("sends once the cooldown window has actually passed", async () => {
    routeAuth.getUser.mockResolvedValue({
      data: {
        user: goTrueUser({
          new_email: "new@example.com",
          email_change_sent_at: new Date(Date.now() - 61_000).toISOString(),
        }),
      },
      error: null,
    });

    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(200);
    expect(routeAuth.updateUser).toHaveBeenCalled();
  });

  it("lets a different address supersede a pending change instead of cooldown-gating it", async () => {
    routeAuth.getUser.mockResolvedValue({
      data: {
        user: goTrueUser({ new_email: "stale@example.com", email_change_sent_at: new Date().toISOString() }),
      },
      error: null,
    });

    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(routeAuth.updateUser).toHaveBeenCalledWith(
      { email: "new@example.com" },
      { emailRedirectTo: "http://localhost:3000/api/auth/callback" },
    );
  });

  // The cooldown deliberately lets a different address through (correcting a
  // typo should not cost a minute), which is exactly why it cannot be the only
  // gate — the limiter is what stands behind that door.
  it("refuses a send the limiter rejects, and spends no mail doing it", async () => {
    checkEmailChangeSendLimit.mockResolvedValue({ allowed: false, retryAfter: 840 });

    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ ok: false, error: { status: 429, message: "", retryAfter: 840 } });
    expect(res.headers.get("Retry-After")).toBe("840");
    expect(routeAuth.updateUser).not.toHaveBeenCalled();
    expect(sendTemplatedEmail).not.toHaveBeenCalled();
  });

  it("counts the caller and their origin, never the address they asked for", async () => {
    await POST(send("new@example.com", { "cf-connecting-ip": "203.0.113.7" }));

    expect(checkEmailChangeSendLimit).toHaveBeenCalledWith({ service: true }, USER.id, "203.0.113.7");
  });

  // Absent under `next dev` and behind any host that is not Cloudflare, where
  // the per-user limit has to carry the whole load.
  it("still consults the limiter when no origin header is present", async () => {
    await POST(send("new@example.com"));

    expect(checkEmailChangeSendLimit).toHaveBeenCalledWith({ service: true }, USER.id, null);
  });

  // A double-click on one address is what the cooldown is for; making it spend
  // a ledger row would let an honest user throttle themselves.
  it("does not reach the limiter when the cooldown already refused", async () => {
    routeAuth.getUser.mockResolvedValue({
      data: {
        user: goTrueUser({
          new_email: "new@example.com",
          email_change_sent_at: new Date(Date.now() - 10_000).toISOString(),
        }),
      },
      error: null,
    });

    await POST(send("new@example.com"));

    expect(checkEmailChangeSendLimit).not.toHaveBeenCalled();
  });

  it("passes a provider rejection through verbatim for the client helper to map", async () => {
    routeAuth.updateUser.mockResolvedValue({ error: { status: 422, message: "Email already in use" } });

    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: { status: 422, message: "Email already in use" },
    });
    expect(sendTemplatedEmail).not.toHaveBeenCalled();
  });

  // GoTrue's own gates sit behind updateUser and never reach the cooldown
  // above, which only guards a re-send of the address already pending. Its
  // minimum-interval refusal states the wait in prose and nowhere else.
  it("carries the wait GoTrue named in its own 429 through to the client", async () => {
    routeAuth.updateUser.mockResolvedValue({
      error: {
        status: 429,
        code: "over_email_send_rate_limit",
        message: "For security purposes, you can only request this after 41 seconds.",
      },
    });

    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        status: 429,
        code: "over_email_send_rate_limit",
        message: "For security purposes, you can only request this after 41 seconds.",
        retryAfter: 41,
      },
    });
    expect(res.headers.get("Retry-After")).toBe("41");
  });

  // The hourly budget names no number. The code is what lets the client say
  // which limit was hit instead of implying a wait it cannot measure.
  it("carries the rate-limit code when the hourly budget refuses with no number", async () => {
    routeAuth.updateUser.mockResolvedValue({
      error: { status: 429, code: "over_email_send_rate_limit", message: "email rate limit exceeded" },
    });

    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: { status: 429, code: "over_email_send_rate_limit", message: "email rate limit exceeded" },
    });
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("answers ok when the send lands", async () => {
    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(routeAuth.updateUser).toHaveBeenCalledWith(
      { email: "new@example.com" },
      { emailRedirectTo: "http://localhost:3000/api/auth/callback" },
    );
  });

  it("normalises a trailing slash off the configured app URL in the redirect target", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.test/";

    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(routeAuth.updateUser).toHaveBeenCalledWith(
      { email: "new@example.com" },
      { emailRedirectTo: "https://app.test/api/auth/callback" },
    );
  });

  it("notifies the old address that the email is changing", async () => {
    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(200);
    expect(sendTemplatedEmail).toHaveBeenCalledTimes(1);
    expect(sendTemplatedEmail).toHaveBeenCalledWith(
      emailChangeAlertTemplate,
      { name: "Ada", newEmail: "new@example.com" },
      { email: "ada@example.com", name: "Ada" },
    );
    expect(sendTemplatedEmail.mock.invocationCallOrder[0]).toBeGreaterThan(routeAuth.updateUser.mock.invocationCallOrder[0]);
  });

  it("still ok when the notice reports it could not send", async () => {
    sendTemplatedEmail.mockResolvedValue({ success: false });

    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("still ok and logs when the notice throws", async () => {
    sendTemplatedEmail.mockRejectedValue(new Error("provider down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(send("new@example.com"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});

describe("POST /api/auth/email/send refuses a cross-site caller", () => {
  it("stops a form on another origin before the session is even read", async () => {
    const res = await POST(send("new@example.com", { origin: "https://evil.example", host: "app.test" }));

    expect(res.status).toBe(400);
    expect(requireRole).not.toHaveBeenCalled();
    expect(routeAuth.updateUser).not.toHaveBeenCalled();
    expect(checkEmailChangeSendLimit).not.toHaveBeenCalled();
  });

  it("lets the app's own form through", async () => {
    routeAuth.getUser.mockResolvedValue({ data: { user: goTrueUser() } });
    checkEmailChangeSendLimit.mockResolvedValue({ allowed: true });
    routeAuth.updateUser.mockResolvedValue({ error: null });

    const res = await POST(send("new@example.com", { origin: "https://app.test", host: "app.test" }));

    expect(res.status).toBe(200);
    expect(routeAuth.updateUser).toHaveBeenCalled();
  });
});
