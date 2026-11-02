import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import type { ArrangementClip, Track } from "../api";
import { formatClock, shortTitle } from "../format";
import { CLIP_MIME, TRACK_MIME } from "../mime";
import { formatPause } from "./format";
import { Menu } from "./Menu";
import { clipDuration } from "./timeline";

/** Scroll `wrap` just enough to show the sequence row for `id`. */
function scrollRowIntoView(wrap: HTMLElement | null, id: string) {
  const row = wrap?.querySelector<HTMLElement>(`[data-clip-id="${id}"]`);
  if (!wrap || !row) return;
  const w = wrap.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const margin = 8;
  if (r.top < w.top + margin) {
    wrap.scrollTop += r.top - w.top - margin;
  } else if (r.bottom > w.bottom - margin) {
    wrap.scrollTop += r.bottom - w.bottom + margin;
  }
}

/** Insert before a row when over its top half, after it otherwise. */
function rowInsertIndex(e: ReactDragEvent<HTMLElement>, index: number) {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? index : index + 1;
}

/**
 * The cut list: one row per clip, in order. Owners reorder rows by dragging
 * and drop library tracks between them; drop targets light up while a drag
 * is in flight.
 */
export function Sequence({
  clips,
  trackById,
  isOwner,
  selectedId,
  headClipId,
  playing,
  soloClipId,
  skippedIds,
  onSelect,
  onHoverTrack,
  onToggleSkip,
  onPlayClip,
  onRemove,
  onMoveClip,
  onAddTrack,
}: {
  clips: ArrangementClip[];
  trackById: Map<string, Track>;
  isOwner: boolean;
  selectedId: string | null;
  headClipId: string | null;
  playing: boolean;
  soloClipId: string | null;
  skippedIds: ReadonlySet<string>;
  onSelect: (instanceId: string) => void;
  onHoverTrack: (trackId: string) => void;
  onToggleSkip: (instanceId: string) => void;
  onPlayClip: (instanceId: string) => void;
  onRemove: (instanceId: string) => void;
  /** Move a clip so it lands before the clip now at `insertIndex`. */
  onMoveClip: (instanceId: string, insertIndex: number) => void;
  onAddTrack: (trackId: string, insertIndex: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dragClipId, setDragClipId] = useState<string | null>(null);
  /** A track from the library is being dragged (drop targets light up). */
  const [trackDragging, setTrackDragging] = useState(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // Library rows live in another panel; watch drags at the window level so
  // the sequence can show its drop targets while one is in flight.
  useEffect(() => {
    const onStart = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(TRACK_MIME)) setTrackDragging(true);
    };
    const onEnd = () => {
      setTrackDragging(false);
      setDropIndex(null);
    };
    window.addEventListener("dragstart", onStart);
    window.addEventListener("dragend", onEnd);
    window.addEventListener("drop", onEnd);
    return () => {
      window.removeEventListener("dragstart", onStart);
      window.removeEventListener("dragend", onEnd);
      window.removeEventListener("drop", onEnd);
    };
  }, []);

  // Keep the selected row, and while playing the row under the playhead, in view.
  useEffect(() => {
    if (selectedId) scrollRowIntoView(wrapRef.current, selectedId);
  }, [selectedId]);
  useEffect(() => {
    if (playing && headClipId) {
      scrollRowIntoView(wrapRef.current, headClipId);
    }
  }, [playing, headClipId]);

  function clearDrag() {
    setDragClipId(null);
    setDropIndex(null);
  }

  function onDrop(e: ReactDragEvent, insertIndex: number) {
    e.preventDefault();
    e.stopPropagation();
    clearDrag();
    if (!isOwner) return;
    const clipId =
      e.dataTransfer.getData(CLIP_MIME) ||
      e.dataTransfer.getData("text/clip-id");
    if (clipId) {
      onMoveClip(clipId, insertIndex);
      return;
    }
    const trackId =
      e.dataTransfer.getData(TRACK_MIME) ||
      e.dataTransfer.getData("text/plain");
    if (trackId) onAddTrack(trackId, insertIndex);
  }

  const dragging = isOwner && (dragClipId != null || trackDragging);
  const dragClipIndex = dragClipId
    ? clips.findIndex((c) => c.instanceId === dragClipId)
    : -1;
  const maxClipDur = clips.reduce((m, c) => Math.max(m, clipDuration(c)), 0);

  /**
   * Drop slot `i` inserts before clip `i`. While dragging, every slot that
   * would change the order is outlined; the one under the pointer is filled.
   * Slots on either side of a dragged clip would not move it, so stay hidden.
   */
  function dropSlotClass(i: number) {
    const noop =
      dragClipIndex >= 0 && (i === dragClipIndex || i === dragClipIndex + 1);
    const classes = ["arr-drop-slot"];
    if (dragging && !noop) {
      classes.push("arr-drop-target");
      if (dropIndex === i) classes.push("arr-drop-target-active");
    }
    return classes.join(" ");
  }

  return (
    <div
      ref={wrapRef}
      className={
        isOwner ? "arr-sequence-wrap" : "arr-sequence-wrap arr-sequence-readonly"
      }
      onDragOver={(e) => {
        if (!isOwner) return;
        e.preventDefault();
        // Bare padding around the rows drops at the end.
        if (e.target === e.currentTarget) setDropIndex(clips.length);
      }}
      onDragLeave={(e) => {
        if (
          !(e.relatedTarget instanceof Node) ||
          !e.currentTarget.contains(e.relatedTarget)
        ) {
          setDropIndex(null);
        }
      }}
      onDrop={(e) => onDrop(e, clips.length)}
      onDragEnd={clearDrag}
    >
      {clips.length === 0 ? (
        <div
          className={[
            "arr-sequence-empty",
            dragging ? "arr-drop-target" : "",
            dragging && dropIndex === 0 ? "arr-drop-target-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onDragOver={(e) => {
            if (!isOwner) return;
            e.preventDefault();
            setDropIndex(0);
          }}
        >
          {isOwner
            ? "Drag tracks from the library (or double-click) to build the sequence."
            : "This arrangement has no clips."}
        </div>
      ) : (
        <div
          className={
            dragging ? "arr-sequence arr-sequence-dragging" : "arr-sequence"
          }
        >
          {clips.map((clip, index) => (
            <div
              key={clip.instanceId}
              className="arr-row-block"
              onDragOver={(e) => {
                if (!isOwner) return;
                e.preventDefault();
                e.stopPropagation();
                setDropIndex(rowInsertIndex(e, index));
              }}
              onDrop={(e) => onDrop(e, rowInsertIndex(e, index))}
            >
              <div className={dropSlotClass(index)} />
              <SequenceRow
                clip={clip}
                index={index}
                track={trackById.get(clip.trackId)}
                isOwner={isOwner}
                selected={clip.instanceId === selectedId}
                skipped={skippedIds.has(clip.instanceId)}
                underPlayhead={playing && headClipId === clip.instanceId}
                soloing={playing && soloClipId === clip.instanceId}
                beingDragged={dragClipId === clip.instanceId}
                lengthFrac={maxClipDur > 0 ? clipDuration(clip) / maxClipDur : 0}
                onSelect={() => onSelect(clip.instanceId)}
                onHover={() => onHoverTrack(clip.trackId)}
                onToggleSkip={() => onToggleSkip(clip.instanceId)}
                onPlay={() => onPlayClip(clip.instanceId)}
                onRemove={() => onRemove(clip.instanceId)}
                onDragStart={() => setDragClipId(clip.instanceId)}
                onDragEnd={clearDrag}
              />
            </div>
          ))}
          <div
            className={`${dropSlotClass(clips.length)} arr-drop-slot-end`}
            onDragOver={(e) => {
              if (!isOwner) return;
              e.preventDefault();
              e.stopPropagation();
              setDropIndex(clips.length);
            }}
            onDrop={(e) => onDrop(e, clips.length)}
          />
        </div>
      )}
    </div>
  );
}

