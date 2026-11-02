import { formatClock } from "../format";

export function formatPxPerSec(n: number) {
  if (n >= 10) return n.toFixed(0);
  if (n >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

/** Short pause cue: "2s", "0.5s", or a clock for a minute and up. */
export function formatPause(sec: number) {
  if (sec >= 60) return formatClock(sec);
  return `${Number(sec.toFixed(1))}s`;
}

/** Clock with tenths, for trim points: "1:05.3". */
export function formatClockTenths(sec: number) {
  const t = Math.max(0, Math.round(sec * 10) / 10);
  const whole = Math.floor(t);
  return `${formatClock(whole)}.${Math.round((t - whole) * 10)}`;
}
