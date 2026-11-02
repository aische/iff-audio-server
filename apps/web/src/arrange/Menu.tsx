import { useEffect, useRef, useState, type ReactNode } from "react";

const MENU_EST_H = 280;

/** Button with a popover; used for transport and row overflow. */
export function Menu({
  label,
  title,
  buttonClassName,
  children,
}: {
  label: ReactNode;
  title: string;
  buttonClassName: string;
  children: (close: () => void) => ReactNode;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  /** Fixed position of the open popover, from the button's rect. */
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
  } | null>(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const inside = (t: EventTarget | null) =>
      t instanceof Node &&
      (popRef.current?.contains(t) || btnRef.current?.contains(t));
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
      btnRef.current?.focus();
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) close();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  function toggle() {
    if (pos) {
      setPos(null);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const right = Math.max(4, window.innerWidth - r.right);
    const below = window.innerHeight - r.bottom;
    setPos(
      below < MENU_EST_H && r.top > below
        ? { bottom: window.innerHeight - r.top + 2, right }
        : { top: r.bottom + 2, right },
    );
  }

  return (
    <span
      className="arr-menu"
      data-open={pos ? "" : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={btnRef}
        type="button"
        className={pos ? `${buttonClassName} arr-menu-btn-open` : buttonClassName}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={pos != null}
        onClick={toggle}
      >
        {label}
      </button>
      {pos && (
        <div
          ref={popRef}
          className="arr-menu-pop"
          role="menu"
          style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}
        >
          {children(() => setPos(null))}
        </div>
      )}
    </span>
  );
}
