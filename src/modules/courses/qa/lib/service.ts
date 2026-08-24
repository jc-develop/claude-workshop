import type { DbClient } from "@/shared/db/dao/types";
import type { Module, UserRole } from "@/shared/types";
import * as courseDao from "@/shared/db/dao/course.dao";
import * as qaMessageDao from "@/modules/courses/qa/db/qa-message.dao";
import { canManageEvent } from "@/modules/courses/lib/course-access";
import { resolveCourseGrant } from "@/modules/courses/lib/course-entitlement";
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX } from "@/shared/lib/rate-limit";
import { ServiceError } from "@/shared/lib/service-error";

export class QaServiceError extends ServiceError {}

/** Who is asking. A Q&A is part of a course, so holding one is the same question. */
export interface QaViewer {
  id: number;
  role: UserRole;
}

/**
 * A Q&A belongs to its course, so the room's gate is the Q&A's gate: staff,
 * assigned speakers and ticket holders, and nobody else.
 *
 * It lives here rather than in the three routes that need it because the reads
 * were the ones that went without — module ids are sequential, so a listing
 * that only checked for a session handed any signed-in caller every question
 * ever asked, with the asker's name on it, for events they had no part in.
 */
export async function requireQaAccess(supabase: DbClient, moduleId: number, viewer: QaViewer): Promise<void> {
  const course = await courseDao.findCourseByModule(supabase, moduleId);
  if (!course) {
    throw new QaServiceError(404, "Module not found");
  }
  if ((await resolveCourseGrant(supabase, viewer, course.id)) === null) {
    throw new QaServiceError(403, "Forbidden");
  }
}

export async function findQaModule(supabase: DbClient, moduleId: number): Promise<Module> {
  const mod = await courseDao.findModuleById(supabase, moduleId);
  if (!mod) {
    throw new QaServiceError(404, "Module not found");
  }
  return mod;
}

/**
 * A Q&A module accepts questions: it exists, is typed `qa` and its moderator
 * has not locked it. Listing and single-message reads deliberately skip this so
 * attendees can still read a locked session's history.
 */
export async function requireQaModule(supabase: DbClient, moduleId: number): Promise<Module> {
  const mod = await findQaModule(supabase, moduleId);
  if (mod.module_type !== "qa") {
    throw new QaServiceError(400, "Module is not a Q&A module");
  }
  if (mod.is_locked) {
    throw new QaServiceError(403, "Q&A is locked");
  }
  return mod;
}

export async function listQuestions(
  supabase: DbClient,
  moduleId: number,
  viewer: QaViewer,
): Promise<{
  messages: Awaited<ReturnType<typeof qaMessageDao.listQuestionsByModule>>["messages"];
  nextCursor: string | null;
}> {
  await requireQaAccess(supabase, moduleId, viewer);
  return qaMessageDao.listQuestionsByModule(supabase, moduleId, { before: null, after: null, limit: 50 });
}

export async function getQuestion(
  supabase: DbClient,
  messageId: number,
  viewer: QaViewer,
): Promise<NonNullable<Awaited<ReturnType<typeof qaMessageDao.findByIdWithUser>>>> {
  const message = await qaMessageDao.findByIdWithUser(supabase, messageId);
  if (!message) {
    throw new QaServiceError(404, "Message not found");
  }
  await requireQaAccess(supabase, message.module_id, viewer);
  return message;
}

export async function sendQuestion(
  supabase: DbClient,
  moduleId: number,
  viewer: QaViewer,
  message: string,
): Promise<NonNullable<Awaited<ReturnType<typeof qaMessageDao.sendQuestion>>>> {
  const mod = await requireQaModule(supabase, moduleId);
  await requireQaAccess(supabase, moduleId, viewer);

  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { messages } = await qaMessageDao.listQuestionsByModule(supabase, moduleId, {
    before: null,
    after: windowStart,
    limit: RATE_LIMIT_MAX,
  });
  if (messages.length >= RATE_LIMIT_MAX) {
    throw new QaServiceError(429, "Too many messages. Please slow down.");
  }

  const course = await courseDao.findCourseEvent(supabase, mod.course_id);
  if (!course) {
    throw new QaServiceError(404, "Course not found");
  }

  const created = await qaMessageDao.sendQuestion(supabase, {
    event_id: course.event_id,
    module_id: moduleId,
    user_id: viewer.id,
    message,
  });
  if (!created) {
    throw new QaServiceError(500, "Failed to send message");
  }
  return created;
}

export async function setModuleLock(
  supabase: DbClient,
  moduleId: number,
  isLocked: boolean,
): Promise<NonNullable<Awaited<ReturnType<typeof courseDao.setModuleLock>>>> {
  const mod = await courseDao.setModuleLock(supabase, moduleId, isLocked);
  if (!mod) {
    throw new QaServiceError(500, "Failed to update lock state");
  }
  return mod;
}

/**
 * The asker may always take their own question down; anyone else must be on
 * the course's team (admin+, or a facilitator/speaker assigned to its event).
 */
export async function deleteQuestion(
  supabase: DbClient,
  messageId: number,
  user: { id: number; role: UserRole },
): Promise<void> {
  const message = await qaMessageDao.findById(supabase, messageId);
  if (!message) {
    throw new QaServiceError(404, "Message not found");
  }

  if (message.user_id !== user.id) {
    const course = await courseDao.findCourseByModule(supabase, message.module_id);
    if (!course) {
      throw new QaServiceError(404, "Module not found");
    }
    if (!(await canManageEvent(supabase, user.id, user.role, course.event_id))) {
      throw new QaServiceError(403, "Forbidden");
    }
  }

  const ok = await qaMessageDao.deleteByIds(supabase, [messageId]);
  if (!ok) {
    throw new QaServiceError(500, "Failed to delete message");
  }
}
