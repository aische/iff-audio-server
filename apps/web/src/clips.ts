import type { ArrangementClip, Track } from "./api";

/** Full-length clip for a track; null when the file is missing. */
export function newClipForTrack(
  track: Track | undefined,
): ArrangementClip | null {
  if (!track?.present) return null;
  const dur =
    track.durationSeconds != null && track.durationSeconds > 0
      ? track.durationSeconds
      : 60;
  return {
    instanceId: crypto.randomUUID(),
    trackId: track.id,
    inSec: 0,
    outSec: dur,
    pauseSec: 0,
    gain: 1,
  };
}
