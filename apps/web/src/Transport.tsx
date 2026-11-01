import { useEffect, useRef, useState } from "react";
import { trackStreamUrl } from "./api";
import { formatClock, formatDuration, shortTitle } from "./format";

export type TransportTrack = {
  id: string;
  filename: string;
  durationSeconds: number | null;
};

export type TransportProps = {
  track: TransportTrack | null;
  onEnded?: () => void;
};

export default function Transport({ track, onEnded }: TransportProps) {
  if (!track) {
    return (
      <div className="transport transport-empty">
        <span className="transport-placeholder">no track</span>
      </div>
    );
  }

  return <TransportActive key={track.id} track={track} onEnded={onEnded} />;
}

function TransportActive({
  track,
  onEnded,
}: {
  track: TransportTrack;
  onEnded?: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTimeUpdate = () => setCurrentTime(Math.floor(el.currentTime));
    const onDurationChange = () =>
      setAudioDuration(Number.isFinite(el.duration) ? el.duration : null);
    const onEndedHandler = () => {
      setIsPlaying(false);
      onEnded?.();
    };

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("durationchange", onDurationChange);
    el.addEventListener("ended", onEndedHandler);

    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("durationchange", onDurationChange);
      el.removeEventListener("ended", onEndedHandler);
    };
  }, [onEnded]);

  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }

  function onScrub(e: React.ChangeEvent<HTMLInputElement>) {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Number(e.target.value);
    setCurrentTime(Math.floor(Number(e.target.value)));
  }

  const displayDuration = audioDuration ?? track.durationSeconds ?? null;

  return (
    <div className="transport">
      <audio
        ref={audioRef}
        src={trackStreamUrl(track.id)}
        autoPlay
        preload="metadata"
      />
      <button
        type="button"
        className="transport-play"
        onClick={togglePlay}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? "pause" : "play"}
      </button>
      <span className="transport-title">{shortTitle(track.filename)}</span>
      <span className="transport-time">
        {formatClock(currentTime)}
        {" / "}
        {formatDuration(
          displayDuration != null ? Math.floor(displayDuration) : null,
        )}
      </span>
      {displayDuration != null && (
        <input
          type="range"
          className="transport-scrub"
          min={0}
          max={Math.max(1, Math.floor(displayDuration))}
          value={Math.min(currentTime, Math.floor(displayDuration))}
          onChange={onScrub}
          aria-label="Scrub"
        />
      )}
    </div>
  );
}
