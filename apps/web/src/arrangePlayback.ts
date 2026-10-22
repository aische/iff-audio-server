import { trackStreamUrl } from "./api";

/**
 * Per-clip playback for the arrange view. The transport (schedule, seeking,
 * solo audition, stale-start handling) lives in ArrangeView and only talks
 * to these interfaces; the mode just picks which engine creates voices.
 */
export type PlaybackMode = "stream" | "precise";

export const PLAYBACK_MODES: PlaybackMode[] = ["stream", "precise"];

/** One clip instance's audio. Reusable: load once, then start/stop as often as needed. */
export interface ClipVoice {
  /** Fetch / buffer what's needed to start near `offsetSec`. */
  load(offsetSec: number): Promise<void>;
  /**
   * Play source `[offsetSec, offsetSec + durSec)` beginning `delaySec` from now.
   * Rejects if playback fails to start.
   */
  start(offsetSec: number, durSec: number, delaySec: number): Promise<void>;
  /** Silence the voice; it stays loaded. */
  stop(): void;
  setGain(gain: number): void;
  /** Source position of audible output, or null while not (yet) audible. */
  sourcePosition(): number | null;
  /** True once the last start finished or will produce no more audio. */
  ended(): boolean;
  /** Release everything this voice holds. */
  dispose(): void;
}

export interface PlaybackEngine {
  readonly mode: PlaybackMode;
  createVoice(trackId: string): ClipVoice;
  /** Release all resources (elements / buffers). Voices must not be used afterwards. */
  dispose(): void;
}

export function createPlaybackEngine(
  mode: PlaybackMode,
  ctx: AudioContext,
): PlaybackEngine {
  return mode === "stream"
    ? createStreamEngine(ctx)
    : createPreciseEngine(ctx);
}

function isAbortError(err: unknown) {
  return err instanceof DOMException && err.name === "AbortError";
}

// ---------------------------------------------------------------------------
// stream: HTMLAudioElement → MediaElementAudioSourceNode → GainNode

/** Skip re-seeking an element that is already this close to the target. */
const STREAM_SEEK_TOLERANCE_SEC = 0.05;
/** Backup stop via `timeupdate` when rAF is throttled (background tab). */
const STREAM_OVERRUN_SEC = 0.25;
/** Idle elements kept around for reuse. */
const STREAM_POOL_MAX = 4;

type PooledElement = {
  el: HTMLAudioElement;
  gain: GainNode;
  source: MediaElementAudioSourceNode;
};

