import type { ChatMessage } from "../shared/chat.ts";
import {
  buildTaskTree,
  effortLabels,
  getTaskDueState,
  priorityLabels,
  sortTasksByUrgency,
  taskDetailsLabels,
  type Task,
} from "../shared/task.ts";
import type { Intent } from "./intent.ts";
import { localDate, readLocalIntent, unquote } from "./local-intent.ts";
import type { AgentRunner } from "./model.ts";
import type { TaskStore } from "./task-store.ts";

export type { ChatMessage } from "../shared/chat.ts";

const help =
  "你可以直接告诉我，比如「帮我记一下买牛奶」「看看我的待办」「今天有哪些任务到期？」「牛奶买好了」或「把取快递删掉」。";
const clarification = {
  unknown: help,
  multiple:
    "离线模式一次只能处理一类写入指令，请拆成一句话一条，或配置 DEEPSEEK_API_KEY 启用完整智能体。",
  cancelled: "好的，没改动你的清单，需要时再告诉我。",
  title: "请告诉我要记什么，任务标题需要 1 至 200 个字符。",
  details:
    "请确认任务信息：日期支持「今天」「明天」「下周三」或 YYYY-MM-DD，优先级为高/中/低，工作量为小/中/大。",
};

function isInquiry(content: string) {
  if (
    /^(?:请问|(?:我)?想(?:问|知道|了解)|如果|假如|假设|举个?例|比如|怎么|怎样|如何|有没有)/u.test(
      content,
    )
  ) {
    return true;
  }
  const question = /(?:[？?]|[吗么呢][。！!]?)\s*$/u.test(content);
  const request =
    /^(?:(?:请|能不能|能否|可不可以|可以|能|麻烦你?)\s*)?(?:再\s*)?(?:帮我|给我|替我)|^(?:请|麻烦你?)\s*(?:把|将|记|添加|新增|删|移除|完成|勾选)/u.test(
      content,
    );
  return question && !request;
}

export function createAgent(tasks: TaskStore, runner?: AgentRunner, clock = () => new Date()) {
  return async (messages: ChatMessage[]): Promise<string> => {
    const content = messages.at(-1)?.content;
    if (!content) return help;
    if (content.length > 2000) return "这条消息有点长，请简洁告诉我你要处理的任务。";

    const now = clock();

    // 配置了 DeepSeek 时，由真正的 Tool Calling 智能体主驱动全部对话。
    if (runner) {
      try {
        return await runner(messages, tasks, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`DeepSeek 调用失败：${message}`);
        return "暂时无法连接 DeepSeek 服务，当前清单未发生变化，请检查网络、API Key 或稍后重试。";
      }
    }

    // 未配置 Key 时，走离线规则降级模式。
    const today = localDate(now);
    const intent = readLocalIntent(content, now);
    if (!intent) return help;

    // 针对原始未去标点文本执行问句拦截，防止「删除第2条？」这类问句误触发写入。
    if (intent.action !== "list" && intent.action !== "clarify" && isInquiry(content)) {
      return "如果要修改清单，请直接告诉我要做什么，例如「完成买牛奶」。";
    }

    return executeLocalIntent(intent, messages, tasks, today);
  };
}

