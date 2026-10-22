import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  api,
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
import {
  createPlaybackEngine,
  PLAYBACK_MODES,
  type ClipVoice,
  type PlaybackEngine,
  type PlaybackMode,
} from "./arrangePlayback";

const AUTOSAVE_MS = 600;
const MIN_CLIP_SEC = 0.5;

function arrangementSnapshot(name: string, clips: ArrangementClip[]) {
  return JSON.stringify({ name, clips });
}

const ROW_WAVE_H = 40;
const EDITOR_WAVE_H = 96;
const PX_PER_SEC_DEFAULT = 24;
const PX_PER_SEC_MIN = 2;
const PX_PER_SEC_MAX = 200;
const EDITOR_PX_DEFAULT = 40;
/** Cap canvas backing-store width — huge tracks × zoom × DPR can blank the GPU. */
const MAX_CANVAS_BACKING_PX = 8192;
/** Soft cap on editor CSS width before we force-fit zoom. */
const MAX_EDITOR_CSS_PX = 4096;
const TRACK_MIME = "application/x-iff-track-id";
const CLIP_MIME = "application/x-iff-clip-id";

type FilterId = "all" | "commented";

type ScheduleSeg = {
  clip: ArrangementClip;
  arrStart: number;
  arrEnd: number;
  kind: "audio" | "pause";
};

/**
 * Voice for a clip instance (the current or next one) while the transport
 * runs. `gen` bumps whenever a pending load/start becomes stale.
 */
type VoiceSlot = {
  instanceId: string;
  trackId: string;
  voice: ClipVoice;
  state: "idle" | "loading" | "ready" | "started" | "failed";
  gen: number;
};

/** Restart a voice only after an explicit seek (not rAF vs audio clock drift). */
const SEEK_JUMP_SEC = 0.3;
/** Start the next clip this far ahead so the engine can schedule it on time. */
const LOOKAHEAD_SEC = 0.2;
/** Show "loading…" only when audio is held up longer than this. */
const WAITING_HINT_MS = 200;
const PLAYBACK_MODE_KEY = "iff-arrange-playback";

function readPlaybackMode(): PlaybackMode {
  try {
    const raw = localStorage.getItem(PLAYBACK_MODE_KEY);
    return raw === "precise" ? "precise" : "stream";
  } catch {
    return "stream";
  }
}

function audioSegAt(segs: ScheduleSeg[], at: number) {
  return segs.find(
    (s) => s.kind === "audio" && at >= s.arrStart && at < s.arrEnd,
  );
}

/**
 * Playhead time kept outside React state: the transport updates it every
 * frame, and only the small components that display it re-render.
 */
type PlayheadStore = {
  get: () => number;
  set: (sec: number) => void;
  subscribe: (listener: () => void) => () => void;
};

