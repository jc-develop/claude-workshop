import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { createSignedUrl, from, getCurrentUser, resolveCourseGrant, isPublished, isSpeakerOnPublishedEvent } = vi.hoisted(() => {
  const createSignedUrl = vi.fn();
  return {
    createSignedUrl,
    from: vi.fn(() => ({ createSignedUrl })),
    getCurrentUser: vi.fn(),
    resolveCourseGrant: vi.fn(),
    isPublished: vi.fn(),
    isSpeakerOnPublishedEvent: vi.fn(),
  };
});

vi.mock("@/shared/db/client", () => ({
  getServiceClient: () => ({ storage: { from } }),
}));
vi.mock("@/modules/auth/lib/session", () => ({ getCurrentUser }));
vi.mock("@/modules/courses/lib/course-entitlement", () => ({ resolveCourseGrant }));
vi.mock("@/modules/events/db/event.dao", () => ({ isPublished }));
vi.mock("@/shared/db/dao/speaker.dao", () => ({ isSpeakerOnPublishedEvent }));

import { GET } from "@/app/api/storage/[bucket]/[...path]/route";

const req = () => new Request("https://app.test/api/storage/x/y");
const params = (bucket: string, path: string[]) => ({ params: Promise.resolve({ bucket, path }) });

// The route redirects to a signed URL rather than proxying the bytes, so these
// mirror the lifetimes it asks Supabase for.
const SIGNED_URL = "https://storage.test/signed/object?token=abc";
const PUBLIC_TTL = 3600;
const PRIVATE_TTL = 60;

const attendee = { id: 5, role: ROLES.ATTENDEE, full_name: "Jane", email: "jane@example.com" };
const facilitator = { id: 9, role: ROLES.FACILITATOR, full_name: "Fay", email: "fay@example.com" };
const speaker = { id: 7, role: ROLES.SPEAKER, full_name: "Sam", email: "sam@example.com" };

const lesson = ["courses", "12", "modules", "3", "lessons", "8", "slides.pdf"];
const cover = ["events", "1", "cover.png"];
const avatar = ["users", "5", "profile.png"];

// event_images is keyed on the event in its path and profile_images on the
// user, so those buckets take their own shape; course buckets share `lesson`.
const keyFor = (bucket: string) => (bucket === "event_images" ? cover : bucket === "profile_images" ? avatar : lesson);

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockResolvedValue(attendee);
  resolveCourseGrant.mockResolvedValue("live");
  isPublished.mockResolvedValue(true);
  isSpeakerOnPublishedEvent.mockResolvedValue(true);
  createSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
});

describe("bucket allowlist", () => {
  it.each(["event_images", "profile_images", "course_assets", "course_videos"])("serves the known bucket %s", async (b) => {
    const res = await GET(req(), params(b, keyFor(b)));

    expect(res.status).toBe(302);
    expect(from).toHaveBeenCalledWith(b);
  });

  it.each(["secrets", "private", "auth", "", "COURSE_ASSETS"])("refuses the unknown bucket %j", async (b) => {
    const res = await GET(req(), params(b, ["x.pdf"]));

    expect(res.status).toBe(404);
    // Never reaches storage, so an unknown bucket cannot be probed for existence.
    expect(from).not.toHaveBeenCalled();
  });
});

