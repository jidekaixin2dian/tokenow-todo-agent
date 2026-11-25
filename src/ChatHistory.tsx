import { Fragment, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { ChatMessage } from "../shared/chat.ts";

const examplePrompts = [
  "帮我记一下今天交报告，优先级高，工作量中",
  "帮我记一下买牛奶和取快递",
  "今天有哪些任务到期？",
  "看看我的待办",
];

interface ChatHistoryProps {
  messages: ChatMessage[];
  pending: boolean;
  taskPanelOpen: boolean;
  onSelectPrompt: (prompt: string) => void;
}

function renderInlineFormatting(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/gu);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function renderMessageContent(content: string): ReactNode {
  const lines = content.split("\n");
  return lines.map((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return <div key={index} className="msg-gap" aria-hidden="true" />;
    }

    if (/^(?:  |\t)?↳\s+/u.test(line)) {
      return (
        <div key={index} className="msg-line msg-subitem">
          <span className="msg-sub-marker" aria-hidden="true">
            ↳
          </span>
          <span>{renderInlineFormatting(trimmed.replace(/^↳\s+/u, ""))}</span>
        </div>
      );
    }

    if (/^(?:•|-|\*)\s+/u.test(trimmed)) {
      return (
        <div key={index} className="msg-line msg-bullet">
          <span className="msg-dot" aria-hidden="true" />
          <span>{renderInlineFormatting(trimmed.replace(/^(?:•|-|\*)\s+/u, ""))}</span>
        </div>
      );
    }

    const headingMatch = /^(?:###?\s*)?(.+（\d+）)$/u.exec(trimmed);
    if (headingMatch) {
      return (
        <div key={index} className="msg-line msg-section-title">
          {renderInlineFormatting(headingMatch[1])}
        </div>
      );
    }

    return (
      <div key={index} className="msg-line">
        {renderInlineFormatting(line)}
      </div>
    );
  });
}

export function ChatHistory({
  messages,
  pending,
  taskPanelOpen,
  onSelectPrompt,
}: ChatHistoryProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevCount = useRef(messages.length);

  function handleScroll() {
    const el = viewport.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance <= 120;
  }

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const userJustSent = messages.length > prevCount.current && messages.at(-1)?.role === "user";
    prevCount.current = messages.length;

    if (userJustSent || stickToBottom.current) {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
    }
  }, [messages, pending, taskPanelOpen]);

  // 监听视口与内容高度变化（抽屉展开、拖拽换宽、软键盘弹出），若用户原本贴底则即时校正。
  useEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    observer.observe(el);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [messages.length]);

  return (
    <div
      className="scroll"
      ref={viewport}
      onScroll={handleScroll}
      role="region"
      aria-label="聊天内容"
      tabIndex={0}
    >
      {messages.length === 0 ? (
        <section className="welcome">
          <div className="welcome-badge">
            <img src="/logo.png" alt="" />
          </div>
          <h1>你好，我是小明</h1>
          <p>
            直接用口语告诉我你的安排，我会帮你记下来、排轻重缓急、盯紧到期日，右侧清单实时同步。
          </p>
          <div className="examples">
            {examplePrompts.map((prompt, index) => (
              <button
                key={prompt}
                type="button"
                style={{ "--stagger": index } as CSSProperties}
                onClick={() => onSelectPrompt(prompt)}
              >
                <span>{prompt}</span>
                <span className="example-arrow" aria-hidden="true">
                  ↗
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <div
          className="thread"
          ref={contentRef}
          role="log"
          aria-label="对话记录"
          aria-live="polite"
        >
          {messages.map((message, index) => (
            <div key={index} className={`message ${message.role}`}>
              <small>{message.role === "user" ? "你" : "小明智能体"}</small>
              <div className="bubble">
                {message.role === "assistant"
                  ? renderMessageContent(message.content)
                  : message.content}
              </div>
            </div>
          ))}
          {pending && (
            <div className="message assistant is-thinking" role="status" aria-label="小明正在处理">
              <small>小明智能体</small>
              <div className="bubble thinking-bubble">
                <span className="thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>正在整理…</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
