import type { PlaybackMode } from "../arrangePlayback";

const PLAYBACK_MODE_KEY = "iff-arrange-playback";
const INSPECTOR_OPEN_KEY = "iff-arrange-inspector-open";
const INSPECTOR_VIEW_KEY = "iff-arrange-inspector-view";

/** What the inspector shows below its bar. */
export type InspectorView = "wave" | "comments";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function readInspectorView(): InspectorView {
  return readStored(INSPECTOR_VIEW_KEY) === "comments" ? "comments" : "wave";
}

export function persistInspectorView(view: InspectorView) {
  writeStored(INSPECTOR_VIEW_KEY, view);
}

export function readInspectorOpen(): boolean {
  return readStored(INSPECTOR_OPEN_KEY) !== "0";
}

export function persistInspectorOpen(open: boolean) {
  writeStored(INSPECTOR_OPEN_KEY, open ? "1" : "0");
}

export function readPlaybackMode(): PlaybackMode {
  return readStored(PLAYBACK_MODE_KEY) === "precise" ? "precise" : "stream";
}

export function persistPlaybackMode(mode: PlaybackMode) {
  writeStored(PLAYBACK_MODE_KEY, mode);
}
