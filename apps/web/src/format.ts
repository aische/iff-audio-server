/** Display-formatting helpers shared across pool and arrange views. */

export function formatDuration(seconds: number | null): string {
  if (seconds == null || seconds < 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  const mm = String(m);
  const padded = mm.length < 2 ? `\u00a0${mm}` : mm;
  return `${padded}:${String(s).padStart(2, "0")}`;
}

/** Clock display for arrangement transport — floors to integer, never null. */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** Strip `.aif.mp3` or `.mp3` suffix to get a readable track title. */
export function shortTitle(filename: string): string {
  return filename.replace(/\.aif\.mp3$/i, "").replace(/\.mp3$/i, "");
}
