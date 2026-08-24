import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  requireRole,
  requireMinRole,
  requireModuleAccess,
  getQuestion,
  deleteQuestion,
  findMessageWithUser,
  sessionFindById,
  speakerFindById,
  speakerUpdate,
  speakerRemove,
  deleteFromStorage,
} = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireMinRole: vi.fn(),
  requireModuleAccess: vi.fn(),
  getQuestion: vi.fn(),
  deleteQuestion: vi.fn(),
  findMessageWithUser: vi.fn(),
  sessionFindById: vi.fn(),
  speakerFindById: vi.fn(),
  speakerUpdate: vi.fn(),
  speakerRemove: vi.fn(),
  deleteFromStorage: vi.fn(),
}));

vi.mock("@/modules/auth/lib/role-guard", () => ({ requireRole, requireMinRole }));
vi.mock("@/shared/db/client", () => ({ getServiceClient: () => ({}) }));
vi.mock("@/shared/db/dao/chat.dao", () => ({
  findMessageWithUser,
}));
vi.mock("@/modules/courses/qa/lib/service", async () => {
  const actual = await vi.importActual<typeof import("@/modules/courses/qa/lib/service")>("@/modules/courses/qa/lib/service");
  return { ...actual, getQuestion, deleteQuestion };
});
vi.mock("@/shared/db/dao/support-session.dao", () => ({ findById: sessionFindById }));
vi.mock("@/modules/courses/lib/course-access", () => ({ requireModuleAccess }));
vi.mock("@/shared/db/dao/speaker.dao", () => ({
  findById: speakerFindById,
  update: speakerUpdate,
  remove: speakerRemove,
}));
vi.mock("@/shared/integrations/storage/service", () => ({ deleteFromStorage }));

import { GET as GET_QA, DELETE as DELETE_QA } from "@/app/api/qa/message/[messageId]/route";
import { GET as GET_SUPPORT } from "@/app/api/support/[messageId]/route";
import { PATCH as PATCH_SPEAKER, DELETE as DELETE_SPEAKER } from "@/app/api/speakers/[id]/route";
import { QaServiceError } from "@/modules/courses/qa/lib/service";

const req = () => new Request("https://app.test/x");
const msgParams = { params: Promise.resolve({ messageId: "42" }) };
const speakerParams = { params: Promise.resolve({ id: "7" }) };

const user = (id: number, role: string) => ({ id, role, full_name: "U", email: "u@example.com", profile_image_url: null });
const speakerProfile = (userId: number) => ({ id: 7, user_id: userId, bio: null, photo_url: null, designation: null });

function patch(body: unknown) {
  return new Request("https://app.test/api/speakers/7", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteFromStorage.mockResolvedValue(undefined);
});

describe("DELETE /api/qa/message/[messageId]", () => {
  it("answers 401 before any lookups", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    const res = await DELETE_QA(req(), msgParams);

    expect(res.status).toBe(401);
    expect(deleteQuestion).not.toHaveBeenCalled();
  });

  it("answers 404 for a message that does not exist", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(1, ROLES.ATTENDEE) });
    deleteQuestion.mockRejectedValue(new QaServiceError(404, "Message not found"));

    const res = await DELETE_QA(req(), msgParams);

    expect(res.status).toBe(404);
  });

  it("asks the service to take down the asker's own question", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(5, ROLES.ATTENDEE) });
    deleteQuestion.mockResolvedValue(undefined);

    const res = await DELETE_QA(req(), msgParams);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(requireModuleAccess).not.toHaveBeenCalled();
    expect(deleteQuestion).toHaveBeenCalledWith({}, 42, expect.objectContaining({ id: 5, role: ROLES.ATTENDEE }));
  });

  it("asks the service to remove someone else's question as team", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(9, ROLES.SPEAKER) });
    deleteQuestion.mockResolvedValue(undefined);

    const res = await DELETE_QA(req(), msgParams);

    expect(res.status).toBe(200);
    expect(deleteQuestion).toHaveBeenCalledWith({}, 42, expect.objectContaining({ id: 9, role: ROLES.SPEAKER }));
  });

  it("refuses a caller who is neither the asker nor on the course's team", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(9, ROLES.FACILITATOR) });
    deleteQuestion.mockRejectedValue(new QaServiceError(403, "Forbidden"));

    const res = await DELETE_QA(req(), msgParams);

    expect(res.status).toBe(403);
  });
});

