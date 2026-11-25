import { addDaysToDate, localDateString } from "../shared/task.ts";
import type { Intent } from "./intent.ts";
import { taskDate, taskTitle, type TaskDetails, type TaskDetailsUpdate } from "./task-schema.ts";

const priorities = { 高: 1, 中: 2, 低: 3 } as const;
const efforts = { 小: "small", 中: "medium", 大: "large" } as const;
const dayOffsets = new Map([
  ["今天", 0],
  ["今日", 0],
  ["明天", 1],
  ["明日", 1],
  ["后天", 2],
  ["大后天", 3],
]);
const weekdayMap: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
};
const chineseOrdinals: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const dateToken =
  "(?:今天|今日|明天|明日|后天|大后天|(?:这|本|下)?周[一二三四五六日天]|\\d{4}-\\d{2}-\\d{2})";
const datePrefix = new RegExp(`^(${dateToken})\\s*(?:前|之前|要)?\\s*(.+)$`, "u");
const dateQuery = new RegExp(
  `^(${dateToken})(?:有什么|有哪些)?(?:到期的)?(?:任务|待办)(?:到期)?(?:有哪些|有什么)?$`,
  "u",
);

export function localDate(date: Date) {
  return localDateString(date);
}

export function readDate(value: string, now: Date): string | undefined {
  const token = value.trim();
  const offset = dayOffsets.get(token);
  if (offset !== undefined) return addDaysToDate(now, offset);

  const week = /^(这|本|下)?周([一二三四五六日天])$/u.exec(token);
  if (week) {
    const scope = week[1] ?? "";
    const targetDay = weekdayMap[week[2]];
    const currentDay = now.getDay();
    const mondayBasedCurrent = currentDay === 0 ? 7 : currentDay;
    const mondayBasedTarget = targetDay === 0 ? 7 : targetDay;
    let delta = mondayBasedTarget - mondayBasedCurrent;
    if (scope === "下") {
      delta += 7;
    } else if (!scope && delta < 0) {
      delta += 7;
    }
    return addDaysToDate(now, delta);
  }

  return taskDate.safeParse(token).data;
}

export function unquote(value: string) {
  const text = value.trim();
  const quotes: Partial<Record<string, string>> = { "「": "」", "『": "』", "“": "”", '"': '"' };
  const closing = quotes[text[0]];
  return closing && text.endsWith(closing) ? text.slice(1, -1).trim() : text;
}

function parseDetails(
  fields: string[],
  now: Date,
  allowClear: boolean,
): TaskDetailsUpdate | undefined {
  const details: TaskDetailsUpdate = {};
  for (const rawField of fields) {
    const field = rawField.trim();
    if (!field) continue;

    if (allowClear && /^(?:取消|清除|去掉|删掉)?(?:截止(?:日期)?|到期(?:日期)?)$/u.test(field)) {
      details.dueDate = null;
      continue;
    }
    if (allowClear && /^(?:取消|清除|去掉)优先级$/u.test(field)) {
      details.priority = null;
      continue;
    }
    if (allowClear && /^(?:取消|清除|去掉)工作量$/u.test(field)) {
      details.effort = null;
      continue;
    }

    const priority = /^优先级\s*(?:[:：]|为|设为|改为|调到|调成)?\s*(高|中|低)$/u.exec(field);
    if (priority) {
      details.priority = priorities[priority[1] as keyof typeof priorities];
      continue;
    }

    const effort = /^工作量\s*(?:[:：]|为|设为|改为|调到|调成)?\s*(小|中|大)$/u.exec(field);
    if (effort) {
      details.effort = efforts[effort[1] as keyof typeof efforts];
      continue;
    }

    const date =
      /^(?:到期(?:日期)?|截止(?:日期)?)\s*(?:[:：]|为|设为|改到|改为|调到|是)?\s*(.+)$/u.exec(
        field,
      );
    if (date) {
      const dueDate = readDate(date[1], now);
      if (!dueDate) return undefined;
      details.dueDate = dueDate;
      continue;
    }

    return undefined;
  }
  return details;
}

