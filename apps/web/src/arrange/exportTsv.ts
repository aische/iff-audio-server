import type { ArrangementClip, Track } from "../api";

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
export function buildArrangementTsv(
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

/** Download the arrangement's cut list as `<name>.tsv`. */
export function downloadArrangementTsv(
  name: string,
  clips: ArrangementClip[],
  trackById: Map<string, Track>,
) {
  downloadTextFile(
    `${sanitizeDownloadName(name)}.tsv`,
    buildArrangementTsv(clips, trackById),
    "text/tab-separated-values;charset=utf-8",
  );
}
