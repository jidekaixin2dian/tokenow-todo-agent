import { join } from "node:path";
import { createAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import { createDeepSeekAgentRunner, model } from "./model.ts";
import { createJsonTaskStore } from "./task-store.ts";

const tasks = createJsonTaskStore(join("data", "tasks.json"));
const hasApiKey = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
const runner = hasApiKey ? createDeepSeekAgentRunner() : undefined;
const reply = createAgent(tasks, runner);
const app = createApp({
  reply,
  tasks,
  status: hasApiKey ? { mode: "deepseek", model } : { mode: "offline", model: null },
});
const port = Number(process.env.PORT || 3000);
app.listen(port, "127.0.0.1", () => {
  const modeLabel = hasApiKey
    ? `DeepSeek 智能体（${model}）`
    : "离线规则模式（配置 DEEPSEEK_API_KEY 后自动启用 DeepSeek 智能体）";
  console.log(`小明智能体已启动：http://127.0.0.1:${port}`);
  console.log(`当前模式：${modeLabel}`);
});
