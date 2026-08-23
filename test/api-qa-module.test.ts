import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QaServiceError } from "@/modules/courses/qa/lib/service";

const {
  requireRole,
  courseDao,
  facilitatorIsAssigned,
  speakerIsAssignedByUserId,
  findQaModule,
  listQuestions,
  sendQuestion,
  setModuleLock,
} = vi.hoisted(() => ({
  requireRole: vi.fn(),
  courseDao: {
    findModuleById: vi.fn(),
    findCourseByModule: vi.fn(),
    findCourseEvent: vi.fn(),
    setModuleLock: vi.fn(),
  },
  facilitatorIsAssigned: vi.fn(),
  speakerIsAssignedByUserId: vi.fn(),
  findQaModule: vi.fn(),
  listQuestions: vi.fn(),
  sendQuestion: vi.fn(),
  setModuleLock: vi.fn(),
}));

vi.mock("@/modules/auth/lib/role-guard", () => ({ requireRole, requireMinRole: requireRole }));
vi.mock("@/shared/db/client", () => ({ getServiceClient: () => ({}) }));
vi.mock("@/shared/db/dao/course.dao", () => courseDao);
vi.mock("@/shared/db/dao/facilitator.dao", () => ({ isAssigned: facilitatorIsAssigned }));
vi.mock("@/shared/db/dao/speaker.dao", () => ({ isAssignedByUserId: speakerIsAssignedByUserId }));
vi.mock("@/modules/courses/qa/lib/service", async () => {
  const actual = await vi.importActual<typeof import("@/modules/courses/qa/lib/service")>("@/modules/courses/qa/lib/service");
  return { ...actual, findQaModule, listQuestions, sendQuestion, setModuleLock };
});

import { GET, POST, PATCH } from "@/app/api/qa/module/[moduleId]/route";

const params = { params: Promise.resolve({ moduleId: "4" }) };
const ATTENDEE = { id: 12, role: ROLES.ATTENDEE };
const QUESTION = { message: "How do I start?" };
const QA_MODULE = { id: 4, module_type: "qa", is_locked: false, course_id: 7 };

function post(payload: unknown) {
  return new Request("https://app.test/api/qa/module/4", { method: "POST", body: JSON.stringify(payload) });
}

beforeEach(() => {
  vi.clearAllMocks();
  // GET and POST guard bare (any authenticated user); PATCH guards as
  // requireMinRole(ROLES.SPEAKER) through the requireMinRole: requireRole alias.
  requireRole.mockImplementation((role?: string) =>
    Promise.resolve(
      role
        ? { allowed: true, error: null, user: { id: 3, role: ROLES.SPEAKER } }
        : { allowed: true, error: null, user: ATTENDEE },
    ),
  );
  courseDao.findModuleById.mockResolvedValue(QA_MODULE);
  courseDao.findCourseByModule.mockResolvedValue({ id: 7, event_id: 9 });
  courseDao.findCourseEvent.mockResolvedValue({ id: 7, event_id: 9 });
  courseDao.setModuleLock.mockResolvedValue({ id: 4, is_locked: true });
  facilitatorIsAssigned.mockResolvedValue(false);
  speakerIsAssignedByUserId.mockResolvedValue(true);
  findQaModule.mockResolvedValue(QA_MODULE);
  listQuestions.mockResolvedValue({ messages: [] });
  sendQuestion.mockResolvedValue({ id: 88, message: "How do I start?" });
  setModuleLock.mockResolvedValue({ id: 4, is_locked: true });
});

describe("GET /api/qa/module/[moduleId]", () => {
  it("answers 404 for a module that does not exist", async () => {
    findQaModule.mockRejectedValue(new QaServiceError(404, "Module not found"));

    const res = await GET(new Request("https://app.test/api/qa/module/4"), params);

    expect(res.status).toBe(404);
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("refuses a caller with no session", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    const res = await GET(new Request("https://app.test/api/qa/module/4"), params);

    expect(res.status).toBe(401);
    expect(listQuestions).not.toHaveBeenCalled();
  });

  it("returns the module's questions", async () => {
    listQuestions.mockResolvedValue({ messages: [{ id: 1, message: "Hi" }] });

    const res = await GET(new Request("https://app.test/api/qa/module/4"), params);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ messages: [{ id: 1, message: "Hi" }] });
  });
});

