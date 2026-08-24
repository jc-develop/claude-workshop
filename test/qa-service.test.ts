import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  findModuleById,
  findCourseEvent,
  findCourseByModule,
  setModuleLock,
  listQuestionsByModule,
  sendQuestion,
  findById,
  findByIdWithUser,
  deleteByIds,
  facilitatorIsAssigned,
  speakerIsAssignedByUserId,
  userHasCourseAccess,
} = vi.hoisted(() => ({
  findModuleById: vi.fn(),
  findCourseEvent: vi.fn(),
  findCourseByModule: vi.fn(),
  setModuleLock: vi.fn(),
  userHasCourseAccess: vi.fn(),
  listQuestionsByModule: vi.fn(),
  sendQuestion: vi.fn(),
  findById: vi.fn(),
  findByIdWithUser: vi.fn(),
  deleteByIds: vi.fn(),
  facilitatorIsAssigned: vi.fn(),
  speakerIsAssignedByUserId: vi.fn(),
}));

vi.mock("@/shared/db/dao/course.dao", () => ({
  findModuleById,
  findCourseEvent,
  findCourseByModule,
  setModuleLock,
  userHasCourseAccess,
}));
vi.mock("@/modules/courses/qa/db/qa-message.dao", () => ({
  listQuestionsByModule,
  sendQuestion,
  findById,
  findByIdWithUser,
  deleteByIds,
}));
vi.mock("@/shared/db/dao/facilitator.dao", () => ({ isAssigned: facilitatorIsAssigned }));
vi.mock("@/shared/db/dao/speaker.dao", () => ({ isAssignedByUserId: speakerIsAssignedByUserId }));
// The service's transitive course-access import loads @/shared/db/client at
// module scope, whose createClient needs env vars. The client is passed in by
// callers, so this module is never used here.
vi.mock("@/shared/db/client", () => ({ getServiceClient: () => ({}) }));

import {
  listQuestions,
  getQuestion,
  sendQuestion as serviceSendQuestion,
  setModuleLock as serviceSetModuleLock,
  deleteQuestion,
  findQaModule,
  QaServiceError,
} from "@/modules/courses/qa/lib/service";
import { RATE_LIMIT_MAX } from "@/shared/lib/rate-limit";

const supabase = {} as never;
const QA_MODULE = { id: 4, module_type: "qa", is_locked: false, course_id: 7 };
const COURSE = { id: 7, event_id: 9 };
// An attendee holding a ticket to the course's event — the ordinary caller.
const VIEWER = { id: 12, role: ROLES.ATTENDEE };

async function rejectStatus(promise: Promise<unknown>, status: number): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(QaServiceError);
    expect((err as QaServiceError).status).toBe(status);
    return (err as QaServiceError).message;
  }
  throw new Error("expected the call to throw");
}

beforeEach(() => {
  vi.clearAllMocks();
  findModuleById.mockResolvedValue(QA_MODULE);
  findCourseEvent.mockResolvedValue(COURSE);
  findCourseByModule.mockResolvedValue(COURSE);
  setModuleLock.mockResolvedValue({ ...QA_MODULE, is_locked: true });
  listQuestionsByModule.mockResolvedValue({ messages: [], nextCursor: null });
  sendQuestion.mockResolvedValue({ id: 88, message: "Hi" });
  findById.mockResolvedValue({ id: 42, module_id: 4, user_id: 5 });
  findByIdWithUser.mockResolvedValue({ id: 42, module_id: 4, user_id: 5, message: "Hi" });
  deleteByIds.mockResolvedValue(true);
  facilitatorIsAssigned.mockResolvedValue(false);
  speakerIsAssignedByUserId.mockResolvedValue(false);
  userHasCourseAccess.mockResolvedValue(true);
});

describe("listQuestions", () => {
  it("asks the DAO for the module's cursor feed at the listing size", async () => {
    listQuestionsByModule.mockResolvedValue({ messages: [{ id: 1, message: "Hi" }], nextCursor: "abc" });

    const result = await listQuestions(supabase, 4, VIEWER);

    expect(listQuestionsByModule).toHaveBeenCalledWith(supabase, 4, { before: null, after: null, limit: 50 });
    expect(result).toEqual({ messages: [{ id: 1, message: "Hi" }], nextCursor: "abc" });
  });
});

