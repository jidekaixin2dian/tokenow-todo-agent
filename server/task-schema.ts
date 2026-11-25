import { z } from "zod";

export const taskTitle = z.string().trim().min(1).max(200);
export const taskDate = z.iso.date();
export const taskPriority = z.literal([1, 2, 3]);
export const taskEffort = z.enum(["small", "medium", "large"]);

export const taskDetailsFields = {
  dueDate: taskDate.optional(),
  priority: taskPriority.optional(),
  effort: taskEffort.optional(),
};

export const taskDetailsUpdateFields = {
  dueDate: taskDate.nullable().optional(),
  priority: taskPriority.nullable().optional(),
  effort: taskEffort.nullable().optional(),
};

const taskDetails = z.object(taskDetailsFields);
const taskDetailsUpdate = z.object(taskDetailsUpdateFields);

export type TaskDetails = z.infer<typeof taskDetails>;
export type TaskDetailsUpdate = z.infer<typeof taskDetailsUpdate>;
