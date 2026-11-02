import { useEffect, useRef, useState } from "react";
import {
  drawClipWaveform,
  getCachedPeaks,
  loadPeaks,
  type PeaksRecord,
} from "../peaks";
import { MIN_CLIP_SEC } from "./timeline";
import { MAX_CANVAS_BACKING_PX } from "./waveScale";

/** The clip's full source waveform, with everything outside the clip dimmed. */
export function ClipWaveform({
  trackId,
  offsetSec,
  durationSec,
  width,
  height,
  peaksVersion,
  sourceDurHint,
}: {
  trackId: string;
  offsetSec: number;
  durationSec: number;
  width: number;
  height: number;
  peaksVersion: number;
  sourceDurHint?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState<{
    trackId: string;
    rec: PeaksRecord | null;
  } | null>(null);
  const rec =
    getCachedPeaks(trackId) ??
    (loaded?.trackId === trackId ? loaded.rec : null);

  useEffect(() => {
    if (getCachedPeaks(trackId)) return;
    let cancelled = false;
    void loadPeaks(trackId)
      .then((r) => {
        if (!cancelled) setLoaded({ trackId, rec: r });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ trackId, rec: null });
      });
    return () => {
      cancelled = true;
    };
  }, [trackId, peaksVersion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width < 1 || height < 1) return;
    const cssW = Math.max(1, width);
    const cssH = Math.max(1, height);
    let scale = Math.min(window.devicePixelRatio || 1, 2);
    if (cssW * scale > MAX_CANVAS_BACKING_PX) {
      scale = MAX_CANVAS_BACKING_PX / cssW;
    }
    const w = Math.max(1, Math.floor(cssW * scale));
    const h = Math.max(1, Math.floor(cssH * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    const srcDur =
      sourceDurHint != null && sourceDurHint > 0
        ? sourceDurHint
        : rec && rec.durationSec > 0
          ? rec.durationSec
          : Math.max(offsetSec + durationSec, MIN_CLIP_SEC);

    if (!rec) {
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.moveTo(0, cssH / 2);
      ctx.lineTo(cssW, cssH / 2);
      ctx.stroke();
      return;
    }

    // Full source, with everything outside [offset, offset + duration] dimmed.
    drawClipWaveform(ctx, rec.peaks, srcDur, 0, srcDur, cssW, cssH);
    const x0 = (offsetSec / srcDur) * cssW;
    const x1 = ((offsetSec + durationSec) / srcDur) * cssW;
    ctx.fillStyle = "rgba(26, 25, 23, 0.55)";
    ctx.fillRect(0, 0, Math.max(0, x0), cssH);
    ctx.fillRect(Math.min(cssW, x1), 0, Math.max(0, cssW - x1), cssH);
    ctx.fillStyle = "rgba(212, 160, 23, 0.14)";
    ctx.fillRect(x0, 0, Math.max(0, x1 - x0), cssH);
  }, [rec, offsetSec, durationSec, width, height, peaksVersion, sourceDurHint]);

  return <canvas ref={canvasRef} className="arr-clip-wave" aria-hidden />;
}
