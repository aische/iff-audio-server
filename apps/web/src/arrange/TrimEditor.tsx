import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { ArrangementClip } from "../api";
import { ClipWaveform } from "./ClipWaveform";
import { useLatestRef, usePlayhead, type PlayheadStore } from "./playhead";
import { clipDuration, MIN_CLIP_SEC, type ClipPatch } from "./timeline";
import { EDITOR_WAVE_H } from "./waveScale";

/** A press on the trim selection that moves less than this is a click (seek). */
const CLICK_SLOP_PX = 4;

/** The arrangement playhead as the trim view needs it (selected clip only). */
export type TrimHead = {
  store: PlayheadStore;
  /** The selected clip's audio in arrangement time. */
  arrStart: number;
  arrEnd: number;
  /** Keep the playhead in view (while playing). */
  follow: boolean;
};

export function TrimEditor({
  clip,
  isOwner,
  peaksVersion,
  srcDur,
  pxPerSec,
  head,
  onSeek,
  onChange,
}: {
  clip: ArrangementClip;
  isOwner: boolean;
  peaksVersion: number;
  srcDur: number;
  pxPerSec: number;
  head: TrimHead | null;
  onSeek: (srcSec: number) => void;
  onChange: (patch: ClipPatch) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const clipRef = useLatestRef(clip);
  const dragRef = useRef<{
    kind: "in" | "out" | "range";
    grabOffset: number;
    fixedLen?: number;
  } | null>(null);

  const widthPx = Math.max(320, srcDur * pxPerSec);
  const inX = Math.round(clip.inSec * pxPerSec);
  const outX = Math.round(clip.outSec * pxPerSec);
  const selW = Math.max(4, outX - inX);

  /** X in canvas content coordinates (matches selection `left` / waveform). */
  function pointerCanvasX(clientX: number) {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return clientX - rect.left - canvas.clientLeft;
  }

  /**
   * Handles drag the in / out point. A press on the selection seeks there
   * on release, unless it moves past CLICK_SLOP_PX: then (for the owner)
   * it drags the whole selection.
   */
  function onPointerDown(
    e: ReactPointerEvent,
    kind: "in" | "out" | "range",
  ) {
    if (e.button !== 0) return;
    if (!isOwner && kind !== "range") return;
    e.preventDefault();
    e.stopPropagation();
    const current = clipRef.current;
    if (!current) return;
    if (!canvasRef.current) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const startClientX = e.clientX;
    const x = pointerCanvasX(e.clientX);
    const at = x / pxPerSec;
    let dragging = kind !== "range";

    if (kind === "range") {
      dragRef.current = {
        kind: "range",
        grabOffset: at - current.inSec,
        fixedLen: current.outSec - current.inSec,
      };
    } else if (kind === "in") {
      dragRef.current = { kind: "in", grabOffset: at - current.inSec };
    } else {
      dragRef.current = { kind: "out", grabOffset: at - current.outSec };
    }

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (!isOwner) return;
        if (Math.abs(ev.clientX - startClientX) < CLICK_SLOP_PX) return;
        dragging = true;
      }
      const d = dragRef.current;
      const c = clipRef.current;
      if (!d || !c) return;
      const atMove = pointerCanvasX(ev.clientX) / pxPerSec;

      if (d.kind === "in") {
        const next = atMove - d.grabOffset;
        onChange({
          inSec: Math.max(0, Math.min(next, c.outSec - MIN_CLIP_SEC)),
        });
      } else if (d.kind === "out") {
        const next = atMove - d.grabOffset;
        onChange({
          outSec: Math.max(c.inSec + MIN_CLIP_SEC, Math.min(next, srcDur)),
        });
      } else if (d.kind === "range" && d.fixedLen != null) {
        let nextIn = atMove - d.grabOffset;
        nextIn = Math.max(0, Math.min(nextIn, srcDur - d.fixedLen));
        onChange({ inSec: nextIn, outSec: nextIn + d.fixedLen });
      }
    };

    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      dragRef.current = null;
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      if (!dragging && ev.type === "pointerup") onSeek(at);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  return (
    <div className="arr-trim">
      <div className="arr-trim-scroll" ref={scrollRef}>
        <div
          className="arr-trim-canvas"
          ref={canvasRef}
          style={{ width: widthPx }}
        >
          <ClipWaveform
            trackId={clip.trackId}
            offsetSec={clip.inSec}
            durationSec={clipDuration(clip)}
            width={widthPx}
            height={EDITOR_WAVE_H}
            peaksVersion={peaksVersion}
            sourceDurHint={srcDur}
          />
          <div
            className={
              isOwner
                ? "arr-trim-selection"
                : "arr-trim-selection arr-trim-selection-ro"
            }
            style={{ left: inX, width: selW, height: EDITOR_WAVE_H }}
            title={
              isOwner
                ? "Click to move the playhead here · drag to move the selection"
                : "Click to move the playhead here"
            }
            onPointerDown={(e) => onPointerDown(e, "range")}
          >
            {isOwner && (
              <>
                <div
                  className="arr-trim-handle left"
                  onPointerDown={(e) => onPointerDown(e, "in")}
                />
                <div
                  className="arr-trim-handle right"
                  onPointerDown={(e) => onPointerDown(e, "out")}
                />
              </>
            )}
          </div>
          {head && (
            <TrimPlayhead
              head={head}
              inSec={clip.inSec}
              pxPerSec={pxPerSec}
              scrollRef={scrollRef}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** The arrangement playhead, drawn while it is inside the selected clip. */
function TrimPlayhead({
  head,
  inSec,
  pxPerSec,
  scrollRef,
}: {
  head: TrimHead;
  inSec: number;
  pxPerSec: number;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { store, arrStart, arrEnd, follow } = head;
  const x = usePlayhead(store, (sec) =>
    sec >= arrStart && sec <= arrEnd
      ? Math.round((inSec + (sec - arrStart)) * pxPerSec)
      : null,
  );

  useEffect(() => {
    const sc = scrollRef.current;
    const el = ref.current;
    if (!follow || !sc || !el) return;
    const sr = sc.getBoundingClientRect();
    const left = el.getBoundingClientRect().left - sr.left;
    if (left < 0 || left > sc.clientWidth - 16) {
      sc.scrollLeft += left - sc.clientWidth * 0.2;
    }
  }, [x, follow, scrollRef]);

  if (x == null) return null;
  return <div ref={ref} className="arr-trim-playhead" style={{ left: x }} />;
}
