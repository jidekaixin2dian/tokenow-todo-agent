import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Task } from "../shared/task.ts";
import type { TaskDetails, TaskDetailsUpdate } from "./task-schema.ts";

const storedTask = z.looseObject({ id: z.string(), title: z.string(), done: z.boolean() });
const taskList = z.array(storedTask);
export type TaskChanges = Partial<Pick<Task, "title" | "done">> & TaskDetailsUpdate;
export type TaskOptions = TaskDetails & { parentId?: string };

export interface TaskStore {
  list(): Task[];
  create(title: string, options?: TaskOptions): Task;
  update(id: string, changes: TaskChanges): Task | undefined;
  remove(id: string): boolean;
}

function cleanOptions(options?: TaskOptions): Partial<Task> {
  if (!options) return {};
  const cleaned: Partial<Task> = {};
  if (options.dueDate !== undefined) cleaned.dueDate = options.dueDate;
  if (options.priority !== undefined) cleaned.priority = options.priority;
  if (options.effort !== undefined) cleaned.effort = options.effort;
  if (options.parentId !== undefined) cleaned.parentId = options.parentId;
  return cleaned;
}

export function createJsonTaskStore(filename: string): TaskStore {
  function list(): Task[] {
    if (!existsSync(filename)) return [];
    return taskList.parse(JSON.parse(readFileSync(filename, "utf8"))) as Task[];
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: Task[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  return {
    list,

    create(title, options) {
      const task: Task = { id: randomUUID(), title, done: false, ...cleanOptions(options) };
      save([...list(), task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) continue;
        if (value === null) {
          delete task[key];
        } else {
          task[key] = value;
        }
      }
      save(tasks);
      return task;
    },

    remove(id) {
      const tasks = list();
      const remaining = tasks.filter((task) => task.id !== id);
      if (remaining.length === tasks.length) return false;

      for (const task of remaining) {
        if (task.parentId === id) delete task.parentId;
      }
      save(remaining);
      return true;
    },
  };
}
