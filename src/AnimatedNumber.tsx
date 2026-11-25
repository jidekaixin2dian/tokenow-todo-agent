import { useState } from "react";

interface AnimatedNumberProps {
  value: number;
  compact?: boolean;
}

export function AnimatedNumber({ value, compact = false }: AnimatedNumberProps) {
  const [state, setState] = useState<{
    prev: number;
    dir: "up" | "down" | null;
    tick: number;
  }>({ prev: value, dir: null, tick: 0 });

  if (value !== state.prev) {
    setState({
      prev: value,
      dir: value > state.prev ? "up" : "down",
      tick: state.tick + 1,
    });
  }

  const display = compact && value > 99 ? "99+" : String(value);
  const cls = state.dir ? `num-roll is-${state.dir}` : "num-roll";
  return (
    <span key={state.tick} className={cls}>
      {display}
    </span>
  );
}
