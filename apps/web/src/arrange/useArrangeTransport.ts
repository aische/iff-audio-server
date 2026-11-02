import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ArrangementClip } from "../api";
import {
  createPlaybackEngine,
  type ClipVoice,
  type PlaybackEngine,
  type PlaybackMode,
} from "../arrangePlayback";
import {
  createPlayheadStore,
  useLatestRef,
  usePlayhead,
} from "./playhead";
import { persistPlaybackMode, readPlaybackMode } from "./storage";
import {
  audioSegAt,
  audioSegOf,
  buildSchedule,
  retimeAfterEdit,
  retimeAfterSkip,
  segAt,
  type Retime,
  type ScheduleSeg,
} from "./timeline";

/** Restart a voice only after an explicit seek (not rAF vs audio clock drift). */
const SEEK_JUMP_SEC = 0.3;
/** Start the next clip this far ahead so the engine can schedule it on time. */
const LOOKAHEAD_SEC = 0.2;
/** Show "loading…" only when audio is held up longer than this. */
const WAITING_HINT_MS = 200;
/** Clip play resumes from the playhead unless it is this close to the out point. */
const RESUME_TAIL_SEC = 0.25;

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
  /** Source time the last start plays up to. */
  endSrc: number;
};

/**
 * Playback of an arrangement: the playhead, play / stop, seeking, auditioning
 * one clip (solo), skipping clips for this session, and the audio voices
 * that follow the playhead. Edits to `clips` while playing keep the playhead
 * on the same spot of the same clip.
 */
