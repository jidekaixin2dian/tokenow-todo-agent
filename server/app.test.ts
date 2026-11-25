import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import OpenAI from "openai";
import type { ChatMessage } from "../shared/chat.ts";
import { createAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import { createDeepSeekInterpreter } from "./model.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

interface TestAppOptions {
  filename?: string;
  agent?: (tasks: TaskStore) => (messages: ChatMessage[]) => Promise<string>;
}

async function startTestApp(t: TestContext, { filename, agent }: TestAppOptions = {}) {
  if (!filename) {
    const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    filename = join(directory, "tasks.json");
  }
  const tasks = createJsonTaskStore(filename);
  const conversations: ChatMessage[][] = [];
  const app = createApp({
    tasks,
    reply:
      agent?.(tasks) ??
      (async (messages) => {
        conversations.push(messages);
        return "收到";
      }),
  });

  const server = app.listen(0, "127.0.0.1");
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= server[Symbol.asyncDispose]());
  t.after(close);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  const messages: ChatMessage[] = [];
  async function chat(content: string): Promise<string> {
    messages.push({ role: "user", content });
    const result = await request("POST", "/api/chat", { messages });
    assert.equal(result.status, 200);
    const reply = result.body.reply;
    assert.equal(typeof reply, "string");
    messages.push({ role: "assistant", content: reply });
    return reply;
  }

  return { request, conversations, filename, close, chat };
}

test("任务 API 可以创建、列出、修改和删除任务", async (t) => {
  const { request } = await startTestApp(t);
  const collection = "/api/tasks";
  assert.deepEqual(await request("GET", collection), { status: 200, body: [] });

  const created = await request("POST", collection, { title: " 买牛奶 " });
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal(typeof task.id, "string");
  assert.deepEqual(task, { id: task.id, title: "买牛奶", done: false });

  const item = collection + "/" + task.id;
  const completed = await request("PATCH", item, { done: true });
  assert.deepEqual(completed, { status: 200, body: { ...task, done: true } });
  const renamed = await request("PATCH", item, { title: "买面包" });
  assert.deepEqual(renamed, { status: 200, body: { ...task, title: "买面包", done: true } });
  assert.deepEqual((await request("GET", collection)).body, [renamed.body]);

  assert.deepEqual(await request("DELETE", item), { status: 204, body: null });
  assert.deepEqual((await request("GET", collection)).body, []);
});

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const { request, filename } = await startTestApp(t);
  const first = { id: "a", title: "买牛奶", done: false, priority: 1 };
  const second = { id: "b", title: "取快递", done: false };
  await writeFile(filename, JSON.stringify([first, second]));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...first, done: true }, second]);
});

test("聊天 API 只将有效的完整对话传给智能体，并返回其回复", async (t) => {
  const { request, conversations } = await startTestApp(t);
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
    { role: "user", content: "今天有哪些待办？" },
  ];
  const valid = await request("POST", "/api/chat", { messages });
  assert.deepEqual(valid, { status: 200, body: { reply: "收到" } });

  const invalid = await request("POST", "/api/chat", { messages: messages.slice(0, 2) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(conversations, [messages]);
});

test("不用模型也能走完验收对话，服务重启后可以从聊天查到任务", async (t) => {
  const { request, chat, filename, close } = await startTestApp(t, { agent: createAgent });
  assert.match(await chat("帮我记一下买牛奶"), /已记下.*买牛奶/u);
  assert.match(await chat("再记一条取快递"), /已记下.*取快递/u);
  assert.match(await chat("我有哪些任务？"), /待办（2）\n• 买牛奶\n• 取快递/u);

  assert.match(await chat("牛奶买好了"), /已完成「买牛奶」/u);
  assert.match(await chat("牛奶买好了"), /已经完成/u);
  assert.match(await chat("取快递这条删掉吧"), /已删除「取快递」/u);
  assert.match(await chat("再给我看看清单"), /待办（0）\n\n已完成（1）\n• 买牛奶/u);
  const rows = (await request("GET", "/api/tasks")).body;
  assert.deepEqual(
    rows.map(({ title, done }: { title: string; done: boolean }) => ({ title, done })),
    [{ title: "买牛奶", done: true }],
  );

  await close();
  const restarted = await startTestApp(t, { filename, agent: createAgent });
  assert.match(await restarted.chat("看看我的待办"), /已完成（1）\n• 买牛奶/u);
  assert.match(await restarted.chat("帮我记一下洗衣服"), /已记下「洗衣服」/u);
  assert.match(await restarted.chat("衣服洗好了"), /已完成「洗衣服」/u);
});

test("匹配不唯一时保留原任务，用户可凭编号指定，否定、询问和批量命令不会写入", async (t) => {
  const { chat, request } = await startTestApp(t, { agent: createAgent });
  await chat("帮我记一下买牛奶");
  await chat("帮我记一下热牛奶");
  const readTasks = async () => (await request("GET", "/api/tasks")).body;
  const before = await readTasks();

  const choices = await chat("删掉牛奶");
  assert.match(choices, /多条相关任务/u);
  assert.match(choices, /买牛奶（待办，#[0-9a-f]{8}）/u);
  await chat("先别删除买牛奶");
  await chat("牛奶买好了？");
  await chat("删除买牛奶？");
  await chat("完成热牛奶？");
  await chat("帮我记一下");
  await chat("删除不存在的任务");
  await chat("帮我记一下洗衣服，然后删除买牛奶");
  await chat("帮我记一下洗衣服，取快递这条删掉吧");
  await chat("清空任务清单");
  assert.deepEqual(await readTasks(), before);

  assert.match(await chat(`删除 #${before[1].id.slice(0, 8)}`), /已删除「热牛奶」/u);
  assert.deepEqual(await readTasks(), [before[0]]);
  assert.match(await chat("能帮我完成买牛奶吗？"), /已完成「买牛奶」/u);
});

test("完成报告匹配完整的动作和对象，也能按标题操作以 # 开头的任务", async (t) => {
  const { chat, request } = await startTestApp(t, { agent: createAgent });
  await chat("帮我记一下买牛奶");
  await chat("帮我记一下牛奶");
  await chat("帮我记一下热牛奶");
  assert.match(await chat("牛奶买好了"), /已完成「买牛奶」/u);
  await chat("删除买牛奶");
  assert.match(await chat("牛奶买好了"), /没找到「买牛奶」/u);
  const rows = (await request("GET", "/api/tasks")).body;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row: { done: boolean }) => !row.done));

  const named = "#" + rows[0].id.slice(0, 8);
  await chat(`帮我记一下「${named}」`);
  assert.match(await chat(`完成「${named}」`), /已完成/u);
  const after = (await request("GET", "/api/tasks")).body;
  assert.equal(after[0].done, false);
  assert.equal(after[2].title, named);
  assert.equal(after[2].done, true);
});