describe("path safety", () => {
  it.each([
    [["..", "..", "private", "keys.json"]],
    [["courses", "..", "12"]],
    [["courses", "", "12"]],
    [["."]],
    [[]],
    [["a\\b"]],
    // Next decodes before it splits, so an encoded slash lands *inside* a
    // segment: these are the shapes that walked past a check for an exact
    // "." or "..", and the entitlement only ever reads segments 0 and 1.
    [["courses", "12", "..%2F..%2Fcourses%2F99%2Fsecret.pdf".replace(/%2F/g, "/")]],
    [["courses", "12", "a/../../courses/99/secret.pdf"]],
    [["courses", "12", "..", "..", "courses", "99"]],
    [["courses", "12", "lesson..pdf/../../x"]],
    [["courses", "12", ".."]],
  ])("refuses traversal-shaped path %j", async (segments) => {
    const res = await GET(req(), params("course_assets", segments));

    expect(res.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  // sanitizeObjectName only trims dots at the ends, so this name really does
  // upload — and a segment with no separator in it cannot climb anywhere.
  it("still serves a filename with dots inside it", async () => {
    await GET(req(), params("course_assets", ["courses", "12", "my..notes.pdf"]));

    expect(createSignedUrl).toHaveBeenCalledWith("courses/12/my..notes.pdf", PRIVATE_TTL);
  });

  it("passes a well-formed key through unchanged", async () => {
    await GET(req(), params("course_assets", lesson));

    expect(createSignedUrl).toHaveBeenCalledWith("courses/12/modules/3/lessons/8/slides.pdf", PRIVATE_TTL);
  });
});

describe("authentication", () => {
  it("refuses an unauthenticated caller without touching storage", async () => {
    getCurrentUser.mockResolvedValue(null);

    const res = await GET(req(), params("course_assets", lesson));

    expect(res.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("does not require an entitlement check for non-course buckets", async () => {
    const res = await GET(req(), params("event_images", cover));

    expect(res.status).toBe(302);
    expect(resolveCourseGrant).not.toHaveBeenCalled();
  });
});

// `uploadToStorage` stores covers as /api/storage/..., and `/` and `/events`
// render them to visitors with no session. Requiring one here 401'd every cover
// on the landing page.
describe("public event covers", () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue(null);
  });

  it("serves a published event's cover to a caller with no session", async () => {
    isPublished.mockResolvedValue(true);

    const res = await GET(req(), params("event_images", cover));

    expect(res.status).toBe(302);
    expect(isPublished).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it("does not ask who the caller is when the cover is published", async () => {
    isPublished.mockResolvedValue(true);

    const res = await GET(req(), params("event_images", cover));

    // Every card on `/` and `/events` is one of these requests, and each
    // `getCurrentUser` is an auth round trip plus a user lookup whose answer this
    // branch never reads. Without this assertion the ordering silently regresses.
    expect(res.status).toBe(302);
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("still resolves the caller for a draft cover, which is role-gated", async () => {
    isPublished.mockResolvedValue(false);

    await GET(req(), params("event_images", cover));

    expect(getCurrentUser).toHaveBeenCalled();
  });

  it("lets a shared cache hold a published cover, since it is the same for everyone", async () => {
    isPublished.mockResolvedValue(true);

    const res = await GET(req(), params("event_images", cover));

    expect(res.headers.get("Cache-Control")).toBe(`public, max-age=${PUBLIC_TTL - 300}`);
  });

  it("refuses a draft cover, so a guessed path cannot preview an unpublished event", async () => {
    isPublished.mockResolvedValue(false);

    const res = await GET(req(), params("event_images", cover));

    expect(res.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("still shows a draft cover to staff", async () => {
    isPublished.mockResolvedValue(false);
    getCurrentUser.mockResolvedValue(facilitator);

    const res = await GET(req(), params("event_images", cover));

    expect(res.status).toBe(302);
    // Per-user verdict, so it must not be replayed out of a shared cache.
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("refuses a draft cover to a signed-in attendee", async () => {
    isPublished.mockResolvedValue(false);
    getCurrentUser.mockResolvedValue(attendee);

    const res = await GET(req(), params("event_images", cover));

    expect(res.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it.each([
    [["cover.png"]],
    [["users", "5", "profile.png"]],
    [["events", "abc", "cover.png"]],
    [["events", "-1", "cover.png"]],
  ])("refuses the event_images key %j that names no event", async (segments) => {
    isPublished.mockResolvedValue(true);

    const res = await GET(req(), params("event_images", segments));

    expect(res.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("leaves the course buckets closed to an anonymous caller", async () => {
    for (const bucket of ["course_assets", "course_videos"]) {
      const res = await GET(req(), params(bucket, lesson));
      expect(res.status).toBe(404);
    }
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});

// Speaker avatars are rendered on the public event detail page, so the image of
// anyone whose speaker profile sits on a published event is served without a
// session. Ordinary account photos keep the signed-in access they had before.
describe("public speaker avatars", () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue(null);
  });

  it("serves a published-event speaker's avatar to a caller with no session", async () => {
    isSpeakerOnPublishedEvent.mockResolvedValue(true);

    const res = await GET(req(), params("profile_images", avatar));

    expect(res.status).toBe(302);
    expect(isSpeakerOnPublishedEvent).toHaveBeenCalledWith(expect.anything(), 5);
    expect(from).toHaveBeenCalledWith("profile_images");
  });

  it("does not ask who the caller is for a public speaker avatar", async () => {
    isSpeakerOnPublishedEvent.mockResolvedValue(true);

    const res = await GET(req(), params("profile_images", avatar));

    expect(res.status).toBe(302);
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("lets a shared cache hold a speaker avatar, since it is the same for everyone", async () => {
    isSpeakerOnPublishedEvent.mockResolvedValue(true);

    const res = await GET(req(), params("profile_images", avatar));

    expect(res.headers.get("Cache-Control")).toBe(`public, max-age=${PUBLIC_TTL - 300}`);
  });

  it("refuses a non-speaker's avatar to a caller with no session", async () => {
    isSpeakerOnPublishedEvent.mockResolvedValue(false);

    const res = await GET(req(), params("profile_images", avatar));

    expect(res.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("still serves a non-speaker's avatar to any signed-in user", async () => {
    isSpeakerOnPublishedEvent.mockResolvedValue(false);
    getCurrentUser.mockResolvedValue(attendee);

    const res = await GET(req(), params("profile_images", avatar));

    expect(res.status).toBe(302);
    // Per-user verdict, so it must not be replayed out of a shared cache.
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([
    [["cover.png"]],
    [["events", "1", "cover.png"]],
    [["users", "abc", "profile.png"]],
    [["users", "-1", "profile.png"]],
    [["users"]],
  ])("refuses the profile_images key %j that names no user", async (segments) => {
    isSpeakerOnPublishedEvent.mockResolvedValue(true);

    const res = await GET(req(), params("profile_images", segments));

    expect(res.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});

describe("course entitlement", () => {
  it("serves course material to a user who holds the entitlement", async () => {
    resolveCourseGrant.mockResolvedValue("live");

    const res = await GET(req(), params("course_videos", lesson));

    expect(res.status).toBe(302);
    expect(resolveCourseGrant).toHaveBeenCalledWith(expect.anything(), attendee, 12);
  });

  it("refuses course material to a user without the entitlement", async () => {
    resolveCourseGrant.mockResolvedValue(null);

    const res = await GET(req(), params("course_videos", lesson));

    expect(res.status).toBe(404);
    // The regression this guards: paid course video readable by any signed-in user.
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("gives facilitators access without consulting entitlements", async () => {
    getCurrentUser.mockResolvedValue(facilitator);

    const res = await GET(req(), params("course_assets", lesson));

    expect(res.status).toBe(302);
    expect(resolveCourseGrant).not.toHaveBeenCalled();
  });

  // "Facilitator" here means facilitator *and up*. An equality test denied
  // admins and super_admins the material every facilitator already reads.
  it.each([ROLES.ADMIN, ROLES.SUPER_ADMIN])("gives %s the same access as a facilitator", async (role) => {
    getCurrentUser.mockResolvedValue({ ...facilitator, role });

    const res = await GET(req(), params("course_assets", lesson));

    expect(res.status).toBe(302);
    expect(resolveCourseGrant).not.toHaveBeenCalled();
  });

  it("checks entitlement for a speaker like any other non-facilitator", async () => {
    getCurrentUser.mockResolvedValue(speaker);
    resolveCourseGrant.mockResolvedValue(null);

    const res = await GET(req(), params("course_assets", lesson));

    expect(res.status).toBe(404);
    expect(resolveCourseGrant).toHaveBeenCalledWith(expect.anything(), speaker, 12);
  });

  it.each([[["assets", "12", "x.pdf"]], [["courses", "abc", "x.pdf"]], [["courses", "-1", "x.pdf"]], [["courses"]]])(
    "refuses course material whose key carries no usable course id: %j",
    async (segments) => {
      const res = await GET(req(), params("course_assets", segments));

      expect(res.status).toBe(404);
      expect(createSignedUrl).not.toHaveBeenCalled();
    },
  );
});

describe("responses", () => {
  // The bytes no longer pass through the isolate: `download()` resolved a Blob,
  // which held the whole object in the 128 MB an isolate shares across every
  // request on it, and `course_videos` accepts 50 MB. Content type and range
  // support now come from Supabase, which is also what lets a video seek.
  it("redirects to the signed URL instead of proxying the object", async () => {
    const res = await GET(req(), params("course_assets", lesson));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SIGNED_URL);
  });

  it("gives entitled material only a short-lived link", async () => {
    await GET(req(), params("course_assets", lesson));

    expect(createSignedUrl).toHaveBeenCalledWith(expect.any(String), PRIVATE_TTL);
  });

  it("gives a published cover a link that outlives the redirect caching it", async () => {
    isPublished.mockResolvedValue(true);

    const res = await GET(req(), params("event_images", cover));

    expect(createSignedUrl).toHaveBeenCalledWith(expect.any(String), PUBLIC_TTL);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1]);
    expect(maxAge).toBeLessThan(PUBLIC_TTL);
  });

  it("marks the response private so a shared cache cannot serve it onward", async () => {
    const res = await GET(req(), params("course_assets", lesson));

    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns the same 404 for a missing object as for a forbidden one", async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: "not found" } });
    const missing = await GET(req(), params("course_assets", lesson));

    resolveCourseGrant.mockResolvedValue(null);
    const forbidden = await GET(req(), params("course_assets", lesson));

    expect(missing.status).toBe(forbidden.status);
    await expect(missing.json()).resolves.toEqual(await forbidden.json());
  });

  it("does not leak the underlying storage error", async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: "bucket 'x' does not exist" } });

    const res = await GET(req(), params("course_assets", lesson));

    await expect(res.json()).resolves.toEqual({ error: "File not found" });
  });
});
