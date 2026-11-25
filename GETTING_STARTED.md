# 本地开发指南

## 启动

安装 Node.js 24.12 或更高版本（含 npm）。在终端执行以下命令。

```sh
git clone https://github.com/jidekaixin2dian/tokenow-todo-agent.git
cd tokenow-todo-agent
npm ci
npm run dev
```

浏览器打开 <http://127.0.0.1:3000>。前后端共用这个地址，修改服务端代码后服务会自动重启。修改聊天界面的 TSX 后，在另一个终端运行 `npm run build` 并刷新页面。若 3000 端口已占用，可以用 `PORT=3001 npm run dev` 指定其他端口（macOS / Linux）。

## 接入 DeepSeek

1. 在项目根目录将 `.env.example` 复制为 `.env`。
2. 在 `.env` 中填写 [DeepSeek 开放平台](https://platform.deepseek.com/) 的 API Key。默认使用 `deepseek-flash`，可通过 `DEEPSEEK_MODEL` 指定其他支持 JSON Output 的模型。
3. 重启开发服务，发送「我得把票据扫描归档，这事麻烦你收进我的待办」，观察清单里是否新增了任务。这类说法会走模型解析路径。

常用指令优先在本地解析。需要模型时，服务端通过 [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/) 获取意图，对字段和本地任务做校验，再执行操作。模型请求最多携带最新的八条对话消息，清单文件保存在本地。

## 代码入口

| 文件                                             | 用途                                       |
| ------------------------------------------------ | ------------------------------------------ |
| [src/App.tsx](src/App.tsx)                       | 聊天界面，发送当前页面的对话历史并显示回复 |
| [server/index.ts](server/index.ts)               | 接入智能体与任务存储，启动服务             |
| [server/agent.ts](server/agent.ts)               | 校验意图、匹配目标、执行任务操作和生成回复 |
| [server/local-intent.ts](server/local-intent.ts) | 解析常用的中文待办指令                     |
| [server/model.ts](server/model.ts)               | 服务端 DeepSeek 客户端与意图解析           |
| [server/tasks.ts](server/tasks.ts)               | 任务 API 的输入校验和 HTTP 响应            |
| [server/app.ts](server/app.ts)                   | 接收对话历史，调用智能体并挂载任务 API     |
| [server/task-store.ts](server/task-store.ts)     | 读写本地 JSON 任务清单                     |
| [server/openapi.yaml](server/openapi.yaml)       | 任务请求和响应的完整定义                   |

## 手动验证接口

启动服务后，在另一个终端发送聊天消息。

```sh
curl -sS http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"看看我的待办"}]}'
```

响应的 `reply` 字段会给出当前任务清单或说明清单为空。后续请求可在 `messages` 中按顺序传入之前的用户消息和小明的回复，再追加最新的用户消息。

创建一条任务，然后检查列表。

```sh
curl -sS http://127.0.0.1:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"买牛奶"}'
curl -sS http://127.0.0.1:3000/api/tasks
```

首次创建任务时，服务会在项目根目录创建 `data/tasks.json`。这些任务会保留到下次启动，浏览器中的聊天记录则会在刷新后清空。

## 本地检查

```sh
npm test
npm run typecheck
npm run lint
npm run fmt:check
npm run build
```

测试使用独立的临时目录。要预览构建产物，先停止开发服务，再运行 `npm start` 并打开同一地址。
