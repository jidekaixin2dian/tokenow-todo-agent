import { Router } from "express";
import { z } from "zod";
import { taskDetailsFields, taskDetailsUpdateFields, taskTitle } from "./task-schema.ts";
import type { TaskStore } from "./task-store.ts";

const createTaskSchema = z.strictObject({
  title: taskTitle,
  parentId: z.string().trim().min(1).optional(),
  ...taskDetailsFields,
});
const updateTaskSchema = z
  .strictObject({
    title: taskTitle.optional(),
    done: z.boolean().optional(),
    ...taskDetailsUpdateFields,
  })
  .refine((changes) => Object.keys(changes).length > 0);

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(tasks.list());
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供 1 至 200 个字符的任务标题，并检查可选字段。" });
    }
    const { title, ...options } = input.data;
    if (options.parentId) {
      const parent = tasks.list().find((task) => task.id === options.parentId);
      if (!parent) return res.status(404).json(taskNotFound);
      if (typeof parent.parentId === "string") {
        return res.status(400).json({ error: "只能为主任务创建子任务。" });
      }
    }
    res.status(201).json(tasks.create(title, options));
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请至少提供一个有效的任务字段。" });
    }

    const updated = tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    res.sendStatus(204);
  });

  return router;
}