describe("getQuestion", () => {
  it("answers 404 for a message that does not exist", async () => {
    findByIdWithUser.mockResolvedValue(null);

    const message = await rejectStatus(getQuestion(supabase, 42, VIEWER), 404);

    expect(message).toBe("Message not found");
  });

  it("returns the pre-joined message", async () => {
    const joined = { id: 42, USER: { full_name: "Ana", role: ROLES.ATTENDEE } };
    findByIdWithUser.mockResolvedValue(joined);

    await expect(getQuestion(supabase, 42, VIEWER)).resolves.toEqual(joined);
  });
});

describe("sendQuestion", () => {
  it("answers 404 for a module that does not exist", async () => {
    findModuleById.mockResolvedValue(null);

    const message = await rejectStatus(serviceSendQuestion(supabase, 4, VIEWER, "Hi"), 404);

    expect(message).toBe("Module not found");
    expect(sendQuestion).not.toHaveBeenCalled();
  });

  it("refuses a module that is not for Q&A", async () => {
    findModuleById.mockResolvedValue({ ...QA_MODULE, module_type: "lessons" });

    const message = await rejectStatus(serviceSendQuestion(supabase, 4, VIEWER, "Hi"), 400);

    expect(message).toBe("Module is not a Q&A module");
    expect(sendQuestion).not.toHaveBeenCalled();
  });

  it("refuses a locked Q&A", async () => {
    findModuleById.mockResolvedValue({ ...QA_MODULE, is_locked: true });

    const message = await rejectStatus(serviceSendQuestion(supabase, 4, VIEWER, "Hi"), 403);

    expect(message).toBe("Q&A is locked");
    expect(sendQuestion).not.toHaveBeenCalled();
  });

  it("slows down a module posting faster than the limit", async () => {
    listQuestionsByModule.mockResolvedValue({
      messages: Array.from({ length: RATE_LIMIT_MAX }, (_, i) => ({ id: i })),
      nextCursor: null,
    });

    const message = await rejectStatus(serviceSendQuestion(supabase, 4, VIEWER, "Hi"), 429);

    expect(message).toBe("Too many messages. Please slow down.");
    expect(sendQuestion).not.toHaveBeenCalled();
  });

  it("counts the module's own recent questions against the shared window", async () => {
    await serviceSendQuestion(supabase, 4, VIEWER, "Hi");

    expect(listQuestionsByModule).toHaveBeenCalledWith(supabase, 4, {
      before: null,
      after: expect.any(String),
      limit: RATE_LIMIT_MAX,
    });
  });

  it("answers 404 when the module points at a course that is gone", async () => {
    findCourseEvent.mockResolvedValue(null);

    const message = await rejectStatus(serviceSendQuestion(supabase, 4, VIEWER, "Hi"), 404);

    expect(message).toBe("Course not found");
    expect(sendQuestion).not.toHaveBeenCalled();
  });

  it("reports a message that did not save", async () => {
    sendQuestion.mockResolvedValue(null);

    const message = await rejectStatus(serviceSendQuestion(supabase, 4, VIEWER, "Hi"), 500);

    expect(message).toBe("Failed to send message");
  });

  it("files the question against the event that owns the course", async () => {
    await serviceSendQuestion(supabase, 4, VIEWER, "Hi");

    expect(sendQuestion).toHaveBeenCalledWith(supabase, {
      event_id: 9,
      module_id: 4,
      user_id: 12,
      message: "Hi",
    });
  });
});

describe("setModuleLock", () => {
  it("delegates the flip to the course DAO", async () => {
    const result = await serviceSetModuleLock(supabase, 4, true);

    expect(setModuleLock).toHaveBeenCalledWith(supabase, 4, true);
    expect(result).toEqual({ ...QA_MODULE, is_locked: true });
  });

  it("reports a lock that did not take", async () => {
    setModuleLock.mockResolvedValue(null);

    const message = await rejectStatus(serviceSetModuleLock(supabase, 4, true), 500);

    expect(message).toBe("Failed to update lock state");
  });
});

