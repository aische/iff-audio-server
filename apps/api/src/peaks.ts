import { spawn } from "node:child_process";

/** Overview resolution; matches what the web client draws. */
export const PEAK_BINS = 800;

const SAMPLE_RATE = 44100;
/** Intermediate 10 ms chunks keep memory flat regardless of file length. */
const CHUNK_SAMPLES = SAMPLE_RATE / 100;

export type ComputedPeaks = {
  peaks: number[];
  /** Exact decoded duration (fractional seconds). */
  durationSec: number;
};

/** Resolves true when an `ffmpeg` binary is runnable. */
export function hasFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Decode `filePath` to mono f32 PCM with ffmpeg and reduce to PEAK_BINS
 * max-abs values. Duration is derived from the decoded sample count.
 */
export function computePeaks(filePath: string): Promise<ComputedPeaks> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-v", "error",
        "-nostdin",
        "-i", filePath,
        "-vn",
        "-ac", "1",
        "-ar", String(SAMPLE_RATE),
        "-f", "f32le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const chunkPeaks: number[] = [];
    let chunkPeak = 0;
    let chunkFill = 0;
    let totalSamples = 0;
    // Bytes left over when a stream chunk splits a 4-byte float.
    let carry: Buffer = Buffer.alloc(0);
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, data]) : data;
      const whole = buf.length - (buf.length % 4);
      for (let off = 0; off < whole; off += 4) {
        const a = Math.abs(buf.readFloatLE(off));
        if (a > chunkPeak) chunkPeak = a;
        if (++chunkFill === CHUNK_SAMPLES) {
          chunkPeaks.push(chunkPeak);
          chunkPeak = 0;
          chunkFill = 0;
        }
      }
      totalSamples += whole / 4;
      carry = buf.subarray(whole);
    });

    proc.stderr.on("data", (data: Buffer) => {
      if (stderr.length < 4000) stderr += data.toString();
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`ffmpeg exited with ${code}: ${stderr.trim() || "no output"}`),
        );
        return;
      }
      if (chunkFill > 0) chunkPeaks.push(chunkPeak);
      if (totalSamples === 0) {
        reject(new Error("ffmpeg decoded no audio"));
        return;
      }

      const n = chunkPeaks.length;
      const peaks = new Array<number>(PEAK_BINS);
      for (let i = 0; i < PEAK_BINS; i++) {
        const start = Math.floor((i * n) / PEAK_BINS);
        const end = Math.max(start + 1, Math.floor(((i + 1) * n) / PEAK_BINS));
        let peak = 0;
        for (let j = start; j < end && j < n; j++) {
          if (chunkPeaks[j]! > peak) peak = chunkPeaks[j]!;
        }
        peaks[i] = Math.min(1, peak);
      }

      resolve({ peaks, durationSec: totalSamples / SAMPLE_RATE });
    });
  });
}
