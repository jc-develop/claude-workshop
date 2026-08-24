import { z } from "zod";

/**
 * What a caller may write to their own row through `PATCH /api/auth/me`.
 *
 * Every field is optional and each card sends only the columns it owns, so
 * `undefined` and `null` mean different things here and the schema has to keep
 * them apart: absent leaves a column alone, an explicit null clears it. That is
 * also how the route decides a speaker update was asked for at all.
 *
 * No `email` and no `role`, deliberately. The address belongs to the auth
 * identity and is copied across only once Supabase has confirmed it; the role
 * lives in app_metadata, which only the service role writes. Unknown keys are
 * stripped rather than rejected, so a body carrying either is inert instead of
 * being an error the caller can probe.
 */
export const updateMeSchema = z.object({
  full_name: z.string().trim().min(1, "Name is required").max(120, "Name too long").optional(),
  profile_image_url: z.string().nullable().optional(),
  designation: z.string().max(120, "Designation too long").nullable().optional(),
  bio: z.string().max(2000, "Bio too long").nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  twitter_url: z.string().nullable().optional(),
  github_url: z.string().nullable().optional(),
  website_url: z.string().nullable().optional(),
});

export type UpdateMeBody = z.infer<typeof updateMeSchema>;

/** The speaker-owned columns, named once so the route and the schema agree. */
export const SPEAKER_PROFILE_FIELDS = [
  "designation",
  "bio",
  "linkedin_url",
  "twitter_url",
  "github_url",
  "website_url",
] as const;
