import type { Intent } from "./intent.ts";
import { taskDate, taskTitle, type TaskDetails } from "./task-schema.ts";

const priorities = { 高: 1, 中: 2, 低: 3 } as const;
const efforts = { 小: "small", 中: "medium", 大: "large" } as const;
const dayOffsets = new Map([
  ["今天", 0],
  ["明天", 1],
  ["后天", 2],
]);
const datePrefix = /^(今天|明天|后天|\d{4}-\d{2}-\d{2})\s*(?:要\s*)?(.+)$/u;
const dateQuery =
  /^(今天|明天|后天|\d{4}-\d{2}-\d{2})(?:有什么|有哪些)?(?:到期的)?(?:任务|待办)(?:到期)?(?:有哪些|有什么)?$/u;

export function localDate(date: Date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return [year, month, day].join("-");
}

function readDate(value: string, now: Date) {
  const offset = dayOffsets.get(value);
  if (offset === undefined) return taskDate.safeParse(value).data;
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return localDate(date);
}

export function unquote(value: string) {
  const text = value.trim();
  const quotes: Partial<Record<string, string>> = { "「": "」", "『": "』", "“": "”", '"': '"' };
  const closing = quotes[text[0]];
  return closing && text.endsWith(closing) ? text.slice(1, -1).trim() : text;
}

function readDetails(fields: string[], now: Date): TaskDetails | undefined {
  const details: TaskDetails = {};
  for (const field of fields) {
    const priority = /^优先级\s*(?:[:：]|为|设为|改为|调到)?\s*(高|中|低)$/u.exec(field);
    if (priority) {
      details.priority = priorities[priority[1] as keyof typeof priorities];
      continue;
    }

    const effort = /^工作量\s*(?:[:：]|为|设为|改为|调到)?\s*(小|中|大)$/u.exec(field);
    if (effort) {
      details.effort = efforts[effort[1] as keyof typeof efforts];
      continue;
    }

    const date = /^(?:到期|截止(?:日期)?)\s*(?:[:：]|为|设为|改到|改为|是)?\s*(.+)$/u.exec(field);
    const dueDate = date && readDate(date[1], now);
    if (!dueDate) return undefined;
    details.dueDate = dueDate;
  }
  return details;
}

function readCreation(content: string, now: Date, parent?: string): Intent {
  const [name, ...fields] = content.split(/\s*[,，]\s*(?=优先级|工作量|截止|到期)/u);
  const details = readDetails(fields, now);
  const dated = datePrefix.exec(name.trim());
  if (!details) return { action: "clarify", reason: "details" };
  if (dated) {
    const dueDate = readDate(dated[1], now);
    if (!dueDate || (details.dueDate && details.dueDate !== dueDate)) {
      return { action: "clarify", reason: "details" };
    }
    details.dueDate = dueDate;
  }

  const title = taskTitle.safeParse(unquote(dated ? dated[2] : name));
  if (!title.success) return { action: "clarify", reason: "title" };
  return { action: "create", title: title.data, parent, ...details };
}

const clauseBreak = /\s*(?:[,，;；\n]+|然后|顺便|接着|另外)\s*/u;
const commandStart =
  /^(?:再\s*)?(?:帮我|给我)?\s*(?:记(?:一条|一下|下)|添加|新增|删除|删掉|完成|清空)/u;
const commandEnd = /(?:删掉|删了|删除|移除|标记(?:为|成)?完成)(?:吧)?$/u;

const listAll =
  /^(?:(?:看看|看一下|列出|查看|显示)(?:一下)?(?:我的)?(?:全部)?(?:任务(?:清单)?|待办(?:清单)?|清单)|我(?:还)?有(?:哪些|什么)(?:任务|待办)|(?:我的)?(?:任务|待办)(?:有)?(?:哪些|有什么))(?:吧|吗)?$/u;

