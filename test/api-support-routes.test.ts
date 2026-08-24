import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireRole, requireMinRole, chatDao } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireMinRole: vi.fn(),
  chatDao: {
    listRecentSessions: vi.fn(),
    listRecentSupportMessages: vi.fn(),
    listActiveSessions: vi.fn(),
    findActiveSession: vi.fn(),
    createSession: vi.fn(),
    claimSession: vi.fn(),
    relinquishSession: vi.fn(),
    endSession: vi.fn(),
    sendMessage: vi.fn(),
    deleteSessionsExcept: vi.fn(),
    deleteSession: vi.fn(),
    deleteMessagesByUser: vi.fn(),
    deleteMessagesByRecipient: vi.fn(),
  },
}));

vi.mock("@/modules/auth/lib/role-guard", () => ({ requireRole, requireMinRole }));
vi.mock("@/shared/db/client", () => ({ getServiceClient: () => ({}) }));
vi.mock("@/shared/db/dao/chat.dao", () => chatDao);

import { GET as listUsers } from "@/app/api/support/users/route";
import { GET as listSessions, POST as sessionAction } from "@/app/api/support/sessions/route";
import { DELETE as destroySession } from "@/app/api/support/sessions/[userId]/route";

const ATTENDEE = { id: 12, role: ROLES.ATTENDEE };
const FACILITATOR = { id: 3, role: ROLES.FACILITATOR };
const ADMIN = { id: 1, role: ROLES.ADMIN };

function action(payload: unknown) {
  return new Request("https://app.test/api/support/sessions", { method: "POST", body: JSON.stringify(payload) });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ allowed: true, error: null, user: FACILITATOR });
  requireMinRole.mockResolvedValue({ allowed: true, error: null, user: FACILITATOR });
  chatDao.listRecentSessions.mockResolvedValue([]);
  chatDao.listRecentSupportMessages.mockResolvedValue([]);
  chatDao.listActiveSessions.mockResolvedValue([]);
  chatDao.findActiveSession.mockResolvedValue(null);
  chatDao.createSession.mockResolvedValue({ id: 50, status: "active" });
  chatDao.claimSession.mockResolvedValue({ id: 50, status: "active" });
  chatDao.relinquishSession.mockResolvedValue({ id: 50, status: "active" });
  chatDao.endSession.mockResolvedValue({ id: 50, status: "ended_by_facilitator" });
  chatDao.sendMessage.mockResolvedValue({ id: 100 });
  chatDao.deleteSessionsExcept.mockResolvedValue(true);
  chatDao.deleteSession.mockResolvedValue(true);
  chatDao.deleteMessagesByUser.mockResolvedValue(true);
  chatDao.deleteMessagesByRecipient.mockResolvedValue(true);
});