function normalizeTitle(title: string) {
  return unquote(title).normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

function matchingTasks(tasks: Task[], target: string, quoted: boolean) {
  if (!quoted && target.startsWith("#")) {
    const id = target.slice(1);
    const exact = tasks.filter((task) => task.id.toLowerCase() === id);
    const codes =
      exact.length || id.length !== 8
        ? exact
        : tasks.filter((task) => task.id.toLowerCase().startsWith(id));
    if (codes.length) return codes;
  }

  const exact = tasks.filter((task) => normalizeTitle(task.title) === target);
  if (exact.length || quoted || [...target].length < 2) return exact;
  return tasks.filter((task) => normalizeTitle(task.title).includes(target));
}

function selectTask(
  tasks: Task[],
  query: string,
  actionKind: "complete" | "reopen" | "delete" | "edit" | "parent",
  example: (code: string) => string,
) {
  const target = normalizeTitle(query);
  const quoted = unquote(query) !== query.trim();
  const generic =
    /^(?:(?:所有|全部|这些|那些|我的)(?:已完成|未完成)?(?:任务|待办|清单)?|它们?|这(?:个|条)|那(?:个|条)|刚才那条|任务|清单|待办)$/u;
  if (!target || (!quoted && generic.test(target))) {
    return { reply: "请告诉我具体的任务名称，例如「完成买牛奶」。" };
  }

  let matches = matchingTasks(tasks, target, quoted);
  if (matches.length > 1) {
    if (actionKind === "complete") {
      const pending = matches.filter((item) => !item.done);
      if (pending.length === 1) return { task: pending[0] };
      if (pending.length > 1) matches = pending;
    } else if (actionKind === "reopen") {
      const done = matches.filter((item) => item.done);
      if (done.length === 1) return { task: done[0] };
      if (done.length > 1) matches = done;
    }
  }

  if (!matches.length) return { reply: `没找到「${query}」。可以先看看清单，确认任务名称。` };
  if (matches.length === 1) return { task: matches[0] };

  const codes = matches.map((task) => {
    const prefix = task.id.slice(0, 8);
    return tasks.filter((item) => item.id.toLowerCase().startsWith(prefix.toLowerCase())).length ===
      1
      ? prefix
      : task.id;
  });
  const supportsOrdinal =
    actionKind === "complete" || actionKind === "delete" || actionKind === "reopen";
  const actionLabel =
    actionKind === "complete"
      ? "完成"
      : actionKind === "delete"
        ? "删除"
        : actionKind === "reopen"
          ? "取消完成"
          : "操作";
  const choices = matches.map(
    (task, index) =>
      `${index + 1}. ${task.title}（${task.done ? "已完成" : "待办"}，#${codes[index]}）`,
  );
  const prompt = supportsOrdinal
    ? `找到多条相关任务，请回复序号（如「第1个」）或编号指定要${actionLabel}的任务，例如「${example("#" + codes[0])}」：`
    : `找到多条相关任务，请用编号指定目标任务，例如「${example("#" + codes[0])}」：`;
  return {
    reply: `${prompt}\n${choices.join("\n")}`,
  };
}

function resolvePreviousChoice(
  messages: ChatMessage[],
  index: number,
  overrideAction?: "complete" | "reopen" | "delete",
): { action: "complete" | "reopen" | "delete"; code: string } | undefined {
  const lastAssistant = [...messages]
    .slice(0, -1)
    .reverse()
    .find((item) => item.role === "assistant");
  if (!lastAssistant || !lastAssistant.content.includes("找到多条相关任务")) return undefined;

  const lines = lastAssistant.content.split("\n");
  const pickedLine = lines.find((line) => line.startsWith(`${index}. `));
  if (!pickedLine) return undefined;

  const codeMatch = /#([^）\s]+)）$/u.exec(pickedLine);
  if (!codeMatch) return undefined;

  let originalAction: "complete" | "reopen" | "delete" | undefined;
  if (lastAssistant.content.includes("要删除的任务")) originalAction = "delete";
  else if (lastAssistant.content.includes("要取消完成的任务")) originalAction = "reopen";
  else if (lastAssistant.content.includes("要完成的任务")) originalAction = "complete";

  if (!originalAction) return undefined;
  // 防止用户用序号快捷回复暗中切换上一轮待确认动作
  if (overrideAction && overrideAction !== originalAction) return undefined;
  return { action: originalAction, code: `#${codeMatch[1]}` };
}

function describeTask(task: Task, parentTitle?: string, today?: string) {
  const details = taskDetailsLabels(task, parentTitle, today);
  return details.length ? `${task.title}（${details.join(" · ")}）` : task.title;
}

function formatTreeGroup(items: Task[], done: boolean, label: string, today: string) {
  const tree = buildTaskTree(items, today);
  const rows: string[] = [];

  for (const { task, subtasks } of tree) {
    if (task.done === done) {
      rows.push(`• ${describeTask(task, undefined, today)}`);
      for (const child of subtasks) {
        if (child.done === done) {
          rows.push(`  ↳ ${describeTask(child, undefined, today)}`);
        }
      }
    } else {
      // 主任务在另一分组，但子任务属于当前分组时单独列出并注明归属
      for (const child of subtasks) {
        if (child.done === done) {
          rows.push(`• ${describeTask(child, task.title, today)}`);
        }
      }
    }
  }

  return [`${label}（${rows.length}）`, ...rows].join("\n");
}

function formatList(items: Task[], intent: Extract<Intent, { action: "list" }>, today: string) {
  const { status = "all", dueDate, includeOverdue } = intent;

  if (dueDate) {
    const titles = new Map(items.map((task) => [task.id, task.title]));
    const matched = sortTasksByUrgency(
      items.filter(
        (task) =>
          task.dueDate === dueDate && (status === "all" || task.done === (status === "done")),
      ),
      today,
    );
    const overdue = includeOverdue
      ? sortTasksByUrgency(
          items.filter((task) => !task.done && getTaskDueState(task, today) === "overdue"),
          today,
        )
      : [];

    const heading = dueDate === today ? "今天到期" : `${dueDate} 到期`;
    const sections: string[] = [];

    if (overdue.length > 0) {
      sections.push(
        [
          `已逾期未完成（${overdue.length}）`,
          ...overdue.map((task) => {
            const parent =
              typeof task.parentId === "string" ? titles.get(task.parentId) : undefined;
            return `• ${describeTask(task, parent, today)}`;
          }),
        ].join("\n"),
      );
    }

    if (matched.length > 0) {
      sections.push(
        [
          `${heading}（${matched.length}）`,
          ...matched.map((task) => {
            const parent =
              typeof task.parentId === "string" ? titles.get(task.parentId) : undefined;
            return `• ${describeTask(task, parent, today)}`;
          }),
        ].join("\n"),
      );
    } else {
      sections.push(`${heading}（0）\n暂无${dueDate === today ? "今天" : "该日"}到期的待办。`);
    }

    return sections.join("\n\n");
  }

  if (!items.length) return "任务清单还是空的。可以说「帮我记一下买牛奶」添加第一条。";

  return [
    status !== "done" ? formatTreeGroup(items, false, "待办", today) : "",
    status !== "pending" ? formatTreeGroup(items, true, "已完成", today) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function executeLocalIntent(
  intent: Intent,
  messages: ChatMessage[],
  tasks: TaskStore,
  today: string,
): string {
  if (intent.action === "clarify") return clarification[intent.reason ?? "unknown"];

  if (intent.action === "select_choice") {
    const resolved = resolvePreviousChoice(messages, intent.index, intent.overrideAction);
    if (!resolved) return "没有找到上一轮的可选列表，请直接告诉我任务名称。";
    return executeLocalIntent(
      { action: resolved.action, target: resolved.code },
      messages,
      tasks,
      today,
    );
  }

  const items = tasks.list();

  if (intent.action === "list") return formatList(items, intent, today);

  if (intent.action === "create") {
    const replies: string[] = [];
    for (const draft of intent.items) {
      const currentItems = tasks.list();
      let parentTask: Task | undefined;
      if (draft.parent) {
        const selected = selectTask(
          currentItems,
          draft.parent,
          "parent",
          (code) => `给${code}加子任务${draft.title}`,
        );
        if (!selected.task) return selected.reply;
        parentTask = selected.task;
        if (typeof parentTask.parentId === "string") return "子任务只支持一层，请选一条主任务。";
      }

      const task = tasks.create(draft.title, {
        parentId: parentTask?.id,
        dueDate: draft.dueDate,
        priority: draft.priority,
        effort: draft.effort,
      });
      const name = describeTask(task, undefined, today);
      replies.push(
        parentTask ? `已为「${parentTask.title}」添加子任务「${name}」。` : `已记下「${name}」。`,
      );
    }
    return replies.join("\n");
  }

  const actionKind =
    intent.action === "complete" || intent.action === "reopen" || intent.action === "delete"
      ? intent.action
      : "edit";

  const selected = selectTask(items, intent.target, actionKind, (code) => {
    if (intent.action === "complete") return `完成 ${code}`;
    if (intent.action === "reopen") return `取消完成 ${code}`;
    if (intent.action === "delete") return `删除 ${code}`;
    if (intent.action === "rename") return `把 ${code} 改为${intent.newTitle}`;
    const fields = [
      intent.dueDate
        ? `截止日期改为${intent.dueDate}`
        : intent.dueDate === null
          ? "取消截止日期"
          : "",
      intent.priority
        ? `优先级改为${priorityLabels[intent.priority]}`
        : intent.priority === null
          ? "取消优先级"
          : "",
      intent.effort
        ? `工作量改为${effortLabels[intent.effort]}`
        : intent.effort === null
          ? "取消工作量"
          : "",
    ];
    return `把 ${code} 的${fields.filter(Boolean).join("，")}`;
  });
  if (!selected.task) return selected.reply;
  const task = selected.task;
  const missing = `找不到「${task.title}」。请再看看清单。`;

  if (intent.action === "delete") {
    const children = items.filter((item) => item.parentId === task.id).length;
    if (!tasks.remove(task.id)) return missing;
    return `已删除「${task.title}」。${children ? `${children} 条子任务已转为独立任务。` : ""}`;
  }

  if (intent.action === "complete") {
    if (task.done) return `「${task.title}」已经完成了。`;
    const updated = tasks.update(task.id, { done: true });
    if (!updated) return missing;

    if (typeof updated.parentId === "string") {
      const latest = tasks.list();
      const parent = latest.find((item) => item.id === updated.parentId);
      const siblings = latest.filter((item) => item.parentId === updated.parentId);
      if (parent && !parent.done && siblings.length > 0 && siblings.every((item) => item.done)) {
        return `已完成「${task.title}」。主任务「${parent.title}」下的子任务已全部完成，需要一并标记完成吗？`;
      }
    }
    return `已完成「${task.title}」。`;
  }

  if (intent.action === "reopen") {
    if (!task.done) return `「${task.title}」本来就在待办里。`;
    return tasks.update(task.id, { done: false }) ? `已将「${task.title}」恢复为待办。` : missing;
  }

  if (intent.action === "rename") {
    const updated = tasks.update(task.id, { title: intent.newTitle });
    return updated ? `已将「${task.title}」改名为「${updated.title}」。` : missing;
  }

  const { dueDate, priority, effort } = intent;
  const updated = tasks.update(task.id, {
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(effort !== undefined ? { effort } : {}),
  });
  return updated ? `已更新「${describeTask(updated, undefined, today)}」。` : missing;
}
