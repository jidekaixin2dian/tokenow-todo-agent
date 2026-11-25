export type Priority = 1 | 2 | 3;
export type Effort = "small" | "medium" | "large";
export type DueState = "overdue" | "today" | "upcoming" | "none";

export interface Task {
  id: string;
  title: string;
  done: boolean;
  dueDate?: string;
  priority?: Priority;
  effort?: Effort;
  parentId?: string;
  [field: string]: unknown;
}

export interface TaskTreeNode {
  task: Task;
  subtasks: Task[];
}

export const priorityLabels = { 1: "高", 2: "中", 3: "低" } as const;
export const effortLabels = { small: "小", medium: "中", large: "大" } as const;

export function localDateString(date: Date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDaysToDate(date: Date, days: number): string {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return localDateString(next);
}

export function isPriority(value: unknown): value is Priority {
  return value === 1 || value === 2 || value === 3;
}

export function isEffort(value: unknown): value is Effort {
  return value === "small" || value === "medium" || value === "large";
}

export function getTaskDueState(task: Task, today: string): DueState {
  if (typeof task.dueDate !== "string" || !task.dueDate) return "none";
  if (task.dueDate < today) return "overdue";
  if (task.dueDate === today) return "today";
  return "upcoming";
}

function shortDate(isoDate: string, today: string): string {
  return isoDate.slice(0, 4) === today.slice(0, 4) ? isoDate.slice(5) : isoDate;
}

export function formatDueLabel(dueDate: string, today: string, done = false): string {
  if (done) return `${shortDate(dueDate, today)} 到期`;
  if (dueDate < today) return `已逾期 · ${shortDate(dueDate, today)}`;
  if (dueDate === today) return "今天到期";
  const [year, month, day] = today.split("-").map(Number);
  const tomorrow = addDaysToDate(new Date(year, month - 1, day), 1);
  if (dueDate === tomorrow) return "明天到期";
  return `${shortDate(dueDate, today)} 到期`;
}

export function taskDetailsLabels(task: Task, parentTitle?: string, today?: string): string[] {
  const labels: string[] = [];
  if (typeof task.dueDate === "string") {
    labels.push(today ? formatDueLabel(task.dueDate, today, task.done) : `${task.dueDate} 到期`);
  }
  if (isPriority(task.priority)) {
    labels.push(`${priorityLabels[task.priority]}优先级`);
  }
  if (isEffort(task.effort)) {
    labels.push(`工作量${effortLabels[task.effort]}`);
  }
  if (parentTitle) labels.push(`${parentTitle}的子任务`);
  return labels;
}

function urgencyBucket(task: Task, today: string): number {
  if (task.done) return 4;
  const due = getTaskDueState(task, today);
  if (due === "overdue") return 0;
  if (due === "today") return 1;
  if (due === "upcoming") return 2;
  return 3;
}

export function sortTasksByUrgency(items: Task[], today: string): Task[] {
  const order = new Map(items.map((item, index) => [item.id, index]));
  return [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    // 已完成任务统一按原顺序稳定排列，保证比较器严格满足弱序传递性。
    if (a.done && b.done) {
      return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    }
    const bucketDiff = urgencyBucket(a, today) - urgencyBucket(b, today);
    if (bucketDiff !== 0) return bucketDiff;
    if (typeof a.dueDate === "string" && typeof b.dueDate === "string" && a.dueDate !== b.dueDate) {
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    const pa = isPriority(a.priority) ? a.priority : 9;
    const pb = isPriority(b.priority) ? b.priority : 9;
    if (pa !== pb) return pa - pb;
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
}

export function buildTaskTree(items: Task[], today: string): TaskTreeNode[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const childrenByParent = new Map<string, Task[]>();
  const roots: Task[] = [];

  for (const item of items) {
    if (typeof item.parentId === "string" && byId.has(item.parentId)) {
      const list = childrenByParent.get(item.parentId) ?? [];
      list.push(item);
      childrenByParent.set(item.parentId, list);
    } else {
      roots.push(item);
    }
  }

  return sortTasksByUrgency(roots, today).map((root) => ({
    task: root,
    subtasks: sortTasksByUrgency(childrenByParent.get(root.id) ?? [], today),
  }));
}
