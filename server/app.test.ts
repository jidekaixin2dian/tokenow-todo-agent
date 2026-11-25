import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import OpenAI from "openai";
import type { ChatMessage } from "../shared/chat.ts";
import { createAgent } from "./agent.ts";
import { createApp, type AppStatus } from "./app.ts";
import { createDeepSeekAgentRunner } from "./model.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

interface TestAppOptions {
  filename?: string;
  status?: AppStatus;
  agent?: (
    tasks: TaskStore,
  ) => (messages: ChatMessage[], conversationId?: string) => Promise<string>;
}

function useDefaultReasoningEffort(t: TestContext) {
  const original = process.env.DEEPSEEK_REASONING_EFFORT;
  delete process.env.DEEPSEEK_REASONING_EFFORT;
  t.after(() => {
    if (original !== undefined) process.env.DEEPSEEK_REASONING_EFFORT = original;
  });
}

async function startTestApp(t: TestContext, { filename, status, agent }: TestAppOptions = {}) {
  if (!filename) {
    const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    filename = join(directory, "tasks.json");
  }
  const tasks = createJsonTaskStore(filename);
  const conversations: ChatMessage[][] = [];
  const app = createApp({
    tasks,
    status,
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
  const conversationId = randomUUID();
  async function chat(content: string): Promise<string> {
    messages.push({ role: "user", content });
    const result = await request("POST", "/api/chat", { messages, conversationId });
    assert.equal(result.status, 200);
    const reply = result.body.reply;
    assert.equal(typeof reply, "string");
    messages.push({ role: "assistant", content: reply });
    return reply;
  }

  return { request, conversations, filename, close, chat };
}

test("任务 API 可以创建、列出、修改、清除可选字段和删除任务", async (t) => {
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
  const renamed = await request("PATCH", item, {
    title: "买面包",
    dueDate: "2026-11-30",
    priority: 1,
    effort: "medium",
  });
  assert.deepEqual(renamed, {
    status: 200,
    body: {
      ...task,
      title: "买面包",
      done: true,
      dueDate: "2026-11-30",
      priority: 1,
      effort: "medium",
    },
  });

  const cleared = await request("PATCH", item, { dueDate: null, priority: null, effort: null });
  assert.deepEqual(cleared, { status: 200, body: { ...task, title: "买面包", done: true } });
  assert.deepEqual((await request("GET", collection)).body, [cleared.body]);

  assert.deepEqual(await request("DELETE", item), { status: 204, body: null });
  assert.deepEqual((await request("GET", collection)).body, []);
});

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal(
    (await request("POST", "/api/tasks", { title: "测试", parentId: "   " })).status,
    400,
  );
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const { request, filename } = await startTestApp(t);
  const first = { id: "a", title: "买牛奶", done: false, priority: 1, customTag: "keep" };
  const second = { id: "b", title: "取快递", done: false };
  await writeFile(filename, JSON.stringify([first, second]));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...first, done: true }, second]);
});

