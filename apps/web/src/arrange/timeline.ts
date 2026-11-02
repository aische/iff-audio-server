import type { ArrangementClip, Track } from "../api";
import type { PeaksRecord } from "../peaks";

/** Shortest a clip can be trimmed to. */
export const MIN_CLIP_SEC = 0.5;

/** One stretch of the arrangement timeline: a clip's audio, or the pause after it. */
export type ScheduleSeg = {
  clip: ArrangementClip;
  arrStart: number;
  arrEnd: number;
  kind: "audio" | "pause";
};

export type ClipPatch = Partial<
  Pick<ArrangementClip, "inSec" | "outSec" | "pauseSec" | "gain">
>;

export function clipDuration(clip: ArrangementClip) {
  return Math.max(MIN_CLIP_SEC, clip.outSec - clip.inSec);
}

/** Length of the clip's source file: track metadata, else peaks, else a guess. */
export function sourceDuration(
  track: Track | undefined,
  peaks: PeaksRecord | null,
) {
  if (track?.durationSeconds != null && track.durationSeconds > 0) {
    return track.durationSeconds;
  }
  if (peaks && peaks.durationSec > 0) return peaks.durationSec;
  return 60;
}

export function buildSchedule(clips: ArrangementClip[]): {
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

/** Audio segment under `at`. */
export function audioSegAt(segs: ScheduleSeg[], at: number) {
  return segs.find(
    (s) => s.kind === "audio" && at >= s.arrStart && at < s.arrEnd,
  );
}

/** Audio or pause segment under `at`. */
export function segAt(segs: ScheduleSeg[], at: number) {
  return segs.find((s) => at >= s.arrStart && at < s.arrEnd);
}

/** Audio segment of a clip instance; none while it is skipped. */
export function audioSegOf(segs: ScheduleSeg[], instanceId: string) {
  return segs.find(
    (s) => s.kind === "audio" && s.clip.instanceId === instanceId,
  );
}

export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) {
    return arr;
  }
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/**
 * Apply an edit to a clip, keeping in / out inside the source (and at least
 * MIN_CLIP_SEC apart), pause non-negative and gain within 0–2.
 */
export function applyClipPatch(
  c: ArrangementClip,
  patch: ClipPatch,
  srcDur: number,
): ArrangementClip {
  let inSec = patch.inSec ?? c.inSec;
  let outSec = patch.outSec ?? c.outSec;
  inSec = Math.max(0, Math.min(inSec, srcDur - MIN_CLIP_SEC));
  outSec = Math.max(inSec + MIN_CLIP_SEC, Math.min(outSec, srcDur));
  return {
    ...c,
    inSec,
    outSec,
    pauseSec:
      patch.pauseSec !== undefined ? Math.max(0, patch.pauseSec) : c.pauseSec,
    gain:
      patch.gain !== undefined ? Math.min(2, Math.max(0, patch.gain)) : c.gain,
  };
}

/**
 * New playhead after the timeline changed. `continuous`: the audio under the
 * playhead is the same as before, so running voices can keep playing.
 */
export type Retime = { target: number; continuous: boolean };

/**
 * After clips change (trim, pause, reorder, edits to earlier clips), keep
 * the playhead on the same spot of the same clip: inside its audio at the
 * same source time, or at the new in / out point if that was trimmed past.
 * Null when the playhead was not on a clip that still exists.
 */
export function retimeAfterEdit(
  oldSegs: ScheduleSeg[],
  newSegs: ScheduleSeg[],
  at: number,
): Retime | null {
  const old = segAt(oldSegs, at);
  if (!old) return null;
  const id = old.clip.instanceId;
  const audio = audioSegOf(newSegs, id);
  if (!audio) return null;

  if (old.kind === "audio") {
    const src = old.clip.inSec + (at - old.arrStart);
    if (src < audio.clip.inSec) {
      return { target: audio.arrStart, continuous: false };
    }
    if (src >= audio.clip.outSec) {
      return { target: audio.arrEnd, continuous: false };
    }
    return {
      target: audio.arrStart + (src - audio.clip.inSec),
      continuous: true,
    };
  }

  const pause = newSegs.find(
    (s) => s.kind === "pause" && s.clip.instanceId === id,
  );
  const oldLen = old.arrEnd - old.arrStart;
  return {
    target: pause
      ? Math.min(pause.arrEnd, pause.arrStart + (at - old.arrStart))
      : audio.arrEnd,
    // The next clip may already be scheduled against the old pause.
    continuous:
      pause != null && Math.abs(pause.arrEnd - pause.arrStart - oldLen) < 0.001,
  };
}

/**
 * After the set of skipped clips changed, the playhead stays on the clip it
 * was in; if that clip is now skipped, it moves to the start of the next
 * clip that still plays.
 */
export function retimeAfterSkip(
  clips: ArrangementClip[],
  skipped: ReadonlySet<string>,
  old: { segs: ScheduleSeg[]; totalSec: number },
  next: { segs: ScheduleSeg[]; totalSec: number },
  at: number,
): Retime {
  const cur = segAt(old.segs, at);
  if (!cur) {
    return {
      target: at >= old.totalSec ? next.totalSec : Math.min(at, next.totalSec),
      continuous: true,
    };
  }
  const same = next.segs.find(
    (s) => s.kind === cur.kind && s.clip.instanceId === cur.clip.instanceId,
  );
  if (same) {
    return { target: same.arrStart + (at - cur.arrStart), continuous: true };
  }
  const from = clips.findIndex((c) => c.instanceId === cur.clip.instanceId);
  const after = clips.slice(from + 1).find((c) => !skipped.has(c.instanceId));
  const afterSeg = after ? audioSegOf(next.segs, after.instanceId) : undefined;
  return {
    target: afterSeg ? afterSeg.arrStart : next.totalSec,
    continuous: false,
  };
}
