import { ROLES } from "@/shared/lib/roles";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/modules/auth/lib/session";
import { getServiceClient } from "@/shared/db/client";
import { resolveCourseGrant } from "@/modules/courses/lib/course-entitlement";
import * as eventDao from "@/modules/events/db/event.dao";
import * as speakerDao from "@/shared/db/dao/speaker.dao";
import { isStorageBucket, COURSE_CONTENT_BUCKETS } from "@/shared/integrations/storage/policy";
import type { StorageBucket } from "@/shared/integrations/storage/policy";
import { hasMinRole } from "@/shared/lib/role-hierarchy";

type Db = ReturnType<typeof getServiceClient>;

// Every refusal looks the same. A caller must not be able to tell a file that
// does not exist from one they are not entitled to, or the endpoint becomes a
// way to enumerate other people's uploads.
const refuse = () => NextResponse.json({ error: "File not found" }, { status: 404 });

/**
 * Object keys are built by the path helpers in the storage integration, which
 * never emit relative or empty segments. Anything else came from a caller
 * shaping the URL by hand.
 *
 * Testing the segments for an exact "." or ".." is not enough on its own. Next
 * decodes the URL before it splits it, so a `%2F` arrives inside a segment
 * rather than between two — `courses/1/a%2F..%2F..%2Fcourses%2F2` is a single
 * segment that equals neither dot form, and the entitlement below reads only
 * the first two segments, so a traversal buried in a later one is authorised
 * against the wrong course.
 *
 * The separator is what makes it a traversal, so that is what is refused. A
 * segment carrying no separator cannot climb anywhere no matter what dots it
 * holds — and `sanitizeObjectName` only trims dots at the ends, so `my..file.pdf`
 * is a name that really uploads and has to keep being readable.
 */
function isSafePath(segments: string[]): boolean {
  if (segments.length === 0) return false;
  return segments.every(
    (s) => s.length > 0 && !s.includes("/") && !s.includes("\\") && !s.includes("\0") && s !== "." && s !== "..",
  );
}