function createStreamEngine(ctx: AudioContext): PlaybackEngine {
  // createMediaElementSource works once per element, so elements are pooled.
  const free: PooledElement[] = [];
  const all = new Set<PooledElement>();

  function acquire(url: string): PooledElement {
    const reused = free.pop();
    if (reused) return reused;
    const el = new Audio();
    el.preload = "auto";
    if (new URL(url, location.href).origin !== location.origin) {
      // Without CORS credentials Web Audio would output silence.
      el.crossOrigin = "use-credentials";
    }
    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(ctx.destination);
    const item = { el, gain, source };
    all.add(item);
    return item;
  }

  function clear(item: PooledElement) {
    item.el.pause();
    item.el.removeAttribute("src");
    item.el.load();
  }

  function destroy(item: PooledElement) {
    clear(item);
    item.source.disconnect();
    item.gain.disconnect();
    all.delete(item);
  }

  function release(item: PooledElement) {
    if (!all.has(item)) return;
    if (free.length >= STREAM_POOL_MAX) {
      destroy(item);
      return;
    }
    clear(item);
    free.push(item);
  }

  return {
    mode: "stream",
    createVoice(trackId) {
      const url = trackStreamUrl(trackId);
      const item = acquire(url);
      const { el } = item;
      let started = false;
      let endSec = Infinity;
      let startTimer: number | null = null;
      let startToken = 0;
      let cancelLoad: (() => void) | null = null;

      const onTimeUpdate = () => {
        if (started && el.currentTime >= endSec + STREAM_OVERRUN_SEC) el.pause();
      };
      el.addEventListener("timeupdate", onTimeUpdate);

      function seekTo(offsetSec: number) {
        if (Math.abs(el.currentTime - offsetSec) > STREAM_SEEK_TOLERANCE_SEC) {
          el.currentTime = offsetSec;
        }
      }

      function stop() {
        startToken += 1;
        started = false;
        if (startTimer != null) {
          window.clearTimeout(startTimer);
          startTimer = null;
        }
        el.pause();
      }

      return {
        load(offsetSec) {
          cancelLoad?.();
          return new Promise<void>((resolve, reject) => {
            const events = ["loadedmetadata", "canplay", "seeked"] as const;
            const done = () => {
              if (el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
              if (el.seeking) return;
              cleanup();
              resolve();
            };
            const fail = () => {
              cleanup();
              reject(new Error("Failed to load audio"));
            };
            const cleanup = () => {
              for (const ev of events) el.removeEventListener(ev, done);
              el.removeEventListener("error", fail);
              cancelLoad = null;
            };
            cancelLoad = cleanup;
            for (const ev of events) el.addEventListener(ev, done);
            el.addEventListener("error", fail);
            if (!el.getAttribute("src")) el.src = url;
            // Before metadata this sets the default start position.
            seekTo(offsetSec);
            done();
          });
        },
        start(offsetSec, durSec, delaySec) {
          stop();
          const token = startToken;
          endSec = offsetSec + durSec;
          return new Promise<void>((resolve, reject) => {
            const go = () => {
              startTimer = null;
              if (token !== startToken) return resolve();
              seekTo(offsetSec);
              started = true;
              el.play().then(resolve, (err: unknown) => {
                // pause() during play() — superseded, not a failure.
                if (token !== startToken || isAbortError(err)) resolve();
                else reject(err);
              });
            };
            if (delaySec > 0.001) {
              startTimer = window.setTimeout(go, delaySec * 1000);
            } else {
              go();
            }
          });
        },
        stop,
        setGain(gain) {
          item.gain.gain.value = gain;
        },
        sourcePosition() {
          if (!started || el.paused || el.seeking) return null;
          if (el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return null;
          return el.currentTime;
        },
        ended() {
          return started && (el.ended || el.error != null);
        },
        dispose() {
          stop();
          cancelLoad?.();
          el.removeEventListener("timeupdate", onTimeUpdate);
          item.gain.gain.value = 1;
          release(item);
        },
      };
    },
    dispose() {
      for (const item of [...all]) destroy(item);
      free.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// precise: decoded AudioBuffer → AudioBufferSourceNode → GainNode

/** Starts this close to another voice's scheduled end snap onto it (gapless). */
const PRECISE_SNAP_SEC = 0.01;

type BufferEntry = {
  refs: number;
  abort: AbortController;
  promise: Promise<AudioBuffer>;
};

function createPreciseEngine(ctx: AudioContext): PlaybackEngine {
  // Only tracks with a live voice stay decoded; the transport keeps voices
  // for the current and next clip only.
  const buffers = new Map<string, BufferEntry>();
  /** Scheduled end (ctx time) of each started voice, for back-to-back snapping. */
  const scheduledEnds = new Map<object, number>();

  function acquire(trackId: string): BufferEntry {
    const existing = buffers.get(trackId);
    if (existing) {
      existing.refs += 1;
      return existing;
    }
    const abort = new AbortController();
    const promise = (async () => {
      const res = await fetch(trackStreamUrl(trackId), {
        credentials: "include",
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`Failed to load audio (${res.status})`);
      const raw = await res.arrayBuffer();
      return ctx.decodeAudioData(raw);
    })();
    // Avoid unhandled rejections when nobody awaits an aborted decode.
    promise.catch(() => undefined);
    const entry = { refs: 1, abort, promise };
    buffers.set(trackId, entry);
    return entry;
  }

  function release(trackId: string, entry: BufferEntry) {
    entry.refs -= 1;
    if (entry.refs > 0 || buffers.get(trackId) !== entry) return;
    entry.abort.abort();
    buffers.delete(trackId);
  }

  return {
    mode: "precise",
    createVoice(trackId) {
      const entry = acquire(trackId);
      const key = {};
      let buffer: AudioBuffer | null = null;
      let disposed = false;
      let gainValue = 1;
      let playing: {
        source: AudioBufferSourceNode;
        gain: GainNode;
        when: number;
        offset: number;
        ended: boolean;
      } | null = null;

      function stop() {
        scheduledEnds.delete(key);
        if (!playing) return;
        const p = playing;
        playing = null;
        p.source.onended = null;
        try {
          p.source.stop();
        } catch {
          // already stopped
        }
        p.source.disconnect();
        p.gain.disconnect();
      }

      return {
        async load() {
          buffer = await entry.promise;
        },
        async start(offsetSec, durSec, delaySec) {
          stop();
          if (disposed) return;
          buffer ??= await entry.promise;
          if (disposed) return;
          const offset = Math.max(
            0,
            Math.min(offsetSec, Math.max(0, buffer.duration - 0.001)),
          );
          const dur = Math.min(durSec, Math.max(0, buffer.duration - offset));
          if (dur <= 0.001) return;

          let when = ctx.currentTime + Math.max(0, delaySec);
          for (const end of scheduledEnds.values()) {
            if (Math.abs(end - when) < PRECISE_SNAP_SEC && end >= ctx.currentTime) {
              when = end;
              break;
            }
          }

          const gain = ctx.createGain();
          gain.gain.value = gainValue;
          gain.connect(ctx.destination);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(gain);
          const p = { source, gain, when, offset, ended: false };
          source.onended = () => {
            p.ended = true;
          };
          source.start(when, offset, dur);
          playing = p;
          scheduledEnds.set(key, when + dur);
        },
        stop,
        setGain(gain) {
          gainValue = gain;
          if (playing) playing.gain.gain.value = gain;
        },
        sourcePosition() {
          if (!playing || playing.ended) return null;
          const elapsed = ctx.currentTime - playing.when;
          return elapsed < 0 ? null : playing.offset + elapsed;
        },
        ended() {
          return playing?.ended ?? false;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          stop();
          buffer = null;
          release(trackId, entry);
        },
      };
    },
    dispose() {
      for (const entry of buffers.values()) entry.abort.abort();
      buffers.clear();
      scheduledEnds.clear();
    },
  };
}
