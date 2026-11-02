import type { ArrangementClip, Track } from "../api";
import { getCachedPeaks } from "../peaks";
import { MIN_CLIP_SEC, sourceDuration } from "./timeline";

export const EDITOR_WAVE_H = 96;
export const PX_PER_SEC_MIN = 2;
export const PX_PER_SEC_MAX = 200;
export const EDITOR_PX_DEFAULT = 40;
/** Cap canvas backing-store width — huge tracks × zoom × DPR can blank the GPU. */
export const MAX_CANVAS_BACKING_PX = 8192;
/** Soft cap on editor CSS width before we force-fit zoom. */
export const MAX_EDITOR_CSS_PX = 4096;

/** Trim-editor zoom that fits `durSec` within the editor's width cap. */
export function fitPxPerSec(durSec: number) {
  const fit = MAX_EDITOR_CSS_PX / Math.max(durSec, MIN_CLIP_SEC);
  return Math.min(EDITOR_PX_DEFAULT, Math.max(PX_PER_SEC_MIN, fit));
}

/** Waveform scale for the trim editor, capped so huge tracks stay drawable. */
export function trimScale(
  clip: ArrangementClip,
  track: Track,
  editorPxPerSec: number,
) {
  const srcDur = sourceDuration(track, getCachedPeaks(clip.trackId) ?? null);
  const maxPx = Math.min(
    PX_PER_SEC_MAX,
    MAX_EDITOR_CSS_PX / Math.max(srcDur, MIN_CLIP_SEC),
  );
  const effectivePx = Math.min(editorPxPerSec, Math.max(PX_PER_SEC_MIN, maxPx));
  return { srcDur, maxPx, effectivePx };
}
