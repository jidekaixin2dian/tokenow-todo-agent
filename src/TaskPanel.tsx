import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildTaskTree,
  effortLabels,
  formatDueLabel,
  getTaskDueState,
  isEffort,
  isPriority,
  localDateString,
  priorityLabels,
  type Task,
} from "../shared/task.ts";
import { fetchTasks, removeTaskById, updateTaskDone } from "./chat-client.ts";

type FilterKey = "pending" | "today" | "done" | "all";

interface TaskPanelProps {
  revision: number;
  open: boolean;
  onPendingCountChange?: (count: number) => void;
  onQuickPrompt?: (text: string) => void;
}

function taskSignature(task: Task): string {
  return JSON.stringify([
    task.title,
    task.done,
    task.dueDate ?? "",
    task.priority ?? "",
    task.effort ?? "",
    task.parentId ?? "",
  ]);
}

export function TaskPanel({ revision, open, onPendingCountChange, onQuickPrompt }: TaskPanelProps) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [flashedIds, setFlashedIds] = useState<Set<string>>(() => new Set());
  const previousSnapshot = useRef<Map<string, string> | null>(null);
  const flashTimer = useRef<number | null>(null);
  const loadVersion = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++loadVersion.current;
    async function load() {
      try {
        const items = await fetchTasks(controller.signal);
        if (controller.signal.aborted || version !== loadVersion.current) return;

        const nextSnapshot = new Map(items.map((item) => [item.id, taskSignature(item)]));
        if (previousSnapshot.current) {
          const changed = new Set<string>();
          for (const [id, sig] of nextSnapshot) {
            if (previousSnapshot.current.get(id) !== sig) {
              changed.add(id);
            }
          }
          if (changed.size > 0) {
            setFlashedIds(changed);
            if (flashTimer.current) window.clearTimeout(flashTimer.current);
            flashTimer.current = window.setTimeout(() => setFlashedIds(new Set()), 1300);
          }
        }
        previousSnapshot.current = nextSnapshot;

        setTasks(items);
        setError(false);
        onPendingCountChange?.(items.filter((item) => !item.done).length);
      } catch {
        if (!controller.signal.aborted && version === loadVersion.current) setError(true);
      }
    }
    void load();
    return () => controller.abort();
  }, [revision, attempt, onPendingCountChange]);

  useEffect(() => {
    return () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    };
  }, []);

  const today = localDateString();

  const stats = useMemo(() => {
    const list = tasks ?? [];
    const total = list.length;
    const pending = list.filter((item) => !item.done).length;
    const done = total - pending;
    const overdue = list.filter(
      (item) => !item.done && getTaskDueState(item, today) === "overdue",
    ).length;
    const dueToday = list.filter(
      (item) => !item.done && getTaskDueState(item, today) === "today",
    ).length;
    const progress = total === 0 ? 0 : Math.round((done / total) * 100);
    return { total, pending, done, overdue, dueToday, progress };
  }, [tasks, today]);

  const tree = useMemo(() => buildTaskTree(tasks ?? [], today), [tasks, today]);

  const subtaskProgressByParent = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of tree) {
      if (node.subtasks.length > 0) {
        const doneCount = node.subtasks.filter((item) => item.done).length;
        map.set(node.task.id, `${doneCount}/${node.subtasks.length}`);
      }
    }
    return map;
  }, [tree]);

  const filteredTree = useMemo(() => {
    if (filter === "all") return tree;
    return tree
      .map((node) => {
        const match = (item: Task) => {
          if (filter === "pending") return !item.done;
          if (filter === "done") return item.done;
          const due = getTaskDueState(item, today);
          return !item.done && (due === "today" || due === "overdue");
        };
        const parentMatched = match(node.task);
        const matchingSubtasks =
          filter === "today" && parentMatched ? node.subtasks : node.subtasks.filter(match);
        if (parentMatched || matchingSubtasks.length > 0) {
          return {
            task: node.task,
            subtasks: matchingSubtasks,
          };
        }
        return null;
      })
      .filter((node): node is NonNullable<typeof node> => node !== null);
  }, [tree, filter, today]);

  async function handleToggle(task: Task) {
    if (busyIds.has(task.id)) return;
    setBusyIds((prev) => new Set(prev).add(task.id));
    loadVersion.current += 1;
    try {
      const updated = await updateTaskDone(task.id, !task.done);
      setTasks((prev) => {
        const next = prev?.map((item) => (item.id === updated.id ? updated : item)) ?? null;
        if (next) {
          previousSnapshot.current = new Map(next.map((item) => [item.id, taskSignature(item)]));
          onPendingCountChange?.(next.filter((item) => !item.done).length);
        }
        return next;
      });
    } catch {
      setError(true);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  }

  async function handleDelete(task: Task) {
    if (busyIds.has(task.id)) return;
    setBusyIds((prev) => new Set(prev).add(task.id));
    loadVersion.current += 1;
    try {
      await removeTaskById(task.id);
      setTasks((prev) => {
        if (!prev) return null;
        const next = prev
          .filter((item) => item.id !== task.id)
          .map((item) => {
            if (item.parentId !== task.id) return item;
            const copy = { ...item };
            delete copy.parentId;
            return copy;
          });
        previousSnapshot.current = new Map(next.map((item) => [item.id, taskSignature(item)]));
        onPendingCountChange?.(next.filter((item) => !item.done).length);
        return next;
      });
    } catch {
      setError(true);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  }

  function renderMetaPills(task: Task) {
    const dueState = getTaskDueState(task, today);
    const hasDue = typeof task.dueDate === "string" && task.dueDate.length > 0;
    const hasPriority = isPriority(task.priority);
    const hasEffort = isEffort(task.effort);
    if (!hasDue && !hasPriority && !hasEffort) return null;

    return (
      <div className="task-tags">
        {hasDue && (
          <span className={`tag tag-due is-${task.done ? "done" : dueState}`}>
            {formatDueLabel(task.dueDate!, today, task.done)}
          </span>
        )}
        {hasPriority && (
          <span className={`tag tag-priority is-p${task.priority}`}>
            {priorityLabels[task.priority!]}优先
          </span>
        )}
        {hasEffort && <span className="tag tag-effort">工作量 {effortLabels[task.effort!]}</span>}
      </div>
    );
  }

  function renderTaskRow(task: Task, isSubtask: boolean, subtaskProgress?: string) {
    const isBusy = busyIds.has(task.id);
    const isFlashed = flashedIds.has(task.id);
    const dueState = getTaskDueState(task, today);
    const itemClasses = [
      "task-item",
      isSubtask ? "is-subtask" : "",
      task.done ? "is-done" : "",
      !task.done && dueState === "overdue" ? "is-overdue" : "",
      isFlashed ? "is-updated" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div className={itemClasses}>
        <button
          type="button"
          className="task-check"
          aria-label={task.done ? `取消完成「${task.title}」` : `标记完成「${task.title}」`}
          aria-pressed={task.done}
          disabled={isBusy}
          onClick={() => void handleToggle(task)}
        >
          <span className="task-mark" aria-hidden="true">
            {task.done ? "✓" : ""}
          </span>
        </button>
        <div className="task-body">
          <div className="task-title-row">
            <p className="task-title">{task.title}</p>
            {subtaskProgress && <span className="subtask-progress">{subtaskProgress}</span>}
          </div>
          {renderMetaPills(task)}
        </div>
        <div className="task-actions">
          {onQuickPrompt && !task.done && (
            <button
              type="button"
              className="task-action-btn"
              title="在对话中继续操作此任务"
              aria-label={`在对话中操作「${task.title}」`}
              onClick={() => onQuickPrompt(`把「${task.title}」的`)}
            >
              ✎
            </button>
          )}
          <button
            type="button"
            className="task-action-btn is-danger"
            title="删除任务"
            aria-label={`删除「${task.title}」`}
            disabled={isBusy}
            onClick={() => void handleDelete(task)}
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  const filterTabs: Array<{ key: FilterKey; label: string; count: number }> = [
    { key: "all", label: "全部", count: stats.total },
    { key: "pending", label: "待办", count: stats.pending },
    { key: "today", label: "今日", count: stats.dueToday + stats.overdue },
    { key: "done", label: "已完成", count: stats.done },
  ];

  const pendingNodes = filteredTree.filter(
    (node) => !node.task.done || node.subtasks.some((child) => !child.done),
  );
  const doneNodes = filteredTree.filter(
    (node) => node.task.done && node.subtasks.every((child) => child.done),
  );
  const pendingGroupCount = pendingNodes.reduce((sum, node) => sum + 1 + node.subtasks.length, 0);
  const doneGroupCount = doneNodes.reduce((sum, node) => sum + 1 + node.subtasks.length, 0);

  return (
    <aside
      id="task-panel"
      className={open ? "task-panel is-open" : "task-panel"}
      aria-labelledby="task-panel-title"
    >
      <div className="task-panel-header">
        <div className="task-heading-row">
          <h2 id="task-panel-title">任务清单</h2>
          {stats.total > 0 && (
            <span className="task-ratio" aria-label={`已完成 ${stats.done} / ${stats.total}`}>
              {stats.done}/{stats.total}
            </span>
          )}
        </div>
        {stats.total > 0 && (
          <div className="task-progress-bar" aria-hidden="true">
            <div className="task-progress-fill" style={{ width: `${stats.progress}%` }} />
          </div>
        )}
        {(stats.overdue > 0 || stats.dueToday > 0) && (
          <div className="task-alerts">
            {stats.overdue > 0 && (
              <span className="alert-pill is-overdue">已逾期 {stats.overdue}</span>
            )}
            {stats.dueToday > 0 && (
              <span className="alert-pill is-today">今日到期 {stats.dueToday}</span>
            )}
          </div>
        )}
        <div className="task-filters" role="tablist" aria-label="筛选任务视图">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={filter === tab.key}
              className={filter === tab.key ? "filter-tab is-active" : "filter-tab"}
              onClick={() => setFilter(tab.key)}
            >
              {tab.label}
              <span>{tab.count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="task-scroll" role="region" aria-label="任务分组" tabIndex={0}>
        {error && (
          <div className="task-load-error">
            <p role="status">暂时无法更新清单</p>
            <button
              type="button"
              onClick={() => {
                setError(false);
                setAttempt((count) => count + 1);
              }}
            >
              重试
            </button>
          </div>
        )}

        {!tasks && !error && (
          <p role="status" className="task-empty">
            正在读取…
          </p>
        )}

        {tasks?.length === 0 && !error && (
          <div className="task-empty-card">
            <p className="task-empty">清单还是空的</p>
            <small>在左侧对小明说「帮我记一下买牛奶」，任务就会实时同步到这里。</small>
          </div>
        )}

        {!!tasks?.length && filteredTree.length === 0 && (
          <p className="task-empty">当前筛选下没有任务。</p>
        )}

        {!!tasks?.length && filteredTree.length > 0 && (
          <>
            {filter === "all" ? (
              <>
                {pendingNodes.length > 0 && (
                  <section className="task-group" aria-labelledby="task-group-pending">
                    <h3 id="task-group-pending">
                      进行中 <span>{pendingGroupCount}</span>
                    </h3>
                    <ul className="task-items">
                      {pendingNodes.map(({ task, subtasks }) => {
                        const progressText = subtaskProgressByParent.get(task.id);
                        return (
                          <li key={task.id} className="task-node">
                            {renderTaskRow(task, false, progressText)}
                            {subtasks.length > 0 && (
                              <ul className="subtask-list">
                                {subtasks.map((child) => (
                                  <li key={child.id}>{renderTaskRow(child, true)}</li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}

                {doneNodes.length > 0 && (
                  <section className="task-group" aria-labelledby="task-group-done">
                    <h3 id="task-group-done">
                      已完成 <span>{doneGroupCount}</span>
                    </h3>
                    <ul className="task-items">
                      {doneNodes.map(({ task, subtasks }) => {
                        const progressText = subtaskProgressByParent.get(task.id);
                        return (
                          <li key={task.id} className="task-node">
                            {renderTaskRow(task, false, progressText)}
                            {subtasks.length > 0 && (
                              <ul className="subtask-list">
                                {subtasks.map((child) => (
                                  <li key={child.id}>{renderTaskRow(child, true)}</li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
              </>
            ) : (
              <section className="task-group">
                <ul className="task-items">
                  {filteredTree.map(({ task, subtasks }) => {
                    const progressText = subtaskProgressByParent.get(task.id);
                    return (
                      <li key={task.id} className="task-node">
                        {renderTaskRow(task, false, progressText)}
                        {subtasks.length > 0 && (
                          <ul className="subtask-list">
                            {subtasks.map((child) => (
                              <li key={child.id}>{renderTaskRow(child, true)}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