test("聊天 API 只将有效的完整对话传给智能体，并返回其回复与状态端点", async (t) => {
  const { request, conversations } = await startTestApp(t, {
    status: { mode: "deepseek", model: "deepseek-flash" },
  });
  assert.deepEqual(await request("GET", "/api/status"), {
    status: 200,
    body: { mode: "deepseek", model: "deepseek-flash" },
  });

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

test("离线降级模式完整走通官方验收对话、重启持久化与扩展动作", async (t) => {
  const { chat, filename, close } = await startTestApp(t, { agent: createAgent });
  assert.match(await chat("帮我记一下买牛奶"), /已记下.*买牛奶/u);
  assert.match(await chat("再记一条取快递"), /已记下.*取快递/u);
  assert.match(await chat("我有哪些任务？"), /待办（2）\n• 买牛奶\n• 取快递/u);

  assert.match(await chat("牛奶买好了"), /已完成「买牛奶」/u);
  assert.match(await chat("牛奶买好了"), /已经完成/u);
  assert.match(await chat("取快递这条删掉吧"), /已删除「取快递」/u);
  assert.match(await chat("再给我看看清单"), /待办（0）\n\n已完成（1）\n• 买牛奶/u);

  // 取消完成、改标题 & 「改为已完成」写法
  assert.match(await chat("取消完成买牛奶"), /恢复为待办/u);
  assert.match(await chat("把买牛奶改名为买脱脂牛奶"), /改名为「买脱脂牛奶」/u);
  assert.match(await chat("把买脱脂牛奶改为已完成"), /已完成「买脱脂牛奶」/u);

  await close();
  const restarted = await startTestApp(t, { filename, agent: createAgent });
  assert.match(await restarted.chat("看看我的待办"), /已完成（1）\n• 买脱脂牛奶/u);
  assert.match(await restarted.chat("帮我记一下洗衣服和倒垃圾"), /洗衣服[\s\S]*倒垃圾/u);
  assert.match(await restarted.chat("衣服洗好了"), /已完成「洗衣服」/u);
  const rows = (await restarted.request("GET", "/api/tasks")).body;
  assert.equal(rows.length, 3);
});

test("同名待办优先匹配、序号上下文消歧及否定/询问不写入", async (t) => {
  const { chat, request } = await startTestApp(t, { agent: createAgent });
  await chat("帮我记一下买牛奶");
  await chat("牛奶买好了");
  await chat("帮我记一下买牛奶");
  // 一条已完成 + 一条待办同名，标记完成自动命中待办那条
  assert.match(await chat("牛奶买好了"), /已完成「买牛奶」/u);

  await chat("帮我记一下买燕麦奶");
  await chat("帮我记一下热燕麦奶");
  const readTasks = async () => (await request("GET", "/api/tasks")).body;
  const before = await readTasks();

  const choices = await chat("删掉燕麦奶");
  assert.match(choices, /找到多条相关任务/u);
  assert.match(choices, /1\. 买燕麦奶（待办，#[0-9a-f]{8}）/u);
  assert.match(choices, /2\. 热燕麦奶（待办，#[0-9a-f]{8}）/u);

  // 序号问句不得误触发删除
  await chat("删除第2条？");
  assert.equal((await readTasks()).length, before.length);

  // 重新列出候选并直接回复序号承接上一轮消歧
  await chat("删掉燕麦奶");
  assert.match(await chat("第2个"), /已删除「热燕麦奶」/u);
  assert.equal((await readTasks()).length, before.length - 1);

  const snapshot = await readTasks();
  await chat("先别删除买燕麦奶");
  await chat("买燕麦奶完成了？");
  await chat("清空任务清单");
  assert.deepEqual(await readTasks(), snapshot);

  // 用「和」连接的单个名词短语不应被误拆为两条
  await chat("帮我记一下复习概率和统计");
  const afterCourse = await readTasks();
  assert.equal(afterCourse.length, snapshot.length + 1);
  assert.equal(afterCourse.at(-1).title, "复习概率和统计");
  await chat("帮我记一下整理语文、数学笔记");
  const afterNotes = await readTasks();
  assert.equal(afterNotes.length, afterCourse.length + 1);
  assert.equal(afterNotes.at(-1).title, "整理语文、数学笔记");
});

test("到期日、逾期提醒、优先级、工作量与树形子任务全链路", async (t) => {
  // 2026-11-30 为星期一
  const agent = (tasks: TaskStore) =>
    createAgent(tasks, undefined, () => new Date(2026, 10, 30, 10, 0));
  const { chat, request } = await startTestApp(t, { agent });

  await request("POST", "/api/tasks", {
    title: "交上月报销单",
    dueDate: "2026-11-28",
    priority: 1,
  });
  await chat("帮我记一下今天交报告 优先级高 工作量中");
  await chat("提醒我下周三体检");
  await chat("给交报告加子任务整理资料");

  const today = await chat("今天有哪些任务到期？");
  assert.match(today, /已逾期未完成（1）[\s\S]*交上月报销单/u);
  assert.match(today, /今天到期（1）[\s\S]*交报告/u);
  assert.doesNotMatch(today, /体检/u);

  await chat("把交报告的工作量改为小");
  const subDoneReply = await chat("完成整理资料");
  assert.match(subDoneReply, /全部完成/u);

  await chat("取消交报告的截止日期");
  await chat("给整理资料加子任务不允许嵌套");

  const rows = (await request("GET", "/api/tasks")).body;
  const report = rows.find((item: { title: string }) => item.title === "交报告");
  const checkup = rows.find((item: { title: string }) => item.title === "体检");
  const sub = rows.find((item: { title: string }) => item.title === "整理资料");

  assert.equal(report.dueDate, undefined);
  assert.equal(report.priority, 1);
  assert.equal(report.effort, "small");
  assert.equal(checkup.dueDate, "2026-12-09");
  assert.equal(sub.parentId, report.id);
  assert.equal(sub.done, true);

  assert.match(await chat("删除交报告"), /子任务已转为独立任务/u);
  const afterDelete = (await request("GET", "/api/tasks")).body;
  const detached = afterDelete.find((item: { id: string }) => item.id === sub.id);
  assert.equal(detached.parentId, undefined);
});

test("DeepSeek Tool Calling 多轮智能体支持工具编排、错误自恢复与参数降级重试", async (t) => {
  useDefaultReasoningEffort(t);
  let turn = 0;

  const client = new OpenAI({
    apiKey: "test-key",
    baseURL: "https://test.invalid",
    maxRetries: 0,
    async fetch(_url, init) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      turn++;

      // 第 1 次请求模拟自定义模型不支持 reasoning_effort 返回 400，验证自动去掉该字段重试
      if (turn === 1) {
        assert.equal(body.reasoning_effort, "none");
        return Response.json(
          { error: { message: "Unknown parameter: reasoning_effort" } },
          { status: 400 },
        );
      }

      // 第 2 次（重试后）：模型带 reasoning_content 调用 create_tasks（含 null 可选字段容错）
      if (turn === 2) {
        assert.equal(body.reasoning_effort, undefined);
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "用户要创建两条任务，先调用 create_tasks。",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "create_tasks",
                      arguments: JSON.stringify({
                        items: [
                          {
                            title: "准备周五复盘PPT",
                            dueDate: "2026-11-27",
                            priority: 1,
                            effort: "large",
                          },
                          { title: "买纯牛奶", dueDate: null, parentId: "" },
                        ],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }

      // 第 3 次：验证 assistant 消息原样回传了 reasoning_content，且创建结果正常
      if (turn === 3) {
        const msgs = body.messages as Array<{
          role: string;
          content: string;
          reasoning_content?: string;
        }>;
        const assistantMsg = msgs.at(-2);
        assert.equal(assistantMsg?.role, "assistant");
        assert.equal(assistantMsg?.reasoning_content, "用户要创建两条任务，先调用 create_tasks。");
        const toolMsg = msgs.at(-1);
        assert.equal(toolMsg?.role, "tool");
        const parsed = JSON.parse(toolMsg.content);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.created.length, 2);
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "已记下 2 条待办：准备周五复盘PPT（高优先）和买纯牛奶。",
                reasoning_content: "工具确认两条都已保存。",
              },
            },
          ],
        });
      }

      // 第 4 次（第二轮用户模糊口语）：先调 list_tasks（含 null/空串容错），同时测试一个无效工具调用错误回传
      if (turn === 4) {
        const history = body.messages as Array<{
          role: string;
          reasoning_content?: string;
          tool_call_id?: string;
        }>;
        assert.deepEqual(
          history
            .filter((message) => message.role === "assistant")
            .map((message) => message.reasoning_content),
          ["用户要创建两条任务，先调用 create_tasks。", "工具确认两条都已保存。"],
        );
        assert.ok(history.some((message) => message.tool_call_id === "call_1"));
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_2",
                    type: "function",
                    function: {
                      name: "list_tasks",
                      arguments: JSON.stringify({ query: "", priority: null }),
                    },
                  },
                  {
                    id: "call_bad",
                    type: "function",
                    function: { name: "delete_task", arguments: "{invalid-json" },
                  },
                ],
              },
            },
          ],
        });
      }

      // 第 5 次：模型读取 list_tasks 里的真实 ID，语义定位「买纯牛奶」并标完成
      if (turn === 5) {
        const msgs = body.messages as Array<{
          role: string;
          tool_call_id?: string;
          content: string;
        }>;
        const listResult = JSON.parse(msgs.find((m) => m.tool_call_id === "call_2")!.content) as {
          tasks: Array<{ id: string; title: string }>;
        };
        const badResult = JSON.parse(msgs.find((m) => m.tool_call_id === "call_bad")!.content);
        assert.equal(badResult.ok, false);

        const milk = listResult.tasks.find((item) => item.title === "买纯牛奶")!;
        const report = listResult.tasks.find((item) => item.title === "准备周五复盘PPT")!;
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_3",
                    type: "function",
                    function: {
                      name: "update_task",
                      arguments: JSON.stringify({ id: milk.id, done: true }),
                    },
                  },
                  {
                    id: "call_4",
                    type: "function",
                    function: {
                      name: "update_task",
                      arguments: JSON.stringify({
                        id: report.id,
                        done: true,
                        dueDate: null,
                        priority: null,
                        effort: null,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }

      // 第 6 次：返回自然回复
      if (turn === 6) {
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "好的，已把「买纯牛奶」标记为已完成。" },
            },
          ],
        });
      }

      // 第 7 次：模拟 API 故障（401），验证友好兜底且不破坏任务
      return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
    },
  });

  const { chat, request } = await startTestApp(t, {
    agent: (tasks) =>
      createAgent(
        tasks,
        createDeepSeekAgentRunner(client, "deepseek-flash"),
        () => new Date(2026, 10, 25, 14, 0),
      ),
  });

  const r1 = await chat("帮我记两件事：周五前准备复盘PPT（高优、工作量大），还有买纯牛奶");
  assert.match(r1, /准备周五复盘PPT/u);

  const r2 = await chat("刚刚顺路把牛奶抱回来了");
  assert.match(r2, /买纯牛奶.*已完成/u);

  const tasksAfter = (await request("GET", "/api/tasks")).body;
  assert.equal(tasksAfter.length, 2);
  assert.equal(tasksAfter.find((item: { title: string }) => item.title === "买纯牛奶").done, true);
  const report = tasksAfter.find((item: { title: string }) => item.title === "准备周五复盘PPT");
  assert.equal(report.done, true);
  assert.equal(report.dueDate, "2026-11-27");
  assert.equal(report.priority, 1);
  assert.equal(report.effort, "large");

  const r3 = await chat("再帮我看看今天有什么事");
  assert.match(r3, /暂时无法连接 DeepSeek 服务/u);
  assert.deepEqual((await request("GET", "/api/tasks")).body, tasksAfter);
});

