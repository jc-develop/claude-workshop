import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireRole, findMessageWithUser, deleteMessagesByIds, findById } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  findMessageWithUser: vi.fn(),
  deleteMessagesByIds: vi.fn(),
  findById: vi.fn(),
}));

vi.mock("@/modules/auth/lib/role-guard", () => ({ requireRole }));
vi.mock("@/shared/db/client", () => ({ getServiceClient: () => ({}) }));
vi.mock("@/shared/db/dao/chat.dao", () => ({ findMessageWithUser, deleteMessagesByIds }));
vi.mock("@/shared/db/dao/support-session.dao", () => ({ findById }));

import { DELETE } from "@/app/api/support/[messageId]/route";

const ATTENDEE = { id: 12, role: ROLES.ATTENDEE };

function del(id: string) {
  return DELETE(new Request(`https://app.test/api/support/${id}`), {
    params: Promise.resolve({ messageId: id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ allowed: true, error: null, user: ATTENDEE });
  findMessageWithUser.mockResolvedValue(null);
  deleteMessagesByIds.mockResolvedValue(true);
  findById.mockResolvedValue(null);
});

describe("DELETE /api/support/[messageId]", () => {
  it("refuses a caller with no session", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    expect((await del("5")).status).toBe(401);
    expect(deleteMessagesByIds).not.toHaveBeenCalled();
  });

  it("404s when the message does not exist", async () => {
    expect((await del("5")).status).toBe(404);
    expect(deleteMessagesByIds).not.toHaveBeenCalled();
  });

  // Answered as a message that is not there. The ids run in sequence, so a
  // refusal that admitted the row existed was a way to count the project's
  // support traffic without reading any of it.
  it("hides a bystander's message behind the same 404 as a missing one", async () => {
    findMessageWithUser.mockResolvedValue({ id: 5, user_id: 9, recipient_user_id: 9 });
    findById.mockResolvedValue(null);

    const res = await del("5");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Message not found" });
    expect(deleteMessagesByIds).not.toHaveBeenCalled();
  });

  it("answers a missing message with the very same body", async () => {
    findMessageWithUser.mockResolvedValue(null);

    const res = await del("5");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Message not found" });
  });

  it("lets the sender remove their own message", async () => {
    findMessageWithUser.mockResolvedValue({ id: 5, user_id: 12, recipient_user_id: null });

    expect((await del("5")).status).toBe(200);
    expect(deleteMessagesByIds).toHaveBeenCalledWith(expect.anything(), [5]);
  });

  it("reports a failed delete as a server error", async () => {
    deleteMessagesByIds.mockResolvedValue(false);
    findMessageWithUser.mockResolvedValue({ id: 5, user_id: 12, recipient_user_id: null });

    expect((await del("5")).status).toBe(500);
  });
});