/** Course material lives under `courses/{courseId}/...` — see buildCourseAssetPath. */
function courseIdFromPath(segments: string[]): number | null {
  if (segments[0] !== "courses") return null;
  const id = Number(segments[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Covers live at `events/{eventId}/cover.{ext}` — see buildEventImagePath. */
function eventIdFromPath(segments: string[]): number | null {
  if (segments[0] !== "events") return null;
  const id = Number(segments[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Avatars live at `users/{userId}/profile_{ts}.{ext}` — see buildProfileImagePath. */
function userIdFromPath(segments: string[]): number | null {
  if (segments[0] !== "users") return null;
  const id = Number(segments[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

interface Access {
  allowed: boolean;
  /** The bytes carry no per-user entitlement, so a shared cache may hold them. */
  cacheable: boolean;
}

const DENY: Access = { allowed: false, cacheable: false };

/** A published cover is the same object for every visitor, so its link may live
 * as long as the cache entry pointing at it. */
const PUBLIC_URL_TTL_SECONDS = 3600;

/** Entitled material gets only enough time for the browser to follow the
 * redirect. The link works without a session once issued, so its lifetime is
 * the window in which a leaked one is useful. */
const PRIVATE_URL_TTL_SECONDS = 60;

/** Keeps a cached redirect from outliving the URL inside it. */
const CACHE_SAFETY_MARGIN_SECONDS = 300;

/**
 * A published event's cover is public: it is rendered on `/` and `/events`,
 * which anonymous visitors can read. `uploadToStorage` stores those covers as
 * `/api/storage/...`, so requiring a session here 401'd every cover for a
 * logged-out visitor and the landing page showed broken images.
 *
 * Draft covers stay behind the facilitator floor. Publishing is what makes an
 * event visible, and a guessable `events/{id}/cover.png` must not be the way
 * around that.
 */
async function resolveAccess(bucket: StorageBucket, segments: string[], supabase: Db): Promise<Access> {
  if (bucket === "event_images") {
    const eventId = eventIdFromPath(segments);
    if (eventId === null) return DENY;

    // Before the session, not after: a published cover is public and is the
    // common case, so resolving the caller first spent an auth round trip per
    // image on an answer only the draft branch reads.
    if (await eventDao.isPublished(supabase, eventId)) {
      return { allowed: true, cacheable: true };
    }
    const viewer = await getCurrentUser(supabase);
    return { allowed: hasMinRole(viewer?.role ?? null, ROLES.FACILITATOR), cacheable: false };
  }

  if (bucket === "profile_images") {
    const userId = userIdFromPath(segments);
    if (userId === null) return DENY;

    // The speaker avatars on public event pages must load for guests, so the
    // image of anyone whose speaker profile sits on a published event is
    // public and cacheable. Everyone else's account photo keeps the signed-in
    // access it has today — any authenticated user may read it.
    if (await speakerDao.isSpeakerOnPublishedEvent(supabase, userId)) {
      return { allowed: true, cacheable: true };
    }
    const viewer = await getCurrentUser(supabase);
    return viewer ? { allowed: true, cacheable: false } : DENY;
  }

  const user = await getCurrentUser(supabase);

  // Everything else still needs a session. The middleware requires one for the
  // rest of /api/*; re-checking here keeps the rule with the data it protects
  // rather than in a matcher two files away.
  if (!user) return DENY;

  if (!COURSE_CONTENT_BUCKETS.includes(bucket)) return { allowed: true, cacheable: false };

  // Facilitator *and up*: an equality test denied admins and super_admins the
  // course material every facilitator can already read.
  if (hasMinRole(user.role, ROLES.FACILITATOR)) return { allowed: true, cacheable: false };

  const courseId = courseIdFromPath(segments);
  if (courseId === null) return DENY;

  // The same gate the course feeds use, so material a bundle unlocked is
  // downloadable rather than a curriculum of dead links.
  return { allowed: (await resolveCourseGrant(supabase, user, courseId)) !== null, cacheable: false };
}

export async function GET(_req: Request, { params }: { params: Promise<{ bucket: string; path: string[] }> }) {
  const { bucket, path } = await params;

  if (!isStorageBucket(bucket)) return refuse();
  if (!isSafePath(path)) return refuse();

  const supabase = getServiceClient();

  const access = await resolveAccess(bucket, path, supabase);
  if (!access.allowed) return refuse();

  // A signed URL rather than the bytes. `download()` resolves a Blob, which
  // materialises the whole object in an isolate that has 128 MB shared across
  // every concurrent request on it — and `course_videos` accepts 50 MB, so a
  // few simultaneous plays were enough to exceed it. Redirecting holds a
  // string instead, and hands Range support to Supabase, which is what lets a
  // lesson video seek at all: this route served no `Accept-Ranges`, so
  // scrubbing re-fetched the file from the start.
  //
  // The entitlement checks above are unchanged; only the delivery moved. The
  // URL that results is a bearer credential for its lifetime, so it expires in
  // minutes for anything private and is never granted longer than the
  // cacheability of the object it points at.
  const ttlSeconds = access.cacheable ? PUBLIC_URL_TTL_SECONDS : PRIVATE_URL_TTL_SECONDS;
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path.join("/"), ttlSeconds);

  if (error || !data?.signedUrl) return refuse();

  return NextResponse.redirect(data.signedUrl, {
    status: 302,
    headers: {
      // Anything gated on who is asking must never reach a shared cache, or the
      // redirect gets replayed to whoever asks next. A published cover is the
      // same object for everyone, so that one may be cached — but only for less
      // than the signed URL's own lifetime, or the cache outlives the link it
      // is holding and serves an expired one.
      "Cache-Control": access.cacheable
        ? `public, max-age=${PUBLIC_URL_TTL_SECONDS - CACHE_SAFETY_MARGIN_SECONDS}`
        : "private, no-store",
    },
  });
}
