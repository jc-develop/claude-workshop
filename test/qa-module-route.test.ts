import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

const { requireRole, findCourseByModule, setModuleLock, isAssigned, sendQuestion } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  findCourseByModule: vi.fn(),
  setModuleLock: vi.fn(),
  isAssigned: vi.fn(),
  sendQuestion: vi.fn(),
}));

vi.mock("@/modules/auth/lib/role-guard", () => ({ requireRole, requireMinRole: requireRole }));
vi.mock("@/modules/auth/lib/guard-response", () => ({
  guardFailure: (guard: { error: string }) => NextResponse.json({ error: guard.error }, { status: 403 }),
}));
vi.mock("@/shared/db/client", () => ({ getServiceClient: () => ({}) }));
vi.mock("@/shared/db/dao/course.dao", () => ({ findCourseByModule }));
vi.mock("@/shared/db/dao/facilitator.dao", () => ({ isAssigned }));
vi.mock("@/shared/db/dao/speaker.dao", () => ({ isAssignedByUserId: vi.fn() }));
vi.mock("@/modules/courses/qa/lib/service", async () => {
  const actual = await vi.importActual<typeof import("@/modules/courses/qa/lib/service")>("@/modules/courses/qa/lib/service");
  return { ...actual, setModuleLock, sendQuestion };
});

import { POST, PATCH } from "@/app/api/qa/module/[moduleId]/route";

const speaker = {
  allowed: true,
  error: null,
  user: { id: 8, role: ROLES.SPEAKER, full_name: "Sam", email: "sam@example.com", profile_image_url: null },
};

// Module 2 is a qa module on course 1, whose event is 100.
const qaModule = { id: 2, course_id: 1, module_type: "qa", is_locked: false, sequence_order: 1 };
const course = { id: 1, event_id: 100 };

function jsonRequest(method: string, body: unknown): Request {
  return new Request("https://app.test/api/qa/module/2", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // POST guards bare (any authenticated attendee), PATCH guards as
  // requireMinRole(ROLES.SPEAKER) through the requireMinRole: requireRole alias.
  requireRole.mockImplementation((role?: string) =>
    Promise.resolve(
      role
        ? speaker
        : {
            allowed: true,
            error: null,
            user: { id: 5, role: ROLES.ATTENDEE, full_name: "Ana", email: "ana@example.com", profile_image_url: null },
          },
    ),
  );
  findCourseByModule.mockResolvedValue(course);
  setModuleLock.mockResolvedValue({ ...qaModule, is_locked: true });
  isAssigned.mockResolvedValue(false);
  sendQuestion.mockResolvedValue({ id: 9, module_id: 2, message: "hello" });
});

describe("POST /api/qa/module/[moduleId]", () => {
  it("files the question as the authenticated attendee", async () => {
    const res = await POST(jsonRequest("POST", { message: "hello" }), {
      params: Promise.resolve({ moduleId: "2" }),
    });

    expect(res.status).toBe(201);
    expect(sendQuestion).toHaveBeenCalledWith(expect.anything(), 2, 5, "hello");
  });

  it("400s a message with no text", async () => {
    const res = await POST(jsonRequest("POST", { message: "" }), {
      params: Promise.resolve({ moduleId: "2" }),
    });

    expect(res.status).toBe(400);
    expect(sendQuestion).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/qa/module/[moduleId]", () => {
  it("403s an unassigned speaker without touching the lock", async () => {
    const res = await PATCH(jsonRequest("PATCH", { is_locked: true }), {
      params: Promise.resolve({ moduleId: "2" }),
    });

    expect(res.status).toBe(403);
    expect(setModuleLock).not.toHaveBeenCalled();
  });

  it("403s an unassigned facilitator without touching the lock", async () => {
    requireRole.mockResolvedValue({
      allowed: true,
      error: null,
      user: { id: 9, role: ROLES.FACILITATOR, full_name: "Fay", email: "fay@example.com", profile_image_url: null },
    });

    const res = await PATCH(jsonRequest("PATCH", { is_locked: true }), {
      params: Promise.resolve({ moduleId: "2" }),
    });

    expect(res.status).toBe(403);
    expect(setModuleLock).not.toHaveBeenCalled();
  });

  it("400s when is_locked is missing", async () => {
    requireRole.mockResolvedValue({
      allowed: true,
      error: null,
      user: { id: 9, role: ROLES.FACILITATOR, full_name: "Fay", email: "fay@example.com", profile_image_url: null },
    });
    isAssigned.mockResolvedValue(true);

    const res = await PATCH(jsonRequest("PATCH", {}), { params: Promise.resolve({ moduleId: "2" }) });

    expect(res.status).toBe(400);
    expect(setModuleLock).not.toHaveBeenCalled();
  });

  it("flips the lock for an assigned facilitator", async () => {
    requireRole.mockResolvedValue({
      allowed: true,
      error: null,
      user: { id: 9, role: ROLES.FACILITATOR, full_name: "Fay", email: "fay@example.com", profile_image_url: null },
    });
    isAssigned.mockResolvedValue(true);

    const res = await PATCH(jsonRequest("PATCH", { is_locked: true }), {
      params: Promise.resolve({ moduleId: "2" }),
    });

    expect(res.status).toBe(200);
    expect(setModuleLock).toHaveBeenCalledWith(expect.anything(), 2, true);
  });
});
