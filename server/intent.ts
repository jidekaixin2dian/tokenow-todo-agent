import { z } from "zod";
import { taskDate, taskDetailsFields, taskDetailsUpdateFields, taskTitle } from "./task-schema.ts";

const target = z.string().trim().min(1).max(200);

export const intentSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    items: z
      .array(
        z.strictObject({
          title: taskTitle,
          parent: target.optional(),
          ...taskDetailsFields,
        }),
      )
      .min(1)
      .max(10),
  }),
  z.strictObject({
    action: z.literal("list"),
    status: z.enum(["pending", "done", "all"]).optional(),
    dueDate: taskDate.optional(),
    includeOverdue: z.boolean().optional(),
  }),
  z.strictObject({ action: z.literal("complete"), target }),
  z.strictObject({ action: z.literal("reopen"), target }),
  z.strictObject({ action: z.literal("delete"), target }),
  z.strictObject({ action: z.literal("rename"), target, newTitle: taskTitle }),
  z
    .strictObject({ action: z.literal("edit"), target, ...taskDetailsUpdateFields })
    .refine(
      ({ dueDate, priority, effort }) =>
        dueDate !== undefined || priority !== undefined || effort !== undefined,
    ),
  z.strictObject({
    action: z.literal("select_choice"),
    index: z.number().int().min(1).max(20),
    overrideAction: z.enum(["complete", "reopen", "delete"]).optional(),
  }),
  z.strictObject({
    action: z.literal("clarify"),
    reason: z.enum(["unknown", "multiple", "cancelled", "title", "details"]).optional(),
  }),
]);

export type Intent = z.infer<typeof intentSchema>;
