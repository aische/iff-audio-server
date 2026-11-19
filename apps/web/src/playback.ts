import { createContext, useContext, useSyncExternalStore } from "react";
import type { Track } from "./api";

/**
 * Library playback: the one track in the speakers from the pool. Owned by
 * PlaybackProvider, independent of the list query, focus and hover (see
 * .notes/better-ux.md). Arrangement playback has its own engine
 * (arrangePlayback.ts).
 */
export type LibraryPlayback = {
  /** Track loaded for playback (playing, paused or ended), or null. */
  track: Track | null;
  isPlaying: boolean;
  /** Length reported by the audio element, once known (seconds). */
  duration: number | null;
  /** Load a track and start playing it. */
  play: (track: Track) => void;
  /** Pause or resume the loaded track; never changes which track. */
  togglePause: () => void;
  seek: (seconds: number) => void;
  /** Stop and unload. */
  stop: () => void;
  /**
   * Playback position in seconds, read on demand. Time is deliberately not
   * React state: it changes ~4×/s and would re-render every consumer.
   */
  getTime: () => number;
  /** Called on each position change; returns an unsubscribe function. */
  subscribeTime: (listener: () => void) => () => void;
};

export const PlaybackContext = createContext<LibraryPlayback | null>(null);

export function usePlayback(): LibraryPlayback {
  const playback = useContext(PlaybackContext);
  if (!playback) throw new Error("usePlayback outside PlaybackProvider");
  return playback;
}

/** Position in whole seconds; re-renders the caller about once a second. */
export function usePlaybackSeconds(): number {
  const { subscribeTime, getTime } = usePlayback();
  return useSyncExternalStore(subscribeTime, () => Math.floor(getTime()));
}
