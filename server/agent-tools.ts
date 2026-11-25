import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import {
  addDaysToDate,
  buildTaskTree,
  effortLabels,
  getTaskDueState,
  isEffort,
  isPriority,
  priorityLabels,
  sortTasksByUrgency,
  type Task,
} from "../shared/task.ts";
import {
  taskDate,
  taskDetailsUpdateFields,
  taskEffort,
  taskPriority,
  taskTitle,
} from "./task-schema.ts";
import type { TaskStore } from "./task-store.ts";

function emptyToUndefined(value: unknown) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

const optionalDate = z.preprocess(emptyToUndefined, taskDate.optional());
const optionalPriority = z.preprocess(emptyToUndefined, taskPriority.optional());
const optionalEffort = z.preprocess(emptyToUndefined, taskEffort.optional());
const optionalParentId = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalQuery = z.preprocess(emptyToUndefined, z.string().trim().min(1).max(100).optional());

const listTasksArgsSchema = z.object({
  status: z.preprocess(emptyToUndefined, z.enum(["all", "pending", "done"]).optional()),
  dueFilter: z.preprocess(
    emptyToUndefined,
    z.enum(["all", "today", "overdue", "today_and_overdue", "upcoming"]).optional(),
  ),
  priority: optionalPriority,
  effort: optionalEffort,
  query: optionalQuery,
});

const createTasksArgsSchema = z.object({
  items: z
    .array(
      z.object({
        title: taskTitle,
        parentId: optionalParentId,
        dueDate: optionalDate,
        priority: optionalPriority,
        effort: optionalEffort,
      }),
    )
    .min(1)
    .max(10),
});

const updateTaskArgsSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.preprocess(emptyToUndefined, taskTitle.optional()),
    done: z.preprocess((v) => (v === null ? undefined : v), z.boolean().optional()),
    ...taskDetailsUpdateFields,
    clearDueDate: z.boolean().optional(),
    clearPriority: z.boolean().optional(),
    clearEffort: z.boolean().optional(),
  })
  .refine(
    ({ title, done, dueDate, priority, effort, clearDueDate, clearPriority, clearEffort }) =>
      title !== undefined ||
      done !== undefined ||
      dueDate !== undefined ||
      priority !== undefined ||
      effort !== undefined ||
      clearDueDate === true ||
      clearPriority === true ||
      clearEffort === true,
    { message: "至少提供一个要修改的字段。" },
  );

const deleteTaskArgsSchema = z.object({
  id: z.string().trim().min(1),
});