describe("GET /api/qa/message/[messageId]", () => {
  const joinedQuestion = (over: Partial<{ user_id: number }> = {}) => ({
    id: 42,
    event_id: 9,
    module_id: 4,
    user_id: 5,
    message: "Question?",
    created_at: "2026-08-05T09:00:00Z",
    updated_at: "2026-08-05T09:00:00Z",
    ...over,
    USER: { full_name: "Ana", role: ROLES.ATTENDEE },
  });

  it("answers 401 before any lookups", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    const res = await GET_QA(req(), msgParams);

    expect(res.status).toBe(401);
    expect(getQuestion).not.toHaveBeenCalled();
  });

  it("answers 404 for a message that does not exist", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(1, ROLES.ATTENDEE) });
    getQuestion.mockRejectedValue(new QaServiceError(404, "Message not found"));

    const res = await GET_QA(req(), msgParams);

    expect(res.status).toBe(404);
  });

  it("returns the pre-joined question to any authenticated user", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(1, ROLES.ATTENDEE) });
    getQuestion.mockResolvedValue(joinedQuestion());

    const res = await GET_QA(req(), msgParams);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: 42,
      module_id: 4,
      USER: { full_name: "Ana", role: ROLES.ATTENDEE },
    });
  });
});

describe("GET /api/support/[messageId]", () => {
  const supportMessage = (
    over: Partial<{ user_id: number; recipient_user_id: number | null; session_id: number | null }> = {},
  ) => ({
    id: 42,
    user_id: 5,
    recipient_user_id: 9,
    session_id: 11,
    support_type: "general",
    event_id: null,
    message: "Need help",
    sent_at: "2026-08-05T09:00:00Z",
    updated_at: "2026-08-05T09:00:00Z",
    ...over,
    USER: { full_name: "U", role: ROLES.ATTENDEE },
  });

  it("answers 401 before any lookups", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    const res = await GET_SUPPORT(req(), msgParams);

    expect(res.status).toBe(401);
    expect(findMessageWithUser).not.toHaveBeenCalled();
  });

  it("answers 404 for a message that does not exist", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(1, ROLES.ATTENDEE) });
    findMessageWithUser.mockResolvedValue(null);

    const res = await GET_SUPPORT(req(), msgParams);

    expect(res.status).toBe(404);
  });

  it("lets a sender read their own message", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(5, ROLES.ATTENDEE) });
    findMessageWithUser.mockResolvedValue(supportMessage());

    const res = await GET_SUPPORT(req(), msgParams);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: 42, USER: { full_name: "U" } });
    expect(sessionFindById).not.toHaveBeenCalled();
  });

  it("lets the recipient of the conversation read it", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(9, ROLES.FACILITATOR) });
    findMessageWithUser.mockResolvedValue(supportMessage());

    const res = await GET_SUPPORT(req(), msgParams);

    expect(res.status).toBe(200);
  });

  it("lets an admin read any message", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(12, ROLES.ADMIN) });
    findMessageWithUser.mockResolvedValue(supportMessage());

    const res = await GET_SUPPORT(req(), msgParams);

    expect(res.status).toBe(200);
  });

  it("lets the facilitator assigned to the case read it", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(15, ROLES.FACILITATOR) });
    findMessageWithUser.mockResolvedValue(supportMessage());
    sessionFindById.mockResolvedValue({ id: 11, user_id: 5, assigned_to: 15 });

    const res = await GET_SUPPORT(req(), msgParams);

    expect(res.status).toBe(200);
  });

  // Indistinguishable from a message that is not there: the ids are
  // sequential, so telling the two apart counted the support traffic.
  it("refuses a bystander with the same answer a missing message gets", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(99, ROLES.FACILITATOR) });
    findMessageWithUser.mockResolvedValue(supportMessage());
    sessionFindById.mockResolvedValue({ id: 11, user_id: 5, assigned_to: 15 });

    const refused = await GET_SUPPORT(req(), msgParams);

    findMessageWithUser.mockResolvedValue(null);
    const missing = await GET_SUPPORT(req(), msgParams);

    expect(refused.status).toBe(404);
    expect(missing.status).toBe(404);
    await expect(refused.json()).resolves.toEqual(await missing.json());
  });
});