test("DeepSeek 批量创建、已保存回执、跨工具轮次收集删除计划和确认", async (t) => {
  let step = 0;
  let targetIds: string[] = [];
  const client = new OpenAI({
    apiKey: "test-key",
    baseURL: "https://test.invalid",
    maxRetries: 0,
    async fetch(_url, init) {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; tool_call_id?: string; content: string }>;
      };
      step++;

      // 第 1 轮：测试 create_tasks 第二项 parentId 无效，应整批拒绝且 0 条写入
      if (step === 1) {
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "bad_batch",
                    type: "function",
                    function: {
                      name: "create_tasks",
                      arguments: JSON.stringify({
                        items: [
                          { title: "不应残留的任务" },
                          { title: "坏子任务", parentId: "missing" },
                        ],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      if (step === 2) {
        const res = JSON.parse(body.messages.at(-1)!.content);
        assert.equal(res.ok, false);
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "主任务不存在，整批未写入。" },
            },
          ],
        });
      }

      // 第 2 轮：写入 3 条任务后，总结阶段返回 500，验证返回确定性已保存回执而非报错重试
      if (step === 3) {
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "batch_ok",
                    type: "function",
                    function: {
                      name: "create_tasks",
                      arguments: JSON.stringify({
                        items: [{ title: "任务A" }, { title: "任务B" }, { title: "任务C" }],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      if (step === 4) {
        const saved = JSON.parse(body.messages.at(-1)!.content) as {
          created: Array<{ id: string }>;
        };
        targetIds = saved.created.map(({ id }) => id);
        return Response.json({ error: { message: "Upstream timeout" } }, { status: 500 });
      }

      // 第 3 轮：分两次工具调用收集全部删除目标，确认前不写入。
      if (step === 5) {
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "先读取待删除的任务。",
                tool_calls: [
                  {
                    id: "unrelated_update",
                    type: "function",
                    function: {
                      name: "update_task",
                      arguments: JSON.stringify({ id: targetIds[0], done: true }),
                    },
                  },
                  {
                    id: "list_all",
                    type: "function",
                    function: { name: "list_tasks", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        });
      }
      if (step === 6 || step === 7) {
        if (step === 6) {
          const unrelated = body.messages.find(
            (message) => message.tool_call_id === "unrelated_update",
          );
          assert.equal(JSON.parse(unrelated!.content).ok, false);
          const listRes = JSON.parse(body.messages.at(-1)!.content) as {
            tasks: Array<{ id: string }>;
          };
          targetIds = listRes.tasks.map((task) => task.id);
        } else {
          assert.equal(JSON.parse(body.messages.at(-1)!.content).status, "planned");
        }
        const ids = step === 6 ? targetIds.slice(0, 2) : targetIds.slice(2);
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: ids.map((id) => ({
                  id: `del_${id}`,
                  type: "function",
                  function: { name: "delete_task", arguments: JSON.stringify({ id }) },
                })),
              },
            },
          ],
        });
      }
      if (step === 9) {
        const history = body.messages as Array<{
          role: string;
          content: string;
          reasoning_content?: string;
        }>;
        assert.ok(history.some((message) => message.reasoning_content === "先读取待删除的任务。"));
        assert.match(history.at(-1)!.content, /已删除「任务A」/u);
        return Response.json({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "已同步。" } }],
        });
      }
      assert.equal(JSON.parse(body.messages.at(-1)!.content).status, "planned");
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "批量删除需要你的确认。" },
          },
        ],
      });
    },
  });

  const { chat, request } = await startTestApp(t, {
    agent: (tasks) => createAgent(tasks, createDeepSeekAgentRunner(client, "deepseek-flash")),
  });

  await chat("帮我加个任务和坏子任务");
  assert.equal((await request("GET", "/api/tasks")).body.length, 0);

  const receipt = await chat("帮我记下任务A、任务B、任务C");
  assert.match(receipt, /已保存到你的清单[\s\S]*任务A[\s\S]*任务B[\s\S]*任务C/u);
  const original = (await request("GET", "/api/tasks")).body;
  assert.equal(original.length, 3);

  const guardReply = await chat("把这些全删了");
  assert.match(guardReply, /待确认删除 3 条任务[\s\S]*任务A[\s\S]*任务B[\s\S]*任务C/u);
  assert.deepEqual((await request("GET", "/api/tasks")).body, original);
  const unrelated = await request("POST", "/api/chat", {
    conversationId: randomUUID(),
    messages: [{ role: "user", content: "确认删除" }],
  });
  assert.match(unrelated.body.reply, /没有待确认/u);
  assert.deepEqual((await request("GET", "/api/tasks")).body, original);

  const newest = await request("POST", "/api/tasks", { title: "确认前新增的任务" });
  assert.match(await chat("确认删除"), /已删除/u);
  assert.deepEqual((await request("GET", "/api/tasks")).body, [newest.body]);
  assert.match(await chat("确认删除"), /没有待确认/u);
  assert.equal(step, 8);
  assert.equal(await chat("看看我的待办"), "已同步。");
});

