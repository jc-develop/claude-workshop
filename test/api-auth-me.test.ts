import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above the module body, so the doubles it closes over must
// be created inside vi.hoisted rather than as plain consts.
const { requireRole, getCurrentUserId, updateUser, findByUserId, update, create } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentUserId: vi.fn(),
  updateUser: vi.fn(),
  findByUserId: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/modules/auth/lib/session", () => ({ getCurrentUserId }));
vi.mock("@/modules/auth/lib/role-guard", () => ({ requireRole }));
vi.mock("@/shared/db/client", () => ({ getServiceClient: () => ({}) }));
vi.mock("@/shared/db/dao/user.dao", () => ({ updateUser }));
vi.mock("@/shared/db/dao/speaker.dao", () => ({ findByUserId, update, create }));

import { GET, PATCH } from "@/app/api/auth/me/route";

function patch(body: unknown) {
  return new Request("https://app.test/api/auth/me", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const speaker = {
  id: 5,
  role: ROLES.SPEAKER,
  full_name: "Ada",
  email: "ada@example.com",
  profile_image_url: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ allowed: true, error: null, user: speaker });
  getCurrentUserId.mockResolvedValue("auth_123");
  updateUser.mockResolvedValue({ ...speaker });
});

describe("GET /api/auth/me", () => {
  it("returns 401 without a session and performs no lookups", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    const res = await GET();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthenticated" });
    expect(findByUserId).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/auth/me speaker profile guard", () => {
  it("forbids every non-speaker role from writing designation or bio", async () => {
    for (const role of [ROLES.ATTENDEE, ROLES.FACILITATOR, ROLES.ADMIN, ROLES.SUPER_ADMIN]) {
      requireRole.mockResolvedValue({ allowed: true, error: null, user: { ...speaker, role } });

      const res = await PATCH(patch({ designation: "CTO" }));

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
      expect(updateUser).not.toHaveBeenCalled();
    }
  });

  it("forbids every non-speaker role from writing links", async () => {
    for (const role of [ROLES.ATTENDEE, ROLES.FACILITATOR, ROLES.ADMIN, ROLES.SUPER_ADMIN]) {
      requireRole.mockResolvedValue({ allowed: true, error: null, user: { ...speaker, role } });

      const res = await PATCH(patch({ linkedin_url: "https://linkedin.com/in/ada" }));

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
      expect(updateUser).not.toHaveBeenCalled();
    }
  });

  it("lets a speaker update an existing speaker profile", async () => {
    findByUserId.mockResolvedValue({ id: 9, user_id: 5, designation: "Old", bio: null });
    update.mockResolvedValue({ id: 9, user_id: 5, designation: "CTO", bio: "Leads." });

    const res = await PATCH(
      patch({ designation: "CTO", bio: "Leads.", linkedin_url: "https://linkedin.com/in/ada", twitter_url: null }),
    );

    expect(res.status).toBe(200);
    // Speaker fields live on their own row, so the USER update carries none of
    // them. It used to be handed the whole body and quietly ignore the rest.
    expect(updateUser).toHaveBeenCalledWith(expect.anything(), "auth_123", {});
    expect(update).toHaveBeenCalledWith(expect.anything(), 9, {
      designation: "CTO",
      bio: "Leads.",
      linkedin_url: "https://linkedin.com/in/ada",
      twitter_url: null,
      github_url: null,
      website_url: null,
    });
  });

  it("creates the speaker profile row when the speaker has none yet", async () => {
    findByUserId.mockResolvedValue(null);
    create.mockResolvedValue({ id: 12, user_id: 5, designation: "CTO", bio: null });

    const res = await PATCH(patch({ designation: "CTO", bio: null, website_url: "https://ada.dev" }));

    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.anything(), {
      user_id: 5,
      designation: "CTO",
      bio: null,
      linkedin_url: null,
      twitter_url: null,
      github_url: null,
      website_url: "https://ada.dev",
    });
  });
});

// The address belongs to the auth identity and is only ever copied across once
// Supabase confirms it. This route writing one would let a caller claim an
// address they had not proved they own, so it ignores the field entirely.
describe("PATCH /api/auth/me does not write the email", () => {
  it("drops an address a caller tries to set on itself", async () => {
    const res = await PATCH(patch({ email: "grace@example.com" }));

    expect(res.status).toBe(200);
    expect(updateUser).toHaveBeenCalledWith(expect.anything(), "auth_123", {});
  });

  it("drops someone else's address just the same", async () => {
    const res = await PATCH(patch({ email: "admin@company.com" }));

    expect(res.status).toBe(200);
    expect(updateUser).toHaveBeenCalledWith(expect.anything(), "auth_123", {});
  });

  it("keeps writing the fields it does own alongside a dropped address", async () => {
    const res = await PATCH(patch({ full_name: "Ada Lovelace", email: "grace@example.com" }));

    expect(res.status).toBe(200);
    expect(updateUser).toHaveBeenCalledWith(expect.anything(), "auth_123", { full_name: "Ada Lovelace" });
  });

  it("leaves a request that does not touch the email alone", async () => {
    const res = await PATCH(patch({ full_name: "Ada Lovelace" }));

    expect(res.status).toBe(200);
    expect(updateUser).toHaveBeenCalledWith(expect.anything(), "auth_123", { full_name: "Ada Lovelace" });
  });
});

describe("PATCH /api/auth/me validates the body", () => {
  it("refuses a name of the wrong type rather than writing it", async () => {
    const res = await PATCH(patch({ full_name: 42 }));

    expect(res.status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("refuses an empty name", async () => {
    const res = await PATCH(patch({ full_name: "   " }));

    expect(res.status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("refuses a body that is not an object", async () => {
    const res = await PATCH(patch("full_name=Ada"));

    expect(res.status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON at all", async () => {
    const res = await PATCH(new Request("https://app.test/api/auth/me", { method: "PATCH", body: "not json" }));

    expect(res.status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });

  // A speaker field of the wrong type used to reach the DAO as-is, because the
  // annotation that described this body was erased before the request arrived.
  it("refuses a speaker field of the wrong type before touching the profile", async () => {
    const res = await PATCH(patch({ bio: { nested: true } }));

    expect(res.status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("still tells an explicit null from an absent field", async () => {
    findByUserId.mockResolvedValue({ id: 3 });
    update.mockResolvedValue({ id: 3 });

    const res = await PATCH(patch({ bio: null }));

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.anything(), 3, expect.objectContaining({ bio: null }));
  });
});

// The columns are text/unbounded varchar and no form sets a maxLength, so a
// ceiling invented in the schema would refuse a profile that saved fine before
// it existed. Validation here is about the shape of the body, not its size.
describe("PATCH /api/auth/me does not invent a length limit", () => {
  it("saves a long name", async () => {
    const res = await PATCH(patch({ full_name: "A".repeat(500) }));

    expect(res.status).toBe(200);
    expect(updateUser).toHaveBeenCalledWith(expect.anything(), "auth_123", { full_name: "A".repeat(500) });
  });

  it("saves a long bio and designation", async () => {
    findByUserId.mockResolvedValue({ id: 3 });
    update.mockResolvedValue({ id: 3 });

    const res = await PATCH(patch({ bio: "B".repeat(5000), designation: "C".repeat(500) }));

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      3,
      expect.objectContaining({ bio: "B".repeat(5000), designation: "C".repeat(500) }),
    );
  });
});
