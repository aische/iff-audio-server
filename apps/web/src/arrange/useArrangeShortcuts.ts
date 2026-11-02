import { useEffect, useEffectEvent, type RefObject } from "react";

/**
 * Whether a keydown should drive arrangement shortcuts: focus must be on the
 * page itself or inside the editor (not the library or transport), and not
 * in a text field.
 */
function isShortcutTarget(
  target: EventTarget | null,
  panel: HTMLElement | null,
) {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return false;
  }
  return target === document.body || (panel?.contains(target) ?? false);
}

/** Space plays / stops; Backspace / Delete runs `onDelete` when given. */
export function useArrangeShortcuts(
  panelRef: RefObject<HTMLElement | null>,
  {
    active,
    onTogglePlay,
    onDelete,
  }: {
    /** False while the panel is hidden. */
    active: boolean;
    onTogglePlay: () => void;
    onDelete: (() => void) | null;
  },
) {
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (!active || e.defaultPrevented) return;
    if (!isShortcutTarget(e.target, panelRef.current)) return;
    if (e.key === " " || e.code === "Space") {
      // A focused button already handles Space itself.
      if (
        e.target instanceof Element &&
        e.target.closest("button, a[href], [role='button']")
      ) {
        return;
      }
      e.preventDefault();
      onTogglePlay();
    }
    if ((e.key === "Backspace" || e.key === "Delete") && onDelete) {
      e.preventDefault();
      onDelete();
    }
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
