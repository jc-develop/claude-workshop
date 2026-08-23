import { z } from "zod";

// The module is named by the route, never by the body: the handler reads it
// from `/api/qa/module/[moduleId]` and the entitlement check hangs off that
// same value. A `module_id` in the payload was only ever a second, ignored
// answer to a question the URL had already settled.
export const qaMessageSchema = z.object({
  message: z.string().min(1, "Message is required").max(1000, "Message too long"),
});
