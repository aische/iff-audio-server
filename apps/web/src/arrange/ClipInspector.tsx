import { useLayoutEffect, useRef, useState } from "react";
import type { ArrangementClip, Track } from "../api";
import { formatClock, shortTitle } from "../format";
import { CommentsPanel } from "./CommentsPanel";
import { formatClockTenths, formatPause, formatPxPerSec } from "./format";
import {
  persistInspectorView,
  readInspectorView,
  type InspectorView,
} from "./storage";
import { clipDuration, MIN_CLIP_SEC, type ClipPatch } from "./timeline";
import { TrimEditor, type TrimHead } from "./TrimEditor";
import { PX_PER_SEC_MIN, trimScale } from "./waveScale";

/** Inspector height in the comments view before the wave view was measured. */
const DEFAULT_INSPECTOR_H = 176;

/** Content width of the trim waveform's scroll area (inside its padding). */
function trimViewWidth(section: HTMLElement | null): number | null {
  const sc = section?.querySelector<HTMLElement>(".arr-trim-scroll");
  if (!sc) return null;
  const cs = getComputedStyle(sc);
  const w =
    sc.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  // A pixel of slack so rounding never brings back the horizontal scrollbar.
  return w > 1 ? w - 1 : null;
}

/**
 * The selected clip: every control in one toolbar, with the trim waveform
 * or the track's comments below (wave / comments toggle).
 */