export const agentTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_tasks",
      description:
        "查询当前待办清单。支持按完成状态、到期情况、优先级、工作量或关键词筛选。执行完成、修改、删除或添加子任务前，如不确定精确任务 ID，应先调用此工具获取最新任务列表。",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["all", "pending", "done"],
            description: "按完成状态筛选，默认 all。",
          },
          dueFilter: {
            type: "string",
            enum: ["all", "today", "overdue", "today_and_overdue", "upcoming"],
            description: "按到期情况筛选，默认 all。",
          },
          priority: {
            type: "integer",
            enum: [1, 2, 3],
            description: "优先级筛选：1=高，2=中，3=低。",
          },
          effort: {
            type: "string",
            enum: ["small", "medium", "large"],
            description: "工作量筛选：small=小，medium=中，large=大。",
          },
          query: {
            type: "string",
            description: "按任务标题关键词筛选（不区分大小写）。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_tasks",
      description:
        "创建一条或多条任务/子任务（单次最多 10 条）。创建子任务时传入已有主任务的 parentId（仅支持一层子任务）。",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "object",
              required: ["title"],
              properties: {
                title: { type: "string", description: "任务标题，1 到 200 个字符。" },
                dueDate: {
                  type: "string",
                  description: "本地截止日期，格式 YYYY-MM-DD。未指定时省略。",
                },
                priority: {
                  type: "integer",
                  enum: [1, 2, 3],
                  description: "优先级：1=高，2=中，3=低。未指定时省略。",
                },
                effort: {
                  type: "string",
                  enum: ["small", "medium", "large"],
                  description: "工作量：small=小，medium=中，large=大。未指定时省略。",
                },
                parentId: {
                  type: "string",
                  description: "已有主任务的精确 id，仅创建子任务时填写。",
                },
              },
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description:
        "按精确 id 更新单条任务，可修改标题、完成状态（支持完成与取消完成）、截止日期、优先级或工作量。需要清除某属性时传 clearDueDate/clearPriority/clearEffort 为 true。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "任务的精确 id。" },
          title: { type: "string", description: "新的任务标题。" },
          done: { type: "boolean", description: "true 表示已完成，false 表示恢复为待办。" },
          dueDate: {
            type: "string",
            description: "YYYY-MM-DD 格式日期。",
          },
          priority: {
            type: "integer",
            enum: [1, 2, 3],
            description: "1=高，2=中，3=低。",
          },
          effort: {
            type: "string",
            enum: ["small", "medium", "large"],
            description: "small=小，medium=中，large=大。",
          },
          clearDueDate: { type: "boolean", description: "设为 true 清除截止日期。" },
          clearPriority: { type: "boolean", description: "设为 true 清除优先级。" },
          clearEffort: { type: "boolean", description: "设为 true 清除工作量。" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description:
        "按精确 id 删除单条任务。删除主任务时，其子任务会自动转为独立任务。严禁在未获用户确认时清空大量任务。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "要删除任务的精确 id。" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_schedule_overview",
      description:
        "获取今天的待办日程总览，包含今天日期、已逾期未完成任务、今天到期任务、未来 7 天即将到期任务、高优先级待办以及整体统计。回答「今天有哪些任务到期？」「我现在先做什么？」时优先调用。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

function serializeTask(task: Task, today: string, titles: Map<string, string>, allTasks: Task[]) {
  const subtasks = allTasks.filter((item) => item.parentId === task.id);
  const doneSubtasks = subtasks.filter((item) => item.done).length;
  return {
    id: task.id,
    title: task.title,
    done: task.done,
    dueDate: typeof task.dueDate === "string" ? task.dueDate : undefined,
    dueState: getTaskDueState(task, today),
    priority: isPriority(task.priority) ? task.priority : undefined,
    priorityLabel: isPriority(task.priority) ? priorityLabels[task.priority] : undefined,
    effort: isEffort(task.effort) ? task.effort : undefined,
    effortLabel: isEffort(task.effort) ? effortLabels[task.effort] : undefined,
    parentId: typeof task.parentId === "string" ? task.parentId : undefined,
    parentTitle: typeof task.parentId === "string" ? titles.get(task.parentId) : undefined,
    ...(subtasks.length > 0 ? { subtasks: { total: subtasks.length, done: doneSubtasks } } : {}),
  };
}

function normalizeText(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

function parseJsonArgs(
  rawArgs: string,
): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    const trimmed = rawArgs.trim();
    return { ok: true, data: trimmed ? (JSON.parse(trimmed) as unknown) : {} };
  } catch {
    return { ok: false, error: "工具参数不是合法的 JSON。" };
  }
}

export function executeAgentTool(
  name: string,
  rawArgs: string,
  tasks: TaskStore,
  now: Date,
  today: string,
): Record<string, unknown> {
  const parsedJson = parseJsonArgs(rawArgs);
  if (!parsedJson.ok) return { ok: false, error: parsedJson.error };
  const input = parsedJson.data;

  if (name === "list_tasks") {
    const parsed = listTasksArgsSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "list_tasks 参数无效。" };

    const { status = "all", dueFilter = "all", priority, effort, query } = parsed.data;
    const allTasks = tasks.list();
    const titles = new Map(allTasks.map((item) => [item.id, item.title]));
    const normalizedQuery = query ? normalizeText(query) : "";

    const filtered = sortTasksByUrgency(allTasks, today).filter((task) => {
      if (status === "pending" && task.done) return false;
      if (status === "done" && !task.done) return false;
      if (priority !== undefined && task.priority !== priority) return false;
      if (effort !== undefined && task.effort !== effort) return false;
      if (normalizedQuery && !normalizeText(task.title).includes(normalizedQuery)) return false;
      if (dueFilter !== "all") {
        const state = getTaskDueState(task, today);
        if (dueFilter === "today" && state !== "today") return false;
        if (dueFilter === "overdue" && state !== "overdue") return false;
        if (dueFilter === "today_and_overdue" && state !== "today" && state !== "overdue") {
          return false;
        }
        if (dueFilter === "upcoming" && state !== "upcoming") return false;
      }
      return true;
    });

    const tree = buildTaskTree(filtered, today).map(({ task, subtasks }) => ({
      ...serializeTask(task, today, titles, allTasks),
      children: subtasks.map((child) => serializeTask(child, today, titles, allTasks)),
    }));

    return {
      ok: true,
      today,
      totalInStore: allTasks.length,
      matchedCount: filtered.length,
      summary: {
        pending: allTasks.filter((item) => !item.done).length,
        done: allTasks.filter((item) => item.done).length,
        overduePending: allTasks.filter(
          (item) => !item.done && getTaskDueState(item, today) === "overdue",
        ).length,
        todayPending: allTasks.filter(
          (item) => !item.done && getTaskDueState(item, today) === "today",
        ).length,
      },
      tasks: filtered.map((item) => serializeTask(item, today, titles, allTasks)),
      tree,
    };
  }

  if (name === "create_tasks") {
    const parsed = createTasksArgsSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error:
          "create_tasks 参数无效：请确保标题为 1~200 字符、日期为 YYYY-MM-DD、优先级为 1/2/3、工作量为 small/medium/large。",
      };
    }

    const created: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];

    for (const item of parsed.data.items) {
      const current = tasks.list();
      const titles = new Map(current.map((t) => [t.id, t.title]));
      if (item.parentId) {
        const parent = current.find((t) => t.id === item.parentId);
        if (!parent) {
          return {
            ok: false,
            error: `找不到 parentId=${item.parentId} 对应的主任务，请先调用 list_tasks 确认。`,
            createdSoFar: created,
          };
        }
        if (typeof parent.parentId === "string") {
          return {
            ok: false,
            error: `「${parent.title}」已经是子任务，仅支持一层子任务，请选择主任务。`,
            createdSoFar: created,
          };
        }
      }

      const duplicate = current.find(
        (existing) =>
          !existing.done &&
          normalizeText(existing.title) === normalizeText(item.title) &&
          (existing.parentId ?? undefined) === item.parentId,
      );
      if (duplicate) {
        warnings.push(`清单中原本已有同名待办「${duplicate.title}」，本次仍按要求新增了一条。`);
      }

      const task = tasks.create(item.title, {
        dueDate: item.dueDate,
        priority: item.priority,
        effort: item.effort,
        parentId: item.parentId,
      });
      const updatedAll = tasks.list();
      titles.set(task.id, task.title);
      created.push(serializeTask(task, today, titles, updatedAll));
    }

    return {
      ok: true,
      created,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  if (name === "update_task") {
    const parsed = updateTaskArgsSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: "update_task 参数无效，请提供精确 id 和至少一个有效字段。" };
    }

    const { id, clearDueDate, clearPriority, clearEffort, ...rawChanges } = parsed.data;
    const changes = {
      ...rawChanges,
      ...(clearDueDate ? { dueDate: null } : {}),
      ...(clearPriority ? { priority: null } : {}),
      ...(clearEffort ? { effort: null } : {}),
    };

    const beforeAll = tasks.list();
    const existing = beforeAll.find((item) => item.id === id);
    if (!existing) {
      return { ok: false, error: `找不到 id=${id} 的任务，请先调用 list_tasks 核对。` };
    }

    const onlyDoneChange =
      changes.done !== undefined &&
      changes.title === undefined &&
      changes.dueDate === undefined &&
      changes.priority === undefined &&
      changes.effort === undefined;

    if (onlyDoneChange && existing.done === changes.done) {
      const titles = new Map(beforeAll.map((item) => [item.id, item.title]));
      return {
        ok: true,
        alreadyInState: true,
        task: serializeTask(existing, today, titles, beforeAll),
      };
    }

    const updated = tasks.update(id, changes);
    if (!updated) return { ok: false, error: "更新任务失败，任务可能已被删除。" };

    const afterAll = tasks.list();
    const titles = new Map(afterAll.map((item) => [item.id, item.title]));
    const hints: string[] = [];

    if (changes.done === true && typeof updated.parentId === "string") {
      const parent = afterAll.find((item) => item.id === updated.parentId);
      const siblings = afterAll.filter((item) => item.parentId === updated.parentId);
      if (parent && !parent.done && siblings.length > 0 && siblings.every((item) => item.done)) {
        hints.push(
          `主任务「${parent.title}」下的全部子任务均已完成，可以顺带问用户是否把主任务也标为完成。`,
        );
      }
    }

    if (changes.done === true) {
      const pendingChildren = afterAll.filter((item) => item.parentId === updated.id && !item.done);
      if (pendingChildren.length > 0) {
        hints.push(
          `主任务「${updated.title}」还有 ${pendingChildren.length} 条未完成子任务，可以提醒用户。`,
        );
      }
    }

    return {
      ok: true,
      task: serializeTask(updated, today, titles, afterAll),
      ...(hints.length ? { hints } : {}),
    };
  }

  if (name === "delete_task") {
    const parsed = deleteTaskArgsSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "delete_task 需要提供精确 id。" };

    const allTasks = tasks.list();
    const existing = allTasks.find((item) => item.id === parsed.data.id);
    if (!existing) {
      return { ok: false, error: `找不到 id=${parsed.data.id} 的任务，请先调用 list_tasks 核对。` };
    }

    const detachedSubtasks = allTasks.filter((item) => item.parentId === existing.id).length;
    if (!tasks.remove(existing.id)) {
      return { ok: false, error: "删除失败，任务可能已不存在。" };
    }

    return {
      ok: true,
      deleted: { id: existing.id, title: existing.title },
      detachedSubtasks,
    };
  }

  if (name === "get_schedule_overview") {
    const allTasks = tasks.list();
    const titles = new Map(allTasks.map((item) => [item.id, item.title]));
    const weekLater = addDaysToDate(now, 7);
    const pending = sortTasksByUrgency(
      allTasks.filter((item) => !item.done),
      today,
    );

    const overdue = pending.filter((item) => getTaskDueState(item, today) === "overdue");
    const dueToday = pending.filter((item) => getTaskDueState(item, today) === "today");
    const dueTodayDone = allTasks.filter(
      (item) => item.done && typeof item.dueDate === "string" && item.dueDate === today,
    );
    const upcoming7Days = pending.filter(
      (item) =>
        typeof item.dueDate === "string" && item.dueDate > today && item.dueDate <= weekLater,
    );
    const highPriority = pending.filter((item) => item.priority === 1);

    return {
      ok: true,
      today,
      weekday: ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][now.getDay()],
      counts: {
        total: allTasks.length,
        pending: pending.length,
        done: allTasks.length - pending.length,
        overdue: overdue.length,
        dueToday: dueToday.length,
        upcoming7Days: upcoming7Days.length,
      },
      overdue: overdue.map((item) => serializeTask(item, today, titles, allTasks)),
      dueToday: dueToday.map((item) => serializeTask(item, today, titles, allTasks)),
      dueTodayDone: dueTodayDone.map((item) => serializeTask(item, today, titles, allTasks)),
      upcoming7Days: upcoming7Days.map((item) => serializeTask(item, today, titles, allTasks)),
      highPriority: highPriority.map((item) => serializeTask(item, today, titles, allTasks)),
    };
  }

  return { ok: false, error: `未知工具：${name}` };
}

export function isValidIsoDate(value: string): boolean {
  return taskDate.safeParse(value).success;
}
