// 使用真实 DeepSeek API 运行一组中文口语与边界对话回归用例，验证工具编排、护栏与日期接地表现。
// 用法：npm run eval（可附关键词筛选，如 npm run eval -- 日期）
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../server/agent.ts";
import { createDeepSeekAgentRunner, getModelClient, model } from "../server/model.ts";
import { createJsonTaskStore, type TaskOptions, type TaskStore } from "../server/task-store.ts";
import type { ChatMessage } from "../shared/chat.ts";
import { addDaysToDate, type Task } from "../shared/task.ts";

interface SeedTask {
  title: string;
  done?: boolean;
  dueDate?: string;
  priority?: 1 | 2 | 3;
  effort?: "small" | "medium" | "large";
  parentTitle?: string;
}

interface EvalContext {
  tasks: Task[];
  turnSnapshots: Task[][];
  replies: string[];
  operations: string[];
}

interface EvalScenario {
  name: string;
  seed?: SeedTask[];
  turns: string[];
  verify: (ctx: EvalContext) => string[];
}

const now = new Date();
const day = (offset: number) => addDaysToDate(now, offset);
// 按周一为一周起点计算下周三（与系统提示的「下周（周一至周日）」及 local-intent 一致）
const mondayOffset = now.getDay() === 0 ? -6 : 1 - now.getDay();
const nextWednesday = day(mondayOffset + 7 + 2);

function findByTitle(tasks: Task[], keyword: string): Task | undefined {
  return tasks.find((task) => task.title.includes(keyword));
}

