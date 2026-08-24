import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireRole, getRouteClient, routeRpc } = vi.hoisted(() => {
  const routeRpc = vi.fn();
  return {
    requireRole: vi.fn(),
    getRouteClient: vi.fn(async () => ({ rpc: routeRpc })),
    routeRpc,
  };
});

vi.mock("@/modules/auth/lib/role-guard", () => ({ requireRole }));
vi.mock("@/shared/db/route-client", () => ({ getRouteClient }));

import { POST } from "@/app/api/auth/email/cancel/route";

const req = () => new Request("https://app.test/api/auth/email/cancel", { method: "POST" });

const USER = {
  id: 1,
  role: ROLES.ATTENDEE,
  full_name: "Ada",
  email: "ada@example.com",
  profile_image_url: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ allowed: true, error: null, user: USER });
  routeRpc.mockResolvedValue({ data: null, error: null });
});

describe("POST /api/auth/email/cancel", () => {
  it("refuses an anonymous caller", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    const res = await POST(req());

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthenticated" });
    expect(routeRpc).not.toHaveBeenCalled();
  });

  it("calls the cancel helper and answers ok", async () => {
    const res = await POST(req());

    expect(routeRpc).toHaveBeenCalledWith("cancel_pending_email_change");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("answers 500 when the provider RPC errors", async () => {
    routeRpc.mockResolvedValue({ data: null, error: { message: "function gone" } });

    const res = await POST(req());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: { status: 500, message: "function gone" },
    });
  });

  it("answers ok again on a repeat cancel", async () => {
    expect((await POST(req())).status).toBe(200);
    expect((await POST(req())).status).toBe(200);
    expect(routeRpc).toHaveBeenCalledTimes(2);
  });
});
