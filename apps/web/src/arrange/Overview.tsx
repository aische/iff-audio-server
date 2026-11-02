import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { Track } from "../api";
import { formatClock, shortTitle } from "../format";
import { formatPause } from "./format";
import { usePlayhead, type PlayheadStore } from "./playhead";
import { segAt, type ScheduleSeg } from "./timeline";

/** The whole arrangement as one strip: seek, select, playhead. */
export function Overview({
  segs,
  totalSec,
  trackById,
  indexById,
  selectedId,
  headClipId,
  playing,
  zoom,
  store,
  onSeek,
  onSelect,
}: {
  segs: ScheduleSeg[];
  totalSec: number;
  trackById: Map<string, Track>;
  indexById: Map<string, number>;
  selectedId: string | null;
  headClipId: string | null;
  playing: boolean;
  zoom: number;
  store: PlayheadStore;
  onSeek: (sec: number) => void;
  onSelect: (instanceId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  /** Pointer position while scrubbing during playback; seeks on release. */
  const [scrub, setScrub] = useState<number | null>(null);
  const empty = segs.length === 0;
  const pct = (sec: number) => `${(sec / totalSec) * 100}%`;

  function secAt(clientX: number) {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const frac = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return Math.max(0, Math.min(totalSec, frac * totalSec));
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (empty || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    // While playing, every seek reloads audio: preview the drag, seek once.
    const deferred = playing;
    let at = secAt(e.clientX);
    const seg = segAt(segs, at);
    if (seg) onSelect(seg.clip.instanceId);
    if (deferred) setScrub(at);
    else onSeek(at);

    const onMove = (ev: PointerEvent) => {
      at = secAt(ev.clientX);
      if (deferred) setScrub(at);
      else onSeek(at);
    };
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      if (deferred) {
        setScrub(null);
        if (ev.type === "pointerup") onSeek(at);
      }
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  return (
    <div className="arr-overview">
      <div className="arr-overview-scroll" ref={scrollRef}>
        <div
          ref={trackRef}
          className="arr-overview-track"
          style={{ width: `${zoom * 100}%` }}
          onPointerDown={onPointerDown}
          title={empty ? undefined : "Click or drag to seek"}
        >
          {empty && (
            <span className="arr-overview-empty">nothing to play</span>
          )}
          {segs.map((s) => {
            const id = s.clip.instanceId;
            const style = {
              left: pct(s.arrStart),
              width: pct(s.arrEnd - s.arrStart),
            };
            if (s.kind === "pause") {
              return (
                <div
                  key={`${id}-pause`}
                  className="arr-ov-pause"
                  style={style}
                  title={`pause ${formatPause(s.arrEnd - s.arrStart)}`}
                />
              );
            }
            const track = trackById.get(s.clip.trackId);
            const index = indexById.get(id) ?? 0;
            return (
              <div
                key={id}
                className={[
                  "arr-ov-clip",
                  id === selectedId ? "arr-ov-selected" : "",
                  playing && id === headClipId ? "arr-ov-playing" : "",
                  track?.releasedOn ? "arr-ov-released" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={style}
                title={`${index + 1}. ${track ? shortTitle(track.filename) : "?"} · ${formatClock(s.arrEnd - s.arrStart)}`}
              >
                <span className="arr-ov-label">{index + 1}</span>
              </div>
            );
          })}
          {!empty && (
            <OverviewPlayhead
              store={store}
              totalSec={totalSec}
              scrollRef={scrollRef}
              follow={playing && zoom > 1}
            />
          )}
          {scrub != null && (
            <div className="arr-ov-scrub" style={{ left: pct(scrub) }} />
          )}
        </div>
      </div>
    </div>
  );
}

function OverviewPlayhead({
  store,
  totalSec,
  scrollRef,
  follow,
}: {
  store: PlayheadStore;
  totalSec: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Keep the playhead inside the scrolled (zoomed) strip. */
  follow: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const frac = usePlayhead(
    store,
    (sec) => Math.round(Math.min(1, sec / totalSec) * 4000) / 4000,
  );

  useEffect(() => {
    const sc = scrollRef.current;
    const el = ref.current;
    if (!follow || !sc || !el) return;
    const x = el.offsetLeft;
    if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 16) {
      sc.scrollLeft = x - sc.clientWidth * 0.2;
    }
  }, [frac, follow, scrollRef]);

  return (
    <div ref={ref} className="arr-ov-playhead" style={{ left: `${frac * 100}%` }} />
  );
}
