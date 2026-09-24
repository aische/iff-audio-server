import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  api,
  trackStreamUrl,
  unifiedTags,
  type Arrangement,
  type ArrangementClip,
  type ArrangementSummary,
  type Comment,
  type Track,
  type User,
} from "./api";
import {
  drawClipWaveform,
  getCachedPeaks,
  loadPeaks,
  type PeaksRecord,
} from "./peaks";

const AUTOSAVE_MS = 600;
const MIN_CLIP_SEC = 0.5;
const LANE_H = 48;
const RULER_H = 24;
const PX_PER_SEC_DEFAULT = 12;
/** ~0.25 px/s ≈ 1 hour across a ~900px timeline pane. */
const PX_PER_SEC_MIN = 0.25;
const PX_PER_SEC_MAX = 64;
const TRACK_MIME = "application/x-iff-track-id";

type FilterId = "all" | "commented";

function newInstanceId() {
  return crypto.randomUUID();
}

function formatClock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** Major tick step so labels stay ~≥60px apart. */
function rulerTickSec(pxPerSec: number) {
  const candidates = [
    1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200,
  ];
  for (const step of candidates) {
    if (step * pxPerSec >= 60) return step;
  }
  return 7200;
}

function formatPxPerSec(n: number) {
  if (n >= 10) return n.toFixed(0);
  if (n >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

function shortName(filename: string) {
  return filename.replace(/\.aif\.mp3$/i, "").replace(/\.mp3$/i, "");
}

function sourceDuration(track: Track | undefined, clip: ArrangementClip) {
  if (track?.durationSeconds != null && track.durationSeconds > 0) {
    return track.durationSeconds;
  }
  return Math.max(clip.offsetSec + clip.durationSec, MIN_CLIP_SEC);
}

function timelineEnd(clips: ArrangementClip[]) {
  // Keep at least one hour of canvas so zoomed-out view has room to work.
  let end = 3600;
  for (const c of clips) {
    end = Math.max(end, c.startSec + c.durationSec + 30);
  }
  return end;
}

function laneCount(clips: ArrangementClip[]) {
  let max = 0;
  for (const c of clips) max = Math.max(max, c.lane);
  return Math.max(3, max + 2);
}

function ClipWaveform({
  trackId,
  offsetSec,
  durationSec,
  width,
  height,
  peaksVersion,
}: {
  trackId: string;
  offsetSec: number;
  durationSec: number;
  width: number;
  height: number;
  peaksVersion: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rec, setRec] = useState<PeaksRecord | null>(
    () => getCachedPeaks(trackId) ?? null,
  );

  useEffect(() => {
    const cached = getCachedPeaks(trackId);
    if (cached) {
      setRec(cached);
      return;
    }
    let cancelled = false;
    void loadPeaks(trackId)
      .then((r) => {
        if (!cancelled) setRec(r);
      })
      .catch(() => {
        if (!cancelled) setRec(null);
      });
    return () => {
      cancelled = true;
    };
  }, [trackId, peaksVersion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width < 1 || height < 1) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(width * dpr));
    const h = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!rec) {
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      return;
    }
    drawClipWaveform(
      ctx,
      rec.peaks,
      rec.durationSec,
      offsetSec,
      durationSec,
      width,
      height,
    );
  }, [rec, offsetSec, durationSec, width, height, peaksVersion]);

  return (
    <canvas
      ref={canvasRef}
      className="arr-clip-wave"
      width={Math.max(1, Math.floor(width))}
      height={Math.max(1, Math.floor(height))}
      aria-hidden
    />
  );
}

