import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect } from "vitest";
import { qaMessageSchema } from "@/modules/courses/qa/lib/schemas";
import { isChatStaff } from "@/shared/lib/is-chat-staff";
import type { QaMessage } from "@/shared/types";

describe("QAPanel uses QA_MESSAGE", () => {
  it("accepts valid question message via qaMessageSchema", () => {
    const result = qaMessageSchema.safeParse({ message: "What is the deadline?" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe("What is the deadline?");
    }
  });

  it("rejects empty question", () => {
    const result = qaMessageSchema.safeParse({ message: "" });
    expect(result.success).toBe(false);
  });

  it("rejects question exceeding max length", () => {
    const result = qaMessageSchema.safeParse({ message: "x".repeat(1001) });
    expect(result.success).toBe(false);
  });
});

describe("qaMessageSchema leaves the module to the route", () => {
  it("takes a question with no module named in the body", () => {
    const result = qaMessageSchema.safeParse({ message: "A question" });
    expect(result.success).toBe(true);
  });

  it("drops a module_id rather than carrying it past validation", () => {
    const result = qaMessageSchema.safeParse({ message: "A question", module_id: 999 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ message: "A question" });
    }
  });
});

describe("Q&A moderation — staff can delete questions", () => {
  it("applies the shared chat staff floor, not the old speaker floor", () => {
    expect(isChatStaff(ROLES.ATTENDEE)).toBe(false);
    expect(isChatStaff(ROLES.SPEAKER)).toBe(false);
    expect(isChatStaff(ROLES.FACILITATOR)).toBe(true);
    expect(isChatStaff(ROLES.ADMIN)).toBe(true);
    expect(isChatStaff(ROLES.SUPER_ADMIN)).toBe(true);
    expect(isChatStaff(null)).toBe(false);
  });

  it("names a speaker who is not staff so the panel hides moderation UI", () => {
    expect(isChatStaff(ROLES.SPEAKER)).toBe(false);
  });
});

describe("QaMessage type", () => {
  it("includes module_id instead of reply_to", () => {
    const msg: QaMessage = {
      id: 1,
      event_id: 99,
      module_id: 5,
      user_id: 5,
      message: "Question?",
      created_at: "2026-07-10T12:00:00Z",
      updated_at: "2026-07-10T12:00:00Z",
    };
    expect(msg.module_id).toBe(5);
    expect("reply_to" in msg).toBe(false);
    expect("answered_verbally" in msg).toBe(false);
  });
});
