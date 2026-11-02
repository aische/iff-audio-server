import { useState } from "react";
import type { SaveState } from "./useArrangementDoc";

const SAVE_LABEL: Record<SaveState, string> = {
  idle: "",
  saving: "saving…",
  saved: "saved",
  error: "save failed",
};

/** Back link, name, and autosave status (or read-only + copy to edit). */
export function IdentityBar({
  isOwner,
  name,
  onNameChange,
  ownerEmail,
  saveState,
  onBack,
  onCopy,
}: {
  isOwner: boolean;
  name: string;
  onNameChange: (name: string) => void;
  ownerEmail: string;
  saveState: SaveState;
  onBack: () => void;
  /** Make the viewer's own editable copy (non-owners). */
  onCopy: () => Promise<void>;
}) {
  const [copying, setCopying] = useState(false);

  async function copy() {
    setCopying(true);
    try {
      await onCopy();
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="arr-identity">
      <button type="button" className="filterButton" onClick={onBack}>
        ← arrangements
      </button>
      {isOwner ? (
        <input
          className="arr-name-input"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          aria-label="Arrangement name"
        />
      ) : (
        <span className="arr-name-ro" title={name}>
          {name}
        </span>
      )}
      {!isOwner && <span className="arr-muted arr-owner">by {ownerEmail}</span>}
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
          {SAVE_LABEL[saveState]}
        </span>
      ) : (
        <>
          <span className="arr-readonly-tag">read-only</span>
          <button
            type="button"
            className="filterButton arr-cta"
            disabled={copying}
            title="Make your own editable copy of this arrangement"
            onClick={() => void copy()}
          >
            {copying ? "copying…" : "copy to edit"}
          </button>
        </>
      )}
    </div>
  );
}
