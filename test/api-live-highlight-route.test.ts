import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireRole, courseDao, canManageEvent, resolveCourseGrant, liveSessionService } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  courseDao: { findCourseEvent: vi.fn() },
  canManageEvent: vi.fn(),
  resolveCourseGrant: vi.fn(),
  liveSessionService: {
    getCourseHighlight: vi.fn(),
    setCourseHighlight: vi.fn(),
    clearCourseHighlight: vi.fn(),
  },
}));

vi.mock("@/modules/auth/lib/role-guard", () => ({ requireRole }));
vi.mock("@/shared/db/dao/course.dao", () => courseDao);
vi.mock("@/modules/courses/lib/course-access", () => ({ canManageEvent }));
vi.mock("@/modules/courses/lib/course-entitlement", () => ({ resolveCourseGrant }));
vi.mock("@/modules/courses/lib/live-session-service", () => liveSessionService);
vi.mock("@/shared/db/client", () => ({ getServiceClient: () => ({}) }));

import { CourseServiceError } from "@/modules/courses/lib/course-errors";
import { GET, POST, DELETE } from "@/app/api/courses/[courseId]/live/highlight/route";

const params = { params: Promise.resolve({ courseId: "9" }) };
const SPEAKER = { id: 3, role: ROLES.SPEAKER };
const EMPTY_STATE = { highlighted_lesson_id: null, updated_by: null, updated_at: null, lesson: null };

function post(payload: unknown) {
  return new Request("https://app.test/api/courses/9/live/highlight", { method: "POST", body: JSON.stringify(payload) });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ allowed: true, error: null, user: SPEAKER });
  courseDao.findCourseEvent.mockResolvedValue({ id: 7, event_id: 1 });
  canManageEvent.mockResolvedValue(true);
  resolveCourseGrant.mockResolvedValue("staff");
  liveSessionService.getCourseHighlight.mockResolvedValue(EMPTY_STATE);
  liveSessionService.setCourseHighlight.mockResolvedValue({ highlighted_lesson_id: 4 });
  liveSessionService.clearCourseHighlight.mockResolvedValue({ highlighted_lesson_id: null });
});

describe("GET /api/courses/[courseId]/live/highlight", () => {
  it("refuses a caller with no session, and reads no state", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    const res = await GET(new Request("https://app.test/x"), params);

    expect(res.status).toBe(401);
    expect(liveSessionService.getCourseHighlight).not.toHaveBeenCalled();
  });

  // Course ids are sequential, so an open read reported which lesson every
  // running event was on to anyone who asked.
  it("refuses a signed-in caller who holds no ticket to the course", async () => {
    resolveCourseGrant.mockResolvedValue(null);

    const res = await GET(new Request("https://app.test/x"), params);

    expect(res.status).toBe(403);
    expect(liveSessionService.getCourseHighlight).not.toHaveBeenCalled();
  });

  it("admits a ticket holder, who is in the room but runs nothing", async () => {
    resolveCourseGrant.mockResolvedValue("live");

    const res = await GET(new Request("https://app.test/x"), params);

    expect(res.status).toBe(200);
    expect(liveSessionService.getCourseHighlight).toHaveBeenCalled();
  });

  it("answers 404 for a course that does not exist", async () => {
    liveSessionService.getCourseHighlight.mockRejectedValue(new CourseServiceError(404, "Course not found"));

    const res = await GET(new Request("https://app.test/x"), params);

    expect(res.status).toBe(404);
  });

  it("reports nothing highlighted rather than failing when no row exists yet", async () => {
    const res = await GET(new Request("https://app.test/x"), params);

    await expect(res.json()).resolves.toEqual(EMPTY_STATE);
  });

  it("returns the highlighted lesson alongside its state", async () => {
    liveSessionService.getCourseHighlight.mockResolvedValue({
      highlighted_lesson_id: 4,
      updated_by: 3,
      updated_at: "2026-08-05T00:00:00Z",
      lesson: { id: 4, name: "Intro", description: "Intro", content_type: "pdf" },
    });

    const res = await GET(new Request("https://app.test/x"), params);

    await expect(res.json()).resolves.toMatchObject({
      highlighted_lesson_id: 4,
      lesson: { id: 4, name: "Intro", description: "Intro" },
    });
  });
});

describe("POST /api/courses/[courseId]/live/highlight", () => {
  it("refuses a caller with no session", async () => {
    requireRole.mockResolvedValue({ allowed: false, error: "Unauthenticated", user: null });

    const res = await POST(post({ lesson_id: 4 }), params);

    expect(res.status).toBe(401);
    expect(liveSessionService.setCourseHighlight).not.toHaveBeenCalled();
  });

  it("refuses a caller who does not manage the course's event", async () => {
    canManageEvent.mockResolvedValue(false);

    const res = await POST(post({ lesson_id: 4 }), params);

    expect(res.status).toBe(403);
    expect(liveSessionService.setCourseHighlight).not.toHaveBeenCalled();
  });

  it("answers 404 for a course that does not exist", async () => {
    courseDao.findCourseEvent.mockResolvedValue(null);

    const res = await POST(post({ lesson_id: 4 }), params);

    expect(res.status).toBe(404);
    expect(liveSessionService.setCourseHighlight).not.toHaveBeenCalled();
  });

  it("highlights a lesson", async () => {
    const res = await POST(post({ lesson_id: 4 }), params);

    expect(res.status).toBe(200);
    expect(canManageEvent).toHaveBeenCalledWith(expect.anything(), 3, ROLES.SPEAKER, 1);
    expect(liveSessionService.setCourseHighlight).toHaveBeenCalledWith(expect.anything(), 9, 4, { id: 3 });
  });

  it("clears the highlight without a lesson when none is sent", async () => {
    const res = await POST(post({}), params);

    expect(res.status).toBe(200);
    expect(liveSessionService.setCourseHighlight).toHaveBeenCalledWith(expect.anything(), 9, null, { id: 3 });
  });

  it("surfaces a failed write", async () => {
    liveSessionService.setCourseHighlight.mockRejectedValue(new CourseServiceError(500, "Failed to update highlight"));

    const res = await POST(post({ lesson_id: 4 }), params);

    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/courses/[courseId]/live/highlight", () => {
  it("refuses a caller who does not manage the course's event", async () => {
    canManageEvent.mockResolvedValue(false);

    const res = await DELETE(new Request("https://app.test/x"), params);

    expect(res.status).toBe(403);
    expect(liveSessionService.clearCourseHighlight).not.toHaveBeenCalled();
  });

  it("clears the highlight", async () => {
    const res = await DELETE(new Request("https://app.test/x"), params);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ highlighted_lesson_id: null });
    expect(liveSessionService.clearCourseHighlight).toHaveBeenCalledWith(expect.anything(), 9, { id: 3 });
  });

  it("surfaces a failed write", async () => {
    liveSessionService.clearCourseHighlight.mockRejectedValue(new CourseServiceError(500, "Failed to update highlight"));

    const res = await DELETE(new Request("https://app.test/x"), params);

    expect(res.status).toBe(500);
  });
});
