import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
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
import { AnimatedNumber } from "./AnimatedNumber.tsx";
import { fetchTasks, removeTaskById, updateTaskDone } from "./chat-client.ts";

type FilterKey = "all" | "pending" | "today" | "done";
const FILTER_ORDER: FilterKey[] = ["all", "pending", "today", "done"];

interface PendingLocalOp {
  type: "toggle" | "delete";
  done?: boolean;
}

interface TaskPanelProps {
  revision: number;
  open: boolean;
  isMobile: boolean;
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

function applyPendingOps(items: Task[], ops: Map<string, PendingLocalOp>): Task[] {
  if (ops.size === 0) return items;
  const deletedIds = new Set<string>();
  for (const [id, op] of ops) {
    if (op.type === "delete") deletedIds.add(id);
  }
  return items
    .filter((item) => !deletedIds.has(item.id))
    .map((item) => {
      let next = item;
      if (typeof next.parentId === "string" && deletedIds.has(next.parentId)) {
        const copy = { ...next };
        delete copy.parentId;
        next = copy;
      }
      const op = ops.get(next.id);
      if (op?.type === "toggle" && op.done !== undefined) {
        return { ...next, done: op.done };
      }
      return next;
    });
}

export function TaskPanel({
  revision,
  open,
  isMobile,
  onPendingCountChange,
  onQuickPrompt,
}: TaskPanelProps) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [flashedIds, setFlashedIds] = useState<Set<string>>(() => new Set());
  const [enteringIds, setEnteringIds] = useState<Set<string>>(() => new Set());
  const [leavingIds, setLeavingIds] = useState<Set<string>>(() => new Set());

  const previousSnapshot = useRef<Map<string, string> | null>(null);
  const pendingOpsRef = useRef<Map<string, PendingLocalOp>>(new Map());
  const flashTimer = useRef<number | null>(null);
  const enterTimer = useRef<number | null>(null);
  const loadVersion = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabButtonsRef = useRef<Record<FilterKey, HTMLButtonElement | null>>({
    all: null,
    pending: null,
    today: null,
    done: null,
  });

