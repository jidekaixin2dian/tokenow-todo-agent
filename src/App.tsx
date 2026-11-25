import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatMessage } from "../shared/chat.ts";
import { fetchAppStatus, requestReply, type AppStatusInfo } from "./chat-client.ts";
import { ChatHistory } from "./ChatHistory.tsx";
import { TaskPanel } from "./TaskPanel.tsx";

function isSendShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  // 中文输入法会用 Enter 确认选词，部分浏览器此时只报告键码 229。
  const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  return event.key === "Enter" && !event.shiftKey && !composing;
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [taskRevision, setTaskRevision] = useState(0);
  const [showTasks, setShowTasks] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [status, setStatus] = useState<AppStatusInfo | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAppStatus(controller.signal).then((info) => {
      if (!controller.signal.aborted && info) setStatus(info);
    });
    return () => controller.abort();
  }, []);

  const handlePendingCountChange = useCallback((count: number) => {
    setPendingCount(count);
  }, []);

  const handleQuickPrompt = useCallback((text: string) => {
    setDraft(text);
    setShowTasks(false);
    requestAnimationFrame(() => {
      const field = input.current;
      if (field) {
        field.focus();
        field.setSelectionRange(text.length, text.length);
      }
    });
  }, []);

  async function send(text: string) {
    const content = text.trim();
    if (!content || pending) return;
    const outgoing: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(outgoing);
    setDraft("");
    setPending(true);
    setError("");
    try {
      const answer = await requestReply(outgoing);
      setMessages([...outgoing, { role: "assistant", content: answer }]);
      setTaskRevision((revision) => revision + 1);
    } catch (cause) {
      setMessages(messages);
      setDraft(text);
      setError(cause instanceof Error ? `发送失败：${cause.message}` : "发送失败，请重试。");
    } finally {
      setPending(false);
      requestAnimationFrame(() => {
        const field = input.current;
        const active = document.activeElement;
        if (field && (active === document.body || field.form?.contains(active))) {
          field.focus();
        }
      });
    }
  }

  return (
    <div className="app">
      <header>
        <img src="/logo.png" alt="" />
        <strong>TokeNow</strong>
        <span className="brand-sub">小明智能体</span>

        <div className="header-right">
          {status && (
            <span
              className={`mode-badge ${status.mode === "deepseek" ? "is-ai" : "is-offline"}`}
              title={
                status.mode === "deepseek"
                  ? `已接入 DeepSeek 模型：${status.model}`
                  : "未配置 DEEPSEEK_API_KEY，当前为本地离线规则模式"
              }
            >
              <i className="mode-dot" aria-hidden="true" />
              {status.mode === "deepseek" ? `DeepSeek · ${status.model}` : "离线规则模式"}
            </span>
          )}

          {messages.length > 0 && (
            <button
              className="clear-chat"
              type="button"
              disabled={pending}
              onClick={() => {
                setMessages([]);
                setError("");
                input.current?.focus();
              }}
            >
              新对话
            </button>
          )}

          <button
            className="task-toggle"
            type="button"
            aria-expanded={showTasks}
            aria-controls="task-panel"
            onClick={() => setShowTasks(!showTasks)}
          >
            任务清单
            {pendingCount > 0 && <em className="toggle-badge">{pendingCount}</em>}
          </button>
        </div>
      </header>
      <div className="workspace">
        <main>
          <ChatHistory
            messages={messages}
            pending={pending}
            taskPanelOpen={showTasks}
            onSelectPrompt={send}
          />
          <div className="compose">
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send(draft);
              }}
            >
              <textarea
                aria-label="消息"
                ref={input}
                placeholder="告诉小明要记什么、完成了哪件，或问今天有哪些任务到期…"
                rows={2}
                value={draft}
                readOnly={pending}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (isSendShortcut(event)) {
                    event.preventDefault();
                    void send(draft);
                  }
                }}
              />
              <button className="send" disabled={pending || !draft.trim()} aria-label="发送消息">
                ↑
              </button>
            </form>
            <small>Enter 发送 · Shift + Enter 换行</small>
          </div>
        </main>
        <TaskPanel
          revision={taskRevision}
          open={showTasks}
          onPendingCountChange={handlePendingCountChange}
          onQuickPrompt={handleQuickPrompt}
        />
      </div>
    </div>
  );
}