export function ArrangeShell({
  user,
  tracks,
  onBack,
  onError,
}: {
  user: User;
  tracks: Track[];
  onBack: () => void;
  onError: (message: string | null) => void;
}) {
  const [list, setList] = useState<ArrangementSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [copyingId, setCopyingId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setList(await api.listArrangements());
      onError(null);
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Failed to load arrangements",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const row = await api.createArrangement(name);
      setNewName("");
      await refresh();
      setActiveId(row.id);
      onError(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create");
    }
  }

  async function onCopy(id: string) {
    setCopyingId(id);
    try {
      const row = await api.copyArrangement(id);
      onError(null);
      setActiveId(row.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to copy");
    } finally {
      setCopyingId(null);
    }
  }

  if (activeId) {
    return (
      <ArrangeEditor
        arrangementId={activeId}
        user={user}
        tracks={tracks}
        onBack={() => {
          setActiveId(null);
          void refresh();
        }}
        onOpen={setActiveId}
        onCloseAll={onBack}
        onError={onError}
      />
    );
  }

  const mine = list.filter((a) => a.userId === user.id);
  const others = list.filter((a) => a.userId !== user.id);

  return (
    <div className="arr-root">
      <div className="arr-toolbar">
        <button type="button" className="filterButton" onClick={onBack}>
          ← pool
        </button>
        <span className="arr-toolbar-title">arrangements</span>
      </div>
      <div className="arr-list-body">
        <form className="arr-create" onSubmit={onCreate}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="new arrangement name"
            required
          />
          <button type="submit" className="filterButton">
            create
          </button>
        </form>
        {loading ? (
          <p className="arr-muted">Loading…</p>
        ) : list.length === 0 ? (
          <p className="arr-muted">
            No arrangements yet. Create one, then drag tracks onto the timeline.
            Full-duration clips on one lane work as a playlist.
          </p>
        ) : (
          <>
            <ArrangementListSection
              title="yours"
              items={mine}
              empty="You have no arrangements yet."
              onOpen={setActiveId}
              onDelete={async (a) => {
                if (!confirm(`Delete “${a.name}”?`)) return;
                try {
                  await api.deleteArrangement(a.id);
                  await refresh();
                } catch (err) {
                  onError(
                    err instanceof Error ? err.message : "Delete failed",
                  );
                }
              }}
            />
            <ArrangementListSection
              title="others"
              items={others}
              empty="No arrangements from other users yet."
              showOwner
              onOpen={setActiveId}
              onCopy={(a) => void onCopy(a.id)}
              copyingId={copyingId}
            />
          </>
        )}
      </div>
    </div>
  );
}

function ArrangementListSection({
  title,
  items,
  empty,
  showOwner,
  onOpen,
  onDelete,
  onCopy,
  copyingId,
}: {
  title: string;
  items: ArrangementSummary[];
  empty: string;
  showOwner?: boolean;
  onOpen: (id: string) => void;
  onDelete?: (a: ArrangementSummary) => void | Promise<void>;
  onCopy?: (a: ArrangementSummary) => void;
  copyingId?: string | null;
}) {
  return (
    <section className="arr-list-section">
      <h2 className="arr-list-heading">{title}</h2>
      {items.length === 0 ? (
        <p className="arr-muted">{empty}</p>
      ) : (
        <ul className="arr-list">
          {items.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="arr-list-open"
                onClick={() => onOpen(a.id)}
              >
                <span className="arr-list-name">{a.name}</span>
                <span className="arr-muted">
                  {showOwner ? `${a.userEmail} · ` : ""}
                  {a.clipCount} clips · {new Date(a.updatedAt).toLocaleString()}
                </span>
              </button>
              {onCopy && (
                <button
                  type="button"
                  className="filterButton"
                  disabled={copyingId === a.id}
                  onClick={() => onCopy(a)}
                >
                  {copyingId === a.id ? "copying…" : "copy"}
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  className="filterButton"
                  onClick={() => void onDelete(a)}
                >
                  delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ArrangeEditor({
  arrangementId,
  user,
  tracks,
  onBack,
  onOpen,
  onCloseAll,
  onError,
}: {
  arrangementId: string;
  user: User;
  tracks: Track[];
  onBack: () => void;
  onOpen: (id: string) => void;
  onCloseAll: () => void;
  onError: (message: string | null) => void;
}) {
  const [arrangement, setArrangement] = useState<Arrangement | null>(null);
  const [clips, setClips] = useState<ArrangementClip[]>([]);
  const [name, setName] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState(PX_PER_SEC_DEFAULT);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Sidebar hover wins over arrangement selection for the comment panel. */
  const [hoveredTrackId, setHoveredTrackId] = useState<string | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [copying, setCopying] = useState(false);
  const [peaksVersion, setPeaksVersion] = useState(0);
  const trackById = useMemo(
    () => new Map(tracks.map((t) => [t.id, t])),
    [tracks],
  );
  const savedClipsRef = useRef<string>("");
  const savedNameRef = useRef("");
  const playRef = useRef(playing);
  const playheadRef = useRef(playheadSec);
  const clipsRef = useRef(clips);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const audioRef = useRef(new Map<string, HTMLAudioElement>());

  const isOwner = arrangement?.userId === user.id;

  playRef.current = playing;
  playheadRef.current = playheadSec;
  clipsRef.current = clips;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const row = await api.getArrangement(arrangementId);
        if (cancelled) return;
        setArrangement(row);
        setClips(row.clips);
        setName(row.name);
        savedClipsRef.current = JSON.stringify(row.clips);
        savedNameRef.current = row.name;
      } catch (err) {
        if (!cancelled) {
          onError(
            err instanceof Error ? err.message : "Failed to load arrangement",
          );
          onBack();
        }
      }
    })();
    return () => {
      cancelled = true;
      stopTransport();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrangementId]);

  const persist = useEffectEvent(async () => {
    if (!isOwner) return;
    const clipsJson = JSON.stringify(clips);
    const nameTrim = name.trim();
    if (!nameTrim) return;
    if (
      clipsJson === savedClipsRef.current &&
      nameTrim === savedNameRef.current
    ) {
      setSaveState("idle");
      return;
    }
    setSaveState("saving");
    try {
      const patch: { name?: string; clips?: ArrangementClip[] } = {};
      if (nameTrim !== savedNameRef.current) patch.name = nameTrim;
      if (clipsJson !== savedClipsRef.current) patch.clips = clips;
      const updated = await api.updateArrangement(arrangementId, patch);
      savedClipsRef.current = JSON.stringify(updated.clips);
      savedNameRef.current = updated.name;
      setArrangement(updated);
      setClips(updated.clips);
      setName(updated.name);
      setSaveState("saved");
      onError(null);
    } catch (err) {
      setSaveState("error");
      onError(
        err instanceof Error ? err.message : "Failed to save arrangement",
      );
    }
  });

  useEffect(() => {
    if (!arrangement || !isOwner) return;
    const t = window.setTimeout(() => {
      void persist();
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [clips, name, arrangement, isOwner, persist]);

  async function onCopyHere() {
    setCopying(true);
    try {
      const row = await api.copyArrangement(arrangementId);
      onError(null);
      onOpen(row.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to copy");
    } finally {
      setCopying(false);
    }
  }

  function stopTransport() {
    setPlaying(false);
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastTsRef.current = null;
    for (const audio of audioRef.current.values()) {
      audio.pause();
    }
  }

  function syncAudio(at: number) {
    const active = new Set<string>();
    for (const clip of clipsRef.current) {
      const end = clip.startSec + clip.durationSec;
      if (at < clip.startSec || at >= end) continue;
      active.add(clip.instanceId);
      let audio = audioRef.current.get(clip.instanceId);
      if (!audio) {
        audio = new Audio(trackStreamUrl(clip.trackId));
        audio.preload = "auto";
        audioRef.current.set(clip.instanceId, audio);
      }
      const sourcePos = clip.offsetSec + (at - clip.startSec);
      if (Math.abs(audio.currentTime - sourcePos) > 0.35) {
        try {
          audio.currentTime = sourcePos;
        } catch {
          // ignore seek until metadata ready
        }
      }
      if (playRef.current && audio.paused) {
        void audio.play().catch(() => undefined);
      }
    }
    for (const [id, audio] of audioRef.current) {
      if (!active.has(id)) {
        audio.pause();
      }
    }
  }

  useEffect(() => {
    if (!playing) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTsRef.current = null;
      for (const audio of audioRef.current.values()) audio.pause();
      return;
    }

    const tick = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      const next = playheadRef.current + dt;
      const end = timelineEnd(clipsRef.current);
      if (next >= end) {
        setPlayheadSec(end);
        stopTransport();
        return;
      }
      setPlayheadSec(next);
      syncAudio(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    syncAudio(playheadRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const peakTrackKey = useMemo(
    () => [...new Set(clips.map((c) => c.trackId))].sort().join(","),
    [clips],
  );

  useEffect(() => {
    if (!peakTrackKey) return;
    const ids = peakTrackKey.split(",").filter(Boolean);
    let cancelled = false;
    void Promise.all(ids.map((id) => loadPeaks(id).catch(() => null))).then(
      () => {
        if (!cancelled) setPeaksVersion((v) => v + 1);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [peakTrackKey]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (
        isOwner &&
        (e.key === "Backspace" || e.key === "Delete") &&
        selectedId
      ) {
        e.preventDefault();
        setClips((prev) => prev.filter((c) => c.instanceId !== selectedId));
        setSelectedId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, isOwner]);

  const sidebarTracks = tracks.filter((t) => {
    if (!t.present) return false;
    if (filter === "commented" && t.comments.length === 0) return false;
    if (tagFilter) {
      const tags = unifiedTags(t.comments.map((c) => c.body));
      if (!tags.includes(tagFilter)) return false;
    }
    return true;
  });

  const lanes = laneCount(clips);
  const totalSec = timelineEnd(clips);
  const widthPx = Math.max(640, totalSec * pxPerSec);
  const selected = selectedId
    ? (clips.find((c) => c.instanceId === selectedId) ?? null)
    : null;
  const currentTrackId = hoveredTrackId ?? selected?.trackId ?? null;
  const currentTrack = currentTrackId
    ? (trackById.get(currentTrackId) ?? null)
    : null;
  const tickSec = rulerTickSec(pxPerSec);
  const rulerMarks: number[] = [];
  for (let t = 0; t <= totalSec + tickSec; t += tickSec) {
    rulerMarks.push(t);
  }

  function addTrackAt(trackId: string, startSec: number, lane: number) {
    const track = trackById.get(trackId);
    if (!track?.present) return;
    const dur =
      track.durationSeconds != null && track.durationSeconds > 0
        ? track.durationSeconds
        : 60;
    setClips((prev) => [
      ...prev,
      {
        instanceId: newInstanceId(),
        trackId,
        startSec: Math.max(0, startSec),
        offsetSec: 0,
        durationSec: dur,
        lane: Math.max(0, lane),
      },
    ]);
  }

  function onTimelineDrop(e: React.DragEvent) {
    e.preventDefault();
    if (!isOwner) return;
    const trackId =
      e.dataTransfer.getData(TRACK_MIME) ||
      e.dataTransfer.getData("text/plain");
    if (!trackId) return;
    const wrap = e.currentTarget as HTMLElement;
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left + wrap.scrollLeft;
    const y = e.clientY - rect.top + wrap.scrollTop;
    const startSec = Math.max(0, x / pxPerSec);
    const lane = Math.max(
      0,
      Math.min(lanes - 1, Math.floor((y - RULER_H) / LANE_H)),
    );
    addTrackAt(trackId, startSec, lane);
  }

  type DragKind =
    | { kind: "move"; id: string; grabOffset: number }
    | { kind: "trim-left"; id: string; fixedEnd: number; fixedOut: number }
    | { kind: "trim-right"; id: string; offsetSec: number; sourceDur: number };

  const dragRef = useRef<DragKind | null>(null);

  function onClipPointerDown(
    e: ReactPointerEvent,
    clip: ArrangementClip,
    zone: "body" | "left" | "right",
  ) {
    if (!isOwner) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(clip.instanceId);
    const el = e.currentTarget as HTMLElement;
    const timeline = el.closest(".arr-timeline") as HTMLElement | null;
    if (!timeline) return;
    el.setPointerCapture(e.pointerId);
    const track = trackById.get(clip.trackId);
    const sourceDur = sourceDuration(track, clip);

    if (zone === "left") {
      dragRef.current = {
        kind: "trim-left",
        id: clip.instanceId,
        fixedEnd: clip.startSec + clip.durationSec,
        fixedOut: clip.offsetSec + clip.durationSec,
      };
    } else if (zone === "right") {
      dragRef.current = {
        kind: "trim-right",
        id: clip.instanceId,
        offsetSec: clip.offsetSec,
        sourceDur,
      };
    } else {
      const rect = timeline.getBoundingClientRect();
      const x = e.clientX - rect.left + timeline.scrollLeft;
      dragRef.current = {
        kind: "move",
        id: clip.instanceId,
        grabOffset: x / pxPerSec - clip.startSec,
      };
    }

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const rect = timeline.getBoundingClientRect();
      const x = ev.clientX - rect.left + timeline.scrollLeft;
      const y = ev.clientY - rect.top + timeline.scrollTop;
      const at = Math.max(0, x / pxPerSec);

      setClips((prev) =>
        prev.map((c) => {
          if (c.instanceId !== d.id) return c;
          if (d.kind === "move") {
            const lane = Math.max(
              0,
              Math.min(lanes - 1, Math.floor((y - RULER_H) / LANE_H)),
            );
            return {
              ...c,
              startSec: Math.max(0, at - d.grabOffset),
              lane,
            };
          }
          if (d.kind === "trim-left") {
            const src = sourceDuration(trackById.get(c.trackId), c);
            const maxStart = d.fixedEnd - MIN_CLIP_SEC;
            const minStart = d.fixedEnd - Math.min(d.fixedOut, src);
            const startSec = Math.max(minStart, Math.min(maxStart, at));
            const durationSec = d.fixedEnd - startSec;
            const offsetSec = d.fixedOut - durationSec;
            return {
              ...c,
              startSec,
              durationSec,
              offsetSec: Math.max(0, offsetSec),
            };
          }
          const maxDur = Math.max(MIN_CLIP_SEC, d.sourceDur - d.offsetSec);
          const durationSec = Math.max(
            MIN_CLIP_SEC,
            Math.min(maxDur, at - c.startSec),
          );
          return { ...c, durationSec };
        }),
      );
    };

    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      dragRef.current = null;
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  if (!arrangement) {
    return (
      <div className="arr-root">
        <p className="arr-muted" style={{ padding: 12 }}>
          Loading arrangement…
        </p>
      </div>
    );
  }

  return (
    <div className="arr-root">
      <div className="arr-toolbar">
        <button type="button" className="filterButton" onClick={onBack}>
          ← list
        </button>
        <button type="button" className="filterButton" onClick={onCloseAll}>
          pool
        </button>
        <input
          className="arr-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Arrangement name"
          readOnly={!isOwner}
          disabled={!isOwner}
        />
        {!isOwner && (
          <span className="arr-muted">by {arrangement.userEmail}</span>
        )}
        {!isOwner && (
          <button
            type="button"
            className="filterButton"
            disabled={copying}
            onClick={() => void onCopyHere()}
          >
            {copying ? "copying…" : "copy to mine"}
          </button>
        )}
        <button
          type="button"
          className="filterButton"
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? "stop" : "play"}
        </button>
        <button
          type="button"
          className="filterButton"
          onClick={() => setPxPerSec((p) => Math.max(PX_PER_SEC_MIN, p / 1.25))}
        >
          −
        </button>
        <button
          type="button"
          className="filterButton"
          onClick={() => setPxPerSec((p) => Math.min(PX_PER_SEC_MAX, p * 1.25))}
        >
          +
        </button>
        <span className="arr-muted">
          ▶ {formatClock(playheadSec)} · {clips.length} clips ·{" "}
          {formatPxPerSec(pxPerSec)} px/s
        </span>
        <span className="arr-clip-times" aria-live="polite">
          {selected
            ? `@ ${formatClock(selected.startSec)} · in ${formatClock(selected.offsetSec)} – out ${formatClock(selected.offsetSec + selected.durationSec)} · ${formatClock(selected.durationSec)}`
            : "no clip selected"}
        </span>
        {isOwner ? (
          <span
            className={[
              "arr-save",
              saveState === "error" ? "save-error" : "",
              saveState === "saved" ? "save-ok" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {saveState === "saving"
              ? "saving…"
              : saveState === "saved"
                ? "saved"
                : saveState === "error"
                  ? "save failed"
                  : ""}
          </span>
        ) : (
          <span className="arr-save">read-only</span>
        )}
        <span className="arr-hint">
          {isOwner
            ? "drag tracks → timeline · edges trim · space play · del remove"
            : "space play · copy to edit"}
        </span>
      </div>

      <div className="arr-body">
        <aside className="arr-sidebar">
          <div className="arr-sidebar-filters">
            {(
              [
                ["all", "all"],
                ["commented", "commented"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={
                  filter === id && !tagFilter
                    ? "filterButton filterSelected"
                    : "filterButton"
                }
                onClick={() => {
                  setFilter(id);
                  setTagFilter(null);
                }}
              >
                {label}
              </button>
            ))}
            <span className="arr-muted">{sidebarTracks.length}</span>
            {tagFilter && (
              <button
                type="button"
                className="tagButton"
                onClick={() => setTagFilter(null)}
              >
                clear #{tagFilter}
              </button>
            )}
          </div>
          <div className="arr-sidebar-list">
            {sidebarTracks.map((t) => {
              const tags = unifiedTags(t.comments.map((c) => c.body));
              return (
                <div
                  key={t.id}
                  className={
                    hoveredTrackId === t.id
                      ? "arr-sidebar-item arr-sidebar-item-current"
                      : "arr-sidebar-item"
                  }
                  draggable={isOwner}
                  onMouseEnter={() => setHoveredTrackId(t.id)}
                  onMouseLeave={() => setHoveredTrackId(null)}
                  onDragStart={(e) => {
                    if (!isOwner) {
                      e.preventDefault();
                      return;
                    }
                    e.dataTransfer.setData(TRACK_MIME, t.id);
                    e.dataTransfer.setData("text/plain", t.id);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  title={t.filename}
                >
                  <div className="arr-sidebar-item-main">
                    <span className="arr-sidebar-dur">
                      {t.durationSeconds != null
                        ? formatClock(t.durationSeconds)
                        : "—"}
                    </span>
                    <span className="arr-sidebar-name">
                      {shortName(t.filename)}
                    </span>
                  </div>
                  {tags.length > 0 && (
                    <div className="arr-sidebar-tags">
                      {tags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          className={
                            tagFilter === tag
                              ? "tagButton tagButtonSelected"
                              : "tagButton"
                          }
                          draggable={false}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setTagFilter(tag);
                          }}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        <div className="arr-main">
          <div
            className={
              isOwner
                ? "arr-timeline-wrap"
                : "arr-timeline-wrap arr-timeline-readonly"
            }
            onDragOver={(e) => {
              if (isOwner) e.preventDefault();
            }}
            onDrop={onTimelineDrop}
            onClick={() => setSelectedId(null)}
          >
            <div className="arr-timeline" style={{ width: widthPx }}>
              <div className="arr-ruler" style={{ height: RULER_H }}>
                {rulerMarks.map((t) => (
                  <div
                    key={t}
                    className="arr-ruler-tick"
                    style={{ left: t * pxPerSec }}
                  >
                    <span className="arr-ruler-label">{formatClock(t)}</span>
                  </div>
                ))}
              </div>
              <div
                className="arr-playhead"
                style={{ left: playheadSec * pxPerSec }}
              />
              <div className="arr-lanes" style={{ marginTop: RULER_H }}>
                {Array.from({ length: lanes }, (_, lane) => (
                  <div
                    key={lane}
                    className="arr-lane"
                    style={{
                      height: LANE_H,
                      background: lane % 2 === 0 ? "#1e2124" : "#22262a",
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      const wrap = e.currentTarget.closest(".arr-timeline")!;
                      const rect = wrap.getBoundingClientRect();
                      const x = e.clientX - rect.left + wrap.scrollLeft;
                      const at = Math.max(0, x / pxPerSec);
                      setPlayheadSec(at);
                      syncAudio(at);
                    }}
                  />
                ))}
                {clips.map((clip) => {
                  const track = trackById.get(clip.trackId);
                  const isSelected = clip.instanceId === selectedId;
                  const clipW = Math.max(8, clip.durationSec * pxPerSec);
                  const clipH = LANE_H - 8;
                  return (
                    <div
                      key={clip.instanceId}
                      className={
                        isSelected ? "arr-clip arr-clip-selected" : "arr-clip"
                      }
                      style={{
                        left: clip.startSec * pxPerSec,
                        width: clipW,
                        top: clip.lane * LANE_H + 4,
                        height: clipH,
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedId(clip.instanceId);
                      }}
                      onPointerDown={(e) => onClipPointerDown(e, clip, "body")}
                      title={track?.filename ?? clip.trackId}
                    >
                      <div
                        className="arr-clip-handle left"
                        onPointerDown={(e) =>
                          onClipPointerDown(e, clip, "left")
                        }
                      />
                      <div className="arr-clip-body">
                        <ClipWaveform
                          trackId={clip.trackId}
                          offsetSec={clip.offsetSec}
                          durationSec={clip.durationSec}
                          width={Math.max(1, clipW - 12)}
                          height={clipH}
                          peaksVersion={peaksVersion}
                        />
                        <span className="arr-clip-label">
                          {track ? shortName(track.filename) : "?"}
                          {clip.offsetSec > 0.05
                            ? ` @${formatClock(clip.offsetSec)}`
                            : ""}
                        </span>
                      </div>
                      <div
                        className="arr-clip-handle right"
                        onPointerDown={(e) =>
                          onClipPointerDown(e, clip, "right")
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <ClipCommentsPanel track={currentTrack} />
        </div>
      </div>
    </div>
  );
}

function ClipCommentsPanel({ track }: { track: Track | null }) {
  if (!track) {
    return (
      <div className="arr-comments" aria-live="polite">
        <div className="arr-comments-empty">
          Select a clip or hover a track to see its comments.
        </div>
      </div>
    );
  }

  const comments = track.comments;
  return (
    <div className="arr-comments" aria-live="polite">
      <div className="arr-comments-header">
        <span className="arr-comments-title">{shortName(track.filename)}</span>
        <span className="arr-muted">
          {comments.length === 0
            ? "no comments"
            : `${comments.length} comment${comments.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {comments.length === 0 ? (
        <div className="arr-comments-empty">No comments on this track.</div>
      ) : (
        <ul className="arr-comments-list">
          {comments.map((c) => (
            <CommentRow key={c.id} comment={c} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CommentRow({ comment }: { comment: Comment }) {
  return (
    <li className="arr-comment">
      <span className="arr-comment-email">{comment.userEmail}</span>
      <span className="arr-comment-body">{comment.body}</span>
    </li>
  );
}