test("DeepSeek 查询与截断回复不写入，含清空字样的任务标题仍可新增", async (t) => {
  useDefaultReasoningEffort(t);
  let step = 0;
  const client = new OpenAI({
    apiKey: "test-key",
    baseURL: "https://test.invalid",
    maxRetries: 0,
    async fetch(_url, init) {
      const body = JSON.parse(String(init?.body)) as {
        max_tokens: number;
        messages: Array<{ role: string; content: string }>;
      };
      assert.ok(body.max_tokens > 1200);
      step++;
      const write = {
        id: "fixture-write",
        type: "function",
        function: {
          name: "create_tasks",
          arguments: JSON.stringify({
            items: [{ title: step === 4 ? "清空邮箱垃圾邮件" : "样例" }],
          }),
        },
      };
      if (step === 1 || step === 4) {
        return Response.json({
          choices: [
            { finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [write] } },
          ],
        });
      }
      if (step === 2 || step === 5) {
        assert.equal(JSON.parse(body.messages.at(-1)!.content).ok, step === 5);
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: step === 2 ? "清单还是空的。" : "已记下「清空邮箱垃圾邮件」。",
              },
            },
          ],
        });
      }
      return Response.json({
        choices: [
          {
            finish_reason: "length",
            message: { role: "assistant", content: "未写完的半句", tool_calls: [write] },
          },
        ],
      });
    },
  });
  const { chat, request } = await startTestApp(t, {
    agent: (tasks) => createAgent(tasks, createDeepSeekAgentRunner(client, "deepseek-v4-pro")),
  });
  assert.match(await chat("看看我的待办"), /清单还是空的/u);
  assert.match(await chat("帮我记一下样例"), /输出上限/u);
  assert.deepEqual((await request("GET", "/api/tasks")).body, []);
  assert.match(await chat("帮我记一下清空邮箱垃圾邮件"), /已记下/u);
  assert.deepEqual(
    (await request("GET", "/api/tasks")).body.map(({ title }: { title: string }) => title),
    ["清空邮箱垃圾邮件"],
  );
});