describe("PATCH /api/speakers/[id]", () => {
  it("lets an admin edit any profile", async () => {
    requireMinRole.mockResolvedValue({ allowed: true, error: null, user: user(12, ROLES.ADMIN) });
    speakerFindById.mockResolvedValue(speakerProfile(5));
    speakerUpdate.mockResolvedValue(speakerProfile(5));

    const res = await PATCH_SPEAKER(patch({ bio: "x" }), speakerParams);

    expect(res.status).toBe(200);
  });

  it("lets a facilitator edit a profile that is not theirs", async () => {
    requireMinRole.mockResolvedValue({ allowed: true, error: null, user: user(9, ROLES.FACILITATOR) });
    speakerFindById.mockResolvedValue(speakerProfile(5));
    speakerUpdate.mockResolvedValue(speakerProfile(5));

    const res = await PATCH_SPEAKER(patch({ bio: "x" }), speakerParams);

    expect(res.status).toBe(200);
  });

  it("lets a speaker edit their own profile", async () => {
    requireMinRole.mockResolvedValue({ allowed: false, error: "Forbidden", user: null });
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(7, ROLES.SPEAKER) });
    speakerFindById.mockResolvedValue(speakerProfile(7));
    speakerUpdate.mockResolvedValue(speakerProfile(7));

    const res = await PATCH_SPEAKER(patch({ bio: "x" }), speakerParams);

    expect(res.status).toBe(200);
  });

  it("refuses a speaker editing someone else's profile", async () => {
    requireMinRole.mockResolvedValue({ allowed: false, error: "Forbidden", user: null });
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(7, ROLES.SPEAKER) });
    speakerFindById.mockResolvedValue(speakerProfile(5));

    const res = await PATCH_SPEAKER(patch({ bio: "x" }), speakerParams);

    expect(res.status).toBe(403);
    expect(speakerUpdate).not.toHaveBeenCalled();
  });

  it("refuses a caller who is neither staff nor a speaker", async () => {
    requireMinRole.mockResolvedValue({ allowed: false, error: "Forbidden", user: null });
    requireRole.mockResolvedValue({ allowed: false, error: "Forbidden", user: null });

    const res = await PATCH_SPEAKER(patch({ bio: "x" }), speakerParams);

    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/speakers/[id]", () => {
  it("answers 401 before any lookups", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    const res = await DELETE_SPEAKER(req(), speakerParams);

    expect(res.status).toBe(401);
    expect(speakerFindById).not.toHaveBeenCalled();
  });

  it("answers 404 for a profile that does not exist", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(12, ROLES.ADMIN) });
    speakerFindById.mockResolvedValue(null);

    const res = await DELETE_SPEAKER(req(), speakerParams);

    expect(res.status).toBe(404);
  });

  it("lets the profile owner delete their own profile", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(7, ROLES.SPEAKER) });
    speakerFindById.mockResolvedValue(speakerProfile(7));
    speakerRemove.mockResolvedValue(true);

    const res = await DELETE_SPEAKER(req(), speakerParams);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("lets an admin delete anyone's profile", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(12, ROLES.ADMIN) });
    speakerFindById.mockResolvedValue(speakerProfile(5));
    speakerRemove.mockResolvedValue(true);

    const res = await DELETE_SPEAKER(req(), speakerParams);

    expect(res.status).toBe(200);
  });

  it("refuses a facilitator who is not the owner", async () => {
    requireRole.mockResolvedValue({ allowed: true, error: null, user: user(9, ROLES.FACILITATOR) });
    speakerFindById.mockResolvedValue(speakerProfile(5));

    const res = await DELETE_SPEAKER(req(), speakerParams);

    expect(res.status).toBe(403);
    expect(speakerRemove).not.toHaveBeenCalled();
  });
});
