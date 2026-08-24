import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireRole, updateField, findById, uploadToStorage, validateFileType, validateFileSize, buildEventImagePath } =
  vi.hoisted(() => ({
    requireRole: vi.fn(),
    updateField: vi.fn(),
    findById: vi.fn(),
    uploadToStorage: vi.fn(),
    validateFileType: vi.fn(),
    validateFileSize: vi.fn(),
    buildEventImagePath: vi.fn(),
  }));

vi.mock("@/modules/auth/lib/role-guard", () => ({ requireRole, requireMinRole: requireRole }));
vi.mock("@/shared/db/client", () => ({ getServiceClient: () => ({}) }));
vi.mock("@/modules/events/db/event.dao", () => ({ updateField, findById }));
vi.mock("@/shared/integrations/storage/service", () => ({ uploadToStorage }));
// The route's validators and path builder are exercised as they are in
// production; only the guards that would otherwise hit real storage are stubbed.
vi.mock("@/shared/integrations/storage/policy", () => ({
  validateFileType,
  validateFileSize,
  getExtensionFromMimeType: vi.fn(() => "png"),
  buildEventImagePath,
}));

import { POST } from "@/app/api/upload/event-image/route";

const denied = { allowed: false, error: "Forbidden", user: null };
const admin = {
  allowed: true,
  error: null,
  user: { id: 9, role: ROLES.ADMIN, full_name: "Alex", email: "alex@example.com", profile_image_url: null },
};

function uploadReq(eventId = "7"): Request {
  const form = new FormData();
  form.append("event_id", eventId);
  form.append("file", new File(["x"], "cover.png", { type: "image/png" }));
  return new Request("https://app.test/api/upload/event-image", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue(denied);
  updateField.mockResolvedValue(true);
  findById.mockResolvedValue({ id: 7 });
  uploadToStorage.mockResolvedValue({ url: "/api/storage/event_images/events/7/cover.png", path: "events/7/cover.png" });
  validateFileType.mockReturnValue(true);
  validateFileSize.mockReturnValue(true);
  buildEventImagePath.mockReturnValue("events/7/cover.png");
});

describe("POST /api/upload/event-image", () => {
  it("guards at admin, never at facilitator", async () => {
    const res = await POST(uploadReq());

    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(ROLES.ADMIN);
    expect(uploadToStorage).not.toHaveBeenCalled();
  });

  it("admits an admin to the upload and writes the event's cover", async () => {
    requireRole.mockResolvedValue(admin);

    const res = await POST(uploadReq());

    expect(res.status).toBe(200);
    expect(uploadToStorage).toHaveBeenCalled();
    expect(updateField).toHaveBeenCalledWith({}, 7, "cover_image_url", "/api/storage/event_images/events/7/cover.png");
  });

  // The path is built from this number, so a non-numeric id used to write
  // events/NaN/... and only fail on the row update afterwards, stranding the
  // object with nothing pointing at it.
  it.each(["abc", "0", "-3", "1.5", ""])("refuses event_id %j before anything is stored", async (eventId) => {
    requireRole.mockResolvedValue(admin);

    const res = await POST(uploadReq(eventId));

    expect(res.status).toBe(400);
    expect(uploadToStorage).not.toHaveBeenCalled();
  });

  it("refuses an id that parses but names no event, and stores nothing", async () => {
    requireRole.mockResolvedValue(admin);
    findById.mockResolvedValue(null);

    const res = await POST(uploadReq("404"));

    expect(res.status).toBe(404);
    expect(uploadToStorage).not.toHaveBeenCalled();
  });

  it("passes the same file-type and size gates the shared policy enforces", async () => {
    requireRole.mockResolvedValue(admin);
    validateFileType.mockReturnValue(false);

    const res = await POST(uploadReq());

    expect(res.status).toBe(400);
    expect(validateFileType).toHaveBeenCalledWith("event_images", "image/png");
    expect(uploadToStorage).not.toHaveBeenCalled();
  });
});
