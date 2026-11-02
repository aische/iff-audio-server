import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  api,
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
import { formatClock, shortTitle } from "./format";
import { newClipForTrack } from "./clips";
import { TRACK_MIME, CLIP_MIME } from "./mime";

const AUTOSAVE_MS = 600;
const MIN_CLIP_SEC = 0.5;

function arrangementSnapshot(name: string, clips: ArrangementClip[]) {
  return JSON.stringify({ name, clips });
}

const EDITOR_WAVE_H = 96;
const PX_PER_SEC_MIN = 2;
const PX_PER_SEC_MAX = 200;
const EDITOR_PX_DEFAULT = 40;
/** Cap canvas backing-store width — huge tracks × zoom × DPR can blank the GPU. */
const MAX_CANVAS_BACKING_PX = 8192;
/** Soft cap on editor CSS width before we force-fit zoom. */
const MAX_EDITOR_CSS_PX = 4096;

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
const INSPECTOR_TAB_KEY = "iff-arrange-inspector-tab";
const INSPECTOR_OPEN_KEY = "iff-arrange-inspector-open";
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

type InspectorTab = "trim" | "clip" | "comments";
const INSPECTOR_TABS: { id: InspectorTab; label: string }[] = [
  { id: "trim", label: "Trim" },
  { id: "clip", label: "Clip" },
  { id: "comments", label: "Comments" },
];

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function readInspectorTab(): InspectorTab {
  const raw = readStored(INSPECTOR_TAB_KEY);
  return raw === "clip" || raw === "comments" ? raw : "trim";
}

function readInspectorOpen(): boolean {
  return readStored(INSPECTOR_OPEN_KEY) !== "0";
}

function readPlaybackMode(): PlaybackMode {
  return readStored(PLAYBACK_MODE_KEY) === "precise" ? "precise" : "stream";
}

function audioSegAt(segs: ScheduleSeg[], at: number) {
  return segs.find(
    (s) => s.kind === "audio" && at >= s.arrStart && at < s.arrEnd,
  );
}

