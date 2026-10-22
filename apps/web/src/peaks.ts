import { api } from "./api";

export type PeaksRecord = {
  peaks: Float32Array;
  durationSec: number;
};

const memory = new Map<string, PeaksRecord>();
const inflight = new Map<string, Promise<PeaksRecord>>();

/**
 * Load overview peaks for a track (memory → server). Peaks are computed by
 * library sync; rejects if they are not ready yet (caller draws a flat line).
 */
export function loadPeaks(trackId: string): Promise<PeaksRecord> {
  const hit = memory.get(trackId);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(trackId);
  if (pending) return pending;

  const task = (async () => {
    const res = await api.getTrackPeaks(trackId);
    const rec: PeaksRecord = {
      peaks: Float32Array.from(res.peaks),
      durationSec: res.durationSec,
    };
    memory.set(trackId, rec);
    return rec;
  })();

  inflight.set(trackId, task);
  return task.finally(() => {
    inflight.delete(trackId);
  });
}

export function getCachedPeaks(trackId: string): PeaksRecord | undefined {
  return memory.get(trackId);
}

/** Draw the clip's slice of peaks into a canvas (CSS pixel coords). */
export function drawClipWaveform(
  ctx: CanvasRenderingContext2D,
  peaks: Float32Array,
  sourceDurationSec: number,
  offsetSec: number,
  durationSec: number,
  width: number,
  height: number,
) {
  ctx.clearRect(0, 0, width, height);
  const mid = height / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1;

  if (
    !peaks.length ||
    width < 2 ||
    sourceDurationSec <= 0 ||
    durationSec <= 0
  ) {
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();
    return;
  }

  const startBin = Math.floor((offsetSec / sourceDurationSec) * peaks.length);
  const endBin = Math.max(
    startBin + 1,
    Math.ceil(((offsetSec + durationSec) / sourceDurationSec) * peaks.length),
  );
  const span = endBin - startBin;
  const step = span / width;

  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    const i = Math.min(peaks.length - 1, startBin + Math.floor(x * step));
    const amp = peaks[i]! * (height * 0.42);
    ctx.moveTo(x + 0.5, mid - amp);
    ctx.lineTo(x + 0.5, mid + amp);
  }
  ctx.stroke();
}