  // 窄屏打开抽屉时把焦点引入当前选中的筛选按钮，关闭时交由 App 还原焦点。
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (isMobile && open && !prevOpenRef.current) {
      requestAnimationFrame(() => tabButtonsRef.current[filter]?.focus());
    }
    prevOpenRef.current = open;
  }, [isMobile, open, filter]);

  // 纯副作用同步父组件待办计数和任务快照（严禁在 setTasks updater 内触发外部状态更新）。
  useEffect(() => {
    if (!tasks) return;
    previousSnapshot.current = new Map(tasks.map((item) => [item.id, taskSignature(item)]));
    onPendingCountChange?.(tasks.filter((item) => !item.done).length);
  }, [tasks, onPendingCountChange]);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++loadVersion.current;
    async function load() {
      try {
        const rawItems = await fetchTasks(controller.signal);
        if (controller.signal.aborted || version !== loadVersion.current) return;

        // 叠加尚未落盘的本地乐观操作，避免旧快照覆盖并发修改。
        const items = applyPendingOps(rawItems, pendingOpsRef.current);
        const nextSnapshot = new Map(items.map((item) => [item.id, taskSignature(item)]));

        if (previousSnapshot.current) {
          const changed = new Set<string>();
          const added = new Set<string>();
          for (const [id, sig] of nextSnapshot) {
            const prevSig = previousSnapshot.current.get(id);
            if (prevSig === undefined) {
              added.add(id);
              changed.add(id);
            } else if (prevSig !== sig) {
              changed.add(id);
            }
          }
          if (changed.size > 0) {
            setFlashedIds(changed);
            if (flashTimer.current) window.clearTimeout(flashTimer.current);
            flashTimer.current = window.setTimeout(() => setFlashedIds(new Set()), 980);
          }
          if (added.size > 0) {
            setEnteringIds(added);
            if (enterTimer.current) window.clearTimeout(enterTimer.current);
            enterTimer.current = window.setTimeout(() => setEnteringIds(new Set()), 280);
          }
        }

        setTasks(items);
        setError(false);
      } catch {
        if (!controller.signal.aborted && version === loadVersion.current) setError(true);
      }
    }
    void load();
    return () => controller.abort();
  }, [revision, attempt]);

  useEffect(() => {
    return () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      if (enterTimer.current) window.clearTimeout(enterTimer.current);
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
    const map = new Map<string, { label: string; complete: boolean }>();
    for (const node of tree) {
      if (node.subtasks.length > 0) {
        const doneCount = node.subtasks.filter((item) => item.done).length;
        map.set(node.task.id, {
          label: `${doneCount}/${node.subtasks.length}`,
          complete: doneCount === node.subtasks.length,
        });
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
    if (busyIds.has(task.id) || leavingIds.has(task.id)) return;
    const previousDone = task.done;
    const targetDone = !previousDone;

    setBusyIds((prev) => new Set(prev).add(task.id));
    pendingOpsRef.current.set(task.id, { type: "toggle", done: targetDone });

    setTasks(
      (prev) =>
        prev?.map((item) => (item.id === task.id ? { ...item, done: targetDone } : item)) ?? null,
    );

    try {
      const updated = await updateTaskDone(task.id, targetDone);
      pendingOpsRef.current.delete(task.id);
      setTasks((prev) => prev?.map((item) => (item.id === updated.id ? updated : item)) ?? null);
    } catch {
      pendingOpsRef.current.delete(task.id);
      // 仅按当前任务 ID 精确回滚，绝不回滚其他并发任务状态。
      setTasks(
        (prev) =>
          prev?.map((item) => (item.id === task.id ? { ...item, done: previousDone } : item)) ??
          null,
      );
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
    if (busyIds.has(task.id) || leavingIds.has(task.id)) return;
    setBusyIds((prev) => new Set(prev).add(task.id));
    setLeavingIds((prev) => new Set(prev).add(task.id));
    pendingOpsRef.current.set(task.id, { type: "delete" });

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const exitDelay = reduced ? 0 : 210;

    try {
      await Promise.all([
        removeTaskById(task.id),
        new Promise((resolve) => window.setTimeout(resolve, exitDelay)),
      ]);
      pendingOpsRef.current.delete(task.id);
      setTasks((prev) => {
        if (!prev) return null;
        return prev
          .filter((item) => item.id !== task.id)
          .map((item) => {
            if (item.parentId !== task.id) return item;
            const copy = { ...item };
            delete copy.parentId;
            return copy;
          });
      });
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) {
          scrollRef.current?.focus();
        }
      });
    } catch {
      pendingOpsRef.current.delete(task.id);
      setError(true);
    } finally {
      setLeavingIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % FILTER_ORDER.length;
    else if (event.key === "ArrowLeft")
      nextIndex = (currentIndex - 1 + FILTER_ORDER.length) % FILTER_ORDER.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = FILTER_ORDER.length - 1;

    if (nextIndex !== null) {
      event.preventDefault();
      const nextKey = FILTER_ORDER[nextIndex];
      setFilter(nextKey);
      tabButtonsRef.current[nextKey]?.focus();
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

  function renderTaskRow(
    task: Task,
    isSubtask: boolean,
    progress?: { label: string; complete: boolean },
  ) {
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
            <svg viewBox="0 0 14 14" focusable="false">
              <path d="M2.8 7.3L5.7 10.2L11.2 4.2" />
            </svg>
          </span>
        </button>
        <div className="task-body">
          <div className="task-title-row">
            <p className="task-title">{task.title}</p>
            {progress && (
              <span
                className={progress.complete ? "subtask-progress is-complete" : "subtask-progress"}
              >
                {progress.label}
              </span>
            )}
          </div>
          {renderMetaPills(task)}
        </div>
        <div className="task-actions">
          {onQuickPrompt && !task.done && (
            <button
              type="button"
              className="task-action-btn"
              title="在对话中继续修改此任务"
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

  function renderNode(task: Task, subtasks: Task[]) {
    const progress = subtaskProgressByParent.get(task.id);
    const nodeClasses = [
      "task-node",
      enteringIds.has(task.id) ? "is-entering" : "",
      leavingIds.has(task.id) ? "is-leaving" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <li key={task.id} className={nodeClasses}>
        <div className="task-node-inner">
          {renderTaskRow(task, false, progress)}
          {subtasks.length > 0 && (
            <ul className="subtask-list">
              {subtasks.map((child) => {
                const subClasses = [
                  "subtask-wrap",
                  enteringIds.has(child.id) ? "is-entering" : "",
                  leavingIds.has(child.id) ? "is-leaving" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <li key={child.id} className={subClasses}>
                    <div>{renderTaskRow(child, true)}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </li>
    );
  }

  const filterTabs: Array<{ key: FilterKey; label: string; count: number }> = [
    { key: "all", label: "全部", count: stats.total },
    { key: "pending", label: "待办", count: stats.pending },
    { key: "today", label: "今日", count: stats.dueToday + stats.overdue },
    { key: "done", label: "已完成", count: stats.done },
  ];

  const activeFilterIndex = FILTER_ORDER.indexOf(filter);
  const pendingNodes = filteredTree.filter(
    (node) => !node.task.done || node.subtasks.some((child) => !child.done),
  );
  const doneNodes = filteredTree.filter(
    (node) => node.task.done && node.subtasks.every((child) => child.done),
  );
  const pendingGroupPendingCount = pendingNodes.reduce(
    (sum, node) => sum + (node.task.done ? 0 : 1) + node.subtasks.filter((c) => !c.done).length,
    0,
  );
  const doneGroupCount = doneNodes.reduce((sum, node) => sum + 1 + node.subtasks.length, 0);
  const allCompleted = stats.total > 0 && stats.pending === 0;
  const isHiddenDrawer = isMobile && !open;

  return (
    <div
      className={open ? "task-panel-shell is-open" : "task-panel-shell"}
      inert={isHiddenDrawer}
      aria-hidden={isHiddenDrawer || undefined}
    >
      <aside id="task-panel" className="task-panel" aria-labelledby="task-panel-title">
        <div className="task-panel-header">
          <div className="task-heading-row">
            <h2 id="task-panel-title">任务清单</h2>
            {stats.total > 0 && (
              <span className="task-ratio" aria-label={`已完成 ${stats.done} / ${stats.total}`}>
                <AnimatedNumber value={stats.done} />/<AnimatedNumber value={stats.total} />
              </span>
            )}
          </div>
          {stats.total > 0 && (
            <div className="task-progress-bar" aria-hidden="true">
              <div
                className={allCompleted ? "task-progress-fill is-complete" : "task-progress-fill"}
                style={{ width: `${stats.progress}%` }}
              />
            </div>
          )}
          {(stats.overdue > 0 || stats.dueToday > 0) && (
            <div className="task-alerts">
              {stats.overdue > 0 && (
                <span className="alert-pill is-overdue">
                  已逾期 <AnimatedNumber value={stats.overdue} compact />
                </span>
              )}
              {stats.dueToday > 0 && (
                <span className="alert-pill is-today">
                  今日到期 <AnimatedNumber value={stats.dueToday} compact />
                </span>
              )}
            </div>
          )}
          <div
            className="task-filters"
            style={{ "--active-index": activeFilterIndex } as CSSProperties}
            role="tablist"
            aria-label="筛选任务视图"
          >
            <div className="filter-indicator" aria-hidden="true" />
            {filterTabs.map((tab, index) => (
              <button
                key={tab.key}
                id={`task-tab-${tab.key}`}
                ref={(el) => {
                  tabButtonsRef.current[tab.key] = el;
                }}
                type="button"
                role="tab"
                aria-selected={filter === tab.key}
                aria-controls="task-tabpanel"
                tabIndex={filter === tab.key ? 0 : -1}
                className={filter === tab.key ? "filter-tab is-active" : "filter-tab"}
                onClick={() => setFilter(tab.key)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {tab.label}
                <span>
                  <AnimatedNumber value={tab.count} compact />
                </span>
              </button>
            ))}
          </div>
        </div>

        <div
          id="task-tabpanel"
          ref={scrollRef}
          className="task-scroll"
          role="tabpanel"
          aria-labelledby={`task-tab-${filter}`}
          tabIndex={0}
        >
          {error && (
            <div className="task-load-error">
              <p role="status">同步清单失败，请稍后重试</p>
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
              正在读取清单…
            </p>
          )}

          {tasks?.length === 0 && !error && (
            <div className="task-empty-card">
              <p className="task-empty">清单还是空的</p>
              <small>在左侧对小明说「帮我记一下买牛奶」，任务就会实时同步到这里。</small>
            </div>
          )}

          {!!tasks?.length && filteredTree.length === 0 && (
            <div
              className={
                filter === "pending" && allCompleted
                  ? "task-empty-card is-celebrate"
                  : "task-empty-card"
              }
            >
              <p className="task-empty">
                {filter === "pending" && allCompleted
                  ? "全部待办已清零"
                  : filter === "today"
                    ? "今天没有到期或逾期的待办"
                    : "当前视图下还没有任务"}
              </p>
              {filter === "pending" && allCompleted && (
                <small>已完成全部 {stats.done} 项安排，轻松一下吧。</small>
              )}
            </div>
          )}

          {!!tasks?.length && filteredTree.length > 0 && (
            <>
              {filter === "all" ? (
                <>
                  {pendingNodes.length > 0 && (
                    <section className="task-group" aria-labelledby="task-group-pending">
                      <h3 id="task-group-pending">
                        待办{" "}
                        <span>
                          <AnimatedNumber value={pendingGroupPendingCount} />
                        </span>
                      </h3>
                      <ul className="task-items">
                        {pendingNodes.map(({ task, subtasks }) => renderNode(task, subtasks))}
                      </ul>
                    </section>
                  )}

                  {doneNodes.length > 0 && (
                    <section className="task-group" aria-labelledby="task-group-done">
                      <h3 id="task-group-done">
                        已完成{" "}
                        <span>
                          <AnimatedNumber value={doneGroupCount} />
                        </span>
                      </h3>
                      <ul className="task-items">
                        {doneNodes.map(({ task, subtasks }) => renderNode(task, subtasks))}
                      </ul>
                    </section>
                  )}
                </>
              ) : (
                <section className="task-group">
                  <ul className="task-items">
                    {filteredTree.map(({ task, subtasks }) => renderNode(task, subtasks))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
