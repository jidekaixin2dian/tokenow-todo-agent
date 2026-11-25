import {
  useCallback,
  useEffect,
  useLayoutEffect,
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

interface LeavingTask {
  task: Task;
  childIds: string[];
  index: number;
}

interface TaskPresence {
  source: Task[] | null;
  leaving: Map<string, LeavingTask>;
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
  return items.map((task) => {
    const op = ops.get(task.id);
    return op?.type === "toggle" && op.done !== undefined ? { ...task, done: op.done } : task;
  });
}

function retainLeavingTasks(previous: TaskPresence, tasks: Task[] | null): TaskPresence {
  const liveIds = new Set(tasks?.map((task) => task.id));
  const leaving = new Map(previous.leaving);
  for (const id of liveIds) leaving.delete(id);

  const children = new Map<string, string[]>();
  for (const task of previous.source ?? []) {
    if (!task.parentId) continue;
    const ids = children.get(task.parentId) ?? [];
    ids.push(task.id);
    children.set(task.parentId, ids);
  }
  for (const [index, task] of (previous.source ?? []).entries()) {
    if (!liveIds.has(task.id)) {
      leaving.set(task.id, { task, childIds: children.get(task.id) ?? [], index });
    }
  }
  return { source: tasks, leaving };
}

function rowsWithExits(tasks: Task[], leaving: Map<string, LeavingTask>): Task[] {
  if (leaving.size === 0) return tasks;
  const previousParents = new Map<string, string>();
  for (const { task, childIds } of leaving.values()) {
    for (const id of childIds) previousParents.set(id, task.id);
  }
  const rows = tasks.map((task) => {
    const parentId = previousParents.get(task.id);
    return parentId && !task.parentId ? { ...task, parentId } : task;
  });
  for (const { task, index } of [...leaving.values()].sort((a, b) => a.index - b.index)) {
    rows.splice(index, 0, task);
  }
  return rows;
}

function removeAndDetach(tasks: Task[], id: string): Task[] {
  return tasks
    .filter((task) => task.id !== id)
    .map((task) => {
      if (task.parentId !== id) return task;
      const detached = { ...task };
      delete detached.parentId;
      return detached;
    });
}

export function TaskPanel({
  revision,
  open,
  isMobile,
  onPendingCountChange,
  onQuickPrompt,
}: TaskPanelProps) {
  const [snapshot, setSnapshot] = useState<Task[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [pendingOps, setPendingOps] = useState<Map<string, PendingLocalOp>>(() => new Map());
  const [flashedIds, setFlashedIds] = useState<Set<string>>(() => new Set());
  const [enteringIds, setEnteringIds] = useState<Set<string>>(() => new Set());
  const [presence, setPresence] = useState<TaskPresence>(() => ({
    source: null,
    leaving: new Map(),
  }));

  const previousSnapshot = useRef<Map<string, string> | null>(null);
  const flashTimer = useRef<number | null>(null);
  const enterTimer = useRef<number | null>(null);
  const exitTimers = useRef(new Map<string, number>());
  const loadVersion = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousRows = useRef<Map<string, number> | null>(null);
  const focusedRow = useRef<{ id: string; button: HTMLElement } | null>(null);
  const rowAnimations = useRef(new WeakMap<HTMLElement, Animation>());
  const paintedDone = useRef(new Map<string, boolean>());
  const tabButtonsRef = useRef<Record<FilterKey, HTMLButtonElement | null>>({
    all: null,
    pending: null,
    today: null,
    done: null,
  });

  // 窄屏打开抽屉时把焦点引入当前选中的筛选按钮，关闭时交由 App 还原焦点。
  const prevOpenRef = useRef(open);
  useEffect(() => {
    let frame: number | undefined;
    if (isMobile && open && !prevOpenRef.current) {
      frame = requestAnimationFrame(() => tabButtonsRef.current[filter]?.focus());
    }
    prevOpenRef.current = open;
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [isMobile, open, filter]);

  const tasks = useMemo(
    () => snapshot && applyPendingOps(snapshot, pendingOps),
    [snapshot, pendingOps],
  );
  if (presence.source !== tasks) setPresence(retainLeavingTasks(presence, tasks));

  useEffect(() => {
    if (tasks) onPendingCountChange?.(tasks.filter((item) => !item.done).length);
  }, [tasks, onPendingCountChange]);

  const captureRows = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && scroll.contains(active)) {
      const id = active.closest<HTMLElement>("[data-task-id]")?.dataset.taskId;
      if (id) focusedRow.current = { id, button: active };
    }
    if (scroll.closest(".is-resizing") || matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    previousRows.current = new Map(
      [...scroll.querySelectorAll<HTMLElement>(".task-node[data-task-id]")].map((row) => [
        row.dataset.taskId!,
        row.getBoundingClientRect().top,
      ]),
    );
  }, []);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const focus = focusedRow.current;
    const positions = previousRows.current;
    focusedRow.current = null;
    previousRows.current = null;
    if (
      focus &&
      (document.activeElement === document.body || document.activeElement === focus.button)
    ) {
      const row = [...scroll.querySelectorAll<HTMLElement>("[data-task-id]")].find(
        (element) => element.dataset.taskId === focus.id && !element.closest("[inert]"),
      );
      const button = row?.querySelector<HTMLElement>(".task-check");
      if (!button) tabButtonsRef.current[filter]?.focus();
      else if (document.activeElement === document.body) button.focus({ preventScroll: true });
    }
    const before = paintedDone.current;
    paintedDone.current = new Map(tasks?.map(({ id, done }) => [id, done]));
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const [id, done] of paintedDone.current) {
        const wasDone = before.get(id);
        if (wasDone === undefined || wasDone === done) continue;
        const path = scroll.querySelector<SVGPathElement>(
          `[data-task-id="${CSS.escape(id)}"] > div > .task-item > .task-check path`,
        );
        if (!path) continue;
        const running = path.getAnimations()[0];
        const from = running ? getComputedStyle(path).strokeDashoffset : wasDone ? "0px" : "18px";
        running?.cancel();
        path.animate([{ strokeDashoffset: from }, { strokeDashoffset: done ? "0px" : "18px" }], {
          duration: 200,
          easing: "cubic-bezier(.22,1,.36,1)",
        });
      }
    }
    if (!positions || scroll.closest(".is-resizing")) return;

    const viewport = scroll.getBoundingClientRect();
    const shifts: Array<{ row: HTMLElement; distance: number }> = [];
    for (const row of scroll.querySelectorAll<HTMLElement>(
      ".task-node[data-task-id]:not(.is-leaving)",
    )) {
      const previous = positions.get(row.dataset.taskId!);
      if (previous === undefined) continue;
      rowAnimations.current.get(row)?.cancel();
      const rect = row.getBoundingClientRect();
      const distance = previous - rect.top;
      if (
        Math.abs(distance) > 1 &&
        rect.bottom + Math.max(0, distance) > viewport.top &&
        rect.top + Math.min(0, distance) < viewport.bottom
      ) {
        shifts.push({ row, distance });
      }
    }
    for (const { row, distance } of shifts) {
      rowAnimations.current.set(
        row,
        row.animate([{ translate: `0 ${distance}px` }, { translate: "0 0" }], {
          duration: 220,
          easing: "cubic-bezier(.22,1,.36,1)",
        }),
      );
    }
  }, [tasks, filter]);

  const finishExit = useCallback((id: string) => {
    setPresence((current) => {
      if (!current.leaving.has(id)) return current;
      const leaving = new Map(current.leaving);
      leaving.delete(id);
      return { ...current, leaving };
    });
  }, []);

  useEffect(() => {
    const timers = exitTimers.current;
    for (const [id, timer] of timers) {
      if (!presence.leaving.has(id)) {
        clearTimeout(timer);
        timers.delete(id);
      }
    }
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const id of presence.leaving.keys()) {
      if (!timers.has(id)) {
        timers.set(
          id,
          window.setTimeout(() => finishExit(id), reduced ? 0 : 300),
        );
      }
    }
  }, [presence.leaving, finishExit]);

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
            setFlashedIds((ids) => new Set([...ids, ...changed]));
            if (flashTimer.current) window.clearTimeout(flashTimer.current);
            flashTimer.current = window.setTimeout(() => setFlashedIds(new Set()), 980);
          }
          if (added.size > 0) {
            setEnteringIds((ids) => new Set([...ids, ...added]));
            if (enterTimer.current) window.clearTimeout(enterTimer.current);
            enterTimer.current = window.setTimeout(() => setEnteringIds(new Set()), 280);
          }
        }

        captureRows();
        previousSnapshot.current = nextSnapshot;
        setSnapshot(items);
        setLoadError(false);
      } catch {
        if (!controller.signal.aborted && version === loadVersion.current) setLoadError(true);
      }
    }
    void load();
    return () => controller.abort();
  }, [revision, attempt, captureRows]);

  useEffect(() => {
    const timers = exitTimers.current;
    return () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
      if (enterTimer.current) window.clearTimeout(enterTimer.current);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
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

  const tree = useMemo(
    () => buildTaskTree(rowsWithExits(tasks ?? [], presence.leaving), today),
    [tasks, presence.leaving, today],
  );

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
    if (filter === "all") return tree.map((node) => ({ ...node, parentMatched: true }));
    return tree
      .map((node) => {
        const match = (item: Task) => {
          if (filter === "pending") return !item.done;
          if (filter === "done") return item.done;
          const due = getTaskDueState(item, today);
          return !item.done && (due === "today" || due === "overdue");
        };
        const parentMatched = match(node.task);
        const matchingSubtasks = node.subtasks.filter(match);
        if (parentMatched || matchingSubtasks.length > 0) {
          return {
            task: node.task,
            subtasks: matchingSubtasks,
            parentMatched,
          };
        }
        return null;
      })
      .filter((node): node is NonNullable<typeof node> => node !== null);
  }, [tree, filter, today]);

  function rememberFocus(task: Task, button: HTMLButtonElement) {
    if (document.activeElement === button) focusedRow.current = { id: task.id, button };
  }

  function finishOperation(id: string) {
    // Any GET started before this mutation settled may carry an older snapshot.
    loadVersion.current += 1;
    setPendingOps((ops) => {
      const next = new Map(ops);
      next.delete(id);
      return next;
    });
    setAttempt((count) => count + 1);
  }

  async function handleToggle(task: Task, button: HTMLButtonElement) {
    if (pendingOps.has(task.id) || presence.leaving.has(task.id)) return;
    const done = !task.done;
    setActionError("");
    rememberFocus(task, button);
    captureRows();
    setPendingOps((ops) => new Map(ops).set(task.id, { type: "toggle", done }));

    try {
      const updated = await updateTaskDone(task.id, done);
      setSnapshot(
        (items) =>
          items?.map((item) => (item.id === updated.id ? { ...item, done: updated.done } : item)) ??
          null,
      );
    } catch {
      captureRows();
      setActionError("更新任务状态失败，请核对清单后重试。");
    } finally {
      finishOperation(task.id);
    }
  }

  async function handleDelete(task: Task, button: HTMLButtonElement) {
    if (pendingOps.has(task.id) || presence.leaving.has(task.id)) return;
    setActionError("");
    setPendingOps((ops) => new Map(ops).set(task.id, { type: "delete" }));

    try {
      await removeTaskById(task.id);
      rememberFocus(task, button);
      setSnapshot((items) => items && removeAndDetach(items, task.id));
    } catch {
      setActionError("删除任务失败，请核对清单后重试。");
    } finally {
      finishOperation(task.id);
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
    const isBusy = pendingOps.has(task.id);
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
      <div className={itemClasses} aria-busy={isBusy || undefined}>
        <button
          type="button"
          className="task-check"
          aria-label={task.done ? `取消完成「${task.title}」` : `标记完成「${task.title}」`}
          aria-pressed={task.done}
          aria-disabled={isBusy || undefined}
          onClick={(event) => void handleToggle(task, event.currentTarget)}
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
              aria-disabled={isBusy || undefined}
              onClick={() => {
                if (!isBusy) onQuickPrompt(`把「${task.title}」的`);
              }}
            >
              ✎
            </button>
          )}
          <button
            type="button"
            className="task-action-btn is-danger"
            title="删除任务"
            aria-label={`删除「${task.title}」`}
            aria-disabled={isBusy || undefined}
            onClick={(event) => void handleDelete(task, event.currentTarget)}
          >
            ×
          </button>
        </div>
      </div>
    );
  }

  function renderNode(task: Task, subtasks: Task[], parentMatched: boolean) {
    const progress = subtaskProgressByParent.get(task.id);
    const isLeaving = presence.leaving.has(task.id);
    const nodeClasses = [
      "task-node",
      enteringIds.has(task.id) && !isLeaving ? "is-entering" : "",
      isLeaving ? "is-leaving" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <li
        key={`task:${task.id}`}
        className={nodeClasses}
        data-task-id={task.id}
        inert={isLeaving}
        onTransitionEnd={(event) => {
          if (
            isLeaving &&
            event.target === event.currentTarget &&
            event.propertyName === "grid-template-rows"
          ) {
            finishExit(task.id);
          }
        }}
      >
        <div className="task-node-inner">
          {parentMatched ? (
            renderTaskRow(task, false, progress)
          ) : (
            <p className="task-context">主任务 · {task.title}</p>
          )}
          {subtasks.length > 0 && (
            <ul className="subtask-list">
              {subtasks.map((child) => {
                const childLeaving = presence.leaving.has(child.id);
                const subClasses = [
                  "subtask-wrap",
                  enteringIds.has(child.id) && !childLeaving ? "is-entering" : "",
                  childLeaving ? "is-leaving" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <li
                    key={child.id}
                    className={subClasses}
                    data-task-id={child.id}
                    inert={childLeaving}
                    onTransitionEnd={(event) => {
                      if (
                        childLeaving &&
                        event.target === event.currentTarget &&
                        event.propertyName === "grid-template-rows"
                      ) {
                        finishExit(child.id);
                      }
                    }}
                  >
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
  const doneGroupCount = doneNodes.reduce(
    (sum, node) =>
      sum + [node.task, ...node.subtasks].filter((task) => !presence.leaving.has(task.id)).length,
    0,
  );
  const allCompleted = stats.total > 0 && stats.pending === 0;
  const isHiddenDrawer = isMobile && !open;
  const error = actionError || (loadError ? "同步清单失败，请稍后重试" : "");
  const visibleNodes =
    filter === "all"
      ? [
          ...(pendingNodes.length
            ? [
                <li key="pending-heading" className="task-group-heading" role="presentation">
                  <h3>
                    待办 <AnimatedNumber value={stats.pending} />
                  </h3>
                </li>,
                ...pendingNodes.map(({ task, subtasks }) => renderNode(task, subtasks, true)),
              ]
            : []),
          ...(doneNodes.length
            ? [
                <li key="done-heading" className="task-group-heading" role="presentation">
                  <h3>
                    已完成 <AnimatedNumber value={doneGroupCount} />
                  </h3>
                </li>,
                ...doneNodes.map(({ task, subtasks }) => renderNode(task, subtasks, true)),
              ]
            : []),
        ]
      : filteredTree.map(({ task, subtasks, parentMatched }) =>
          renderNode(task, subtasks, parentMatched),
        );

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
            <span
              className={stats.total > 0 ? "task-ratio" : "task-ratio is-empty"}
              aria-hidden="true"
            >
              <AnimatedNumber value={stats.done} />/<AnimatedNumber value={stats.total} />
            </span>
          </div>
          <div
            className={stats.total > 0 ? "task-progress-bar" : "task-progress-bar is-empty"}
            role={stats.total > 0 ? "progressbar" : undefined}
            aria-label={stats.total > 0 ? "任务完成进度" : undefined}
            aria-valuetext={
              stats.total > 0 ? `已完成 ${stats.done} 项，共 ${stats.total} 项` : undefined
            }
            aria-valuenow={stats.total > 0 ? stats.progress : undefined}
          >
            <div
              className={allCompleted ? "task-progress-fill is-complete" : "task-progress-fill"}
              style={{ transform: `scaleX(${stats.progress / 100})` }}
            />
          </div>
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
              <p role="status">{error}</p>
              <button
                type="button"
                onClick={() => {
                  setActionError("");
                  setLoadError(false);
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

          {tasks?.length === 0 && visibleNodes.length === 0 && !error && (
            <div className="task-empty-card">
              <p className="task-empty">清单还是空的</p>
              <small>在左侧对小明说「帮我记一下买牛奶」，任务就会实时同步到这里。</small>
            </div>
          )}

          {!!tasks?.length && visibleNodes.length === 0 && (
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

          {visibleNodes.length > 0 && <ul className="task-items">{visibleNodes}</ul>}
        </div>
      </aside>
    </div>
  );
}