describe("POST /api/qa/module/[moduleId]", () => {
  it("rejects an empty question before touching the service", async () => {
    const res = await POST(post({ message: "" }), params);

    expect(res.status).toBe(400);
    expect(sendQuestion).not.toHaveBeenCalled();
  });

  it("refuses to take questions on a module that is not for Q&A", async () => {
    sendQuestion.mockRejectedValue(new QaServiceError(400, "Module is not a Q&A module"));

    const res = await POST(post(QUESTION), params);

    expect(res.status).toBe(400);
  });

  it("refuses a locked Q&A", async () => {
    sendQuestion.mockRejectedValue(new QaServiceError(403, "Q&A is locked"));

    const res = await POST(post(QUESTION), params);

    expect(res.status).toBe(403);
  });

  it("refuses a caller with no session", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    const res = await POST(post(QUESTION), params);

    expect(res.status).toBe(401);
    expect(sendQuestion).not.toHaveBeenCalled();
  });

  it("slows down someone posting faster than the limit", async () => {
    sendQuestion.mockRejectedValue(new QaServiceError(429, "Too many messages. Please slow down."));

    const res = await POST(post(QUESTION), params);

    expect(res.status).toBe(429);
  });

  it("passes the session user and the validated question to the service", async () => {
    const res = await POST(post(QUESTION), params);

    expect(res.status).toBe(201);
    expect(sendQuestion).toHaveBeenCalledWith({}, 4, ATTENDEE.id, QUESTION.message);
  });

  it("posts to the module in the URL even when the body names another", async () => {
    const res = await POST(post({ ...QUESTION, module_id: 999 }), params);

    expect(res.status).toBe(201);
    expect(sendQuestion).toHaveBeenCalledWith({}, 4, ATTENDEE.id, QUESTION.message);
  });

  it("answers 404 when the module points at a course that is gone", async () => {
    sendQuestion.mockRejectedValue(new QaServiceError(404, "Course not found"));

    const res = await POST(post(QUESTION), params);

    expect(res.status).toBe(404);
  });

  it("reports a message that did not save", async () => {
    sendQuestion.mockRejectedValue(new QaServiceError(500, "Failed to send message"));

    const res = await POST(post(QUESTION), params);

    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/qa/module/[moduleId]", () => {
  it("refuses a caller the guard turned away", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Forbidden", user: null });

    const res = await PATCH(new Request("https://app.test/api/qa/module/4", { method: "PATCH", body: "{}" }), params);

    expect(res.status).toBe(403);
    expect(setModuleLock).not.toHaveBeenCalled();
  });

  it("demands the lock state it is being asked to set", async () => {
    const res = await PATCH(new Request("https://app.test/api/qa/module/4", { method: "PATCH", body: "{}" }), params);

    expect(res.status).toBe(400);
    expect(setModuleLock).not.toHaveBeenCalled();
  });

  it("locks the Q&A", async () => {
    const req = new Request("https://app.test/api/qa/module/4", { method: "PATCH", body: JSON.stringify({ is_locked: true }) });

    const res = await PATCH(req, params);

    expect(res.status).toBe(200);
    expect(setModuleLock).toHaveBeenCalledWith({}, 4, true);
  });

  it("reports a lock that did not take", async () => {
    setModuleLock.mockRejectedValue(new QaServiceError(500, "Failed to update lock state"));
    const req = new Request("https://app.test/api/qa/module/4", {
      method: "PATCH",
      body: JSON.stringify({ is_locked: false }),
    });

    const res = await PATCH(req, params);

    expect(res.status).toBe(500);
  });
});