describe("GET /api/support/users", () => {
  it("refuses an attendee", async () => {
    requireMinRole.mockResolvedValue({ allowed: false, error: "Forbidden", user: null });

    const res = await listUsers();

    expect(res.status).toBe(403);
    expect(chatDao.listRecentSupportMessages).not.toHaveBeenCalled();
  });

  it("refuses a caller with no session", async () => {
    requireMinRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    expect((await listUsers()).status).toBe(401);
  });

  it("lists one entry per asker, newest conversation first", async () => {
    chatDao.listRecentSessions.mockResolvedValue([
      { id: 2, user_id: 20, status: "active" },
      { id: 1, user_id: 21, status: "ended" },
    ]);
    chatDao.listRecentSupportMessages.mockResolvedValue([
      {
        user_id: 20,
        recipient_user_id: null,
        message: "newer",
        sent_at: "2026-08-05T10:00:00Z",
        session_id: 2,
        USER: { full_name: "Ana", role: ROLES.ATTENDEE },
      },
      {
        user_id: 21,
        recipient_user_id: null,
        message: "older",
        sent_at: "2026-08-05T09:00:00Z",
        session_id: 1,
        USER: { full_name: "Ben", role: ROLES.ATTENDEE },
      },
    ]);

    const { users } = await (await listUsers()).json();

    expect(users.map((u: { full_name: string }) => u.full_name)).toEqual(["Ana", "Ben"]);
    expect(users[0]).toMatchObject({ user_id: 20, last_message: "newer", session_active: true });
    expect(users[1].session_active).toBe(false);
  });

  it("leaves staff out of the queue of people waiting for help", async () => {
    // A facilitator answering support is not themselves an asker.
    chatDao.listRecentSessions.mockResolvedValue([{ id: 3, user_id: 30, status: "active" }]);
    chatDao.listRecentSupportMessages.mockResolvedValue([
      {
        user_id: 30,
        recipient_user_id: null,
        message: "on it",
        sent_at: "2026-08-05T10:00:00Z",
        session_id: 3,
        USER: { full_name: "Staffer", role: ROLES.FACILITATOR },
      },
    ]);

    const { users } = await (await listUsers()).json();

    expect(users).toEqual([]);
  });

  it("ignores messages from a conversation the asker has already left behind", async () => {
    chatDao.listRecentSessions.mockResolvedValue([{ id: 9, user_id: 40, status: "active" }]);
    chatDao.listRecentSupportMessages.mockResolvedValue([
      {
        user_id: 40,
        recipient_user_id: null,
        message: "from an old session",
        sent_at: "2026-08-05T10:00:00Z",
        session_id: 8,
        USER: { full_name: "Cara", role: ROLES.ATTENDEE },
      },
    ]);

    const { users } = await (await listUsers()).json();

    expect(users).toEqual([]);
  });

  it("shows the staff reply as the latest word when it is newer", async () => {
    chatDao.listRecentSessions.mockResolvedValue([{ id: 5, user_id: 50, status: "active" }]);
    chatDao.listRecentSupportMessages.mockResolvedValue([
      {
        user_id: 50,
        recipient_user_id: null,
        message: "my question",
        sent_at: "2026-08-05T10:00:00Z",
        session_id: 5,
        USER: { full_name: "Dee", role: ROLES.ATTENDEE },
      },
      {
        user_id: 3,
        recipient_user_id: 50,
        message: "our answer",
        sent_at: "2026-08-05T11:00:00Z",
        session_id: 5,
        USER: { full_name: "Staffer", role: ROLES.FACILITATOR },
      },
    ]);

    const { users } = await (await listUsers()).json();

    expect(users[0]).toMatchObject({ user_id: 50, last_message: "our answer" });
  });

  it("falls back to a name rather than rendering nothing for a missing user row", async () => {
    chatDao.listRecentSessions.mockResolvedValue([{ id: 6, user_id: 60, status: "active" }]);
    chatDao.listRecentSupportMessages.mockResolvedValue([
      { user_id: 60, recipient_user_id: null, message: "hello", sent_at: "2026-08-05T10:00:00Z", session_id: 6, USER: null },
    ]);

    const { users } = await (await listUsers()).json();

    expect(users[0].full_name).toBe("Unknown");
  });
});

describe("GET /api/support/sessions", () => {
  it("refuses an attendee", async () => {
    requireMinRole.mockResolvedValue({ allowed: false, error: "Forbidden", user: null });

    expect((await listSessions()).status).toBe(403);
  });

  it("lists the active sessions for staff", async () => {
    chatDao.listActiveSessions.mockResolvedValue([{ id: 1 }]);

    const res = await listSessions();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ sessions: [{ id: 1 }] });
  });
});

