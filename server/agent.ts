import type { ChatMessage } from "../shared/chat.ts";
import { effortLabels, priorityLabels, taskDetailsLabels, type Task } from "../shared/task.ts";
import { intentSchema, type Intent, type InterpretIntent } from "./intent.ts";
import { localDate, readLocalIntent, unquote } from "./local-intent.ts";
import type { TaskStore } from "./task-store.ts";

const help = "你可以说「帮我记一下买牛奶」「看看我的待办」「牛奶买好了」或「删除买牛奶」。";
const clarification = {
  unknown: help,
  multiple: "一次可以操作一条任务，请告诉我先处理哪一条。",
  cancelled: "好，需要时再告诉我。",
  title: "请告诉我要记什么，任务名称需要 1 至 200 个字符。",
  details:
    "请确认任务的信息。日期可以用「今天」「明天」或 YYYY-MM-DD，优先级用高、中、低，工作量用小、中、大。",
};
const modelWriteWords = {
  create: /待办|清单|记|提醒|追加|添加|新建|新增|收进|帮忙/u,
  complete: /完成|完了|完工|做好|弄好|好了|搞定|交了|办妥|打勾/u,
  delete: /删|移除|去掉|划掉|拿掉|撤下/u,
  edit: /改|调|设|更新|调整|提前|推迟|挪/u,
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

export function createAgent(
  tasks: TaskStore,
  interpret?: InterpretIntent,
  clock = () => new Date(),
) {
  return async (messages: ChatMessage[]): Promise<string> => {
    const content = messages.at(-1)?.content;
    if (!content) return help;
    if (content.length > 1500) return "这条消息有点长，请用一句话告诉我要处理的任务。";

    const now = clock();
    const today = localDate(now);
    const local = readLocalIntent(content, now);
    let intent = local;
    if (!intent && interpret) {
      try {
        // 只为理解当前表达提供少量上下文，任务匹配仍在本地完成。
        const plan = await interpret(
          messages.slice(-8).filter((message) => message.content.length <= 1500),
          today,
        );
        intent = intentSchema.safeParse(plan).data;
      } catch {
        return `暂时无法用语言模型理解这条消息。${help}`;
      }
    }

    if (!intent) return help;
    if (intent.action !== "list" && intent.action !== "clarify") {
      if (isInquiry(content) || (!local && !modelWriteWords[intent.action].test(content))) {
        return "如果要修改清单，请直接告诉我要做什么，例如「完成买牛奶」。";
      }
    }
    return execute(intent, tasks, today);
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

function selectTask(tasks: Task[], query: string, example: (code: string) => string) {
  const target = normalizeTitle(query);
  const quoted = unquote(query) !== query.trim();
  const generic =
    /^(?:(?:所有|全部|这些|那些|我的)(?:已完成|未完成)?(?:任务|待办|清单)?|它们?|这(?:个|条)|那(?:个|条)|刚才那条|任务|清单|待办)$/u;
  if (!target || (!quoted && generic.test(target))) {
    return { reply: "请告诉我具体的任务名称，例如「完成买牛奶」。" };
  }

  const matches = matchingTasks(tasks, target, quoted);
  if (!matches.length) return { reply: `没找到「${query}」。可以先看看清单，确认任务名称。` };
  if (matches.length === 1) return { task: matches[0] };

  const codes = matches.map((task) => {
    const prefix = task.id.slice(0, 8);
    return tasks.filter((item) => item.id.toLowerCase().startsWith(prefix.toLowerCase())).length ===
      1
      ? prefix
      : task.id;
  });
  const choices = matches.map(
    (task, index) => `• ${task.title}（${task.done ? "已完成" : "待办"}，#${codes[index]}）`,
  );
  return {
    reply: `找到多条相关任务，请用编号指定一条，例如「${example("#" + codes[0])}」。\n${choices.join("\n")}`,
  };
}

function describeTask(task: Task, parentTitle?: string) {
  const details = taskDetailsLabels(task, parentTitle);
  return details.length ? `${task.title}（${details.join(" · ")}）` : task.title;
}

function formatList(items: Task[], intent: Extract<Intent, { action: "list" }>, today: string) {
  const { status = "all", dueDate } = intent;
  const titles = new Map(items.map((task) => [task.id, task.title]));
  const heading = dueDate === today ? "今天到期" : dueDate ? `${dueDate} 到期` : "";
  const tasks = dueDate ? items.filter((task) => task.dueDate === dueDate) : items;

  function group(done: boolean, label: string) {
    const rows = tasks
      .filter((task) => task.done === done)
      .map((task) => {
        const parentTitle =
          typeof task.parentId === "string" ? titles.get(task.parentId) : undefined;
        return `• ${describeTask(task, parentTitle)}`;
      });
    return [`${label}（${rows.length}）`, ...rows].join("\n");
  }

  if (!items.length && !heading) return "任务清单是空的。可以说「帮我记一下买牛奶」添加一条。";
  return [
    heading,
    status !== "done" ? group(false, "待办") : "",
    status !== "pending" ? group(true, "已完成") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function execute(intent: Intent, tasks: TaskStore, today: string): string {
  if (intent.action === "clarify") return clarification[intent.reason ?? "unknown"];
  const items = tasks.list();

  if (intent.action === "list") return formatList(items, intent, today);

  if (intent.action === "create") {
    const { parent, title, dueDate, priority, effort } = intent;
    let parentTask: Task | undefined;
    if (parent) {
      const selected = selectTask(items, parent, (code) => `给${code}加子任务${title}`);
      if (!selected.task) return selected.reply;
      parentTask = selected.task;
      if (typeof parentTask.parentId === "string") return "子任务只支持一层，请选一条主任务。";
    }
    const task = tasks.create(title, { parentId: parentTask?.id, dueDate, priority, effort });
    const name = describeTask(task);
    return parentTask
      ? `已为「${parentTask.title}」添加子任务「${name}」。`
      : `已记下「${name}」。`;
  }

  const selected = selectTask(items, intent.target, (code) => {
    if (intent.action === "complete") return `完成 ${code}`;
    if (intent.action === "delete") return `删除 ${code}`;
    const fields = [
      intent.dueDate && `截止日期改为${intent.dueDate}`,
      intent.priority && `优先级改为${priorityLabels[intent.priority]}`,
      intent.effort && `工作量改为${effortLabels[intent.effort]}`,
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
    return tasks.update(task.id, { done: true }) ? `已完成「${task.title}」。` : missing;
  }

  const { dueDate, priority, effort } = intent;
  const updated = tasks.update(task.id, {
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(effort !== undefined ? { effort } : {}),
  });
  return updated ? `已更新「${describeTask(updated)}」。` : missing;
}
