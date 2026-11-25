import { useLayoutEffect, useRef } from "react";

interface AnimatedNumberProps {
  value: number;
  compact?: boolean;
}

export function AnimatedNumber({ value, compact = false }: AnimatedNumberProps) {
  const display = compact && value > 99 ? "99+" : String(value);
  const element = useRef<HTMLSpanElement>(null);
  const previous = useRef({ value, display });
  const animation = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { value, display };
    if (
      before.display === display ||
      !element.current ||
      matchMedia("(prefers-reduced-motion: reduce)").matches ||
      animation.current?.playState === "running"
    )
      return;

    animation.current = element.current.animate(
      [
        { transform: `translateY(${value > before.value ? 3 : -3}px)` },
        { transform: "translateY(0)" },
      ],
      { duration: 180, easing: "cubic-bezier(.22,1,.36,1)" },
    );
  }, [display, value]);

  return (
    <span ref={element} className="num-roll">
      {display}
    </span>
  );
}
