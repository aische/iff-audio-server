import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { api, type Track, type User } from "../api";
import { newClipForTrack } from "../clips";
import { getCachedPeaks } from "../peaks";
import { ClipInspector } from "./ClipInspector";
import { IdentityBar } from "./IdentityBar";
import { Overview } from "./Overview";
import { useLatestRef } from "./playhead";
import { Sequence } from "./Sequence";
import { persistInspectorOpen, readInspectorOpen } from "./storage";
import {
  applyClipPatch,
  audioSegOf,
  moveItem,
  sourceDuration,
  type ClipPatch,
} from "./timeline";
import { TransportBar } from "./TransportBar";
import { useArrangementDoc } from "./useArrangementDoc";
import { useArrangeShortcuts } from "./useArrangeShortcuts";
import { useArrangeTransport } from "./useArrangeTransport";
import { usePeaksVersion } from "./usePeaksVersion";
import { EDITOR_PX_DEFAULT, fitPxPerSec } from "./waveScale";

/** What the editor exposes to the library panel for adding tracks. */
export type ArrangeAddApi = {
  addTrack: (trackId: string, atIndex?: number) => void;
  isOwner: boolean;
};

/** Single arrangement: sequence, trim, playback, autosave. */
export function ArrangeEditor({
  arrangementId,
  user,
  tracks,
  active,
  onBack,
  onOpen,
  onError,
  onAddApiChange,
  onCheckTracks,
  onHoverTrack,
  onSelectTrack,
  onArrangementPlayingChange,
  stopToken,
}: {
  arrangementId: string;
  user: User;
  tracks: Track[];
  active: boolean;
  onBack: () => void;
  onOpen: (id: string) => void;
  onError: (message: string | null) => void;
  onAddApiChange: (api: ArrangeAddApi | null) => void;
  onCheckTracks: (trackIds: string[]) => void;
  onHoverTrack: (trackId: string | null) => void;
  /** Track of the selected clip, or null; highlighted in the library. */
  onSelectTrack: (trackId: string | null) => void;
  onArrangementPlayingChange: (playing: boolean) => void;
  stopToken: number;
}) {
  const doc = useArrangementDoc(arrangementId, user.id, onError);
  const { arrangement, isOwner, clips, setClips } = doc;
  const transport = useArrangeTransport(clips, onError);
  const { playhead, segs, totalSec, headClipId, playing, soloClipId } =
    transport;
  const peaksVersion = usePeaksVersion(clips);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overviewZoom, setOverviewZoom] = useState(1);
  const [inspectorOpen, setInspectorOpen] = useState(readInspectorOpen);
  const [editorPxPerSec, setEditorPxPerSec] = useState(EDITOR_PX_DEFAULT);
  const clipsRef = useLatestRef(clips);
  const panelRef = useRef<HTMLDivElement>(null);

  const trackById = useMemo(() => {
    const m = new Map<string, Track>();
    for (const t of tracks) m.set(t.id, t);
    return m;
  }, [tracks]);

  // Notify parent when playing state changes.
  const notifyPlaying = useEffectEvent((p: boolean) => {
    onArrangementPlayingChange(p);
  });
  useEffect(() => {
    notifyPlaying(playing);
  }, [playing]);

  // Stop transport when stopToken increments (skip initial mount).
  const stopTokenRef = useRef(stopToken);
  const stopOnToken = useEffectEvent(() => {
    if (playing) transport.stop();
  });
  useEffect(() => {
    if (stopTokenRef.current === stopToken) return;
    stopTokenRef.current = stopToken;
    stopOnToken();
  }, [stopToken]);

  useArrangeShortcuts(panelRef, {
    active,
    onTogglePlay: transport.togglePlay,
    onDelete: isOwner && selectedId ? () => removeClip(selectedId) : null,
  });

  function removeClip(id: string) {
    setClips((prev) => prev.filter((c) => c.instanceId !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }

  function changeInspectorOpen(open: boolean) {
    setInspectorOpen(open);
    persistInspectorOpen(open);
  }

  function addTrack(trackId: string, atIndex?: number) {
    const item = newClipForTrack(trackById.get(trackId));
    if (!item) return;
    setClips((prev) => {
      if (atIndex == null || atIndex < 0 || atIndex >= prev.length) {
        return [...prev, item];
      }
      const next = [...prev];
      next.splice(atIndex, 0, item);
      return next;
    });
    setSelectedId(item.instanceId);
    setEditorPxPerSec(fitPxPerSec(item.outSec));
  }

  // The parent keeps the published API in state; route through a ref so it
  // always runs the latest addTrack (current trackById), not the one from
  // the render that published it.
  const addTrackRef = useLatestRef(addTrack);
  useEffect(() => {
    onAddApiChange({
      addTrack: (trackId, atIndex) => addTrackRef.current(trackId, atIndex),
      isOwner,
    });
    return () => onAddApiChange(null);
  }, [isOwner, onAddApiChange, addTrackRef]);

  // Derived from clips, so removing the selected clip clears it too.
  const selectedTrackId = selectedId
    ? (clips.find((c) => c.instanceId === selectedId)?.trackId ?? null)
    : null;
  useEffect(() => {
    onSelectTrack(selectedTrackId);
    return () => onSelectTrack(null);
  }, [selectedTrackId, onSelectTrack]);

  function moveClip(clipId: string, insertIndex: number) {
    setClips((prev) => {
      const from = prev.findIndex((c) => c.instanceId === clipId);
      if (from < 0) return prev;
      let to = insertIndex;
      if (from < to) to -= 1;
      return moveItem(prev, from, Math.max(0, Math.min(prev.length - 1, to)));
    });
  }

  function updateClip(id: string, patch: ClipPatch) {
    setClips((prev) =>
      prev.map((c) => {
        if (c.instanceId !== id) return c;
        const track = trackById.get(c.trackId);
        const src = sourceDuration(track, getCachedPeaks(c.trackId) ?? null);
        return applyClipPatch(c, patch, src);
      }),
    );
  }

  function selectClip(id: string) {
    if (id !== selectedId) changeInspectorOpen(true);
    setSelectedId(id);
    const clip = clipsRef.current.find((c) => c.instanceId === id);
    if (!clip) return;
    const track = trackById.get(clip.trackId);
    const src = sourceDuration(track, getCachedPeaks(clip.trackId) ?? null);
    setEditorPxPerSec(fitPxPerSec(src));
  }

  async function copyToEdit() {
    try {
      const row = await api.copyArrangement(arrangementId);
      onError(null);
      onOpen(row.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to copy");
    }
  }

  if (!arrangement) {
    return (
      <div className="arr-panel">
        <p className="arr-muted" style={{ padding: 12 }}>
          Loading arrangement…
        </p>
      </div>
    );
  }

  const indexById = new Map(clips.map((c, i) => [c.instanceId, i]));
  const selected = selectedId
    ? (clips.find((c) => c.instanceId === selectedId) ?? null)
    : null;
  /** Where the selected clip plays in the arrangement; none while skipped. */
  const selectedSeg = selectedId ? audioSegOf(segs, selectedId) : undefined;
  const skippedCount = clips.filter((c) =>
    transport.skippedIds.has(c.instanceId),
  ).length;

  return (
    <div className="arr-panel" ref={panelRef}>
      <IdentityBar
        isOwner={isOwner}
        name={doc.name}
        onNameChange={doc.setName}
        ownerEmail={arrangement.userEmail}
        saveState={doc.saveState}
        onBack={onBack}
        onCopy={copyToEdit}
      />

      <TransportBar
        name={doc.name}
        clips={clips}
        trackById={trackById}
        isOwner={isOwner}
        playing={playing}
        audioWaiting={transport.audioWaiting}
        playhead={playhead}
        totalSec={totalSec}
        contextId={playing ? headClipId : (selectedId ?? headClipId)}
        skippedCount={skippedCount}
        overviewZoom={overviewZoom}
        playbackMode={transport.playbackMode}
        onTogglePlay={transport.togglePlay}
        onClearSkipped={() => transport.setSkipped(new Set())}
        onOverviewZoom={setOverviewZoom}
        onPlaybackMode={transport.changePlaybackMode}
        onCheckTracks={onCheckTracks}
      />

      <Overview
        segs={segs}
        totalSec={totalSec}
        trackById={trackById}
        indexById={indexById}
        selectedId={selectedId}
        headClipId={headClipId}
        playing={playing}
        zoom={overviewZoom}
        store={playhead}
        onSeek={transport.seek}
        onSelect={selectClip}
      />

      <div className="arr-main">
        <Sequence
          clips={clips}
          trackById={trackById}
          isOwner={isOwner}
          selectedId={selectedId}
          headClipId={headClipId}
          playing={playing}
          soloClipId={soloClipId}
          skippedIds={transport.skippedIds}
          onSelect={selectClip}
          onHoverTrack={onHoverTrack}
          onToggleSkip={transport.toggleSkip}
          onPlayClip={(id) => transport.playClip(id)}
          onRemove={removeClip}
          onMoveClip={moveClip}
          onAddTrack={addTrack}
        />

        <ClipInspector
          clip={selected}
          index={selected ? (indexById.get(selected.instanceId) ?? 0) : 0}
          track={selected ? (trackById.get(selected.trackId) ?? null) : null}
          isOwner={isOwner}
          open={inspectorOpen}
          onOpenChange={changeInspectorOpen}
          skipped={
            selected ? transport.skippedIds.has(selected.instanceId) : false
          }
          soloing={
            selected != null && playing && soloClipId === selected.instanceId
          }
          head={
            selectedSeg
              ? {
                  store: playhead,
                  arrStart: selectedSeg.arrStart,
                  arrEnd: selectedSeg.arrEnd,
                  follow: playing,
                }
              : null
          }
          onSeek={(srcSec) => {
            if (selected) transport.seekInClip(selected.instanceId, srcSec);
          }}
          onPlay={() => {
            if (selected) transport.playClip(selected.instanceId);
          }}
          onPlayFromStart={() => {
            if (selected) transport.playClip(selected.instanceId, true);
          }}
          onToggleSkip={() => {
            if (selected) transport.toggleSkip(selected.instanceId);
          }}
          onChange={(patch) => {
            if (selected) updateClip(selected.instanceId, patch);
          }}
          peaksVersion={peaksVersion}
          editorPxPerSec={editorPxPerSec}
          onZoom={(fn) => setEditorPxPerSec(fn)}
        />
      </div>
    </div>
  );
}
