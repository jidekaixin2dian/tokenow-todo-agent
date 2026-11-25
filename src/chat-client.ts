import type { ChatMessage } from "../shared/chat.ts";
import type { Task } from "../shared/task.ts";

export interface AppStatusInfo {
  mode: "deepseek" | "offline";
  model: string | null;
}

export async function requestReply(messages: ChatMessage[]): Promise<string> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  }).catch(() => null);
  const body: unknown = await response?.json().catch(() => null);
  if (response && typeof body === "object" && body !== null) {
    if (response.ok && "reply" in body && typeof body.reply === "string") return body.reply;
    if ("error" in body && typeof body.error === "string") throw new Error(body.error);
  }
  throw new Error("服务暂时不可用。");
}

export async function fetchAppStatus(signal?: AbortSignal): Promise<AppStatusInfo | null> {
  try {
    const response = await fetch("/api/status", { signal, cache: "no-store" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "mode" in body &&
      (body.mode === "deepseek" || body.mode === "offline")
    ) {
      return {
        mode: body.mode,
        model: "model" in body && typeof body.model === "string" ? body.model : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchTasks(signal?: AbortSignal): Promise<Task[]> {
  const response = await fetch("/api/tasks", { signal, cache: "no-store" });
  if (!response.ok) throw new Error("读取任务失败");
  return (await response.json()) as Task[];
}

export async function updateTaskDone(id: string, done: boolean): Promise<Task> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done }),
  });
  if (!response.ok) throw new Error("更新任务状态失败");
  return (await response.json()) as Task;
}

export async function removeTaskById(id: string): Promise<void> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error("删除任务失败");
}
