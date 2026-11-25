# 本地开发指南

## 启动

安装 Node.js 24.12 或更高版本（含 npm）。在终端执行以下命令：

```sh
git clone https://github.com/jidekaixin2dian/tokenow-todo-agent.git
cd tokenow-todo-agent
npm ci
npm run dev
```

浏览器打开 <http://127.0.0.1:3000>。前后端共用这个地址，修改服务端代码后服务会自动重启。修改前端 TSX 后，运行 `npm run build` 并刷新页面。若 3000 端口已占用，可通过环境变量 `PORT=3001` 指定其他端口。

## 接入 DeepSeek

1. 在项目根目录将 `.env.example` 复制为 `.env`。
2. 在 `.env` 中填写 [DeepSeek 开放平台](https://platform.deepseek.com/) 的 API Key。默认使用 `deepseek-flash`，可通过 `DEEPSEEK_MODEL` 切换其他兼容模型，通过 `DEEPSEEK_REASONING_EFFORT`（`none` / `low` / `medium` / `high` / `max`）调整思考强度。
3. 重启服务。DeepSeek 模式会发送最近最多 16 条对话消息以及其中的工具调用和结果。清单查询每页默认 50 条，日程总览每组最多 20 条。`deepseek-chat` 和 `deepseek-reasoner` 旧配置会转到 `deepseek-flash`，分别默认关闭和开启思考。

未配置 `DEEPSEEK_API_KEY` 时，服务完全运行在本地离线规则模式，不向外部发送任何对话或任务数据。

网页会为每个对话生成一个 `conversationId`。服务端用它续接模型工具上下文和待确认的删除计划。直接调用 `POST /api/chat` 时仍可传 `{ messages }`，响应仍为 `{ reply }`。需要续接完整工具上下文或确认批量删除时，在同一对话的请求里带上同一个 UUID 格式的 `conversationId`。

## 代码入口

| 文件                                             | 用途                                               |
| ------------------------------------------------ | -------------------------------------------------- |
| [src/App.tsx](src/App.tsx)                       | 主布局、运行模式徽章、对话发送与快捷键处理         |
| [src/ChatHistory.tsx](src/ChatHistory.tsx)       | 对话记录、结构化文本排版与思考态动效               |
| [src/TaskPanel.tsx](src/TaskPanel.tsx)           | 右侧联动任务看板（筛选、进度条、树形子任务、交互） |
| [shared/task.ts](shared/task.ts)                 | 共享任务类型、日期状态计算、紧急度排序与树形构建   |
| [server/index.ts](server/index.ts)               | 组装任务存储、智能体与 HTTP 服务                   |
| [server/agent.ts](server/agent.ts)               | 智能体入口（DeepSeek 主驱动 + 离线降级执行器）     |
| [server/agent-tools.ts](server/agent-tools.ts)   | DeepSeek Function Calling 工具定义与强校验执行层   |
| [server/model.ts](server/model.ts)               | DeepSeek 客户端与多轮 Tool Calling 循环            |
| [server/local-intent.ts](server/local-intent.ts) | 离线模式中文指令解析器                             |
| [server/tasks.ts](server/tasks.ts)               | 任务 REST API 的输入校验与 HTTP 响应               |
| [server/app.ts](server/app.ts)                   | 挂载 `/api/status`、`/api/chat` 与 `/api/tasks`    |
| [server/task-store.ts](server/task-store.ts)     | 本地 JSON 原子持久化存储                           |
| [server/openapi.yaml](server/openapi.yaml)       | 任务 API 的 OpenAPI 3.1 完整定义                   |

## 手动验证接口

启动服务后，在另一个终端调用接口：

```sh
curl -sS http://127.0.0.1:3000/api/status
curl -sS http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"看看我的待办"}]}'
```

创建一条任务并查看列表：

```sh
curl -sS http://127.0.0.1:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"买牛奶","priority":1,"effort":"small"}'
curl -sS http://127.0.0.1:3000/api/tasks
```

首次创建任务时，服务会在项目根目录创建 `data/tasks.json`。这些任务会保留到下次启动，浏览器中的聊天记录会在刷新后清空。

## 本地检查

```sh
npm test
npm run typecheck
npm run lint
npm run fmt:check
npm run build
```

测试使用独立的临时目录。要预览构建产物，先停止开发服务，再运行 `npm start`。
