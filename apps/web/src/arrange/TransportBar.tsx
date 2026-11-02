import type { ArrangementClip, Track } from "../api";
import { PLAYBACK_MODES, type PlaybackMode } from "../arrangePlayback";
import { formatClock, shortTitle } from "../format";
import { downloadArrangementTsv } from "./exportTsv";
import { Menu } from "./Menu";
import { usePlayhead, type PlayheadStore } from "./playhead";

/** Overview zoom: 1 = whole arrangement fits the strip. */
const OVERVIEW_ZOOM_MAX = 32;

const PLAYBACK_MODE_LABEL: Record<PlaybackMode, { name: string; hint: string }> =
  {
    stream: {
      name: "Fast",
      hint: "Streams audio; light; transitions within ~50 ms",
    },
    precise: {
      name: "Gapless",
      hint: "Decodes current and next clip; waits to load",
    },
  };

function PlayheadClock({ store }: { store: PlayheadStore }) {
  return <>{usePlayhead(store, formatClock)}</>;
}

/**
 * Play / stop, clock, which clip is in focus, warnings (released, skipped),
 * overview zoom, and the overflow menu (export, check tracks, playback mode).
 */
export function TransportBar({
  name,
  clips,
  trackById,
  isOwner,
  playing,
  audioWaiting,
  playhead,
  totalSec,
  contextId,
  skippedCount,
  overviewZoom,
  playbackMode,
  onTogglePlay,
  onClearSkipped,
  onOverviewZoom,
  onPlaybackMode,
  onCheckTracks,
}: {
  /** Arrangement name, for the export filename. */
  name: string;
  clips: ArrangementClip[];
  trackById: Map<string, Track>;
  isOwner: boolean;
  playing: boolean;
  audioWaiting: boolean;
  playhead: PlayheadStore;
  totalSec: number;
  /** Clip shown as "clip n of m": under the playhead, or the selection. */
  contextId: string | null;
  skippedCount: number;
  overviewZoom: number;
  playbackMode: PlaybackMode;
  onTogglePlay: () => void;
  onClearSkipped: () => void;
  onOverviewZoom: (zoom: number) => void;
  onPlaybackMode: (mode: PlaybackMode) => void;
  onCheckTracks: (trackIds: string[]) => void;
}) {
  const contextIndex =
    contextId != null
      ? clips.findIndex((c) => c.instanceId === contextId)
      : -1;
  const contextClip = contextIndex >= 0 ? clips[contextIndex] : undefined;
  const contextTrack = contextClip
    ? trackById.get(contextClip.trackId)
    : undefined;
  const releasedClips = clips.filter(
    (c) => trackById.get(c.trackId)?.releasedOn,
  );

  return (
    <div className="arr-transport">
      <button
        type="button"
        className={
          playing ? "filterButton filterSelected arr-play" : "filterButton arr-play"
        }
        disabled={clips.length === 0}
        title="Play the arrangement from the playhead (space)"
        onClick={onTogglePlay}
      >
        {playing ? "■ stop" : "▶ play"}
      </button>
      <span className="arr-clock">
        <PlayheadClock store={playhead} />
        <span className="arr-clock-total"> / {formatClock(totalSec)}</span>
      </span>
      {contextClip && (
        <span
          className="arr-context"
          title={contextTrack?.filename ?? contextClip.trackId}
        >
          clip {contextIndex + 1} of {clips.length} ·{" "}
          {contextTrack ? shortTitle(contextTrack.filename) : "?"}
        </span>
      )}
      {playing && audioWaiting && <span className="arr-muted">loading…</span>}
      <span className="arr-spacer" />
      {releasedClips.length > 0 && (
        <span
          className="arr-released-warn"
          title={`Already released:\n${releasedClips
            .map((c) => {
              const t = trackById.get(c.trackId)!;
              return `${shortTitle(t.filename)} — ${t.releasedOn}`;
            })
            .join("\n")}`}
        >
          ⚠ {releasedClips.length} released
        </span>
      )}
      {skippedCount > 0 && (
        <span
          className="arr-skip-chip"
          title="Skipped clips are left out of playback in this session only"
        >
          {skippedCount} skipped (not saved)
          <button type="button" className="arr-chip-btn" onClick={onClearSkipped}>
            clear
          </button>
        </span>
      )}
      <span className="arr-zoom" role="group" aria-label="Overview zoom">
        <button
          type="button"
          className="filterButton"
          disabled={overviewZoom <= 1}
          title="Zoom out overview"
          onClick={() => onOverviewZoom(Math.max(1, overviewZoom / 2))}
        >
          −
        </button>
        <button
          type="button"
          className="filterButton"
          disabled={overviewZoom >= OVERVIEW_ZOOM_MAX}
          title="Zoom in overview"
          onClick={() =>
            onOverviewZoom(Math.min(OVERVIEW_ZOOM_MAX, overviewZoom * 2))
          }
        >
          +
        </button>
      </span>
      <Menu
        label="⋯"
        title="Export, check tracks, playback mode, shortcuts"
        buttonClassName="filterButton"
      >
        {(close) => (
          <>
            <button
              type="button"
              role="menuitem"
              className="arr-menu-item"
              disabled={clips.length === 0}
              onClick={() => {
                close();
                downloadArrangementTsv(name, clips, trackById);
              }}
            >
              Export TSV
              <span className="arr-menu-hint">
                filename, in, out, pause, gain
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="arr-menu-item"
              disabled={clips.length === 0}
              onClick={() => {
                close();
                onCheckTracks([...new Set(clips.map((c) => c.trackId))]);
              }}
            >
              Check tracks in library
              <span className="arr-menu-hint">replaces current checks</span>
            </button>
            <div className="arr-menu-sep" role="separator" />
            <div className="arr-menu-heading">Playback</div>
            {PLAYBACK_MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={playbackMode === m}
                className="arr-menu-item"
                onClick={() => {
                  close();
                  onPlaybackMode(m);
                }}
              >
                <span className="arr-menu-check" aria-hidden>
                  {playbackMode === m ? "●" : ""}
                </span>
                {PLAYBACK_MODE_LABEL[m].name}
                <span className="arr-menu-hint">
                  {PLAYBACK_MODE_LABEL[m].hint}
                </span>
              </button>
            ))}
            <div className="arr-menu-sep" role="separator" />
            <div className="arr-menu-heading">Shortcuts</div>
            <dl className="arr-menu-keys">
              <dt>space</dt>
              <dd>play / stop arrangement</dd>
              {isOwner && (
                <>
                  <dt>del</dt>
                  <dd>remove selected clip</dd>
                  <dt>drag</dt>
                  <dd>tracks from the library, or rows to reorder</dd>
                  <dt>double-click</dt>
                  <dd>library track to append it</dd>
                </>
              )}
            </dl>
          </>
        )}
      </Menu>
    </div>
  );
}