function splitDetailsSegments(raw: string): string[] {
  return raw
    .split(/\s*(?:[,，]\s*|\s+)(?=(?:取消|清除|去掉)?(?:优先级|工作量|截止|到期))/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function readSingleCreation(content: string, now: Date, parent?: string) {
  const parts = splitDetailsSegments(content);
  if (!parts.length) return { error: "title" as const };
  const [name, ...fields] = parts;
  const details = parseDetails(fields, now, false) as TaskDetails | undefined;
  if (!details) return { error: "details" as const };

  const dated = datePrefix.exec(name.trim());
  if (dated) {
    const dueDate = readDate(dated[1], now);
    if (!dueDate || (details.dueDate && details.dueDate !== dueDate)) {
      return { error: "details" as const };
    }
    details.dueDate = dueDate;
  }

  const rawTitle = unquote(dated ? dated[2] : name);
  const title = taskTitle.safeParse(rawTitle);
  if (!title.success) return { error: "title" as const };
  return { item: { title: title.data, ...(parent ? { parent } : {}), ...details } };
}

const actionVerbStart =
  /^(?:买|取|洗|交|写|寄|拿|倒|还|做|看|读|发|付|修|收|开|整理|准备|预约|打印|提交|复习|联系|回复|清理|打扫|购买|归还|下载|备份|更新|检查|核对|确认|报销|取走)/u;

function readCreation(content: string, now: Date, parent?: string): Intent {
  const trimmed = content.trim();
  if (!trimmed) return { action: "clarify", reason: "title" };

  // 只有每段都能独立成待办时才拆分，保留「整理语文、数学笔记」这类共享动词的标题。
  const hasQuote = /[「『“"]/u.test(trimmed);
  const hasAttr = /(?:优先级|工作量|截止|到期)/u.test(trimmed);
  if (!parent && !hasQuote && !hasAttr && /(?:、|以及|和)/u.test(trimmed)) {
    const segments = trimmed.split(/\s*(?:、|以及|和)\s*/u);
    if (
      segments.length >= 2 &&
      segments.length <= 10 &&
      segments.every((part) => actionVerbStart.test(part) && [...part].length >= 2)
    ) {
      const items = [];
      for (const segment of segments) {
        const parsed = readSingleCreation(segment, now);
        if ("error" in parsed) return { action: "clarify", reason: parsed.error };
        items.push(parsed.item);
      }
      return { action: "create", items };
    }
  }

  const parsed = readSingleCreation(trimmed, now, parent);
  if ("error" in parsed) return { action: "clarify", reason: parsed.error };
  return { action: "create", items: [parsed.item] };
}

function parseOrdinal(token: string): number | undefined {
  if (/^\d+$/u.test(token)) {
    const num = Number(token);
    return num >= 1 && num <= 20 ? num : undefined;
  }
  return chineseOrdinals[token];
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
  if (!text) return undefined;

  const command = text.replace(
    /^(?:请\s*)?(?:再\s*)?(?:(?:(?:能不能|能否|可不可以|可以|能)\s*)?(?:帮|给|替)我\s*)?(?:再\s*)?/u,
    "",
  );
  const request =
    command !== text && /[?？]\s*$/u.test(content) ? command.replace(/[吗么]$/u, "") : command;

  if (/^(?:先|暂时)?(?:别|不要|不用|不必|算了)/u.test(request)) {
    return { action: "clarify", reason: "cancelled" };
  }

  // 上下文序号选择（例如「1」「第一个」「删除第2条」「完成 1」）
  const choice =
    /^(?:(完成|删除|删掉|取消完成)\s*)?(?:选|选择)?第?\s*([1-9]\d?|[一二两三四五六七八九十])\s*(?:个|条|项)?$/u.exec(
      request,
    );
  if (choice) {
    const index = parseOrdinal(choice[2]);
    if (index) {
      const actionWord = choice[1];
      const overrideAction =
        actionWord === "完成"
          ? "complete"
          : actionWord === "删除" || actionWord === "删掉"
            ? "delete"
            : actionWord === "取消完成"
              ? "reopen"
              : undefined;
      return { action: "select_choice", index, ...(overrideAction ? { overrideAction } : {}) };
    }
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
    return {
      action: "list",
      status: "pending",
      dueDate,
      includeOverdue: due[1] === "今天" || due[1] === "今日",
    };
  }
  if (
    /^(?:(?:看看|查看|列出)?(?:未完成的任务|剩余待办|待办任务)|还有(?:哪些|什么)(?:待办|没做))$/u.test(
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

  // 取消完成 / 标为未完成
  const reopen =
    /^(?:取消完成|撤销完成|重新打开)\s*(.+?)(?:吧)?$/u.exec(request) ??
    /^(?:把|将)?\s*(.+?)\s*(?:这一?条(?:待办|任务)?)?\s*(?:标记(?:为|成)|标为|改为|改回|恢复(?:为|成)?|设为)\s*(?:未完成|待办)(?:吧)?$/u.exec(
      request,
    );
  if (reopen) return { action: "reopen", target: reopen[1] };

  // 修改属性（支持「把 X 的优先级改为高」或「取消 X 的截止日期」），需优先于改标题规则匹配
  const clearDetail =
    /^(?:取消|清除|去掉)\s*(.+?)\s*的\s*(截止(?:日期)?|到期(?:日期)?|优先级|工作量)$/u.exec(
      request,
    );
  if (clearDetail) {
    const details = parseDetails([`取消${clearDetail[2]}`], now, true);
    if (!details) return { action: "clarify", reason: "details" };
    return { action: "edit", target: clearDetail[1], ...details };
  }

  const edit = /^(?:把|将)?\s*(.+?)\s*的\s*((?:优先级|工作量|到期|截止).+)$/u.exec(request);
  if (edit) {
    const details = parseDetails(splitDetailsSegments(edit[2]), now, true);
    if (!details || Object.keys(details).length === 0) {
      return { action: "clarify", reason: "details" };
    }
    return { action: "edit", target: edit[1], ...details };
  }

  // 修改标题
  const rename =
    /^(?:把|将)\s*(.+?)\s*(?:这一?条(?:待办|任务)?)?\s*(?:改名为|重命名为|改成|改为)\s*(.+)$/u.exec(
      request,
    );
  if (rename && !/^(?:未完成|待办|已完成|完成)$/u.test(rename[2].trim())) {
    const newTitle = taskTitle.safeParse(unquote(rename[2]));
    if (!newTitle.success) return { action: "clarify", reason: "title" };
    return { action: "rename", target: rename[1], newTitle: newTitle.data };
  }

  const remove =
    /^(?:删除|删掉|移除)\s*(.+?)(?:吧)?$/u.exec(request) ??
    /^(?:把|将)?\s*(.+?)\s*(?:这一?条(?:待办|任务)?)?\s*(?:删除|删掉|删了|移除)(?:吧)?$/u.exec(
      request,
    );
  if (remove) return { action: "delete", target: remove[1] };

  const complete =
    /^(?:完成|勾选)\s*(.+?)(?:吧)?$/u.exec(request) ??
    /^(?:把|将)?\s*(.+?)\s*(?:这一?条(?:待办|任务)?)?\s*(?:标记(?:为|成)|标为|改为|改成|设为)\s*(?:已)?完成(?:吧)?$/u.exec(
      request,
    );
  if (complete) return { action: "complete", target: complete[1] };

  // 动宾倒装/完成报告（如「牛奶买好了」「买完牛奶了」「衣服洗好了」「快递取了」「牛奶买回来了」）
  const verbObjDone =
    /^(?:我\s*)?(?:已经|已|刚刚|刚才|刚)?(买|洗|取|拿|做|写|交|发|寄|收|看|读|开|修|付|还)完(.+?)了$/u.exec(
      request,
    );
  if (verbObjDone) {
    const subject = unquote(verbObjDone[2]);
    return { action: "complete", target: verbObjDone[1] + subject };
  }

  const report =
    /^(.+?)(?:已经|已|刚刚|刚才|刚)?(买|洗|取|拿|做|写|交|发|寄|收|看|读|开|修|付|还)(?:好了|完了|到了|回来了|上去了|掉了|了)$/u.exec(
      request,
    ) ?? /^(.+?)(?:已经)?(?:完成了|搞定了|做好了|弄好了|办妥了)$/u.exec(request);
  if (!report) return undefined;
  if (/(?:没有|还没|没|未)$/u.test(report[1])) {
    return { action: "clarify", reason: "unknown" };
  }
  const verb = report[2];
  if (!verb) return { action: "complete", target: report[1] };
  const subject = unquote(report[1].replace(/^(?:我\s*)?(?:把|将)\s*/u, ""));
  return { action: "complete", target: subject.startsWith(verb) ? subject : verb + subject };
}