function SequenceRow({
  clip,
  index,
  track,
  isOwner,
  selected,
  skipped,
  underPlayhead,
  soloing,
  beingDragged,
  lengthFrac,
  onSelect,
  onHover,
  onToggleSkip,
  onPlay,
  onRemove,
  onDragStart,
  onDragEnd,
}: {
  clip: ArrangementClip;
  index: number;
  track: Track | undefined;
  isOwner: boolean;
  selected: boolean;
  skipped: boolean;
  underPlayhead: boolean;
  soloing: boolean;
  beingDragged: boolean;
  /** Clip length relative to the longest clip, for the length bar. */
  lengthFrac: number;
  onSelect: () => void;
  onHover: () => void;
  onToggleSkip: () => void;
  onPlay: () => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const releasedOn = track?.releasedOn ?? null;
  const dur = clipDuration(clip);
  const title = track ? shortTitle(track.filename) : "?";
  const tooltip = [
    track?.filename ?? `missing track ${clip.trackId}`,
    releasedOn ? `released on ${releasedOn}` : "",
    skipped ? "skipped in playback (not saved)" : "",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      data-clip-id={clip.instanceId}
      className={[
        "arr-row",
        selected ? "arr-row-selected" : "",
        skipped ? "arr-row-skipped" : "",
        releasedOn ? "arr-row-released" : "",
        underPlayhead ? "arr-row-playing" : "",
        soloing ? "arr-row-soloing" : "",
        beingDragged ? "arr-row-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onSelect}
      onMouseEnter={onHover}
    >
      {isOwner && (
        <span
          className="arr-row-handle"
          title="Drag to reorder"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(CLIP_MIME, clip.instanceId);
            e.dataTransfer.setData("text/clip-id", clip.instanceId);
            e.dataTransfer.effectAllowed = "move";
            onDragStart();
            const ghost = document.createElement("div");
            ghost.className = "arr-drag-ghost";
            ghost.textContent = `${index + 1}. ${title}`;
            document.body.appendChild(ghost);
            e.dataTransfer.setDragImage(ghost, 16, 16);
            window.setTimeout(() => ghost.remove(), 0);
          }}
          onDragEnd={onDragEnd}
        >
          ⠿
        </span>
      )}
      <span className="arr-row-index">{index + 1}</span>
      <span className="arr-row-name" title={tooltip}>
        {title}
      </span>
      {clip.pauseSec > 0 && (
        <span
          className="arr-row-pause-cue"
          title={`${formatPause(clip.pauseSec)} pause after this clip`}
        >
          +{formatPause(clip.pauseSec)}
        </span>
      )}
      <span className="arr-row-len" aria-hidden>
        <span style={{ width: `${lengthFrac * 100}%` }} />
      </span>
      <span className="arr-row-dur">{formatClock(dur)}</span>
      <button
        type="button"
        className={skipped ? "arr-row-skip arr-row-skip-on" : "arr-row-skip"}
        aria-pressed={skipped}
        title={
          skipped
            ? "Skipped: left out of playback (this session only, not saved). Click to play it again."
            : "Skip in playback (this session only, not saved)"
        }
        onClick={(e) => {
          e.stopPropagation();
          onToggleSkip();
        }}
      >
        skip
      </button>
      <span className="arr-row-actions">
        <button
          type="button"
          disabled={skipped}
          className={soloing ? "arr-row-btn arr-row-btn-on" : "arr-row-btn"}
          title={
            skipped ? "Skipped clips don't play" : soloing ? "Stop" : "Play this clip"
          }
          aria-label={soloing ? "Stop clip" : "Play clip"}
          onClick={(e) => {
            e.stopPropagation();
            onPlay();
          }}
        >
          {soloing ? "■" : "▶"}
        </button>
        {isOwner && (
          <Menu label="⋯" title="Clip actions" buttonClassName="arr-row-btn">
            {(close) => (
              <button
                type="button"
                role="menuitem"
                className="arr-menu-item arr-menu-danger"
                onClick={() => {
                  close();
                  onRemove();
                }}
              >
                Remove from arrangement
              </button>
            )}
          </Menu>
        )}
      </span>
    </div>
  );
}