export function readLocalIntent(content: string, now: Date): Intent | undefined {
  const text = content
    .trim()
    .replace(/[。.!！?？]+$/u, "")
    .trim();
  const command = text.replace(
    /^(?:请\s*)?(?:再\s*)?(?:(?:(?:能不能|能否|可不可以|可以|能)\s*)?(?:帮|给|替)我\s*)?(?:再\s*)?/u,
    "",
  );
  const request =
    command !== text && /[?？]\s*$/u.test(content) ? command.replace(/[吗么]$/u, "") : command;
  if (/^(?:先|暂时)?(?:别|不要|不用|不必)/u.test(request)) {
    return { action: "clarify", reason: "cancelled" };
  }
  const additional = request.split(clauseBreak).slice(1);
  if (
    additional.some((clause) => commandStart.test(clause) || commandEnd.test(clause)) ||
    request.startsWith("清空")
  ) {
    return { action: "clarify", reason: "multiple" };
  }

  const due = dateQuery.exec(request);
  if (due) {
    const dueDate = readDate(due[1], now);
    if (!dueDate) return { action: "clarify", reason: "details" };
    return { action: "list", status: "pending", dueDate };
  }
  if (
    /^(?:(?:看看|查看|列出)?(?:未完成的任务|剩余待办)|还有(?:哪些|什么)(?:待办|没做))$/u.test(
      request,
    )
  ) {
    return { action: "list", status: "pending" };
  }
  if (/^(?:看看|查看|列出)?(?:已完成的任务|哪些任务已完成|完成了哪些任务)$/u.test(request)) {
    return { action: "list", status: "done" };
  }
  if (listAll.test(request)) return { action: "list" };

  const child = /^给\s*(.+?)\s*(?:加|添加|新增)(?:个|一个|一条)?子任务\s*[:：]?\s*(.*)$/u.exec(
    request,
  );
  if (child) {
    return unquote(child[1])
      ? readCreation(child[2], now, child[1])
      : { action: "clarify", reason: "unknown" };
  }
  const create =
    /^(?:记一下|记一条(?:待办)?|记个待办|记下|提醒我|添加(?:一条)?(?:待办)?|新增(?:一条)?(?:待办)?)\s*[:：]?\s*(.*)$/u.exec(
      request,
    );
  if (create) return readCreation(create[1], now);

  const edit = /^(?:把|将)?\s*(.+?)\s*的\s*((?:优先级|工作量|到期|截止).+)$/u.exec(request);
  if (edit) {
    const details = readDetails(edit[2].split(/\s*[,，]\s*/u), now);
    if (!details) return { action: "clarify", reason: "details" };
    return { action: "edit", target: edit[1], ...details };
  }

  const remove =
    /^(?:删除|删掉|移除)\s*(.+?)(?:吧)?$/u.exec(request) ??
    /^(?:把|将)?\s*(.+?)\s*(?:这一?条(?:待办|任务)?)?\s*(?:删除|删掉|删了|移除)(?:吧)?$/u.exec(
      request,
    );
  if (remove) return { action: "delete", target: remove[1] };

  const complete =
    /^(?:完成|勾选)\s*(.+?)(?:吧)?$/u.exec(request) ??
    /^(?:把|将)?\s*(.+?)\s*(?:这一?条(?:待办|任务)?)?\s*(?:标记(?:为|成)|标为|设为)\s*(?:已)?完成(?:吧)?$/u.exec(
      request,
    );
  if (complete) return { action: "complete", target: complete[1] };

  const report =
    /^(.+?)(?:已经|已|刚刚|刚才|刚)?(买|洗|取|拿|做|写|交|发|寄|收|看|读|开|修|付)(?:好了|完了|到了)$/u.exec(
      request,
    ) ?? /^(.+?)(?:已经)?(?:完成了|搞定了)$/u.exec(request);
  if (!report) return undefined;
  if (/(?:没有|还没|没|未)$/u.test(report[1])) {
    return { action: "clarify", reason: "unknown" };
  }
  const verb = report[2];
  if (!verb) return { action: "complete", target: report[1] };
  const subject = unquote(report[1].replace(/^(?:我\s*)?(?:把|将)\s*/u, ""));
  return { action: "complete", target: subject.startsWith(verb) ? subject : verb + subject };
}