const scenarios: EvalScenario[] = [
  {
    name: "基础：官方 6 句验收全链路",
    turns: [
      "帮我记一下买牛奶",
      "再记一条取快递",
      "我有哪些任务？",
      "牛奶买好了",
      "取快递这条删掉吧",
      "再给我看看清单",
    ],
    verify({ tasks, replies }) {
      const issues: string[] = [];
      if (tasks.length !== 1 || tasks[0].title !== "买牛奶" || !tasks[0].done) {
        issues.push(`期望仅剩已完成「买牛奶」，实际：${JSON.stringify(tasks)}`);
      }
      const last = replies.at(-1) ?? "";
      if (!last.includes("买牛奶")) issues.push("最终回复未列出「买牛奶」");
      if (last.includes("取快递")) issues.push("最终回复不应再包含已删除的「取快递」");
      return issues;
    },
  },
  {
    name: "基础：一次新增两条、改名、完成与取消完成",
    turns: [
      "帮我记两件事：交房租和买猫粮",
      "把买猫粮改名为买狗粮",
      "交房租办完了",
      "交房租其实还没转，取消完成",
    ],
    verify({ tasks, turnSnapshots }) {
      const issues: string[] = [];
      const afterComplete = findByTitle(turnSnapshots[2] ?? [], "交房租");
      if (!afterComplete?.done) {
        issues.push(`第 3 轮后「交房租」应已标完成，实际：${JSON.stringify(afterComplete)}`);
      }
      const rent = findByTitle(tasks, "交房租");
      const food = findByTitle(tasks, "买狗粮");
      if (tasks.length !== 2) issues.push(`期望 2 条任务，实际 ${tasks.length} 条`);
      if (!rent || rent.done) issues.push(`「交房租」应为未完成，实际：${JSON.stringify(rent)}`);
      if (!food || food.done) issues.push(`「买狗粮」应为未完成，实际：${JSON.stringify(food)}`);
      return issues;
    },
  },
  {
    name: "护栏：问句、否定句与假设句不触发写入",
    seed: [{ title: "买牛奶" }],
    turns: ["牛奶买好了吗？", "先别删买牛奶", "如果把买牛奶删了会怎样？"],
    verify({ tasks, operations }) {
      const issues: string[] = [];
      if (operations.length > 0) issues.push(`不应产生写操作，实际：${operations.join("；")}`);
      if (tasks.length !== 1 || tasks[0].title !== "买牛奶" || tasks[0].done) {
        issues.push(`清单被意外修改：${JSON.stringify(tasks)}`);
      }
      return issues;
    },
  },
  {
    name: "护栏：标题含「清空」字样的任务可正常新增",
    turns: ["帮我记一下清空邮箱垃圾邮件"],
    verify({ tasks }) {
      if (tasks.length !== 1 || !tasks[0].title.includes("清空邮箱")) {
        return [`期望正常新增含「清空邮箱」的任务，实际：${JSON.stringify(tasks)}`];
      }
      return [];
    },
  },
  {
    name: "消歧：同名已完成与待办并存时，完成优先命中待办",
    seed: [
      { title: "买牛奶", done: true },
      { title: "买牛奶", done: false },
    ],
    turns: ["牛奶买好了"],
    verify({ tasks }) {
      if (tasks.length !== 2 || !tasks.every((task) => task.done)) {
        return [`期望两条「买牛奶」均为已完成，实际：${JSON.stringify(tasks)}`];
      }
      return [];
    },
  },
  {
    name: "消歧：多条相似候选先确认，回复序号后执行",
    seed: [{ title: "买纯牛奶" }, { title: "买燕麦奶" }],
    turns: ["奶买好了", "第2个"],
    verify({ tasks, replies }) {
      const issues: string[] = [];
      const firstReply = replies[0] ?? "";
      if (!/[12][.、]/u.test(firstReply) && !firstReply.includes("哪")) {
        issues.push(`首轮应列出候选确认，实际回复：${firstReply}`);
      }
      const pure = findByTitle(tasks, "纯牛奶");
      const oat = findByTitle(tasks, "燕麦奶");
      if (!pure || pure.done) issues.push("「买纯牛奶」应保持未完成");
      if (!oat || !oat.done) issues.push("「买燕麦奶」应被标记完成");
      return issues;
    },
  },
  {
    name: "边界：清单里不存在的任务不误改其他条目",
    seed: [{ title: "买牛奶" }],
    turns: ["衣服洗好了"],
    verify({ tasks, operations }) {
      const issues: string[] = [];
      if (operations.length > 0) issues.push(`不应有写操作，实际：${operations.join("；")}`);
      if (tasks.length !== 1 || tasks[0].done) issues.push(`清单被误改：${JSON.stringify(tasks)}`);
      return issues;
    },
  },
  {
    name: "安全：批量清空先确认，回复「取消」保留全部任务",
    seed: [{ title: "买牛奶" }, { title: "取快递" }, { title: "交水费" }],
    turns: ["把这些全部删掉", "取消"],
    verify({ tasks, replies, turnSnapshots }) {
      const issues: string[] = [];
      if (!(replies[0] ?? "").includes("待确认删除 3 条任务")) {
        issues.push(`首轮应触发服务端统一确认提示，实际回复：${replies[0]}`);
      }
      if ((turnSnapshots[0] ?? []).length !== 3) {
        issues.push("确认前不应删除任何任务");
      }
      if (tasks.length !== 3) issues.push(`取消后应保留 3 条任务，实际 ${tasks.length} 条`);
      return issues;
    },
  },
  {
    name: "安全：批量清空确认后彻底清空",
    seed: [{ title: "买牛奶" }, { title: "取快递" }, { title: "交水费" }],
    turns: ["把全部任务删掉", "确认删除"],
    verify({ tasks, replies, turnSnapshots }) {
      const issues: string[] = [];
      if (!(replies[0] ?? "").includes("待确认删除 3 条任务")) {
        issues.push(`首轮应触发服务端统一确认提示，实际回复：${replies[0]}`);
      }
      if ((turnSnapshots[0] ?? []).length !== 3) {
        issues.push("确认前不应删除任何任务");
      }
      if (tasks.length !== 0) issues.push(`确认后应为空清单，实际：${JSON.stringify(tasks)}`);
      return issues;
    },
  },
  {
    name: "安全：3 条任务里删 2 条必须先确认，确认后保留第 3 条",
    seed: [{ title: "买牛奶" }, { title: "取快递" }, { title: "交水费" }],
    turns: ["把买牛奶和取快递删掉", "确认删除"],
    verify({ tasks, replies, turnSnapshots }) {
      const issues: string[] = [];
      if (!(replies[0] ?? "").includes("待确认删除 2 条任务")) {
        issues.push(`删 2 条首轮应触发服务端确认提示，实际回复：${replies[0]}`);
      }
      if ((turnSnapshots[0] ?? []).length !== 3) {
        issues.push("确认前不应删除任何任务");
      }
      if (tasks.length !== 1 || tasks[0].title !== "交水费") {
        issues.push(`确认后应仅剩「交水费」，实际：${JSON.stringify(tasks)}`);
      }
      return issues;
    },
  },
  {
    name: "上下文：指代上一轮任务「刚才那条删掉」",
    turns: ["帮我记一下取快递", "刚才那条删掉"],
    verify({ tasks }) {
      return tasks.length === 0 ? [] : [`期望「取快递」被直接删除，实际：${JSON.stringify(tasks)}`];
    },
  },
  {
    name: "日期与属性：明天到期、高优先级、工作量大",
    turns: ["明天要交周报，很急，工作量很大"],
    verify({ tasks }) {
      const issues: string[] = [];
      const task = tasks[0];
      if (tasks.length !== 1 || !task?.title.includes("周报")) {
        return [`期望 1 条周报任务，实际：${JSON.stringify(tasks)}`];
      }
      if (task.dueDate !== day(1)) issues.push(`期望 dueDate=${day(1)}，实际=${task.dueDate}`);
      if (task.priority !== 1) issues.push(`期望 priority=1，实际=${task.priority}`);
      if (task.effort !== "large") issues.push(`期望 effort=large，实际=${task.effort}`);
      return issues;
    },
  },
  {
    name: "日期与属性：下周三查表换算、低优先级、小工作量",
    turns: ["下周三去体检，不太急，顺手的小事"],
    verify({ tasks }) {
      const issues: string[] = [];
      const task = tasks[0];
      if (tasks.length !== 1 || !task?.title.includes("体检")) {
        return [`期望 1 条体检任务，实际：${JSON.stringify(tasks)}`];
      }
      if (task.dueDate !== nextWednesday) {
        issues.push(`期望 dueDate=${nextWednesday}，实际=${task.dueDate}`);
      }
      if (task.priority !== 3) issues.push(`期望 priority=3，实际=${task.priority}`);
      if (task.effort !== "small") issues.push(`期望 effort=small，实际=${task.effort}`);
      return issues;
    },
  },
  {
    name: "日期：模糊时间「过几天」不瞎猜截止日期",
    turns: ["过几天整理书架"],
    verify({ tasks }) {
      const issues: string[] = [];
      if (tasks.length !== 1 || !tasks[0].title.includes("书架")) {
        return [`期望新增整理书架，实际：${JSON.stringify(tasks)}`];
      }
      if (tasks[0].dueDate !== undefined) {
        issues.push(`模糊时间不应设置 dueDate，实际=${tasks[0].dueDate}`);
      }
      return issues;
    },
  },
  {
    name: "属性：清除截止日期并修改优先级与工作量",
    seed: [{ title: "交报告", dueDate: day(1), priority: 1, effort: "large" }],
    turns: ["交报告不用定截止日期了，优先级改成中，工作量改成小"],
    verify({ tasks }) {
      const task = tasks[0];
      const issues: string[] = [];
      if (task?.dueDate !== undefined) issues.push(`dueDate 应已清除，实际=${task?.dueDate}`);
      if (task?.priority !== 2) issues.push(`priority 应为 2，实际=${task?.priority}`);
      if (task?.effort !== "small") issues.push(`effort 应为 small，实际=${task?.effort}`);
      return issues;
    },
  },
  {
    name: "日程：今天到期查询并准确引用逾期 2 天",
    seed: [
      { title: "还书", dueDate: day(-2) },
      { title: "交水费", dueDate: day(0) },
      { title: "体检", dueDate: day(3) },
      { title: "买牛奶", dueDate: day(0), done: true },
    ],
    turns: ["今天有哪些任务到期？"],
    verify({ replies, operations }) {
      const issues: string[] = [];
      const reply = replies[0] ?? "";
      if (operations.length > 0) issues.push(`查询不应产生写操作：${operations.join("；")}`);
      if (!reply.includes("交水费")) issues.push("回复缺少今天到期的「交水费」");
      if (!reply.includes("还书")) issues.push("回复缺少已逾期的「还书」");
      if (!reply.includes("逾期 2 天") && !reply.includes("逾期2天")) {
        issues.push(`回复未准确引用逾期 2 天：${reply}`);
      }
      return issues;
    },
  },
  {
    name: "子任务：拆分子任务并拦截二层嵌套",
    seed: [{ title: "交报告" }],
    turns: ["把交报告拆成查资料和写初稿两个子任务", "给查资料再加一个子任务找论文"],
    verify({ tasks }) {
      const issues: string[] = [];
      const parent = findByTitle(tasks, "交报告");
      const research = findByTitle(tasks, "查资料");
      const draft = findByTitle(tasks, "写初稿");
      const nested = findByTitle(tasks, "找论文");
      if (!parent || !research || !draft) {
        return [`拆分结果不完整：${JSON.stringify(tasks)}`];
      }
      if (research.parentId !== parent.id || draft.parentId !== parent.id) {
        issues.push(`子任务 parentId 未挂在主任务下：${JSON.stringify(tasks)}`);
      }
      if (nested && nested.parentId === research.id) {
        issues.push("不应允许在子任务下创建二层子任务");
      }
      return issues;
    },
  },
  {
    name: "子任务：全部子任务完成时提醒主任务但不擅自完成主任务",
    seed: [
      { title: "交报告" },
      { title: "查资料", done: true, parentTitle: "交报告" },
      { title: "写初稿", done: false, parentTitle: "交报告" },
    ],
    turns: ["写初稿完成了"],
    verify({ tasks, replies }) {
      const issues: string[] = [];
      const parent = findByTitle(tasks, "交报告");
      const draft = findByTitle(tasks, "写初稿");
      if (!draft?.done) issues.push("「写初稿」应标记为完成");
      if (parent?.done) issues.push("不应擅自将主任务「交报告」标为完成");
      if (!(replies[0] ?? "").includes("交报告")) {
        issues.push("回复应提醒主任务「交报告」");
      }
      return issues;
    },
  },
  {
    name: "子任务：删除主任务时保留子任务并解绑为独立任务",
    seed: [{ title: "交报告" }, { title: "查资料", parentTitle: "交报告" }],
    turns: ["把交报告删掉"],
    verify({ tasks }) {
      const issues: string[] = [];
      if (tasks.length !== 1 || tasks[0].title !== "查资料" || tasks[0].parentId !== undefined) {
        issues.push(`期望仅剩独立任务「查资料」，实际：${JSON.stringify(tasks)}`);
      }
      return issues;
    },
  },
];