function createPlayheadStore(): PlayheadStore {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(sec) {
      if (sec === value) return;
      value = sec;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Re-renders only when `select(playhead)` changes. */
function usePlayhead<T>(store: PlayheadStore, select: (sec: number) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

function PlayheadClock({ store }: { store: PlayheadStore }) {
  return <>{usePlayhead(store, formatClock)}</>;
}

/** Playhead line inside a sequence row; renders nothing outside the row's span. */
function RowPlayhead({
  store,
  arrStart,
  arrEnd,
  pxPerSec,
}: {
  store: PlayheadStore;
  arrStart: number;
  arrEnd: number;
  pxPerSec: number;
}) {
  const left = usePlayhead(store, (sec) =>
    sec >= arrStart && sec < arrEnd
      ? Math.round((sec - arrStart) * pxPerSec)
      : null,
  );
  if (left == null) return null;
  return <div className="arr-row-playhead" style={{ left }} />;
}

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

function formatPxPerSec(n: number) {
  if (n >= 10) return n.toFixed(0);
  if (n >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

function shortName(filename: string) {
  return filename.replace(/\.aif\.mp3$/i, "").replace(/\.mp3$/i, "");
}

function sanitizeDownloadName(name: string) {
  const cleaned = name
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return cleaned || "arrangement";
}

function formatExportNumber(n: number) {
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

/** TSV cut list: filename, inSec, outSec, pauseSec, gain. */
function buildArrangementTsv(
  clips: ArrangementClip[],
  trackById: Map<string, Track>,
) {
  const lines = ["filename\tinSec\toutSec\tpauseSec\tgain"];
  for (const clip of clips) {
    const track = trackById.get(clip.trackId);
    const filename = (track?.filename ?? `missing:${clip.trackId}`).replace(
      /[\t\r\n]+/g,
      " ",
    );
    lines.push(
      [
        filename,
        formatExportNumber(clip.inSec),
        formatExportNumber(clip.outSec),
        formatExportNumber(clip.pauseSec),
        formatExportNumber(clip.gain),
      ].join("\t"),
    );
  }
  return lines.join("\n") + "\n";
}

function downloadTextFile(filename: string, body: string, mime: string) {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function clipDuration(clip: ArrangementClip) {
  return Math.max(MIN_CLIP_SEC, clip.outSec - clip.inSec);
}

function sourceDuration(track: Track | undefined, peaks: PeaksRecord | null) {
  if (track?.durationSeconds != null && track.durationSeconds > 0) {
    return track.durationSeconds;
  }
  if (peaks && peaks.durationSec > 0) return peaks.durationSec;
  return 60;
}

function buildSchedule(clips: ArrangementClip[]): {
  segs: ScheduleSeg[];
  totalSec: number;
} {
  const segs: ScheduleSeg[] = [];
  let t = 0;
  for (const clip of clips) {
    const dur = clipDuration(clip);
    segs.push({
      clip,
      arrStart: t,
      arrEnd: t + dur,
      kind: "audio",
    });
    t += dur;
    if (clip.pauseSec > 0) {
      segs.push({
        clip,
        arrStart: t,
        arrEnd: t + clip.pauseSec,
        kind: "pause",
      });
      t += clip.pauseSec;
    }
  }
  return { segs, totalSec: Math.max(t, 0.001) };
}

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) {
    return arr;
  }
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

function ClipWaveform({
  trackId,
  offsetSec,
  durationSec,
  width,
  height,
  peaksVersion,
  dimOutside,
  sourceDurHint,
}: {
  trackId: string;
  offsetSec: number;
  durationSec: number;
  width: number;
  height: number;
  peaksVersion: number;
  /** When set, draw full source and dim outside [offset, offset+duration]. */
  dimOutside?: boolean;
  sourceDurHint?: number;
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

    if (dimOutside) {
      drawClipWaveform(ctx, rec.peaks, srcDur, 0, srcDur, cssW, cssH);
      const x0 = (offsetSec / srcDur) * cssW;
      const x1 = ((offsetSec + durationSec) / srcDur) * cssW;
      ctx.fillStyle = "rgba(20, 22, 24, 0.55)";
      ctx.fillRect(0, 0, Math.max(0, x0), cssH);
      ctx.fillRect(Math.min(cssW, x1), 0, Math.max(0, cssW - x1), cssH);
      ctx.fillStyle = "rgba(232, 93, 76, 0.12)";
      ctx.fillRect(x0, 0, Math.max(0, x1 - x0), cssH);
    } else {
      drawClipWaveform(
        ctx,
        rec.peaks,
        srcDur,
        offsetSec,
        durationSec,
        cssW,
        cssH,
      );
    }
  }, [
    rec,
    offsetSec,
    durationSec,
    width,
    height,
    peaksVersion,
    dimOutside,
    sourceDurHint,
  ]);

  return <canvas ref={canvasRef} className="arr-clip-wave" aria-hidden />;
}

export function ArrangeShell({
  user,
  tracks,
  hideReleased,
  onHideReleasedChange,
  onBack,
  onError,
}: {
  user: User;
  tracks: Track[];
  hideReleased: boolean;
  onHideReleasedChange: (value: boolean) => void;
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
        hideReleased={hideReleased}
        onHideReleasedChange={onHideReleasedChange}
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
            No arrangements yet. Create one, then drag tracks into the sequence.
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
  hideReleased,
  onHideReleasedChange,
  onBack,
  onOpen,
  onCloseAll,
  onError,
}: {
  arrangementId: string;
  user: User;
  tracks: Track[];
  hideReleased: boolean;
  onHideReleasedChange: (value: boolean) => void;
  onBack: () => void;
  onOpen: (id: string) => void;
  onCloseAll: () => void;
  onError: (message: string | null) => void;
}) {
  const [arrangement, setArrangement] = useState<Arrangement | null>(null);
  const [clips, setClips] = useState<ArrangementClip[]>([]);
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredTrackId, setHoveredTrackId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState(PX_PER_SEC_DEFAULT);
  const [editorPxPerSec, setEditorPxPerSec] = useState(EDITOR_PX_DEFAULT);
  const [playing, setPlaying] = useState(false);
  const [playhead] = useState(createPlayheadStore);
  const setPlayheadSec = playhead.set;
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [copying, setCopying] = useState(false);
  const [peaksVersion, setPeaksVersion] = useState(0);
  const [dragClipId, setDragClipId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  /** When set, transport stops at this arrangement time (solo clip audition). */
  const [soloEndSec, setSoloEndSec] = useState<number | null>(null);
  const [soloClipId, setSoloClipId] = useState<string | null>(null);

  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const playRef = useRef(playing);
  playRef.current = playing;
  const soloEndRef = useRef<number | null>(null);
  soloEndRef.current = soloEndSec;
  const savedSnapshotRef = useRef("");
  const saveSeqRef = useRef(0);

  const [playbackMode, setPlaybackMode] =
    useState<PlaybackMode>(readPlaybackMode);
  /** Audio for the clip under the playhead is taking a while to start. */
  const [audioWaiting, setAudioWaiting] = useState(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const playbackModeRef = useRef(playbackMode);
  const engineRef = useRef<PlaybackEngine | null>(null);
  /** Voices for the current and next clip instance, by instanceId. */
  const slotsRef = useRef<Map<string, VoiceSlot>>(new Map());
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  /** Previous sync playhead — large jumps mean the user seeked. */
  const lastSyncAtRef = useRef(0);
  /** Frame timestamp since which the clip under the playhead waits for audio. */
  const waitingSinceRef = useRef<number | null>(null);
  const audioWaitingRef = useRef(false);

  const trackById = useMemo(() => {
    const m = new Map<string, Track>();
    for (const t of tracks) m.set(t.id, t);
    return m;
  }, [tracks]);

  const tagsByTrack = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of tracks) {
      m.set(t.id, unifiedTags(t.comments.map((c) => c.body)));
    }
    return m;
  }, [tracks]);

  const isOwner = arrangement?.userId === user.id;
  const { segs, totalSec } = useMemo(() => buildSchedule(clips), [clips]);
  const segsRef = useRef(segs);
  segsRef.current = segs;
  const totalSecRef = useRef(totalSec);
  totalSecRef.current = totalSec;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const row = await api.getArrangement(arrangementId);
        if (cancelled) return;
        savedSnapshotRef.current = arrangementSnapshot(row.name, row.clips);
        saveSeqRef.current += 1;
        setArrangement(row);
        setClips(row.clips);
        setName(row.name);
        setSelectedId(null);
        playhead.set(0);
        setPlaying(false);
        setSaveState("idle");
        onError(null);
      } catch (err) {
        if (!cancelled) {
          onError(
            err instanceof Error ? err.message : "Failed to load arrangement",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [arrangementId, playhead]);

  const persist = useEffectEvent(
    async (nextName: string, nextClips: ArrangementClip[]) => {
      if (!arrangement || !isOwner) return;
      const snap = arrangementSnapshot(nextName, nextClips);
      if (snap === savedSnapshotRef.current) {
        setSaveState("idle");
        return;
      }
      const seq = ++saveSeqRef.current;
      setSaveState("saving");
      try {
        let savedName = "";
        let savedClips: ArrangementClip[] = [];
        try {
          const saved = JSON.parse(savedSnapshotRef.current) as {
            name: string;
            clips: ArrangementClip[];
          };
          savedName = saved.name;
          savedClips = saved.clips;
        } catch {
          /* first save after a bad/empty snapshot */
        }
        const patch: { name?: string; clips?: ArrangementClip[] } = {};
        if (nextName !== savedName) patch.name = nextName;
        if (JSON.stringify(nextClips) !== JSON.stringify(savedClips)) {
          patch.clips = nextClips;
        }
        if (patch.name === undefined && patch.clips === undefined) {
          savedSnapshotRef.current = snap;
          setSaveState("idle");
          return;
        }
        const updated = await api.updateArrangement(arrangementId, patch);
        if (seq !== saveSeqRef.current) return;
        // Keep local draft as source of truth so server normalization
        // (gain clamp, etc.) does not immediately re-dirty the editor.
        const committedName = updated.name;
        savedSnapshotRef.current = arrangementSnapshot(committedName, nextClips);
        if (committedName !== nextName) setName(committedName);
        setArrangement((prev) =>
          prev
            ? {
                ...prev,
                name: committedName,
                clips: nextClips,
                updatedAt: updated.updatedAt,
              }
            : prev,
        );
        setSaveState("saved");
        onError(null);
      } catch (err) {
        if (seq !== saveSeqRef.current) return;
        setSaveState("error");
        onError(
          err instanceof Error ? err.message : "Failed to save arrangement",
        );
      }
    },
  );

  useEffect(() => {
    if (!isOwner) return;
    if (arrangementSnapshot(name, clips) === savedSnapshotRef.current) {
      return;
    }
    const t = window.setTimeout(() => {
      void persist(name, clips);
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [clips, name, isOwner, persist]);

  function ensureAudioCtx() {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  }

  function ensureEngine() {
    const mode = playbackModeRef.current;
    if (engineRef.current?.mode !== mode) {
      releaseEngine();
      engineRef.current = createPlaybackEngine(mode, ensureAudioCtx());
    }
    return engineRef.current;
  }

  function releaseSlot(slot: VoiceSlot) {
    slot.gen += 1;
    slot.voice.dispose();
    slotsRef.current.delete(slot.instanceId);
  }

  function releaseAllSlots() {
    for (const slot of [...slotsRef.current.values()]) releaseSlot(slot);
  }

  function releaseEngine() {
    releaseAllSlots();
    engineRef.current?.dispose();
    engineRef.current = null;
  }

  /** Silence a slot but keep what it loaded; failed slots get another try. */
  function stopSlot(slot: VoiceSlot) {
    if (slot.state === "started") {
      slot.gen += 1;
      slot.voice.stop();
      slot.state = "ready";
    } else if (slot.state === "failed") {
      slot.state = "idle";
    }
  }

  function stopAllVoices() {
    for (const slot of slotsRef.current.values()) stopSlot(slot);
  }

  function ensureSlot(clip: ArrangementClip) {
    const existing = slotsRef.current.get(clip.instanceId);
    if (existing && existing.trackId === clip.trackId) return existing;
    if (existing) releaseSlot(existing);
    const slot: VoiceSlot = {
      instanceId: clip.instanceId,
      trackId: clip.trackId,
      voice: ensureEngine().createVoice(clip.trackId),
      state: "idle",
      gen: 0,
    };
    slotsRef.current.set(clip.instanceId, slot);
    return slot;
  }

  /** False once the slot was released or a newer load/start superseded `gen`. */
  function isSlotCurrent(slot: VoiceSlot, gen: number) {
    return slotsRef.current.get(slot.instanceId) === slot && slot.gen === gen;
  }

  function loadSlot(slot: VoiceSlot, offsetSec: number) {
    const gen = ++slot.gen;
    slot.state = "loading";
    slot.voice.load(offsetSec).then(
      () => {
        // The next sync starts it from wherever the playhead is by then.
        if (isSlotCurrent(slot, gen)) slot.state = "ready";
      },
      (err: unknown) => {
        if (!isSlotCurrent(slot, gen)) return;
        slot.state = "failed";
        onError(err instanceof Error ? err.message : "Failed to load audio");
      },
    );
  }

  function startSlot(
    slot: VoiceSlot,
    clip: ArrangementClip,
    offsetSec: number,
    durSec: number,
    delaySec: number,
  ) {
    const gen = ++slot.gen;
    slot.state = "started";
    slot.voice.setGain(clip.gain);
    slot.voice.start(offsetSec, durSec, delaySec).catch((err: unknown) => {
      if (!isSlotCurrent(slot, gen)) return;
      slot.state = "failed";
      onError(err instanceof Error ? err.message : "Failed to play audio");
    });
  }

  function setWaitingHint(value: boolean) {
    if (audioWaitingRef.current === value) return;
    audioWaitingRef.current = value;
    setAudioWaiting(value);
  }

  function stopTransport() {
    setPlaying(false);
    setSoloEndSec(null);
    setSoloClipId(null);
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastTsRef.current = null;
    waitingSinceRef.current = null;
    setWaitingHint(false);
    stopAllVoices();
  }

  /**
   * Line voices up with the playhead: the clip under it plays, the next one
   * loads and, once within LOOKAHEAD_SEC, is scheduled to start on time.
   * Everything else is released.
   */
  function syncAudio(at: number, forceSeek = false) {
    if (!playRef.current) {
      stopAllVoices();
      return;
    }

    const seeked =
      forceSeek || Math.abs(at - lastSyncAtRef.current) > SEEK_JUMP_SEC;
    lastSyncAtRef.current = at;
    if (seeked) stopAllVoices();

    const segs = segsRef.current;
    const soloEnd = soloEndRef.current;
    const cur = audioSegAt(segs, at);
    const next = segs.find(
      (s) =>
        s.kind === "audio" &&
        s !== cur &&
        s.arrStart >= at &&
        (soloEnd == null || s.arrStart < soloEnd - 0.001),
    );
    const keep = new Set<string>();
    let curSlot: VoiceSlot | null = null;

    if (cur && cur.arrEnd - at > 0.001) {
      keep.add(cur.clip.instanceId);
      const slot = (curSlot = ensureSlot(cur.clip));
      const offset = cur.clip.inSec + (at - cur.arrStart);
      if (slot.state === "idle") {
        loadSlot(slot, offset);
      } else if (slot.state === "ready") {
        startSlot(slot, cur.clip, offset, cur.arrEnd - at, 0);
      } else if (slot.state === "started") {
        slot.voice.setGain(cur.clip.gain);
      }
    }

    if (next) {
      keep.add(next.clip.instanceId);
      const slot = ensureSlot(next.clip);
      const delay = next.arrStart - at;
      // Let the clip under the playhead load first.
      if (slot.state === "idle" && (!curSlot || curSlot.state === "started")) {
        loadSlot(slot, next.clip.inSec);
      } else if (slot.state === "ready" && delay <= LOOKAHEAD_SEC) {
        startSlot(
          slot,
          next.clip,
          next.clip.inSec,
          next.arrEnd - next.arrStart,
          delay,
        );
      }
    }

    for (const slot of [...slotsRef.current.values()]) {
      if (!keep.has(slot.instanceId)) releaseSlot(slot);
    }
  }

  /**
   * Playhead for this frame. Inside a clip it follows that clip's audio and
   * holds while the audio loads; in pauses (or after a failure) it runs on
   * the frame clock.
   */
  function advancePlayhead(at: number, dt: number, ts: number) {
    let next = at + dt;
    let waiting = false;
    const seg = audioSegAt(segsRef.current, at);
    if (seg) {
      const slot = slotsRef.current.get(seg.clip.instanceId);
      const started = slot?.state === "started";
      const pos = started ? slot.voice.sourcePosition() : null;
      if (pos != null) {
        next = Math.max(at, seg.arrStart + (pos - seg.clip.inSec));
      } else if (slot?.state !== "failed" && !(started && slot.voice.ended())) {
        next = at;
        waiting = true;
      }
    }
    if (!waiting) waitingSinceRef.current = null;
    else waitingSinceRef.current ??= ts;
    setWaitingHint(
      waitingSinceRef.current != null &&
        ts - waitingSinceRef.current > WAITING_HINT_MS,
    );
    return next;
  }

  function changePlaybackMode(mode: PlaybackMode) {
    if (mode === playbackModeRef.current) return;
    stopTransport();
    releaseEngine();
    playbackModeRef.current = mode;
    setPlaybackMode(mode);
    try {
      localStorage.setItem(PLAYBACK_MODE_KEY, mode);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    return () => {
      releaseEngine();
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
    };
  }, []);

  // Keep gains in sync; drop voices for removed clips.
  useEffect(() => {
    const alive = new Set(clips.map((c) => c.instanceId));
    for (const slot of [...slotsRef.current.values()]) {
      if (!alive.has(slot.instanceId)) releaseSlot(slot);
    }
    for (const clip of clips) {
      slotsRef.current.get(clip.instanceId)?.voice.setGain(clip.gain);
    }
  }, [clips]);

  const peakTrackKey = useMemo(
    () => [...new Set(clips.map((c) => c.trackId))].sort().join(","),
    [clips],
  );

  useEffect(() => {
    if (!playing) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTsRef.current = null;
      stopAllVoices();
      return;
    }

    const tick = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dt = Math.min(0.1, (ts - lastTsRef.current) / 1000);
      lastTsRef.current = ts;
      const next = advancePlayhead(playhead.get(), dt, ts);
      const soloEnd = soloEndRef.current;
      if (soloEnd != null && next >= soloEnd) {
        setPlayheadSec(soloEnd);
        stopTransport();
        return;
      }
      const end = totalSecRef.current;
      if (next >= end) {
        setPlayheadSec(end);
        stopTransport();
        return;
      }
      setPlayheadSec(next);
      syncAudio(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    void ensureAudioCtx().resume();
    syncAudio(playhead.get(), true);
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

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
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (playing) stopTransport();
        else {
          setSoloEndSec(null);
          setSoloClipId(null);
          setPlaying(true);
        }
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
  }, [selectedId, isOwner, playing]);

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

  const sidebarTracks = tracks.filter((t) => {
    if (!t.present) return false;
    if (hideReleased && t.releasedOn) return false;
    if (filter === "commented" && t.comments.length === 0) return false;
    if (tagFilter && !tagsByTrack.get(t.id)?.includes(tagFilter)) {
      return false;
    }
    return true;
  });

  const selected = selectedId
    ? (clips.find((c) => c.instanceId === selectedId) ?? null)
    : null;
  const currentTrackId = hoveredTrackId ?? selected?.trackId ?? null;
  const currentTrack = currentTrackId
    ? (trackById.get(currentTrackId) ?? null)
    : null;

  function addTrack(trackId: string, atIndex?: number) {
    const track = trackById.get(trackId);
    if (!track?.present) return;
    const dur =
      track.durationSeconds != null && track.durationSeconds > 0
        ? track.durationSeconds
        : 60;
    const item: ArrangementClip = {
      instanceId: newInstanceId(),
      trackId,
      inSec: 0,
      outSec: dur,
      pauseSec: 0,
      gain: 1,
    };
    setClips((prev) => {
      if (atIndex == null || atIndex < 0 || atIndex >= prev.length) {
        return [...prev, item];
      }
      const next = [...prev];
      next.splice(atIndex, 0, item);
      return next;
    });
    setSelectedId(item.instanceId);
    const fit = MAX_EDITOR_CSS_PX / Math.max(dur, MIN_CLIP_SEC);
    setEditorPxPerSec(
      Math.min(EDITOR_PX_DEFAULT, Math.max(PX_PER_SEC_MIN, fit)),
    );
  }

  function updateClip(
    id: string,
    patch: Partial<
      Pick<ArrangementClip, "inSec" | "outSec" | "pauseSec" | "gain">
    >,
  ) {
    setClips((prev) =>
      prev.map((c) => {
        if (c.instanceId !== id) return c;
        const track = trackById.get(c.trackId);
        const src = sourceDuration(track, getCachedPeaks(c.trackId) ?? null);
        let inSec = patch.inSec ?? c.inSec;
        let outSec = patch.outSec ?? c.outSec;
        inSec = Math.max(0, Math.min(inSec, src - MIN_CLIP_SEC));
        outSec = Math.max(inSec + MIN_CLIP_SEC, Math.min(outSec, src));
        return {
          ...c,
          inSec,
          outSec,
          pauseSec:
            patch.pauseSec !== undefined
              ? Math.max(0, patch.pauseSec)
              : c.pauseSec,
          gain:
            patch.gain !== undefined
              ? Math.min(2, Math.max(0, patch.gain))
              : c.gain,
        };
      }),
    );
  }

  function selectClip(id: string) {
    setSelectedId(id);
    const clip = clipsRef.current.find((c) => c.instanceId === id);
    if (!clip) return;
    const track = trackById.get(clip.trackId);
    const src = sourceDuration(track, getCachedPeaks(clip.trackId) ?? null);
    // Fit full source into a safe editor width so long tracks don't blow the layout.
    const fit = MAX_EDITOR_CSS_PX / Math.max(src, MIN_CLIP_SEC);
    setEditorPxPerSec(
      Math.min(EDITOR_PX_DEFAULT, Math.max(PX_PER_SEC_MIN, fit)),
    );
  }

  function clearDrag() {
    setDragClipId(null);
    setDropIndex(null);
  }

  function onSequenceDrop(e: React.DragEvent, insertIndex: number) {
    e.preventDefault();
    e.stopPropagation();
    clearDrag();
    if (!isOwner) return;
    const clipId =
      e.dataTransfer.getData(CLIP_MIME) ||
      e.dataTransfer.getData("text/clip-id");
    if (clipId) {
      setClips((prev) => {
        const from = prev.findIndex((c) => c.instanceId === clipId);
        if (from < 0) return prev;
        let to = insertIndex;
        if (from < to) to -= 1;
        return moveItem(prev, from, Math.max(0, Math.min(prev.length - 1, to)));
      });
      return;
    }
    const trackId =
      e.dataTransfer.getData(TRACK_MIME) ||
      e.dataTransfer.getData("text/plain");
    if (trackId) addTrack(trackId, insertIndex);
  }

  function seekToArrangement(at: number) {
    const clamped = Math.max(0, Math.min(totalSec, at));
    setPlayheadSec(clamped);
    syncAudio(clamped, true);
  }

  /** Play full arrangement from current playhead (clears solo). */
  function toggleArrangementPlay() {
    if (playing) {
      stopTransport();
      return;
    }
    soloEndRef.current = null;
    setSoloEndSec(null);
    setSoloClipId(null);
    setPlaying(true);
  }

  /** Audition one clip from selection start (inSec) through outSec, then stop. */
  function playClipSelection(clip: ArrangementClip) {
    const seg = segsRef.current.find(
      (s) => s.kind === "audio" && s.clip.instanceId === clip.instanceId,
    );
    if (!seg) return;
    if (playing && soloClipId === clip.instanceId) {
      stopTransport();
      return;
    }
    stopAllVoices();
    soloEndRef.current = seg.arrEnd;
    setSoloEndSec(seg.arrEnd);
    setSoloClipId(clip.instanceId);
    setPlayheadSec(seg.arrStart);
    if (!playing) {
      setPlaying(true);
    } else {
      syncAudio(seg.arrStart, true);
    }
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
          onClick={() => toggleArrangementPlay()}
        >
          {playing ? "stop" : "play"}
        </button>
        <span className="arr-mode-toggle" role="group" aria-label="Playback mode">
          {PLAYBACK_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={
                playbackMode === m
                  ? "filterButton filterSelected"
                  : "filterButton"
              }
              aria-pressed={playbackMode === m}
              title={
                m === "stream"
                  ? "Stream audio (light; transitions within ~50 ms)"
                  : "Decode current and next clip (gapless; waits to load)"
              }
              onClick={() => changePlaybackMode(m)}
            >
              {m}
            </button>
          ))}
        </span>
        {playing && audioWaiting && (
          <span className="arr-muted">loading…</span>
        )}
        <button
          type="button"
          className="filterButton"
          disabled={clips.length === 0}
          title="Download TSV cut list (filename, in, out, pause, gain)"
          onClick={() => {
            const body = buildArrangementTsv(clips, trackById);
            downloadTextFile(
              `${sanitizeDownloadName(name)}.tsv`,
              body,
              "text/tab-separated-values;charset=utf-8",
            );
          }}
        >
          export
        </button>
        <button
          type="button"
          className="filterButton"
          onClick={() => setPxPerSec((p) => Math.max(PX_PER_SEC_MIN, p / 1.25))}
          title="Zoom out sequence"
        >
          −
        </button>
        <button
          type="button"
          className="filterButton"
          onClick={() => setPxPerSec((p) => Math.min(PX_PER_SEC_MAX, p * 1.25))}
          title="Zoom in sequence"
        >
          +
        </button>
        <span className="arr-muted">
          ▶ <PlayheadClock store={playhead} /> / {formatClock(totalSec)} ·{" "}
          {clips.length} clips · {formatPxPerSec(pxPerSec)} px/s
        </span>
        <span className="arr-clip-times" aria-live="polite">
          {selected
            ? `in ${formatClock(selected.inSec)} – out ${formatClock(selected.outSec)} · ${formatClock(clipDuration(selected))} · pause ${formatClock(selected.pauseSec)} · ×${selected.gain.toFixed(2)}`
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
            ? "drag tracks → sequence · reorder rows · select to trim · space play · del remove"
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
            <button
              type="button"
              className={
                hideReleased ? "filterButton filterSelected" : "filterButton"
              }
              onClick={() => onHideReleasedChange(!hideReleased)}
              title="Hide tracks that already have a release label"
            >
              {hideReleased ? "rel hidden" : "rel shown"}
            </button>
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
              const tags = tagsByTrack.get(t.id) ?? [];
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
                  onDoubleClick={() => {
                    if (isOwner) addTrack(t.id);
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
                ? "arr-sequence-wrap"
                : "arr-sequence-wrap arr-sequence-readonly"
            }
            onDragOver={(e) => {
              if (isOwner) e.preventDefault();
            }}
            onDrop={(e) => onSequenceDrop(e, clips.length)}
            onDragEnd={clearDrag}
          >
            {clips.length === 0 ? (
              <div className="arr-sequence-empty">
                {isOwner
                  ? "Drag tracks here (or double-click in the sidebar) to build the sequence."
                  : "This arrangement has no clips."}
              </div>
            ) : (
              <div
                className={
                  dragClipId
                    ? "arr-sequence arr-sequence-dragging"
                    : "arr-sequence"
                }
              >
                {clips.map((clip, index) => {
                  const track = trackById.get(clip.trackId);
                  const isSelected = clip.instanceId === selectedId;
                  const dur = clipDuration(clip);
                  const waveW = Math.max(48, dur * pxPerSec);
                  const pauseW =
                    clip.pauseSec > 0
                      ? Math.max(12, clip.pauseSec * pxPerSec)
                      : 0;
                  const audioSeg = segs.find(
                    (s) =>
                      s.kind === "audio" &&
                      s.clip.instanceId === clip.instanceId,
                  );

                  return (
                    <div key={clip.instanceId} className="arr-row-block">
                      <div
                        className={
                          dropIndex === index
                            ? "arr-drop-slot arr-drop-slot-active"
                            : "arr-drop-slot"
                        }
                        onDragOver={(e) => {
                          if (!isOwner) return;
                          e.preventDefault();
                          setDropIndex(index);
                        }}
                        onDragLeave={() => {
                          setDropIndex((i) => (i === index ? null : i));
                        }}
                        onDrop={(e) => onSequenceDrop(e, index)}
                      />
                      <div
                        className={[
                          "arr-row",
                          isSelected ? "arr-row-selected" : "",
                          dragClipId === clip.instanceId
                            ? "arr-row-dragging"
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => selectClip(clip.instanceId)}
                      >
                        <div className="arr-row-meta">
                          <span
                            className="arr-row-handle"
                            title="Drag to reorder"
                            draggable={isOwner}
                            onDragStart={(e) => {
                              if (!isOwner) {
                                e.preventDefault();
                                return;
                              }
                              e.dataTransfer.setData(
                                CLIP_MIME,
                                clip.instanceId,
                              );
                              e.dataTransfer.setData(
                                "text/clip-id",
                                clip.instanceId,
                              );
                              e.dataTransfer.effectAllowed = "move";
                              setDragClipId(clip.instanceId);
                              const label = track
                                ? shortName(track.filename)
                                : "clip";
                              const ghost = document.createElement("div");
                              ghost.className = "arr-drag-ghost";
                              ghost.textContent = `${index + 1}. ${label}`;
                              document.body.appendChild(ghost);
                              e.dataTransfer.setDragImage(ghost, 16, 16);
                              window.setTimeout(() => ghost.remove(), 0);
                            }}
                            onDragEnd={clearDrag}
                          >
                            ⠿
                          </span>
                          <span className="arr-row-index">{index + 1}</span>
                          <button
                            type="button"
                            className={
                              playing && soloClipId === clip.instanceId
                                ? "filterButton filterSelected arr-row-play"
                                : "filterButton arr-row-play"
                            }
                            title="Play this clip from selection start"
                            onClick={(e) => {
                              e.stopPropagation();
                              playClipSelection(clip);
                            }}
                          >
                            {playing && soloClipId === clip.instanceId
                              ? "stop"
                              : "play"}
                          </button>
                          {isOwner && (
                            <button
                              type="button"
                              className="filterButton arr-row-remove"
                              title="Remove clip"
                              onClick={(e) => {
                                e.stopPropagation();
                                setClips((prev) =>
                                  prev.filter(
                                    (c) => c.instanceId !== clip.instanceId,
                                  ),
                                );
                                if (selectedId === clip.instanceId) {
                                  setSelectedId(null);
                                }
                              }}
                            >
                              ×
                            </button>
                          )}
                          <span
                            className="arr-row-name"
                            title={track?.filename ?? clip.trackId}
                          >
                            {track ? shortName(track.filename) : "?"}
                          </span>
                          <label className="arr-row-field">
                            pause
                            <input
                              type="number"
                              min={0}
                              step={0.5}
                              disabled={!isOwner}
                              value={clip.pauseSec}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                updateClip(clip.instanceId, {
                                  pauseSec: Number(e.target.value) || 0,
                                })
                              }
                            />
                          </label>
                          <label className="arr-row-field">
                            gain
                            <input
                              type="range"
                              min={0}
                              max={2}
                              step={0.05}
                              disabled={!isOwner}
                              value={clip.gain}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                updateClip(clip.instanceId, {
                                  gain: Number(e.target.value),
                                })
                              }
                            />
                            <span className="arr-row-gain-val">
                              ×{clip.gain.toFixed(2)}
                            </span>
                          </label>
                        </div>
                        <div
                          className="arr-row-wave-wrap"
                          style={{ width: waveW + pauseW }}
                          onClick={(e) => {
                            e.stopPropagation();
                            selectClip(clip.instanceId);
                            if (!audioSeg) return;
                            const rect =
                              e.currentTarget.getBoundingClientRect();
                            const x = e.clientX - rect.left;
                            if (x <= waveW) {
                              seekToArrangement(
                                audioSeg.arrStart + x / pxPerSec,
                              );
                            } else if (clip.pauseSec > 0) {
                              seekToArrangement(
                                audioSeg.arrEnd + (x - waveW) / pxPerSec,
                              );
                            }
                          }}
                        >
                          <div
                            className="arr-row-wave"
                            style={{ width: waveW, height: ROW_WAVE_H }}
                          >
                            <ClipWaveform
                              trackId={clip.trackId}
                              offsetSec={clip.inSec}
                              durationSec={dur}
                              width={waveW}
                              height={ROW_WAVE_H}
                              peaksVersion={peaksVersion}
                            />
                            {audioSeg && (
                              <RowPlayhead
                                store={playhead}
                                arrStart={audioSeg.arrStart}
                                arrEnd={audioSeg.arrEnd}
                                pxPerSec={pxPerSec}
                              />
                            )}
                          </div>
                          {pauseW > 0 && (
                            <div
                              className="arr-row-pause"
                              style={{ width: pauseW, height: ROW_WAVE_H }}
                              title={`pause ${formatClock(clip.pauseSec)}`}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div
                  className={
                    dropIndex === clips.length
                      ? "arr-drop-slot arr-drop-slot-end arr-drop-slot-active"
                      : "arr-drop-slot arr-drop-slot-end"
                  }
                  onDragOver={(e) => {
                    if (!isOwner) return;
                    e.preventDefault();
                    setDropIndex(clips.length);
                  }}
                  onDragLeave={() => {
                    setDropIndex((i) => (i === clips.length ? null : i));
                  }}
                  onDrop={(e) => onSequenceDrop(e, clips.length)}
                />
              </div>
            )}
          </div>

          <ClipEditorPanel
            clip={selected}
            track={selected ? (trackById.get(selected.trackId) ?? null) : null}
            isOwner={isOwner}
            peaksVersion={peaksVersion}
            editorPxPerSec={editorPxPerSec}
            onZoom={(fn) => setEditorPxPerSec(fn)}
            onChange={(patch) => {
              if (selected) updateClip(selected.instanceId, patch);
            }}
          />

          <ClipCommentsPanel track={currentTrack} />
        </div>
      </div>
    </div>
  );
}

function ClipEditorPanel({
  clip,
  track,
  isOwner,
  peaksVersion,
  editorPxPerSec,
  onZoom,
  onChange,
}: {
  clip: ArrangementClip | null;
  track: Track | null;
  isOwner: boolean;
  peaksVersion: number;
  editorPxPerSec: number;
  onZoom: (fn: (p: number) => number) => void;
  onChange: (
    patch: Partial<Pick<ArrangementClip, "inSec" | "outSec">>,
  ) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef(clip);
  clipRef.current = clip;
  const dragRef = useRef<{
    kind: "in" | "out" | "range";
    grabOffset: number;
    fixedLen?: number;
  } | null>(null);

  if (!clip || !track) {
    return (
      <div className="arr-editor" aria-live="polite">
        <div className="arr-editor-empty">
          Select a clip to edit in/out points on the full waveform.
        </div>
      </div>
    );
  }

  const peaks = getCachedPeaks(clip.trackId) ?? null;
  const srcDur = sourceDuration(track, peaks);
  const maxPx = Math.min(
    PX_PER_SEC_MAX,
    MAX_EDITOR_CSS_PX / Math.max(srcDur, MIN_CLIP_SEC),
  );
  const effectivePx = Math.min(editorPxPerSec, Math.max(PX_PER_SEC_MIN, maxPx));
  const widthPx = Math.max(320, srcDur * effectivePx);
  // Integer pixels so handle lines don't fight subpixel antialias / canvas dim.
  const inX = Math.round(clip.inSec * effectivePx);
  const outX = Math.round(clip.outSec * effectivePx);
  const selW = Math.max(4, outX - inX);

  /** X in canvas content coordinates (matches selection `left` / waveform). */
  function pointerCanvasX(clientX: number) {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    // clientLeft skips the canvas border so we match absolute `left` coords.
    return clientX - rect.left - canvas.clientLeft;
  }

  function onPointerDown(
    e: ReactPointerEvent,
    kind: "in" | "out" | "range",
  ) {
    if (!isOwner) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const current = clipRef.current;
    if (!current) return;
    if (!canvasRef.current) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const x = pointerCanvasX(e.clientX);
    const at = x / effectivePx;

    if (kind === "range") {
      dragRef.current = {
        kind: "range",
        grabOffset: at - current.inSec,
        fixedLen: current.outSec - current.inSec,
      };
    } else if (kind === "in") {
      // Keep the line under the cursor even when grabbing the wide hit area.
      dragRef.current = { kind: "in", grabOffset: at - current.inSec };
    } else {
      dragRef.current = { kind: "out", grabOffset: at - current.outSec };
    }

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      const c = clipRef.current;
      if (!d || !c) return;
      const atMove = pointerCanvasX(ev.clientX) / effectivePx;

      if (d.kind === "in") {
        const next = atMove - d.grabOffset;
        onChange({
          inSec: Math.max(
            0,
            Math.min(next, c.outSec - MIN_CLIP_SEC),
          ),
        });
      } else if (d.kind === "out") {
        const next = atMove - d.grabOffset;
        onChange({
          outSec: Math.max(
            c.inSec + MIN_CLIP_SEC,
            Math.min(next, srcDur),
          ),
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
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  return (
    <div className="arr-editor">
      <div className="arr-editor-header">
        <span className="arr-editor-title">{shortName(track.filename)}</span>
        <span className="arr-muted">
          full {formatClock(srcDur)} · selection{" "}
          {formatClock(clipDuration(clip))}
        </span>
        <label className="arr-row-field">
          in
          <input
            type="number"
            min={0}
            step={0.1}
            disabled={!isOwner}
            value={Number(clip.inSec.toFixed(2))}
            onChange={(e) =>
              onChange({ inSec: Number(e.target.value) || 0 })
            }
          />
        </label>
        <label className="arr-row-field">
          out
          <input
            type="number"
            min={0}
            step={0.1}
            disabled={!isOwner}
            value={Number(clip.outSec.toFixed(2))}
            onChange={(e) =>
              onChange({ outSec: Number(e.target.value) || 0 })
            }
          />
        </label>
        <button
          type="button"
          className="filterButton"
          onClick={() =>
            onZoom((p) => Math.max(PX_PER_SEC_MIN, p / 1.25))
          }
        >
          −
        </button>
        <button
          type="button"
          className="filterButton"
          onClick={() =>
            onZoom((p) => Math.min(maxPx, p * 1.25))
          }
        >
          +
        </button>
        <span className="arr-muted">
          {formatPxPerSec(effectivePx)} px/s
        </span>
      </div>
      <div className="arr-editor-scroll" ref={scrollRef}>
        <div
          className="arr-editor-canvas"
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
            dimOutside
            sourceDurHint={srcDur}
          />
          <div
            className={
              isOwner
                ? "arr-editor-selection"
                : "arr-editor-selection arr-editor-selection-ro"
            }
            style={{ left: inX, width: selW, height: EDITOR_WAVE_H }}
            onPointerDown={(e) => onPointerDown(e, "range")}
          >
            <div
              className="arr-editor-handle left"
              onPointerDown={(e) => onPointerDown(e, "in")}
            />
            <div
              className="arr-editor-handle right"
              onPointerDown={(e) => onPointerDown(e, "out")}
            />
          </div>
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