describe("POST /api/support/sessions", () => {
  it("refuses a caller with no session", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    expect((await sessionAction(action({ action: "start" }))).status).toBe(401);
  });

  it("lets anyone start their own conversation", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ATTENDEE });

    const res = await sessionAction(action({ action: "start" }));

    expect(res.status).toBe(200);
    expect(chatDao.createSession).toHaveBeenCalledWith({}, 12, "general");
  });

  it("returns the conversation already open instead of starting a second", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ATTENDEE });
    chatDao.findActiveSession.mockResolvedValue({ id: 77, status: "active" });

    const res = await sessionAction(action({ action: "start" }));

    await expect(res.json()).resolves.toEqual({ session: { id: 77, status: "active" } });
    expect(chatDao.createSession).not.toHaveBeenCalled();
  });

  it("reports a conversation that could not be started", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ATTENDEE });
    chatDao.createSession.mockResolvedValue(null);

    expect((await sessionAction(action({ action: "start" }))).status).toBe(500);
  });

  it("stops an attendee ending somebody else's conversation", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ATTENDEE });

    const res = await sessionAction(action({ action: "end", user_id: 99 }));

    expect(res.status).toBe(403);
    expect(chatDao.endSession).not.toHaveBeenCalled();
  });

  it("needs admin, not facilitator, to end a conversation for someone else", async () => {
    // Support is the admin queue; facilitators stay out of other people's cases.
    const res = await sessionAction(action({ action: "end", user_id: 99 }));

    expect(res.status).toBe(403);
  });

  it("lets an admin end an unclaimed general conversation for someone else", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ADMIN });
    // An unclaimed case can be closed by any admin so the queue stays cleanable.
    chatDao.findActiveSession.mockResolvedValue({ id: 7, case_number: 100, assigned_to: null });

    const res = await sessionAction(action({ action: "end", user_id: 99 }));

    expect(res.status).toBe(200);
    expect(chatDao.endSession).toHaveBeenCalledWith({}, 99, "general", { ownerId: null });
  });

  it("lets the assigned handler end a claimed general conversation", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ADMIN });
    chatDao.findActiveSession.mockResolvedValue({ id: 7, case_number: 100, assigned_to: 1 });

    const res = await sessionAction(action({ action: "end", user_id: 99 }));

    expect(res.status).toBe(200);
    expect(chatDao.endSession).toHaveBeenCalledWith({}, 99, "general", { ownerId: 1 });
  });

  it("stops an admin ending a case that belongs to another handler", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ADMIN });
    chatDao.findActiveSession.mockResolvedValue({ id: 7, case_number: 100, assigned_to: 2 });

    const res = await sessionAction(action({ action: "end", user_id: 99 }));

    expect(res.status).toBe(403);
    expect(chatDao.endSession).not.toHaveBeenCalled();
  });

  it("reports when the target has no active case to end", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ADMIN });

    const res = await sessionAction(action({ action: "end", user_id: 99 }));

    expect(res.status).toBe(404);
    expect(chatDao.endSession).not.toHaveBeenCalled();
  });

  it("refuses to start a conversation on somebody else's behalf", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ADMIN });

    const res = await sessionAction(action({ action: "start", user_id: 99 }));

    expect(res.status).toBe(400);
    expect(chatDao.createSession).not.toHaveBeenCalled();
  });

  it("answers with null rather than failing when there was nothing to end", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ATTENDEE });
    chatDao.endSession.mockResolvedValue(null);

    const res = await sessionAction(action({}));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ session: null });
  });

  it("lets an admin claim an unclaimed general case", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ADMIN });

    const res = await sessionAction(action({ action: "claim", user_id: 99 }));

    expect(res.status).toBe(200);
    expect(chatDao.claimSession).toHaveBeenCalledWith({}, 99, "general", 1);
  });

  it("refuses an attendee claiming a case", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ATTENDEE });

    const res = await sessionAction(action({ action: "claim", user_id: 99 }));

    expect(res.status).toBe(403);
    expect(chatDao.claimSession).not.toHaveBeenCalled();
  });

  it("refuses to claim your own session", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ADMIN });

    const res = await sessionAction(action({ action: "claim", user_id: 1 }));

    expect(res.status).toBe(400);
    expect(chatDao.claimSession).not.toHaveBeenCalled();
  });

  it("reports a case that somebody else already claimed", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ADMIN });
    chatDao.claimSession.mockResolvedValue(null);

    const res = await sessionAction(action({ action: "claim", user_id: 99 }));

    expect(res.status).toBe(409);
  });

  it("lets the assigned handler relinquish a case", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ADMIN });

    const res = await sessionAction(action({ action: "relinquish", user_id: 99 }));

    expect(res.status).toBe(200);
    expect(chatDao.relinquishSession).toHaveBeenCalledWith({}, 99, "general", 1);
  });

  it("refuses to relinquish a case the caller does not own", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ADMIN });
    chatDao.relinquishSession.mockResolvedValue(null);

    const res = await sessionAction(action({ action: "relinquish", user_id: 99 }));

    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/support/sessions/[userId]", () => {
  const del = (userId = "9") =>
    destroySession(new Request(`https://app.test/api/support/sessions/${userId}`, { method: "DELETE" }), {
      params: Promise.resolve({ userId }),
    });

  const purgedNothing = () => {
    expect(chatDao.deleteSession).not.toHaveBeenCalled();
    expect(chatDao.deleteMessagesByUser).not.toHaveBeenCalled();
    expect(chatDao.deleteMessagesByRecipient).not.toHaveBeenCalled();
  };

  it("refuses a caller with no session and deletes nothing", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    const res = await del();

    expect(res.status).toBe(401);
    purgedNothing();
  });

  // The deletes are hard and cover every message the target ever sent or
  // received, so this was the most destructive action in the slice behind the
  // lowest floor in it — and no assignment check, unlike claiming or ending
  // one case.
  it("refuses a facilitator erasing somebody else's history", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: FACILITATOR });

    const res = await del("9");

    expect(res.status).toBe(403);
    purgedNothing();
  });

  it("refuses an attendee erasing somebody else's history", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ATTENDEE });

    const res = await del("9");

    expect(res.status).toBe(403);
    purgedNothing();
  });

  it("lets anyone clear their own", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ATTENDEE });

    const res = await del(String(ATTENDEE.id));

    expect(res.status).toBe(200);
    expect(chatDao.deleteSession).toHaveBeenCalledWith({}, ATTENDEE.id);
  });

  it("purges the target's session and every message row for an admin", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ADMIN });

    const res = await del();

    expect(res.status).toBe(200);
    expect(chatDao.deleteSession).toHaveBeenCalledWith({}, 9);
    expect(chatDao.deleteMessagesByUser).toHaveBeenCalledWith({}, 9);
    expect(chatDao.deleteMessagesByRecipient).toHaveBeenCalledWith({}, 9);
  });

  it("refuses a userId that is not a positive integer", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: ADMIN });

    const res = await del("abc");

    expect(res.status).toBe(400);
    purgedNothing();
  });
});
