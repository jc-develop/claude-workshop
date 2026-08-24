import { ROLES } from "@/shared/lib/roles";
import { NextResponse } from "next/server";
import { requireMinRole } from "@/modules/auth/lib/role-guard";
import { guardFailure } from "@/modules/auth/lib/guard-response";
import { getServiceClient } from "@/shared/db/client";
import * as eventDao from "@/modules/events/db/event.dao";
import { uploadToStorage } from "@/shared/integrations/storage/service";
import {
  buildEventImagePath,
  validateFileType,
  validateFileSize,
  oversizeMessage,
  getExtensionFromMimeType,
} from "@/shared/integrations/storage/policy";

export async function POST(req: Request) {
  const guard = await requireMinRole(ROLES.ADMIN);
  if (!guard.allowed) {
    return guardFailure(guard);
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const eventId = formData.get("event_id") as string | null;

  if (!file || !eventId) {
    return NextResponse.json({ error: "file and event_id are required" }, { status: 400 });
  }

  // Parsed before the upload, not after. The path is built from this number, so
  // a non-numeric id used to write `events/NaN/cover.png` and only fail on the
  // row update afterwards — leaving the object behind with nothing pointing at
  // it and no way to reach it again.
  const id = Number(eventId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "event_id must be a positive integer" }, { status: 400 });
  }

  const supabase = getServiceClient();
  if (!(await eventDao.findById(supabase, id))) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  if (!validateFileType("event_images", file.type)) {
    return NextResponse.json({ error: "Only JPEG and PNG images are allowed" }, { status: 400 });
  }

  // Measured after the browser's resize, so this is the bound on what the
  // isolate holds -- not the size the reader was offered.
  if (!validateFileSize("event_images", file.size)) {
    return NextResponse.json({ error: oversizeMessage("event_images") }, { status: 400 });
  }

  const ext = getExtensionFromMimeType(file.type);
  const path = buildEventImagePath(id, ext);

  try {
    const result = await uploadToStorage("event_images", path, file);

    const ok = await eventDao.updateField(supabase, id, "cover_image_url", result.url);

    if (!ok) {
      return NextResponse.json({ error: "Failed to update event cover image" }, { status: 500 });
    }

    return NextResponse.json({ url: result.url, path: result.path });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
