import { z } from "zod";

export const taskTitle = z.string().trim().min(1).max(200);
export const taskDate = z.iso.date();
export const taskDetailsFields = {
  dueDate: taskDate.optional(),
  priority: z.literal([1, 2, 3]).optional(),
  effort: z.enum(["small", "medium", "large"]).optional(),
};
const taskDetails = z.object(taskDetailsFields);
export type TaskDetails = z.infer<typeof taskDetails>;