function wrapLoggedStore(inner: TaskStore, operations: string[]): TaskStore {
  return {
    list: () => inner.list(),
    create(title: string, options?: TaskOptions) {
      operations.push(`create(${title})`);
      return inner.create(title, options);
    },
    createMany(entries) {
      operations.push(`createMany(${entries.map((entry) => entry.title).join(",")})`);
      return inner.createMany!(entries);
    },
    update(id, changes) {
      operations.push(`update(${id.slice(0, 8)}, ${JSON.stringify(changes)})`);
      return inner.update(id, changes);
    },
    remove(id) {
      operations.push(`remove(${id.slice(0, 8)})`);
      return inner.remove(id);
    },
    removeMany(ids) {
      operations.push(`removeMany(${ids.length})`);
      return inner.removeMany!(ids);
    },
  };
}

async function runScenario(scenario: EvalScenario, client: ReturnType<typeof getModelClient>) {
  const dir = mkdtempSync(join(tmpdir(), "tokenow-eval-"));
  const startedAt = Date.now();
  try {
    const rawStore = createJsonTaskStore(join(dir, "tasks.json"));
    const titleToId = new Map<string, string>();
    for (const item of scenario.seed ?? []) {
      const parentId = item.parentTitle ? titleToId.get(item.parentTitle) : undefined;
      const created = rawStore.create(item.title, {
        dueDate: item.dueDate,
        priority: item.priority,
        effort: item.effort,
        parentId,
      });
      if (item.done) rawStore.update(created.id, { done: true });
      titleToId.set(item.title, created.id);
    }

    const operations: string[] = [];
    const store = wrapLoggedStore(rawStore, operations);
    const runner = createDeepSeekAgentRunner(client, model);
    const reply = createAgent(store, runner, () => new Date(now));
    const conversationId = randomUUID();
    const history: ChatMessage[] = [];
    const replies: string[] = [];
    const turnSnapshots: Task[][] = [];
    const transcript: string[] = [];

    for (const turn of scenario.turns) {
      const opStart = operations.length;
      history.push({ role: "user", content: turn });
      const answer = await reply(history, conversationId);
      history.push({ role: "assistant", content: answer });
      replies.push(answer);
      turnSnapshots.push(rawStore.list());
      const turnOps = operations.slice(opStart);
      transcript.push(`  用户：${turn}`);
      transcript.push(`  小明：${answer.replaceAll("\n", "\n        ")}`);
      if (turnOps.length) transcript.push(`  [写入] ${turnOps.join("；")}`);
    }

    const issues = scenario.verify({ tasks: rawStore.list(), turnSnapshots, replies, operations });
    return { scenario, issues, transcript, elapsedMs: Date.now() - startedAt };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const filter = process.argv[2]?.trim() ?? "";
  const selected = scenarios.filter((item) => !filter || item.name.includes(filter));
  if (!selected.length) {
    console.error(`没有匹配关键词「${filter}」的用例。`);
    process.exitCode = 1;
    return;
  }

  const client = getModelClient();
  console.log(`正在使用真实模型 ${model} 运行 ${selected.length} 组边界对话评测...\n`);

  let passed = 0;
  for (const scenario of selected) {
    const result = await runScenario(scenario, client);
    const ok = result.issues.length === 0;
    if (ok) passed++;
    console.log(`${ok ? "✔" : "✘"} ${scenario.name} (${(result.elapsedMs / 1000).toFixed(1)}s)`);
    if (!ok || filter) {
      console.log(result.transcript.join("\n"));
    }
    for (const issue of result.issues) {
      console.log(`  ! ${issue}`);
    }
    if (!ok || filter) console.log();
  }

  console.log(`\n评测汇总：${passed}/${selected.length} 通过`);
  process.exitCode = passed === selected.length ? 0 : 1;
}

await main();
