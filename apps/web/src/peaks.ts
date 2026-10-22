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
  // One column per bin or per pixel, whichever is fewer: zoomed-in clips can
  // be hundreds of thousands of px wide but only have a few hundred bins.
  const span = endBin - startBin;
  const cols = Math.max(1, Math.min(Math.ceil(width), span));
  const colW = width / cols;
  const amps = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const b0 = startBin + Math.floor((c * span) / cols);
    const b1 = Math.max(b0 + 1, startBin + Math.floor(((c + 1) * span) / cols));
    let peak = 0;
    for (let i = b0; i < b1 && i < peaks.length; i++) {
      peak = Math.max(peak, peaks[i]!);
    }
    amps[c] = peak * (height * 0.42);
  }

  // Filled envelope: top edge left→right, bottom edge back.
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.beginPath();
  ctx.moveTo(0, mid - amps[0]!);
  for (let c = 0; c < cols; c++) {
    ctx.lineTo((c + 0.5) * colW, mid - amps[c]!);
  }
  ctx.lineTo(width, mid - amps[cols - 1]!);
  ctx.lineTo(width, mid + amps[cols - 1]!);
  for (let c = cols - 1; c >= 0; c--) {
    ctx.lineTo((c + 0.5) * colW, mid + amps[c]!);
  }
  ctx.lineTo(0, mid + amps[0]!);
  ctx.closePath();
  ctx.fill();
}