/** Audio or pause segment under `at`. */
function segAt(segs: ScheduleSeg[], at: number) {
  return segs.find((s) => at >= s.arrStart && at < s.arrEnd);
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

/** Ref to the latest committed value, for rAF loops, listeners and handlers. */
function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Re-renders only when `select(playhead)` changes. */
function usePlayhead<T>(store: PlayheadStore, select: (sec: number) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

function PlayheadClock({ store }: { store: PlayheadStore }) {
  return <>{usePlayhead(store, formatClock)}</>;
}

function formatPxPerSec(n: number) {
  if (n >= 10) return n.toFixed(0);
  if (n >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

/** Short pause cue: "2s", "0.5s", or a clock for a minute and up. */
function formatPause(sec: number) {
  if (sec >= 60) return formatClock(sec);
  return `${Number(sec.toFixed(1))}s`;
}

/** Clock with tenths, for trim points: "1:05.3". */
function formatClockTenths(sec: number) {
  const t = Math.max(0, Math.round(sec * 10) / 10);
  const whole = Math.floor(t);
  return `${formatClock(whole)}.${Math.round((t - whole) * 10)}`;
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

// ---------------------------------------------------------------------------
// Public API type exposed to the parent shell for adding tracks.
// ---------------------------------------------------------------------------

export type ArrangeAddApi = {
  addTrack: (trackId: string, atIndex?: number) => void;
  isOwner: boolean;
};

// ---------------------------------------------------------------------------
// ArrangeShell — arrangement list + editor, rendered as a right panel.
// ---------------------------------------------------------------------------

export function ArrangeShell({
  user,
  tracks,
  active,
  onError,
  onAddApiChange,
  onArrangementPlayingChange,
  stopToken,
  onHoverTrack,
  openRequest,
  onCheckTracks,
}: {
  user: User;
  tracks: Track[];
  /** False while the panel is mounted but hidden (pool mode). */
  active: boolean;
  onError: (message: string | null) => void;
  onAddApiChange: (api: ArrangeAddApi | null) => void;
  onArrangementPlayingChange: (playing: boolean) => void;
  stopToken: number;
  /** Pointer entered a clip of this track (drives the info card). */
  onHoverTrack: (trackId: string) => void;
  /** Open this arrangement (e.g. one just created from checked tracks). */
  openRequest: { id: string; seq: number } | null;
  /** Replace the library's checked tracks with these track ids. */
  onCheckTracks: (trackIds: string[]) => void;
}) {
  const [list, setList] = useState<ArrangementSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(
    () => openRequest?.id ?? null,
  );
  const [handledOpenSeq, setHandledOpenSeq] = useState(
    () => openRequest?.seq ?? 0,
  );
  if (openRequest && openRequest.seq !== handledOpenSeq) {
    setHandledOpenSeq(openRequest.seq);
    setActiveId(openRequest.id);
  }
  const [newName, setNewName] = useState("");
  const [copyingId, setCopyingId] = useState<string | null>(null);

  function load() {
    return api
      .listArrangements()
      .then(
        (rows) => {
          setList(rows);
          onError(null);
        },
        (err: unknown) => {
          onError(
            err instanceof Error ? err.message : "Failed to load arrangements",
          );
        },
      )
      .finally(() => setLoading(false));
  }

  function refresh() {
    setLoading(true);
    return load();
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount
  }, []);

  // Report null API while list view is showing.
  useEffect(() => {
    if (!activeId) onAddApiChange(null);
  }, [activeId, onAddApiChange]);

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
        key={activeId}
        arrangementId={activeId}
        user={user}
        tracks={tracks}
        active={active}
        onBack={() => {
          setActiveId(null);
          void refresh();
        }}
        onOpen={setActiveId}
        onError={onError}
        onAddApiChange={onAddApiChange}
        onCheckTracks={onCheckTracks}
        onHoverTrack={onHoverTrack}
        onArrangementPlayingChange={onArrangementPlayingChange}
        stopToken={stopToken}
      />
    );
  }

  const mine = list.filter((a) => a.userId === user.id);
  const others = list.filter((a) => a.userId !== user.id);

  return (
    <div className="arr-panel">
      <div className="arr-toolbar">
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
                if (!confirm(`Delete "${a.name}"?`)) return;
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

// ---------------------------------------------------------------------------
// ArrangeEditor — single arrangement: sequence, trim, playback, autosave.
// ---------------------------------------------------------------------------

/**
 * Whether a keydown should drive arrangement shortcuts: focus must be on the
 * page itself or inside the editor (not the library or transport), and not
 * in a text field.
 */
function isShortcutTarget(
  target: EventTarget | null,
  panel: HTMLElement | null,
) {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return false;
  }
  return target === document.body || (panel?.contains(target) ?? false);
}

function ArrangeEditor({
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
  onHoverTrack: (trackId: string) => void;
  onArrangementPlayingChange: (playing: boolean) => void;
  stopToken: number;
}) {
  const [arrangement, setArrangement] = useState<Arrangement | null>(null);
  const [clips, setClips] = useState<ArrangementClip[]>([]);
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overviewZoom, setOverviewZoom] = useState(1);
  const [inspectorTab, setInspectorTab] =
    useState<InspectorTab>(readInspectorTab);
  const [inspectorOpen, setInspectorOpen] = useState(readInspectorOpen);
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
  /** A track from the library is being dragged (drop targets light up). */
  const [trackDragging, setTrackDragging] = useState(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  /** When set, transport stops at this arrangement time (solo clip audition). */
  const [soloEndSec, setSoloEndSec] = useState<number | null>(null);
  const [soloClipId, setSoloClipId] = useState<string | null>(null);
  /** Clip instances left out of playback. Temporary: never saved. */
  const [skippedIds, setSkippedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const clipsRef = useLatestRef(clips);
  const playRef = useLatestRef(playing);
  const soloEndRef = useLatestRef(soloEndSec);
  const savedSnapshotRef = useRef("");
  const saveSeqRef = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const sequenceRef = useRef<HTMLDivElement>(null);

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

  const isOwner = arrangement?.userId === user.id;
  const { segs, totalSec } = useMemo(
    () => buildSchedule(clips.filter((c) => !skippedIds.has(c.instanceId))),
    [clips, skippedIds],
  );
  const segsRef = useLatestRef(segs);
  const totalSecRef = useLatestRef(totalSec);
  /** Clip whose audio or pause is under the playhead; changes at clip boundaries only. */
  const headClipId = usePlayhead(
    playhead,
    (sec) => segAt(segs, sec)?.clip.instanceId ?? null,
  );

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
        setSkippedIds(new Set());
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
  }, [arrangementId, playhead, onError]);

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
  }, [clips, name, isOwner]);

  // Closing the editor (back to list, opening another arrangement, logout)
  // cancels the debounce above; save whatever it was still holding.
  const flushPendingSave = useEffectEvent(() => {
    if (!isOwner) return;
    if (arrangementSnapshot(name, clips) === savedSnapshotRef.current) return;
    void persist(name, clips);
  });
  useEffect(() => {
    return () => flushPendingSave();
  }, []);

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
    writeStored(PLAYBACK_MODE_KEY, mode);
  }

  const releaseEngineOnUnmount = useEffectEvent(releaseEngine);
  useEffect(() => {
    return () => {
      releaseEngineOnUnmount();
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
    if (playing) stopTransport();
  });
  useEffect(() => {
    if (stopTokenRef.current === stopToken) return;
    stopTokenRef.current = stopToken;
    stopOnToken();
  }, [stopToken]);

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (!active || e.defaultPrevented) return;
    if (!isShortcutTarget(e.target, panelRef.current)) return;
    if (e.key === " " || e.code === "Space") {
      // A focused button already handles Space itself.
      if (
        e.target instanceof Element &&
        e.target.closest("button, a[href], [role='button']")
      ) {
        return;
      }
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
      removeClip(selectedId);
    }
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

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

  const selected = selectedId
    ? (clips.find((c) => c.instanceId === selectedId) ?? null)
    : null;

  // Keep the selected row, and while playing the row under the playhead, in view.
  useEffect(() => {
    if (selectedId) scrollRowIntoView(sequenceRef.current, selectedId);
  }, [selectedId]);
  useEffect(() => {
    if (playing && headClipId) {
      scrollRowIntoView(sequenceRef.current, headClipId);
    }
  }, [playing, headClipId]);

  function removeClip(id: string) {
    setClips((prev) => prev.filter((c) => c.instanceId !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }

  function changeInspectorTab(tab: InspectorTab) {
    setInspectorTab(tab);
    writeStored(INSPECTOR_TAB_KEY, tab);
    changeInspectorOpen(true);
  }

  function changeInspectorOpen(open: boolean) {
    setInspectorOpen(open);
    writeStored(INSPECTOR_OPEN_KEY, open ? "1" : "0");
  }

  function addTrack(trackId: string, atIndex?: number) {
    const item = newClipForTrack(trackById.get(trackId));
    if (!item) return;
    const dur = item.outSec;
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
    if (id !== selectedId) changeInspectorOpen(true);
    setSelectedId(id);
    const clip = clipsRef.current.find((c) => c.instanceId === id);
    if (!clip) return;
    const track = trackById.get(clip.trackId);
    const src = sourceDuration(track, getCachedPeaks(clip.trackId) ?? null);
    const fit = MAX_EDITOR_CSS_PX / Math.max(src, MIN_CLIP_SEC);
    setEditorPxPerSec(
      Math.min(EDITOR_PX_DEFAULT, Math.max(PX_PER_SEC_MIN, fit)),
    );
  }

  function clearDrag() {
    setDragClipId(null);
    setDropIndex(null);
  }

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

  /** Insert before a row when over its top half, after it otherwise. */
  function rowInsertIndex(e: React.DragEvent<HTMLElement>, index: number) {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? index : index + 1;
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

  /**
   * Skip or unskip a clip. The playhead stays on the clip it was in; if that
   * clip is the one being skipped, it moves to the start of the next clip.
   */
  function setSkipped(ids: ReadonlySet<string>) {
    const at = playhead.get();
    const cur = segs.find((s) => at >= s.arrStart && at < s.arrEnd);
    const next = buildSchedule(clips.filter((c) => !ids.has(c.instanceId)));
    setSkippedIds(ids);
    // Rendering catches the refs up too, but the transport may tick first.
    segsRef.current = next.segs;
    totalSecRef.current = next.totalSec;

    let stopped = false;
    if (soloClipId != null) {
      const soloSeg = next.segs.find(
        (s) => s.kind === "audio" && s.clip.instanceId === soloClipId,
      );
      if (!soloSeg) {
        stopTransport();
        stopped = true;
      } else {
        soloEndRef.current = soloSeg.arrEnd;
        setSoloEndSec(soloSeg.arrEnd);
      }
    }

    let target = at >= totalSec ? next.totalSec : Math.min(at, next.totalSec);
    let jumped = false;
    if (cur) {
      const same = next.segs.find(
        (s) => s.kind === cur.kind && s.clip.instanceId === cur.clip.instanceId,
      );
      if (same) {
        target = same.arrStart + (at - cur.arrStart);
      } else {
        const from = clips.findIndex(
          (c) => c.instanceId === cur.clip.instanceId,
        );
        const after = clips
          .slice(from + 1)
          .find((c) => !ids.has(c.instanceId));
        const afterSeg = after
          ? next.segs.find(
              (s) => s.kind === "audio" && s.clip.instanceId === after.instanceId,
            )
          : undefined;
        target = afterSeg ? afterSeg.arrStart : next.totalSec;
        jumped = true;
      }
    }
    setPlayheadSec(target);
    if (!playRef.current || stopped) return;
    if (jumped) {
      syncAudio(target, true);
    } else {
      // Same audio position, new timeline: not a seek.
      lastSyncAtRef.current = target;
    }
  }

  function toggleSkip(instanceId: string) {
    const ids = new Set(skippedIds);
    if (!ids.delete(instanceId)) ids.add(instanceId);
    setSkipped(ids);
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

  const skippedCount = clips.filter((c) => skippedIds.has(c.instanceId)).length;
  const releasedClips = clips.filter(
    (c) => trackById.get(c.trackId)?.releasedOn,
  );
  const dragging = isOwner && (dragClipId != null || trackDragging);
  const dragClipIndex = dragClipId
    ? clips.findIndex((c) => c.instanceId === dragClipId)
    : -1;

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
  const maxClipDur = clips.reduce((m, c) => Math.max(m, clipDuration(c)), 0);
  const contextId = playing ? headClipId : (selectedId ?? headClipId);
  const contextIndex = contextId != null ? indexById.get(contextId) : undefined;
  const contextClip = contextIndex != null ? clips[contextIndex] : undefined;
  const contextTrack = contextClip
    ? trackById.get(contextClip.trackId)
    : undefined;

  return (
    <div className="arr-panel" ref={panelRef}>
      <div className="arr-identity">
        <button type="button" className="filterButton" onClick={onBack}>
          ← arrangements
        </button>
        {isOwner ? (
          <input
            className="arr-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Arrangement name"
          />
        ) : (
          <span className="arr-name-ro" title={name}>
            {name}
          </span>
        )}
        {!isOwner && (
          <span className="arr-muted arr-owner">by {arrangement.userEmail}</span>
        )}
        <span className="arr-spacer" />
        {isOwner ? (
          <span
            className={[
              "arr-save",
              saveState === "error" ? "save-error" : "",
              saveState === "saved" ? "save-ok" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-live="polite"
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
          <>
            <span className="arr-readonly-tag">read-only</span>
            <button
              type="button"
              className="filterButton arr-cta"
              disabled={copying}
              title="Make your own editable copy of this arrangement"
              onClick={() => void onCopyHere()}
            >
              {copying ? "copying…" : "copy to edit"}
            </button>
          </>
        )}
      </div>

      <div className="arr-transport">
        <button
          type="button"
          className={
            playing ? "filterButton filterSelected arr-play" : "filterButton arr-play"
          }
          disabled={clips.length === 0}
          title="Play the arrangement from the playhead (space)"
          onClick={() => toggleArrangementPlay()}
        >
          {playing ? "■ stop" : "▶ play"}
        </button>
        <span className="arr-clock">
          <PlayheadClock store={playhead} />
          <span className="arr-clock-total"> / {formatClock(totalSec)}</span>
        </span>
        {contextClip && contextIndex != null && (
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
            <button
              type="button"
              className="arr-chip-btn"
              onClick={() => setSkipped(new Set())}
            >
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
            onClick={() => setOverviewZoom((z) => Math.max(1, z / 2))}
          >
            −
          </button>
          <button
            type="button"
            className="filterButton"
            disabled={overviewZoom >= OVERVIEW_ZOOM_MAX}
            title="Zoom in overview"
            onClick={() =>
              setOverviewZoom((z) => Math.min(OVERVIEW_ZOOM_MAX, z * 2))
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
                  const body = buildArrangementTsv(clips, trackById);
                  downloadTextFile(
                    `${sanitizeDownloadName(name)}.tsv`,
                    body,
                    "text/tab-separated-values;charset=utf-8",
                  );
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
                    changePlaybackMode(m);
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
        onSeek={seekToArrangement}
        onSelect={selectClip}
      />

      <div className="arr-main">
        <div
          ref={sequenceRef}
          className={
            isOwner
              ? "arr-sequence-wrap"
              : "arr-sequence-wrap arr-sequence-readonly"
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
          onDrop={(e) => onSequenceDrop(e, clips.length)}
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
              {clips.map((clip, index) => {
                const track = trackById.get(clip.trackId);
                const isSkipped = skippedIds.has(clip.instanceId);
                const releasedOn = track?.releasedOn ?? null;
                const dur = clipDuration(clip);
                const soloing = playing && soloClipId === clip.instanceId;
                const title = track ? shortTitle(track.filename) : "?";
                const tooltip = [
                  track?.filename ?? `missing track ${clip.trackId}`,
                  releasedOn ? `released on ${releasedOn}` : "",
                  isSkipped ? "skipped in playback (not saved)" : "",
                ]
                  .filter(Boolean)
                  .join("\n");

                return (
                  <div
                    key={clip.instanceId}
                    className="arr-row-block"
                    onDragOver={(e) => {
                      if (!isOwner) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setDropIndex(rowInsertIndex(e, index));
                    }}
                    onDrop={(e) => onSequenceDrop(e, rowInsertIndex(e, index))}
                  >
                    <div className={dropSlotClass(index)} />
                    <div
                      data-clip-id={clip.instanceId}
                      className={[
                        "arr-row",
                        clip.instanceId === selectedId ? "arr-row-selected" : "",
                        isSkipped ? "arr-row-skipped" : "",
                        releasedOn ? "arr-row-released" : "",
                        playing && headClipId === clip.instanceId
                          ? "arr-row-playing"
                          : "",
                        soloing ? "arr-row-soloing" : "",
                        dragClipId === clip.instanceId
                          ? "arr-row-dragging"
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => selectClip(clip.instanceId)}
                      onMouseEnter={() => onHoverTrack(clip.trackId)}
                    >
                      {isOwner && (
                        <span
                          className="arr-row-handle"
                          title="Drag to reorder"
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData(CLIP_MIME, clip.instanceId);
                            e.dataTransfer.setData(
                              "text/clip-id",
                              clip.instanceId,
                            );
                            e.dataTransfer.effectAllowed = "move";
                            setDragClipId(clip.instanceId);
                            const ghost = document.createElement("div");
                            ghost.className = "arr-drag-ghost";
                            ghost.textContent = `${index + 1}. ${title}`;
                            document.body.appendChild(ghost);
                            e.dataTransfer.setDragImage(ghost, 16, 16);
                            window.setTimeout(() => ghost.remove(), 0);
                          }}
                          onDragEnd={clearDrag}
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
                        <span
                          style={{
                            width: `${maxClipDur > 0 ? (dur / maxClipDur) * 100 : 0}%`,
                          }}
                        />
                      </span>
                      <span className="arr-row-dur">{formatClock(dur)}</span>
                      <span className="arr-row-actions">
                        <button
                          type="button"
                          disabled={isSkipped}
                          className={
                            soloing
                              ? "arr-row-btn arr-row-btn-on"
                              : "arr-row-btn"
                          }
                          title={
                            isSkipped
                              ? "Skipped clips don't play"
                              : soloing
                                ? "Stop"
                                : "Play this clip"
                          }
                          aria-label={soloing ? "Stop clip" : "Play clip"}
                          onClick={(e) => {
                            e.stopPropagation();
                            playClipSelection(clip);
                          }}
                        >
                          {soloing ? "■" : "▶"}
                        </button>
                        <Menu
                          label="⋯"
                          title="Clip actions"
                          buttonClassName="arr-row-btn"
                        >
                          {(close) => (
                            <>
                              <button
                                type="button"
                                role="menuitemcheckbox"
                                aria-checked={isSkipped}
                                className="arr-menu-item"
                                onClick={() => {
                                  close();
                                  toggleSkip(clip.instanceId);
                                }}
                              >
                                <span className="arr-menu-check" aria-hidden>
                                  {isSkipped ? "✓" : ""}
                                </span>
                                Skip in playback
                                <span className="arr-menu-hint">
                                  this session only, not saved
                                </span>
                              </button>
                              {isOwner && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="arr-menu-item arr-menu-danger"
                                  onClick={() => {
                                    close();
                                    removeClip(clip.instanceId);
                                  }}
                                >
                                  Remove from arrangement
                                </button>
                              )}
                            </>
                          )}
                        </Menu>
                      </span>
                    </div>
                  </div>
                );
              })}
              <div
                className={`${dropSlotClass(clips.length)} arr-drop-slot-end`}
                onDragOver={(e) => {
                  if (!isOwner) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropIndex(clips.length);
                }}
                onDrop={(e) => onSequenceDrop(e, clips.length)}
              />
            </div>
          )}
        </div>

        <ClipInspector
          clip={selected}
          index={selected ? (indexById.get(selected.instanceId) ?? 0) : 0}
          track={selected ? (trackById.get(selected.trackId) ?? null) : null}
          isOwner={isOwner}
          open={inspectorOpen}
          onOpenChange={changeInspectorOpen}
          tab={inspectorTab}
          onTabChange={changeInspectorTab}
          skipped={selected ? skippedIds.has(selected.instanceId) : false}
          soloing={
            selected != null && playing && soloClipId === selected.instanceId
          }
          onPlay={() => {
            if (selected) playClipSelection(selected);
          }}
          onToggleSkip={() => {
            if (selected) toggleSkip(selected.instanceId);
          }}
          onRemove={() => {
            if (selected) removeClip(selected.instanceId);
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

// ---------------------------------------------------------------------------
// Menu — button with a popover; used for transport and row overflow.
// ---------------------------------------------------------------------------

const MENU_EST_H = 280;

function Menu({
  label,
  title,
  buttonClassName,
  children,
}: {
  label: ReactNode;
  title: string;
  buttonClassName: string;
  children: (close: () => void) => ReactNode;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  /** Fixed position of the open popover, from the button's rect. */
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
  } | null>(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const inside = (t: EventTarget | null) =>
      t instanceof Node &&
      (popRef.current?.contains(t) || btnRef.current?.contains(t));
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
      btnRef.current?.focus();
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) close();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  function toggle() {
    if (pos) {
      setPos(null);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const right = Math.max(4, window.innerWidth - r.right);
    const below = window.innerHeight - r.bottom;
    setPos(
      below < MENU_EST_H && r.top > below
        ? { bottom: window.innerHeight - r.top + 2, right }
        : { top: r.bottom + 2, right },
    );
  }

  return (
    <span
      className="arr-menu"
      data-open={pos ? "" : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={btnRef}
        type="button"
        className={pos ? `${buttonClassName} arr-menu-btn-open` : buttonClassName}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={pos != null}
        onClick={toggle}
      >
        {label}
      </button>
      {pos && (
        <div
          ref={popRef}
          className="arr-menu-pop"
          role="menu"
          style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}
        >
          {children(() => setPos(null))}
        </div>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Overview — the whole arrangement as one strip: seek, select, playhead.
// ---------------------------------------------------------------------------

function Overview({
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

// ---------------------------------------------------------------------------
// ClipInspector — the selected clip: Trim / Clip / Comments tabs.
// ---------------------------------------------------------------------------

type ClipPatch = Partial<
  Pick<ArrangementClip, "inSec" | "outSec" | "pauseSec" | "gain">
>;

function ClipInspector({
  clip,
  index,
  track,
  isOwner,
  open,
  onOpenChange,
  tab,
  onTabChange,
  skipped,
  soloing,
  onPlay,
  onToggleSkip,
  onRemove,
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
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  skipped: boolean;
  soloing: boolean;
  onPlay: () => void;
  onToggleSkip: () => void;
  onRemove: () => void;
  onChange: (patch: ClipPatch) => void;
  peaksVersion: number;
  editorPxPerSec: number;
  onZoom: (fn: (p: number) => number) => void;
}) {
  const showBody = open && clip != null;
  return (
    <section
      className={showBody ? "arr-inspector" : "arr-inspector arr-inspector-closed"}
      aria-label="Clip inspector"
    >
      <div className="arr-inspector-bar">
        {clip ? (
          <>
            <button
              type="button"
              className="arr-inspector-toggle"
              aria-expanded={open}
              title={open ? "Collapse inspector" : "Expand inspector"}
              onClick={() => onOpenChange(!open)}
            >
              {open ? "▾" : "▸"}
            </button>
            <span
              className="arr-inspector-title"
              title={track?.filename ?? clip.trackId}
            >
              {index + 1}. {track ? shortTitle(track.filename) : "missing track"}
            </span>
            <button
              type="button"
              disabled={skipped}
              className={soloing ? "arr-row-btn arr-row-btn-on" : "arr-row-btn"}
              title={
                skipped
                  ? "Skipped clips don't play"
                  : soloing
                    ? "Stop"
                    : "Play this clip"
              }
              aria-label={soloing ? "Stop clip" : "Play clip"}
              onClick={onPlay}
            >
              {soloing ? "■" : "▶"}
            </button>
            <div className="arr-tabs" role="tablist">
              {INSPECTOR_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={open && tab === t.id}
                  className={
                    open && tab === t.id ? "arr-tab arr-tab-on" : "arr-tab"
                  }
                  onClick={() => onTabChange(t.id)}
                >
                  {t.label}
                  {t.id === "comments" && track && track.comments.length > 0
                    ? ` (${track.comments.length})`
                    : ""}
                </button>
              ))}
            </div>
          </>
        ) : (
          <span className="arr-muted">Select a clip to trim and edit.</span>
        )}
      </div>
      {showBody && (
        <div className="arr-inspector-body" role="tabpanel">
          {!track ? (
            <p className="arr-inspector-empty">
              This track is missing from the library.
            </p>
          ) : tab === "trim" ? (
            <TrimTab
              clip={clip}
              track={track}
              isOwner={isOwner}
              peaksVersion={peaksVersion}
              editorPxPerSec={editorPxPerSec}
              onZoom={onZoom}
              onChange={onChange}
            />
          ) : tab === "clip" ? (
            <ClipTab
              clip={clip}
              track={track}
              isOwner={isOwner}
              skipped={skipped}
              onToggleSkip={onToggleSkip}
              onRemove={onRemove}
              onChange={onChange}
            />
          ) : (
            <CommentsTab track={track} />
          )}
        </div>
      )}
    </section>
  );
}

function TrimTab({
  clip,
  track,
  isOwner,
  peaksVersion,
  editorPxPerSec,
  onZoom,
  onChange,
}: {
  clip: ArrangementClip;
  track: Track;
  isOwner: boolean;
  peaksVersion: number;
  editorPxPerSec: number;
  onZoom: (fn: (p: number) => number) => void;
  onChange: (patch: ClipPatch) => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const clipRef = useLatestRef(clip);
  const dragRef = useRef<{
    kind: "in" | "out" | "range";
    grabOffset: number;
    fixedLen?: number;
  } | null>(null);

  const peaks = getCachedPeaks(clip.trackId) ?? null;
  const srcDur = sourceDuration(track, peaks);
  const maxPx = Math.min(
    PX_PER_SEC_MAX,
    MAX_EDITOR_CSS_PX / Math.max(srcDur, MIN_CLIP_SEC),
  );
  const effectivePx = Math.min(editorPxPerSec, Math.max(PX_PER_SEC_MIN, maxPx));
  const widthPx = Math.max(320, srcDur * effectivePx);
  const inX = Math.round(clip.inSec * effectivePx);
  const outX = Math.round(clip.outSec * effectivePx);
  const selW = Math.max(4, outX - inX);

  /** X in canvas content coordinates (matches selection `left` / waveform). */
  function pointerCanvasX(clientX: number) {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
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
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  return (
    <div className="arr-trim">
      <div className="arr-trim-header">
        <span className="arr-muted">
          full {formatClock(srcDur)} · selection{" "}
          {formatClock(clipDuration(clip))}
        </span>
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
          <span className="arr-muted">
            in {formatClockTenths(clip.inSec)} · out{" "}
            {formatClockTenths(clip.outSec)}
          </span>
        )}
        <span className="arr-spacer" />
        <span className="arr-zoom" role="group" aria-label="Waveform zoom">
          <button
            type="button"
            className="filterButton"
            title="Zoom out waveform"
            onClick={() => onZoom((p) => Math.max(PX_PER_SEC_MIN, p / 1.25))}
          >
            −
          </button>
          <button
            type="button"
            className="filterButton"
            title="Zoom in waveform"
            onClick={() => onZoom((p) => Math.min(maxPx, p * 1.25))}
          >
            +
          </button>
        </span>
        <span className="arr-muted">{formatPxPerSec(effectivePx)} px/s</span>
      </div>
      <div className="arr-trim-scroll">
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
        </div>
      </div>
    </div>
  );
}

function ClipTab({
  clip,
  track,
  isOwner,
  skipped,
  onToggleSkip,
  onRemove,
  onChange,
}: {
  clip: ArrangementClip;
  track: Track;
  isOwner: boolean;
  skipped: boolean;
  onToggleSkip: () => void;
  onRemove: () => void;
  onChange: (patch: ClipPatch) => void;
}) {
  return (
    <div className="arr-clip-form">
      <span className="arr-field-label">pause after</span>
      {isOwner ? (
        <label className="arr-field-inline">
          <input
            type="number"
            min={0}
            step={0.5}
            value={clip.pauseSec}
            aria-label="Pause after clip, seconds"
            onChange={(e) =>
              onChange({ pauseSec: Number(e.target.value) || 0 })
            }
          />
          s
        </label>
      ) : (
        <span>{clip.pauseSec > 0 ? formatPause(clip.pauseSec) : "none"}</span>
      )}

      <span className="arr-field-label">gain</span>
      {isOwner ? (
        <label className="arr-field-inline">
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={clip.gain}
            aria-label="Gain"
            onChange={(e) => onChange({ gain: Number(e.target.value) })}
          />
          <span className="arr-gain-val">×{clip.gain.toFixed(2)}</span>
        </label>
      ) : (
        <span>×{clip.gain.toFixed(2)}</span>
      )}

      <span className="arr-field-label">playback</span>
      <label className="arr-field-inline arr-skip-field">
        <input
          type="checkbox"
          className="track-check"
          checked={skipped}
          onChange={onToggleSkip}
        />
        skip in playback
        <span className="arr-muted">— this session only, not saved</span>
      </label>

      {track.releasedOn && (
        <>
          <span className="arr-field-label">released</span>
          <span className="arr-released-text">{track.releasedOn}</span>
        </>
      )}

      {isOwner && (
        <>
          <span />
          <span>
            <button
              type="button"
              className="filterButton arr-danger-btn"
              onClick={onRemove}
            >
              remove from arrangement
            </button>
          </span>
        </>
      )}
    </div>
  );
}

function CommentsTab({ track }: { track: Track }) {
  const comments = track.comments;
  if (comments.length === 0) {
    return (
      <p className="arr-inspector-empty">
        No comments — edit in the library list.
      </p>
    );
  }
  return (
    <div className="arr-comments">
      <ul className="arr-comments-list">
        {comments.map((c) => (
          <CommentRow key={c.id} comment={c} />
        ))}
      </ul>
      <p className="arr-comments-foot">Edit comments in the library list.</p>
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
