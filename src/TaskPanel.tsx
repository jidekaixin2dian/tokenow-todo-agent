import { useEffect, useState } from "react";
import { taskDetailsLabels, type Task } from "../shared/task.ts";

interface TaskPanelProps {
  revision: number;
  open: boolean;
}

export function TaskPanel({ revision, open }: TaskPanelProps) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/tasks", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("读取任务失败");
        const items: Task[] = await response.json();
        if (controller.signal.aborted) return;
        setTasks(items);
        setError(false);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    }
    void load();
    return () => controller.abort();
  }, [revision, attempt]);

  const titles = new Map(tasks?.map((task) => [task.id, task.title]));
  const groups = [
    { label: "待办", key: "pending", items: tasks?.filter((task) => !task.done) ?? [] },
    { label: "已完成", key: "done", items: tasks?.filter((task) => task.done) ?? [] },
  ];

  return (
    <aside
      id="task-panel"
      className={open ? "task-panel is-open" : "task-panel"}
      aria-labelledby="task-panel-title"
    >
      <h2 id="task-panel-title">任务清单</h2>
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
          <p className="task-empty">从对话里记下一条待办，就会显示在这里。</p>
        )}
        {!!tasks?.length &&
          groups.map(({ label, key, items }) => (
            <section className="task-group" aria-labelledby={`task-group-${key}`} key={key}>
              <h3 id={`task-group-${key}`}>
                {label} <span>{items.length}</span>
              </h3>
              {items.length > 0 && (
                <ul className="task-items">
                  {items.map((task) => {
                    const parent =
                      typeof task.parentId === "string" ? titles.get(task.parentId) : undefined;
                    const details = taskDetailsLabels(task, parent);
                    return (
                      <li key={task.id} className={task.done ? "task-item is-done" : "task-item"}>
                        <span className="task-mark" aria-hidden="true">
                          {task.done ? "✓" : ""}
                        </span>
                        <div>
                          <p className="task-title">{task.title}</p>
                          {details.length > 0 && (
                            <p className="task-details">{details.join(" · ")}</p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
      </div>
    </aside>
  );
}
