import { useEffect, useRef } from "react";
import { drawClipWaveform, type PeaksRecord } from "./peaks";

/**
 * A whole track's waveform, filling its box (sized by CSS). Redraws when the
 * box resizes.
 */
export function PeaksCanvas({
  rec,
  color,
  className,
}: {
  rec: PeaksRecord;
  color: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW < 1 || cssH < 1) return;
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.floor(cssW * scale);
      const h = Math.floor(cssH * scale);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      drawClipWaveform(
        ctx,
        rec.peaks,
        rec.durationSec,
        0,
        rec.durationSec,
        cssW,
        cssH,
        color,
      );
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [rec, color]);

  return <canvas ref={canvasRef} className={className} aria-hidden />;
}
