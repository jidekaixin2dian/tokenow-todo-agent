import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ChatMessage } from "../shared/chat.ts";
import { AnimatedNumber } from "./AnimatedNumber.tsx";
import {
  fetchAppStatus,
  newConversationId,
  requestReply,
  type AppStatusInfo,
} from "./chat-client.ts";
import { ChatHistory } from "./ChatHistory.tsx";
import { TaskPanel } from "./TaskPanel.tsx";

type Theme = "light" | "dark";

const DEFAULT_PANEL_WIDTH = 356;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 520;
const MOBILE_QUERY = "(max-width: 820px)";

function isSendShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  // 中文输入法会用 Enter 确认选词，部分浏览器此时只报告键码 229。
  const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  return event.key === "Enter" && !event.shiftKey && !composing;
}

function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function readIsMobile(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

function maxPanelWidth(): number {
  if (typeof window === "undefined") return MAX_PANEL_WIDTH;
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, Math.round(window.innerWidth * 0.52)));
}

function clampPanelWidth(width: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(maxPanelWidth(), width));
}

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState(newConversationId);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [renderedError, setRenderedError] = useState("");
  const [taskRevision, setTaskRevision] = useState(0);
  const [showTasks, setShowTasks] = useState(false);
  const [isMobile, setIsMobile] = useState(readIsMobile);
  const [pendingCount, setPendingCount] = useState(0);
  const [status, setStatus] = useState<AppStatusInfo | null>(null);
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const [panelWidth, setPanelWidth] = useState(() => clampPanelWidth(DEFAULT_PANEL_WIDTH));
  const [panelMaximum, setPanelMaximum] = useState(maxPanelWidth);
  const [resizing, setResizing] = useState(false);

  const appRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const toggleBtnRef = useRef<HTMLButtonElement>(null);
  const themeTimerRef = useRef<number | null>(null);
  const manualThemeRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // 同步展示中的错误文本（收起时保留文本直至过渡完成再清空，避免文字先蒸发）
  useEffect(() => {
    if (error) setRenderedError(error);
  }, [error]);

  useEffect(() => {
    const compose = composeRef.current;
    if (!compose || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      appRef.current?.style.setProperty(
        "--compose-height",
        `${entry.target.getBoundingClientRect().height}px`,
      );
    });
    observer.observe(compose, { box: "border-box" });
    return () => observer.disconnect();
  }, []);

  const applyTheme = useCallback((next: Theme, options: { animate: boolean; persist: boolean }) => {
    const root = document.documentElement;
    if (options.animate) {
      root.classList.add("theme-animating");
      if (themeTimerRef.current) window.clearTimeout(themeTimerRef.current);
      themeTimerRef.current = window.setTimeout(() => {
        root.classList.remove("theme-animating");
        themeTimerRef.current = null;
      }, 240);
    }
    root.dataset.theme = next;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", next === "dark" ? "#0f141e" : "#f7f8fc");
    if (options.persist) {
      try {
        localStorage.setItem("tokenow-theme", next);
      } catch {
        // 忽略隐私模式存储限制
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      if (themeTimerRef.current) window.clearTimeout(themeTimerRef.current);
      dragCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAppStatus(controller.signal).then((info) => {
      if (!controller.signal.aborted && info) setStatus(info);
    });
    return () => controller.abort();
  }, []);

  // 监听响应式断点与视口缩放，及时重夹紧右侧面板宽度
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    function onMediaChange(event: MediaQueryListEvent) {
      setIsMobile(event.matches);
      if (!event.matches) setShowTasks(false);
      else dragCleanupRef.current?.();
    }
    function onWindowResize() {
      setPanelMaximum(maxPanelWidth());
      setPanelWidth((current) => clampPanelWidth(current));
    }
    media.addEventListener("change", onMediaChange);
    window.addEventListener("resize", onWindowResize);
    return () => {
      media.removeEventListener("change", onMediaChange);
      window.removeEventListener("resize", onWindowResize);
    };
  }, []);

  // 持续跟随系统深浅色（仅当用户未主动手动选择过主题，且系统变化时不写入 localStorage）
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function onChange(event: MediaQueryListEvent) {
      if (manualThemeRef.current) return;
      try {
        const saved = localStorage.getItem("tokenow-theme");
        if (saved === "light" || saved === "dark") return;
      } catch {
        // 存储不可用时继续跟随系统
      }
      const next: Theme = event.matches ? "dark" : "light";
      setTheme(next);
      applyTheme(next, { animate: true, persist: false });
    }
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [applyTheme]);

  const closeMobileDrawer = useCallback(() => {
    setShowTasks(false);
    requestAnimationFrame(() => {
      const toggle = toggleBtnRef.current;
      const active = document.activeElement;
      if (
        toggle?.getAttribute("aria-expanded") === "false" &&
        (active === document.body || active?.closest(".task-panel-shell"))
      ) {
        toggle.focus();
      }
    });
  }, []);

  const dismissError = useCallback(() => {
    if (document.activeElement?.closest(".error-collapse")) input.current?.focus();
    setError("");
  }, []);

  // 全局轻量快捷键：/ 聚焦输入，Esc 关闭移动端抽屉或错误提示
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        if (isMobile && showTasks) {
          closeMobileDrawer();
        } else if (error) {
          dismissError();
        }
        return;
      }
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        document.activeElement?.tagName !== "TEXTAREA" &&
        document.activeElement?.tagName !== "INPUT"
      ) {
        event.preventDefault();
        input.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobile, showTasks, error, closeMobileDrawer, dismissError]);

  const handleToggleTheme = useCallback(() => {
    const next: Theme = readInitialTheme() === "dark" ? "light" : "dark";
    manualThemeRef.current = true;
    setTheme(next);
    applyTheme(next, { animate: true, persist: true });
  }, [applyTheme]);

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragCleanupRef.current?.();

      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startWidth = panelWidth;
      let frame: number | null = null;
      let lastWidth: number | undefined;

      try {
        target.setPointerCapture(pointerId);
      } catch {
        // 忽略合成测试事件捕获失败
      }
      setResizing(true);

      function onMove(moveEvent: globalThis.PointerEvent) {
        if (moveEvent.pointerId !== pointerId) return;
        lastWidth = startWidth + startX - moveEvent.clientX;
        frame ??= requestAnimationFrame(() => {
          frame = null;
          if (lastWidth !== undefined) setPanelWidth(clampPanelWidth(lastWidth));
        });
      }

      function cleanup() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
        window.removeEventListener("blur", cleanup);
        target.removeEventListener("lostpointercapture", onEnd);
        if (frame !== null) {
          cancelAnimationFrame(frame);
          if (lastWidth !== undefined) setPanelWidth(clampPanelWidth(lastWidth));
        }
        setResizing(false);
        try {
          if (target.hasPointerCapture(pointerId)) {
            target.releasePointerCapture(pointerId);
          }
        } catch {}
        dragCleanupRef.current = null;
      }

      function onEnd(endEvent: globalThis.PointerEvent) {
        if (endEvent.pointerId !== pointerId) return;
        cleanup();
      }

      dragCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
      window.addEventListener("blur", cleanup);
      target.addEventListener("lostpointercapture", onEnd);
    },
    [panelWidth],
  );

  const handleResizerKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPanelWidth((w) => clampPanelWidth(w + step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setPanelWidth((w) => clampPanelWidth(w - step));
    } else if (event.key === "Home") {
      event.preventDefault();
      setPanelWidth(MIN_PANEL_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setPanelWidth(clampPanelWidth(MAX_PANEL_WIDTH));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setPanelWidth(clampPanelWidth(DEFAULT_PANEL_WIDTH));
    }
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
      const answer = await requestReply(outgoing, conversationId);
      setMessages([...outgoing, { role: "assistant", content: answer }]);
    } catch (cause) {
      setMessages(messages);
      setDraft(text);
      setError(cause instanceof Error ? `发送失败：${cause.message}` : "发送失败，请稍后重试。");
    } finally {
      setTaskRevision((revision) => revision + 1);
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
    <div
      ref={appRef}
      className={resizing ? "app is-resizing" : "app"}
      style={{ "--panel-width": `${panelWidth}px` } as CSSProperties}
    >
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
                  ? `已配置 DEEPSEEK_API_KEY（模型：${status.model}），对话将由 DeepSeek 工具调用驱动`
                  : "未配置 DEEPSEEK_API_KEY，当前在本地离线规则模式下运行"
              }
            >
              <i className="mode-dot" aria-hidden="true" />
              {status.mode === "deepseek" ? `已配置 · ${status.model}` : "离线规则模式"}
            </span>
          )}

          {messages.length > 0 && (
            <button
              className="clear-chat"
              type="button"
              disabled={pending}
              onClick={() => {
                setMessages([]);
                setConversationId(newConversationId());
                setError("");
                input.current?.focus();
              }}
            >
              新对话
            </button>
          )}

          <button
            className="icon-btn"
            type="button"
            aria-label={theme === "dark" ? "切换到浅色外观" : "切换到深色外观"}
            title={theme === "dark" ? "切换到浅色外观" : "切换到深色外观"}
            onClick={handleToggleTheme}
          >
            <svg className="theme-icon is-sun" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="3.6" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M10 2.5V4.2M10 15.8V17.5M2.5 10H4.2M15.8 10H17.5M4.7 4.7L5.9 5.9M14.1 14.1L15.3 15.3M15.3 4.7L14.1 5.9M5.9 14.1L4.7 15.3"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            <svg className="theme-icon is-moon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M16.2 12.6A6.5 6.5 0 0 1 7.4 3.8a6.5 6.5 0 1 0 8.8 8.8Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <button
            ref={toggleBtnRef}
            className="task-toggle"
            type="button"
            aria-expanded={showTasks}
            aria-controls="task-panel"
            onClick={() => {
              if (showTasks) closeMobileDrawer();
              else setShowTasks(true);
            }}
          >
            任务清单
            <em
              className={pendingCount > 0 ? "toggle-badge is-visible" : "toggle-badge"}
              aria-hidden={pendingCount === 0 || undefined}
            >
              <AnimatedNumber value={pendingCount} compact />
            </em>
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
          <div className="compose" ref={composeRef}>
            <div
              className={error ? "error-collapse is-visible" : "error-collapse"}
              inert={!error}
              onTransitionEnd={(event) => {
                if (
                  event.target === event.currentTarget &&
                  event.propertyName === "grid-template-rows" &&
                  !error
                ) {
                  setRenderedError("");
                }
              }}
            >
              <div>
                {renderedError && (
                  <p className="error" role="alert">
                    <span>{renderedError}</span>
                    <button
                      type="button"
                      className="error-dismiss"
                      aria-label="关闭错误提示"
                      onClick={dismissError}
                    >
                      ×
                    </button>
                  </p>
                )}
              </div>
            </div>
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
              <button
                className="send"
                disabled={pending || !draft.trim()}
                aria-label={pending ? "正在发送" : "发送消息"}
              >
                {pending ? <span className="send-spinner" aria-hidden="true" /> : "↑"}
              </button>
            </form>
            <small>Enter 发送 · Shift + Enter 换行 · 按 / 快速输入</small>
          </div>
        </main>
        <div
          className={resizing ? "panel-resizer is-active" : "panel-resizer"}
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-valuemin={MIN_PANEL_WIDTH}
          aria-valuemax={panelMaximum}
          aria-valuenow={panelWidth}
          aria-controls="task-panel"
          aria-label="拖动或用左右方向键调整任务清单宽度，双击或按回车恢复默认"
          title="拖动调整宽度，双击恢复默认"
          onPointerDown={handleResizeStart}
          onKeyDown={handleResizerKeyDown}
          onDoubleClick={() => setPanelWidth(clampPanelWidth(DEFAULT_PANEL_WIDTH))}
        />
        <TaskPanel
          revision={taskRevision}
          open={showTasks}
          isMobile={isMobile}
          onPendingCountChange={handlePendingCountChange}
          onQuickPrompt={handleQuickPrompt}
        />
      </div>
    </div>
  );
}
