import { useEffect, useEffectEvent } from "react";

/** Input types that take no typed text, so library keys still apply. */
const NON_TEXT_INPUTS = new Set([
  "checkbox",
  "radio",
  "range",
  "button",
  "submit",
  "reset",
  "color",
  "file",
]);

/** A field the user types into: library keys must leave it alone. */
function isTextEntry(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type))
  );
}

function closestElement(target: EventTarget | null, selector: string) {
  return target instanceof Element ? target.closest(selector) : null;
}

export type LibraryKeyActions = {
  /** j / k: move focus one row down (1) or up (-1) in the visible list. */
  moveFocus: (delta: 1 | -1) => void;
  /** enter / p: play the focused track. The only key that changes it. */
  playFocused: () => void;
  /** space: pause or resume what is playing; never changes the track. */
  togglePause: () => void;
  /** c: open the comment field on the focused row. */
  commentFocused: () => void;
  /** ?: show or hide the key map. */
  toggleKeyMap: () => void;
  /** esc outside a field: close the key map; false if nothing to close. */
  escape: () => boolean;
};

/**
 * Library keys in pool mode (better-ux.md §3). Ignored while typing in a
 * field and with ctrl / meta / alt held. Esc in a row's comment field is
 * handled by the row itself.
 */
export function useLibraryShortcuts(
  active: boolean,
  actions: LibraryKeyActions,
) {
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (!active || e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTextEntry(e.target)) return;

    switch (e.key) {
      case "j":
      case "k":
        // Holding j / k keeps moving.
        e.preventDefault();
        actions.moveFocus(e.key === "j" ? 1 : -1);
        return;
      case " ":
        // A checkbox keeps Space for itself. Buttons do not: after clicking
        // a row's ▶, Space would otherwise hit its ■ and stop the track.
        // Buttons still respond to Enter.
        if (closestElement(e.target, "input[type='checkbox'], input[type='radio']")) {
          return;
        }
        e.preventDefault();
        if (!e.repeat) actions.togglePause();
        return;
      case "Enter":
        // Enter on a focused control keeps its own meaning; `p` always plays.
        if (
          closestElement(e.target, "button, a[href], input, [role='button']")
        ) {
          return;
        }
        e.preventDefault();
        if (!e.repeat) actions.playFocused();
        return;
      case "p":
        e.preventDefault();
        if (!e.repeat) actions.playFocused();
        return;
      case "c":
        // preventDefault keeps the "c" out of the field it opens.
        e.preventDefault();
        if (!e.repeat) actions.commentFocused();
        return;
      case "?":
        e.preventDefault();
        if (!e.repeat) actions.toggleKeyMap();
        return;
      case "Escape":
        if (actions.escape()) e.preventDefault();
        return;
    }
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