export function useArrangeTransport(
  clips: ArrangementClip[],
  onError: (message: string | null) => void,
) {
  const [playhead] = useState(createPlayheadStore);
  const setPlayheadSec = playhead.set;
  const [playing, setPlaying] = useState(false);
  /** When set, transport stops at this arrangement time (solo clip audition). */
  const [soloEndSec, setSoloEndSec] = useState<number | null>(null);
  const [soloClipId, setSoloClipId] = useState<string | null>(null);
  /** Clip instances left out of playback. Temporary: never saved. */
  const [skippedIds, setSkippedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [playbackMode, setPlaybackMode] =
    useState<PlaybackMode>(readPlaybackMode);
  /** Audio for the clip under the playhead is taking a while to start. */
  const [audioWaiting, setAudioWaiting] = useState(false);

  const playRef = useLatestRef(playing);
  const soloEndRef = useLatestRef(soloEndSec);
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

  // --- Voices --------------------------------------------------------------

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
      endSrc: 0,
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
    slot.endSrc = offsetSec + durSec;
    slot.voice.setGain(clip.gain);
    slot.voice.start(offsetSec, durSec, delaySec).catch((err: unknown) => {
      if (!isSlotCurrent(slot, gen)) return;
      slot.state = "failed";
      onError(err instanceof Error ? err.message : "Failed to play audio");
    });
  }

  // --- Transport -----------------------------------------------------------

  function setWaitingHint(value: boolean) {
    if (audioWaitingRef.current === value) return;
    audioWaitingRef.current = value;
    setAudioWaiting(value);
  }

  function stop() {
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
        // The out point moved later after this voice started: restart it
        // just before it would stop, rather than on every trim drag event.
        if (
          cur.clip.outSec > slot.endSrc + 0.001 &&
          slot.endSrc - offset < LOOKAHEAD_SEC
        ) {
          startSlot(slot, cur.clip, offset, cur.arrEnd - at, 0);
        }
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

  /**
   * The schedule changed under a soloed clip: follow its new out point, or
   * stop if it no longer plays. True when the transport was stopped.
   */
  function retargetSolo(newSegs: ScheduleSeg[]) {
    if (soloClipId == null) return false;
    const soloSeg = audioSegOf(newSegs, soloClipId);
    if (!soloSeg) {
      stop();
      return true;
    }
    soloEndRef.current = soloSeg.arrEnd;
    setSoloEndSec(soloSeg.arrEnd);
    return false;
  }

  /** Move the playhead after a timeline change; reload audio only if needed. */
  function applyRetime({ target, continuous }: Retime, stopped: boolean) {
    setPlayheadSec(target);
    if (!playRef.current || stopped) return;
    if (continuous) {
      // Same audio position, new timeline: not a seek.
      lastSyncAtRef.current = target;
    } else {
      syncAudio(target, true);
    }
  }

  const retimeHead = useEffectEvent(
    (oldSegs: ScheduleSeg[], newSegs: ScheduleSeg[]) => {
      const stopped = retargetSolo(newSegs);
      const retime = retimeAfterEdit(oldSegs, newSegs, playhead.get());
      if (retime) applyRetime(retime, stopped);
    },
  );
  const prevScheduleRef = useRef({ clips, segs });
  useLayoutEffect(() => {
    const prev = prevScheduleRef.current;
    prevScheduleRef.current = { clips, segs };
    // Skip toggles change `segs` only and retime the playhead themselves.
    if (prev.clips !== clips) retimeHead(prev.segs, segs);
  }, [clips, segs]);

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
        stop();
        return;
      }
      const end = totalSecRef.current;
      if (next >= end) {
        setPlayheadSec(end);
        stop();
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

  // --- Actions -------------------------------------------------------------

  /** Play the full arrangement from the playhead (clears solo), or stop. */
  function togglePlay() {
    if (playing) {
      stop();
      return;
    }
    soloEndRef.current = null;
    setSoloEndSec(null);
    setSoloClipId(null);
    setPlaying(true);
  }

  function seek(at: number) {
    const clamped = Math.max(0, Math.min(totalSec, at));
    setPlayheadSec(clamped);
    syncAudio(clamped, true);
  }

  /** Move the playhead to source time `srcSec` of a clip (trim view click). */
  function seekInClip(instanceId: string, srcSec: number) {
    const seg = audioSegOf(segsRef.current, instanceId);
    if (!seg) return;
    const into = Math.max(
      0,
      Math.min(srcSec - seg.clip.inSec, seg.arrEnd - seg.arrStart),
    );
    // Auditioning another clip: audition this one from here instead.
    if (playing && soloClipId != null && soloClipId !== instanceId) {
      soloEndRef.current = seg.arrEnd;
      setSoloEndSec(seg.arrEnd);
      setSoloClipId(instanceId);
    }
    seek(seg.arrStart + into);
  }

  /**
   * Audition one clip through outSec, then stop. Starts at the playhead when
   * it is inside the clip, otherwise (or with `fromStart`) at the in point.
   * Toggles off while that clip is already auditioning, unless `fromStart`
   * (which restarts it).
   */
  function playClip(instanceId: string, fromStart = false) {
    const seg = audioSegOf(segsRef.current, instanceId);
    if (!seg) return;
    if (!fromStart && playing && soloClipId === instanceId) {
      stop();
      return;
    }
    const head = playhead.get();
    const from =
      !fromStart && head >= seg.arrStart && head < seg.arrEnd - RESUME_TAIL_SEC
        ? head
        : seg.arrStart;
    stopAllVoices();
    soloEndRef.current = seg.arrEnd;
    setSoloEndSec(seg.arrEnd);
    setSoloClipId(instanceId);
    setPlayheadSec(from);
    if (!playing) {
      setPlaying(true);
    } else {
      syncAudio(from, true);
    }
  }

  /** Replace the skipped set; the playhead stays on its clip if it still plays. */
  function setSkipped(ids: ReadonlySet<string>) {
    const at = playhead.get();
    const next = buildSchedule(clips.filter((c) => !ids.has(c.instanceId)));
    setSkippedIds(ids);
    // Rendering catches the refs up too, but the transport may tick first.
    segsRef.current = next.segs;
    totalSecRef.current = next.totalSec;
    const stopped = retargetSolo(next.segs);
    applyRetime(
      retimeAfterSkip(clips, ids, { segs, totalSec }, next, at),
      stopped,
    );
  }

  function toggleSkip(instanceId: string) {
    const ids = new Set(skippedIds);
    if (!ids.delete(instanceId)) ids.add(instanceId);
    setSkipped(ids);
  }

  function changePlaybackMode(mode: PlaybackMode) {
    if (mode === playbackModeRef.current) return;
    stop();
    releaseEngine();
    playbackModeRef.current = mode;
    setPlaybackMode(mode);
    persistPlaybackMode(mode);
  }

  return {
    playhead,
    segs,
    totalSec,
    headClipId,
    playing,
    audioWaiting,
    playbackMode,
    soloClipId,
    skippedIds,
    togglePlay,
    stop,
    seek,
    seekInClip,
    playClip,
    setSkipped,
    toggleSkip,
    changePlaybackMode,
  };
}
