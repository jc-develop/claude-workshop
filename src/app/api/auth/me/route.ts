import { ROLES } from "@/shared/lib/roles";
import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/modules/auth/lib/session";
import { requireRole } from "@/modules/auth/lib/role-guard";
import { forbidden, guardFailure, unauthenticated } from "@/modules/auth/lib/guard-response";
import { getServiceClient } from "@/shared/db/client";
import { badRequest } from "@/shared/lib/api-response";
import { SPEAKER_PROFILE_FIELDS, updateMeSchema } from "@/modules/user/lib/schemas";
import { deleteAccount } from "@/modules/user/lib/delete-account";
import * as userDao from "@/shared/db/dao/user.dao";
import * as speakerDao from "@/shared/db/dao/speaker.dao";
import type { SpeakerProfile } from "@/shared/types";

export async function GET() {
  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  const supabase = getServiceClient();
  const profile = await speakerDao.findByUserId(supabase, guard.user.id);

  return NextResponse.json({
    ...guard.user,
    speaker_profile_id: profile?.id ?? null,
    designation: profile?.designation ?? null,
    bio: profile?.bio ?? null,
    linkedin_url: profile?.linkedin_url ?? null,
    twitter_url: profile?.twitter_url ?? null,
    github_url: profile?.github_url ?? null,
    website_url: profile?.website_url ?? null,
    photo_url: (profile as (SpeakerProfile & { photo_url?: string | null }) | null)?.photo_url ?? null,
  });
}

export async function PATCH(req: Request) {
  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  const authUserId = await getCurrentUserId();
  if (!authUserId) {
    return unauthenticated();
  }

  // No email here, deliberately. The address is owned by the auth identity and
  // only ever copied across once Supabase has confirmed it — see
  // syncEmailFromAuth. Accepting one on this route let any authenticated caller
  // stamp an address they had not proved they own, which is what put unverified
  // addresses on the settings page and could squat one a staff invite was
  // headed for. The schema strips it, along with anything else unrecognised.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const parsed = updateMeSchema.safeParse(raw);
  if (!parsed.success) {
    return badRequest(parsed.error);
  }
  const body = parsed.data;

  // A speaker profile is the user's own row, so it lives on the same route —
  // but only a speaker may write it. The exact role is required, not a minimum,
  // because facilitators and admins carry no speaker bio. Guard before touching
  // anything so a rejected caller never leaves half a profile updated.
  const wantsSpeakerUpdate = SPEAKER_PROFILE_FIELDS.some((field) => body[field] !== undefined);
  if (wantsSpeakerUpdate && guard.user.role !== ROLES.SPEAKER) {
    return forbidden();
  }

  const supabase = getServiceClient();

  // Named fields rather than the parsed body, because the body's type is erased
  // at runtime: forwarding it whole would hand the DAO whatever else the caller
  // put in the JSON — an `email` among it — and the DAO writes any column it
  // recognises.
  const updated = await userDao.updateUser(supabase, authUserId, {
    ...(body.full_name !== undefined && { full_name: body.full_name }),
    ...(body.profile_image_url !== undefined && { profile_image_url: body.profile_image_url }),
  });

  if (!updated) {
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }

  if (wantsSpeakerUpdate) {
    const speakerFields = {
      designation: body.designation ?? null,
      bio: body.bio ?? null,
      linkedin_url: body.linkedin_url ?? null,
      twitter_url: body.twitter_url ?? null,
      github_url: body.github_url ?? null,
      website_url: body.website_url ?? null,
    };
    const existing = await speakerDao.findByUserId(supabase, updated.id);
    const profile = existing
      ? await speakerDao.update(supabase, existing.id, speakerFields)
      : await speakerDao.create(supabase, { user_id: updated.id, ...speakerFields });

    if (!profile) {
      return NextResponse.json({ error: "Failed to update speaker profile" }, { status: 500 });
    }
  }

  return NextResponse.json({
    id: updated.id,
    role: updated.role,
    full_name: updated.full_name,
    email: updated.email,
    profile_image_url: updated.profile_image_url,
  });
}

export async function DELETE() {
  const guard = await requireRole();
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  const authUserId = await getCurrentUserId();
  if (!authUserId) {
    return unauthenticated();
  }

  try {
    await deleteAccount({
      userId: guard.user.id,
      authUserId,
      email: guard.user.email,
      role: guard.user.role,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not delete your account. Please try again." }, { status: 500 });
  }
}
