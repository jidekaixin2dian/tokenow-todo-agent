import { z } from "zod";
import type { ChatMessage } from "../shared/chat.ts";
import { taskDate, taskDetailsFields, taskTitle } from "./task-schema.ts";

const target = z.string().trim().min(1).max(200);

export const intentSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    title: taskTitle,
    parent: target.optional(),
    ...taskDetailsFields,
  }),
  z.strictObject({
    action: z.literal("list"),
    status: z.enum(["pending", "done", "all"]).optional(),
    dueDate: taskDate.optional(),
  }),
  z.strictObject({ action: z.literal("complete"), target }),
  z.strictObject({ action: z.literal("delete"), target }),
  z
    .strictObject({ action: z.literal("edit"), target, ...taskDetailsFields })
    .refine(({ dueDate, priority, effort }) => dueDate || priority || effort),
  z.strictObject({
    action: z.literal("clarify"),
    reason: z.enum(["unknown", "multiple", "cancelled", "title", "details"]).optional(),
  }),
]);

export type Intent = z.infer<typeof intentSchema>;
export type InterpretIntent = (messages: ChatMessage[], today: string) => Promise<unknown>;