describe("deleteQuestion", () => {
  it("answers 404 for a message that does not exist", async () => {
    findById.mockResolvedValue(null);

    const message = await rejectStatus(deleteQuestion(supabase, 42, { id: 5, role: ROLES.ATTENDEE }), 404);

    expect(message).toBe("Message not found");
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  it("lets the asker take their own question down without an access check", async () => {
    findById.mockResolvedValue({ id: 42, module_id: 4, user_id: 5 });

    await deleteQuestion(supabase, 42, { id: 5, role: ROLES.ATTENDEE });

    expect(findCourseByModule).not.toHaveBeenCalled();
    expect(deleteByIds).toHaveBeenCalledWith(supabase, [42]);
  });

  it("lets an admin remove someone else's question without consulting the team tables", async () => {
    await deleteQuestion(supabase, 42, { id: 9, role: ROLES.ADMIN });

    expect(findCourseByModule).toHaveBeenCalledWith(supabase, 4);
    expect(facilitatorIsAssigned).not.toHaveBeenCalled();
    expect(speakerIsAssignedByUserId).not.toHaveBeenCalled();
    expect(deleteByIds).toHaveBeenCalledWith(supabase, [42]);
  });

  it("lets a speaker assigned to the event's team remove it", async () => {
    speakerIsAssignedByUserId.mockResolvedValue(true);

    await deleteQuestion(supabase, 42, { id: 9, role: ROLES.SPEAKER });

    expect(speakerIsAssignedByUserId).toHaveBeenCalledWith(supabase, 9, 9);
    expect(deleteByIds).toHaveBeenCalledWith(supabase, [42]);
  });

  it("lets a facilitator assigned to the event's team remove it", async () => {
    facilitatorIsAssigned.mockResolvedValue(true);

    await deleteQuestion(supabase, 42, { id: 9, role: ROLES.FACILITATOR });

    expect(facilitatorIsAssigned).toHaveBeenCalledWith(supabase, 9, 9);
    expect(deleteByIds).toHaveBeenCalledWith(supabase, [42]);
  });

  it("refuses someone who is neither the asker nor on the course's team", async () => {
    const message = await rejectStatus(deleteQuestion(supabase, 42, { id: 9, role: ROLES.SPEAKER }), 403);

    expect(message).toBe("Forbidden");
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  it("answers 404 when the message's module has no course", async () => {
    findCourseByModule.mockResolvedValue(null);

    const message = await rejectStatus(deleteQuestion(supabase, 42, { id: 9, role: ROLES.ADMIN }), 404);

    expect(message).toBe("Module not found");
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  it("reports a deletion that did not save", async () => {
    deleteByIds.mockResolvedValue(false);

    const message = await rejectStatus(deleteQuestion(supabase, 42, { id: 5, role: ROLES.ATTENDEE }), 500);

    expect(message).toBe("Failed to delete message");
  });
});

describe("findQaModule", () => {
  it("answers 404 for a module that does not exist", async () => {
    findModuleById.mockResolvedValue(null);

    const message = await rejectStatus(findQaModule(supabase, 4), 404);

    expect(message).toBe("Module not found");
  });
});

// Module ids are sequential, so an unscoped read was a way to walk every
// event's Q&A — questions and asker names included — from any account.
describe("Q&A entitlement", () => {
  const outsider = { id: 99, role: ROLES.ATTENDEE };

  beforeEach(() => {
    userHasCourseAccess.mockResolvedValue(false);
  });

  it("refuses a listing to someone with no ticket and no assignment", async () => {
    const message = await rejectStatus(listQuestions(supabase, 4, outsider), 403);

    expect(message).toBe("Forbidden");
    expect(listQuestionsByModule).not.toHaveBeenCalled();
  });

  it("refuses a single message to the same caller, and reads nothing back", async () => {
    const message = await rejectStatus(getQuestion(supabase, 42, outsider), 403);

    expect(message).toBe("Forbidden");
  });

  it("refuses a post to a room the caller is not in", async () => {
    const message = await rejectStatus(serviceSendQuestion(supabase, 4, outsider, "Hi"), 403);

    expect(message).toBe("Forbidden");
    expect(sendQuestion).not.toHaveBeenCalled();
  });

  it("answers 404 when the module belongs to no course at all", async () => {
    findCourseByModule.mockResolvedValue(null);

    const message = await rejectStatus(listQuestions(supabase, 4, outsider), 404);

    expect(message).toBe("Module not found");
  });

  it("admits a ticket holder", async () => {
    userHasCourseAccess.mockResolvedValue(true);

    await expect(listQuestions(supabase, 4, outsider)).resolves.toEqual({ messages: [], nextCursor: null });
    expect(userHasCourseAccess).toHaveBeenCalledWith(supabase, outsider.id, COURSE.id);
  });

  it("admits staff without asking about tickets", async () => {
    await expect(listQuestions(supabase, 4, { id: 3, role: ROLES.FACILITATOR })).resolves.toBeTruthy();
    expect(userHasCourseAccess).not.toHaveBeenCalled();
  });
});
