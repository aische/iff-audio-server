import {
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { unifiedTags, type Track } from "./api";
import { shortTitle } from "./format";

// --- localStorage keys ---

export const SHOW_OTHERS_KEY = "iff-show-other-comments";
export const HIDE_RELEASED_KEY = "iff-hide-released";
export const SORT_KEY = "iff-pool-sort";
export const TITLE_W_KEY = "iff-title-width";
export const COMMENT_W_KEY = "iff-comment-width";
export const SPLIT_W_KEY = "iff-split-width";
export const MODE_KEY = "iff-app-mode";

// --- Column width defaults & bounds ---

export const TITLE_W_DEFAULT = 210;
export const TITLE_W_MIN = 80;
export const TITLE_W_MAX = 480;

export const COMMENT_W_DEFAULT = 300;
export const COMMENT_W_MIN = 120;
export const COMMENT_W_MAX = 900;

export const SPLIT_W_DEFAULT = 420;
export const SPLIT_W_MIN = 280;
export const SPLIT_W_MAX = 900;

// --- Types ---

export type FilterId = "all" | "commented";
export type SortKey = "name" | "duration";
export type SortDir = "asc" | "desc";
export type PoolSort = { key: SortKey; dir: SortDir };
export type AppMode = "pool" | "arrange";

// --- Defaults ---

export const SORT_DEFAULT: PoolSort = { key: "name", dir: "asc" };

// --- Width persistence ---

export function readStoredWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  } catch {
    return fallback;
  }
}

export function usePersistedWidth(
  key: string,
  initial: number,
  min: number,
  max: number,
) {
  const [width, setWidth] = useState(() =>
    readStoredWidth(key, initial, min, max),
  );

  useEffect(() => {
    try {
      localStorage.setItem(key, String(width));
    } catch {
      // ignore
    }
  }, [key, width]);

  function onResizePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      setWidth(
        Math.min(
          max,
          Math.max(min, Math.round(startW + (ev.clientX - startX))),
        ),
      );
    };
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  function reset() {
    setWidth(initial);
  }

  return { width, onResizePointerDown, reset };
}

// --- Boolean / enum readers ---

export function readHideReleased(): boolean {
  try {
    return localStorage.getItem(HIDE_RELEASED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function readShowOthers(): boolean {
  try {
    return localStorage.getItem(SHOW_OTHERS_KEY) === "1";
  } catch {
    return false;
  }
}

export function readSort(): PoolSort {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (!raw) return SORT_DEFAULT;
    const v = JSON.parse(raw) as Partial<PoolSort>;
    if (
      (v.key === "name" || v.key === "duration") &&
      (v.dir === "asc" || v.dir === "desc")
    ) {
      return { key: v.key, dir: v.dir };
    }
    return SORT_DEFAULT;
  } catch {
    return SORT_DEFAULT;
  }
}

export function readMode(): AppMode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    return raw === "arrange" ? "arrange" : "pool";
  } catch {
    return "pool";
  }
}

function persistBool(key: string, value: boolean, on: string, off: string) {
  try {
    localStorage.setItem(key, value ? on : off);
  } catch {
    // ignore
  }
}

export function persistShowOthers(value: boolean) {
  persistBool(SHOW_OTHERS_KEY, value, "1", "0");
}

export function persistHideReleased(value: boolean) {
  persistBool(HIDE_RELEASED_KEY, value, "1", "0");
}

export function persistSort(sort: PoolSort) {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(sort));
  } catch {
    // ignore
  }
}

export function persistMode(mode: AppMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore
  }
}

// --- Sorting & filtering ---

/** Sort by display title or duration; missing durations sort last. */
export function sortTracks(list: Track[], sort: PoolSort): Track[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const byName = (a: Track, b: Track) =>
    shortTitle(a.filename).localeCompare(shortTitle(b.filename), undefined, {
      sensitivity: "base",
      numeric: true,
    });
  return [...list].sort((a, b) => {
    if (sort.key === "duration") {
      const da = a.durationSeconds;
      const db = b.durationSeconds;
      if (da == null || db == null) {
        if (da == null && db == null) return byName(a, b);
        return da == null ? 1 : -1;
      }
      return (da - db) * sign || byName(a, b);
    }
    return byName(a, b) * sign;
  });
}

/**
 * Filter tracks by release state, comment presence and tag.
 * The `present` field is NOT checked here — pool callers typically want all
 * tracks, while arrange callers can pre-filter on `present` themselves.
 */
export function filterTracks({
  tracks,
  hideReleased,
  filter,
  tagFilter,
}: {
  tracks: Track[];
  hideReleased: boolean;
  filter: FilterId;
  tagFilter: string | null;
}): Track[] {
  return tracks.filter((t) => {
    if (hideReleased && t.releasedOn) return false;
    if (filter === "commented" && t.comments.length === 0) return false;
    if (tagFilter) {
      const tags = unifiedTags(t.comments.map((c) => c.body));
      if (!tags.includes(tagFilter)) return false;
    }
    return true;
  });
}