export function ClipInspector({
  clip,
  index,
  track,
  isOwner,
  open,
  onOpenChange,
  skipped,
  soloing,
  head,
  onSeek,
  onPlay,
  onPlayFromStart,
  onToggleSkip,
  onChange,
  peaksVersion,
  editorPxPerSec,
  onZoom,
}: {
  clip: ArrangementClip | null;
  index: number;
  track: Track | null;
  isOwner: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skipped: boolean;
  soloing: boolean;
  head: TrimHead | null;
  /** Move the playhead to this source time of the clip. */
  onSeek: (srcSec: number) => void;
  onPlay: () => void;
  /** Audition from the in point, restarting if already auditioning. */
  onPlayFromStart: () => void;
  onToggleSkip: () => void;
  onChange: (patch: ClipPatch) => void;
  peaksVersion: number;
  editorPxPerSec: number;
  onZoom: (fn: (p: number) => number) => void;
}) {
  const [view, setView] = useState<InspectorView>(readInspectorView);
  const sectionRef = useRef<HTMLElement>(null);
  /**
   * Inspector height in the wave view. The comments view reuses it, so
   * toggling never resizes the panel (and the sequence above it).
   */
  const [waveHeight, setWaveHeight] = useState<number | null>(null);
  const hasClip = clip != null;
  const measureWave = open && view === "wave" && hasClip;
  useLayoutEffect(() => {
    const el = sectionRef.current;
    if (!el || !measureWave) return;
    const ro = new ResizeObserver(() => setWaveHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureWave]);

  function showView(next: InspectorView) {
    setView(next);
    persistInspectorView(next);
    if (!open) onOpenChange(true);
  }

  if (!clip) {
    return (
      <section
        className="arr-inspector arr-inspector-closed"
        aria-label="Clip inspector"
      >
        <div className="arr-inspector-bar">
          <span className="arr-muted">Select a clip to trim and edit.</span>
        </div>
      </section>
    );
  }

  const scale = track ? trimScale(clip, track, editorPxPerSec) : null;
  const showBody = open;
  const commentCount = track?.comments.length ?? 0;
  const commentsView = open && view === "comments";

  /** Zoom at which the whole source track fits the trim view, if shown. */
  function fitPx(): number | null {
    const w = trimViewWidth(sectionRef.current);
    if (w == null || !scale) return null;
    return Math.min(scale.maxPx, w / Math.max(scale.srcDur, MIN_CLIP_SEC));
  }

  return (
    <section
      ref={sectionRef}
      className={showBody ? "arr-inspector" : "arr-inspector arr-inspector-closed"}
      style={
        commentsView ? { height: waveHeight ?? DEFAULT_INSPECTOR_H } : undefined
      }
      aria-label="Clip inspector"
    >
      <div className="arr-inspector-bar">
        <button
          type="button"
          className="arr-inspector-toggle"
          aria-expanded={open}
          title={open ? "Collapse to the toolbar" : "Expand"}
          onClick={() => onOpenChange(!open)}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className="arr-view-toggle" role="group" aria-label="Show">
          <button
            type="button"
            className={
              open && view === "wave"
                ? "filterButton filterSelected"
                : "filterButton"
            }
            aria-pressed={open && view === "wave"}
            title="Show the trim waveform"
            onClick={() => showView("wave")}
          >
            wave
          </button>
          <button
            type="button"
            className={
              open && view === "comments"
                ? "filterButton filterSelected"
                : "filterButton"
            }
            aria-pressed={open && view === "comments"}
            title="Show this track's comments (edit them in the library list)"
            onClick={() => showView("comments")}
          >
            comments{commentCount > 0 ? ` (${commentCount})` : ""}
          </button>
        </span>
        <span
          className="arr-inspector-title"
          title={track?.filename ?? clip.trackId}
        >
          {index + 1}. {track ? shortTitle(track.filename) : "missing track"}
        </span>
        {!commentsView && (
          <>
            <button
              type="button"
              disabled={skipped}
              className="arr-row-btn"
              title={
                skipped
                  ? "Skipped clips don't play"
                  : "Play this clip from the in point"
              }
              aria-label="Play clip from the in point"
              onClick={onPlayFromStart}
            >
              ⏮
            </button>
            <button
              type="button"
              disabled={skipped}
              className={soloing ? "arr-row-btn arr-row-btn-on" : "arr-row-btn"}
              title={
                skipped
                  ? "Skipped clips don't play"
                  : soloing
                    ? "Stop"
                    : "Play this clip (from the playhead when it is inside)"
              }
              aria-label={soloing ? "Stop clip" : "Play clip"}
              onClick={onPlay}
            >
              {soloing ? "■" : "▶"}
            </button>

            <span className="arr-insp-group">
              {isOwner ? (
                <>
                  <label className="arr-field-inline">
                    in
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={Number(clip.inSec.toFixed(2))}
                      onChange={(e) =>
                        onChange({ inSec: Number(e.target.value) || 0 })
                      }
                    />
                  </label>
                  <label className="arr-field-inline">
                    out
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={Number(clip.outSec.toFixed(2))}
                      onChange={(e) =>
                        onChange({ outSec: Number(e.target.value) || 0 })
                      }
                    />
                  </label>
                </>
              ) : (
                <span className="arr-field-inline">
                  in {formatClockTenths(clip.inSec)} · out{" "}
                  {formatClockTenths(clip.outSec)}
                </span>
              )}
              <span
                className="arr-muted"
                title="Selection length of full source length"
              >
                {formatClock(clipDuration(clip))}
                {scale ? ` of ${formatClock(scale.srcDur)}` : ""}
              </span>
            </span>

            <span className="arr-insp-group">
              {isOwner ? (
                <label className="arr-field-inline" title="Silence after this clip">
                  pause
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={clip.pauseSec}
                    onChange={(e) =>
                      onChange({ pauseSec: Number(e.target.value) || 0 })
                    }
                  />
                  s
                </label>
              ) : (
                <span className="arr-field-inline">
                  pause{" "}
                  {clip.pauseSec > 0 ? formatPause(clip.pauseSec) : "none"}
                </span>
              )}
              {isOwner ? (
                <label className="arr-field-inline">
                  gain
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={clip.gain}
                    onChange={(e) => onChange({ gain: Number(e.target.value) })}
                  />
                  <span className="arr-gain-val">×{clip.gain.toFixed(2)}</span>
                </label>
              ) : (
                <span className="arr-field-inline">
                  gain ×{clip.gain.toFixed(2)}
                </span>
              )}
            </span>

            <span className="arr-insp-group">
              <label
                className="arr-field-inline arr-skip-field"
                title="Leave this clip out of playback. This session only; not saved."
              >
                <input
                  type="checkbox"
                  className="track-check"
                  checked={skipped}
                  onChange={onToggleSkip}
                />
                skip <span className="arr-muted">(not saved)</span>
              </label>
              {track?.releasedOn && (
                <span
                  className="arr-released-warn"
                  title={`Already released on ${track.releasedOn}`}
                >
                  released {track.releasedOn}
                </span>
              )}
            </span>

            <span className="arr-spacer" />

            {scale && open && (
              <span className="arr-insp-group">
                <span className="arr-zoom" role="group" aria-label="Waveform zoom">
                  <button
                    type="button"
                    className="filterButton"
                    title="Zoom out waveform"
                    onClick={() => {
                      // Long tracks need less than the minimum to fit whole.
                      const floor = Math.min(PX_PER_SEC_MIN, fitPx() ?? Infinity);
                      onZoom((p) => Math.min(p, Math.max(floor, p / 1.25)));
                    }}
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className="filterButton"
                    title="Zoom in waveform"
                    onClick={() => onZoom((p) => Math.min(scale.maxPx, p * 1.25))}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="filterButton"
                    title="Zoom to fit the whole track"
                    onClick={() => {
                      const px = fitPx();
                      if (px != null) onZoom(() => px);
                    }}
                  >
                    fit
                  </button>
                </span>
                <span className="arr-muted">
                  {formatPxPerSec(scale.effectivePx)} px/s
                </span>
              </span>
            )}
          </>
        )}
      </div>

      {showBody && (
        <div className="arr-inspector-body">
          {view === "comments" ? (
            <CommentsPanel track={track} />
          ) : track && scale ? (
            <TrimEditor
              clip={clip}
              isOwner={isOwner}
              peaksVersion={peaksVersion}
              srcDur={scale.srcDur}
              pxPerSec={scale.effectivePx}
              head={head}
              onSeek={onSeek}
              onChange={onChange}
            />
          ) : (
            <p className="arr-inspector-empty arr-trim">
              This track is missing from the library.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
