export interface Task {
  id: string;
  title: string;
  done: boolean;
  [field: string]: unknown;
}

export const priorityLabels = { 1: "高", 2: "中", 3: "低" } as const;
export const effortLabels = { small: "小", medium: "中", large: "大" } as const;

export function taskDetailsLabels(task: Task, parentTitle?: string) {
  const labels: string[] = [];
  if (typeof task.dueDate === "string") labels.push(`${task.dueDate} 到期`);
  if (task.priority === 1 || task.priority === 2 || task.priority === 3) {
    labels.push(`${priorityLabels[task.priority]}优先级`);
  }
  if (task.effort === "small" || task.effort === "medium" || task.effort === "large") {
    labels.push(`工作量${effortLabels[task.effort]}`);
  }
  if (parentTitle) labels.push(`${parentTitle}的子任务`);
  return labels;
}
