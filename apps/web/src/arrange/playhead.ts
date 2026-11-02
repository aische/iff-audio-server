import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

/**
 * Playhead time kept outside React state: the transport updates it every
 * frame, and only the small components that display it re-render.
 */
export type PlayheadStore = {
  get: () => number;
  set: (sec: number) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createPlayheadStore(): PlayheadStore {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(sec) {
      if (sec === value) return;
      value = sec;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Re-renders only when `select(playhead)` changes. */
export function usePlayhead<T>(
  store: PlayheadStore,
  select: (sec: number) => T,
): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

/** Ref to the latest committed value, for rAF loops, listeners and handlers. */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