test("到期筛选、优先级、工作量和子任务都接入原任务 API", async (t) => {
  const agent = (tasks: TaskStore) =>
    createAgent(tasks, undefined, () => new Date(2026, 10, 30, 23, 55));
  const { chat, request } = await startTestApp(t, { agent });
  await chat("帮我记一下今天交报告，优先级高，工作量中");
  await chat("提醒我明天还书");
  await chat("给交报告加子任务整理资料");
  const today = await chat("今天有哪些任务到期？");
  assert.match(today, /今天到期.*交报告/su);
  assert.doesNotMatch(today, /还书|整理资料/u);

  await chat("把交报告的工作量改为小");
  await chat("完成整理资料");
  await chat("给整理资料加子任务不允许嵌套");
  await chat("帮我记一下整理照片，到期2026-02-30");
  const rows = (await request("GET", "/api/tasks")).body;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    id: rows[0].id,
    title: "交报告",
    done: false,
    dueDate: "2026-11-30",
    priority: 1,
    effort: "small",
  });
  assert.equal(rows[1].dueDate, "2026-12-01");
  assert.deepEqual(rows[2], {
    id: rows[2].id,
    title: "整理资料",
    done: true,
    parentId: rows[0].id,
  });
  assert.equal(
    (await request("POST", "/api/tasks", { title: "任务", parentId: "missing" })).status,
    404,
  );
  assert.equal(
    (await request("POST", "/api/tasks", { title: "任务", parentId: rows[2].id })).status,
    400,
  );
  assert.equal((await request("PATCH", "/api/tasks/" + rows[0].id, { priority: 4 })).status, 400);
  assert.match(await chat("删除交报告"), /子任务已转为独立任务/u);
  assert.deepEqual((await request("GET", "/api/tasks")).body, [
    rows[1],
    { id: rows[2].id, title: "整理资料", done: true },
  ]);
});

test("DeepSeek 路径只执行通过校验的意图，空响应、无效 JSON 和模型故障不写入任务", async (t) => {
  let content = '{"action":"create","title":"归档票据"}';
  let status = 200;
  let calls = 0;
  const client = new OpenAI({
    apiKey: "local-test",
    baseURL: "https://test.invalid",
    maxRetries: 0,
    async fetch(url, init) {
      assert.equal(String(url), "https://test.invalid/chat/completions");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.equal(body.reasoning_effort, "none");
      assert.equal(body.messages.at(-1).role, "user");
      assert.ok(body.messages.length <= 9);
      assert.doesNotMatch(JSON.stringify(body.messages), /敏感任务仅存本地/u);
      calls++;
      return Response.json(
        { choices: [{ finish_reason: "stop", message: { content } }] },
        { status },
      );
    },
  });
  const { chat, request } = await startTestApp(t, {
    agent: (tasks) => createAgent(tasks, createDeepSeekInterpreter(client)),
  });
  await request("POST", "/api/tasks", { title: "敏感任务仅存本地" });
  await chat("帮我记一下买草莓");
  assert.equal(calls, 0);
  assert.match(await chat("下班前得把票据扫描归档，你帮忙挂心上"), /已记下「归档票据」/u);
  const before = (await request("GET", "/api/tasks")).body;
  assert.equal(before.length, 3);

  for (const text of ['{"action":"delete","target":"归档票据","also":"买草莓"}', "not-json", " "]) {
    content = text;
    await chat("那件事怎么处理");
  }
  content = '{"action":"delete","target":"归档票据"}';
  await chat("请问有没有什么办法删任务？");
  await chat("我想喝水");
  status = 401;
  await chat("烦请处理前面的事");
  assert.equal(calls, 7);
  assert.deepEqual((await request("GET", "/api/tasks")).body, before);
});
