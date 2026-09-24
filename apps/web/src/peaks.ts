import { trackStreamUrl } from "./api";

const PEAK_BINS = 800;
const DB_NAME = "iff-peaks-v1";
const STORE = "peaks";

export type PeaksRecord = {
  peaks: Float32Array;
  durationSec: number;
};

type StoredPeaks = {
  peaks: number[];
  durationSec: number;
};

const memory = new Map<string, PeaksRecord>();
const inflight = new Map<string, Promise<PeaksRecord>>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(trackId: string): Promise<PeaksRecord | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(trackId);
      req.onsuccess = () => {
        const v = req.result as StoredPeaks | Float32Array | number[] | null;
        if (!v) {
          resolve(null);
          return;
        }
        // Legacy: bare Float32Array / number[] from early experiments
        if (v instanceof Float32Array) {
          resolve({ peaks: v, durationSec: 0 });
          return;
        }
        if (Array.isArray(v)) {
          resolve({ peaks: Float32Array.from(v), durationSec: 0 });
          return;
        }
        if (v && Array.isArray(v.peaks) && typeof v.durationSec === "number") {
          resolve({
            peaks: Float32Array.from(v.peaks),
            durationSec: v.durationSec,
          });
          return;
        }
        resolve(null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbPut(trackId: string, rec: PeaksRecord): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(
        {
          peaks: Array.from(rec.peaks),
          durationSec: rec.durationSec,
        } satisfies StoredPeaks,
        trackId,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore quota / private mode
  }
}

function downsample(buffer: AudioBuffer, bins: number): Float32Array {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const out = new Float32Array(bins);
  const block = Math.max(1, Math.floor(length / bins));
  for (let i = 0; i < bins; i++) {
    const start = i * block;
    const end = Math.min(length, start + block);
    let peak = 0;
    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let s = start; s < end; s++) {
        const a = Math.abs(data[s]);
        if (a > peak) peak = a;
      }
    }
    out[i] = peak;
  }
  return out;
}

/** Load overview peaks for a track (memory → IndexedDB → decode). */
export function loadPeaks(trackId: string): Promise<PeaksRecord> {
  const hit = memory.get(trackId);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(trackId);
  if (pending) return pending;

  const task = (async () => {
    const cached = await idbGet(trackId);
    if (cached && cached.peaks.length > 0 && cached.durationSec > 0) {
      memory.set(trackId, cached);
      return cached;
    }

    const res = await fetch(trackStreamUrl(trackId), { credentials: "include" });
    if (!res.ok) {
      throw new Error(`Failed to fetch audio for peaks (${res.status})`);
    }
    const arrayBuffer = await res.arrayBuffer();
    const ctx = new AudioContext();
    try {
      const audio = await ctx.decodeAudioData(arrayBuffer.slice(0));
      const rec: PeaksRecord = {
        peaks: downsample(audio, PEAK_BINS),
        durationSec: audio.duration,
      };
      memory.set(trackId, rec);
      void idbPut(trackId, rec);
      return rec;
    } finally {
      await ctx.close();
    }
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

  if (!peaks.length || width < 2 || sourceDurationSec <= 0 || durationSec <= 0) {
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
