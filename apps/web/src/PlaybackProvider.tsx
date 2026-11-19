import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { trackStreamUrl, type Track } from "./api";
import { PlaybackContext, type LibraryPlayback } from "./playback";

/** Owns the library <audio> element and shares its state (see playback.ts). */
export function PlaybackProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const timeListeners = useRef(new Set<() => void>());

  const notifyTime = useCallback(() => {
    for (const listener of timeListeners.current) listener();
  }, []);

  const subscribeTime = useCallback((listener: () => void) => {
    timeListeners.current.add(listener);
    return () => {
      timeListeners.current.delete(listener);
    };
  }, []);

  const getTime = useCallback(() => audioRef.current?.currentTime ?? 0, []);

  /** play() rejects on abort (a newer src) or autoplay refusal. */
  const startAudio = useCallback((el: HTMLAudioElement) => {
    el.play().catch(() => {
      if (el.paused) setIsPlaying(false);
    });
  }, []);

  const play = useCallback(
    (next: Track) => {
      const el = audioRef.current;
      if (!el) return;
      el.src = trackStreamUrl(next.id);
      setTrack(next);
      setDuration(null);
      setIsPlaying(true);
      startAudio(el);
    },
    [startAudio],
  );

  const togglePause = useCallback(() => {
    const el = audioRef.current;
    if (!el?.getAttribute("src")) return;
    if (el.paused) startAudio(el);
    else el.pause();
  }, [startAudio]);

  const seek = useCallback(
    (seconds: number) => {
      const el = audioRef.current;
      if (!el?.getAttribute("src")) return;
      el.currentTime = seconds;
      notifyTime();
    },
    [notifyTime],
  );

  const stop = useCallback(() => {
    const el = audioRef.current;
    if (el?.getAttribute("src")) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    setTrack(null);
    setIsPlaying(false);
    setDuration(null);
  }, []);

  // Logging out unmounts the provider; never leave audio running.
  useEffect(() => {
    const el = audioRef.current;
    return () => el?.pause();
  }, []);

  const value = useMemo<LibraryPlayback>(
    () => ({
      track,
      isPlaying,
      duration,
      play,
      togglePause,
      seek,
      stop,
      getTime,
      subscribeTime,
    }),
    [track, isPlaying, duration, play, togglePause, seek, stop, getTime, subscribeTime],
  );

  return (
    <PlaybackContext value={value}>
      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        // Ended keeps the track loaded, so play starts it again.
        onEnded={() => setIsPlaying(false)}
        onTimeUpdate={notifyTime}
        onEmptied={notifyTime}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration;
          setDuration(Number.isFinite(d) ? d : null);
        }}
      />
      {children}
    </PlaybackContext>
  );
}
