import { useState, type FormEvent } from "react";
import {
  compareTags,
  normalizeTagName,
  parseKeywords,
  trackTagList,
  type Tag,
  type Track,
} from "./api";

/** `<datalist>` id with every shared tag name (rendered once by TrackList). */
export const TAG_NAMES_LIST_ID = "iff-tag-names";
const CATEGORY_LIST_ID = "iff-tag-categories";

export const TAG_NAME_HINT = "tag name: 1-64 letters, digits, _ : or -";

export function TagNamesDatalist({ tags }: { tags: Tag[] }) {
  return (
    <datalist id={TAG_NAMES_LIST_ID}>
      {tags.map((t) => (
        <option key={t.id} value={t.name} />
      ))}
    </datalist>
  );
}

function linkTitle(tag: Tag, addedByEmail: string | null, addedAt: string) {
  const parts = [tag.category ? `${tag.category}: ${tag.name}` : tag.name];
  const date = new Date(addedAt);
  const by = addedByEmail ?? "a removed user";
  parts.push(
    Number.isNaN(date.getTime())
      ? `added by ${by}`
      : `added by ${by} on ${date.toLocaleDateString()}`,
  );
  return parts.join(" · ");
}

/** Track-specific action handlers for shared tags. */
export type TrackTagActions = {
  /** Resolves false when the add failed (error already reported). */
  onAdd: (trackId: string, name: string) => Promise<boolean>;
  onRemove: (trackId: string, tagId: string) => void;
};

/**
 * Shared tags on one row, plus (when editable) an add box and the user's own
 * comment keywords that are not shared on this track yet.
 */
export function TrackTagChips({
  track,
  tagsById,
  myCommentBody,
  editable,
  removable,
  tagFilter,
  actions,
  onTagClick,
  onError,
}: {
  track: Track;
  tagsById: ReadonlyMap<string, Tag>;
  myCommentBody: string;
  editable: boolean;
  /** Global "edit tags" toggle: show × on chips (kept apart from filtering). */
  removable: boolean;
  tagFilter: string | null;
  actions: TrackTagActions;
  onTagClick: (tagId: string) => void;
  onError: (message: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const list = trackTagList(track, tagsById);
  const sharedLower = new Set(list.map(({ tag }) => tag.name.toLowerCase()));
  const suggestions = editable
    ? parseKeywords(myCommentBody).filter(
        (k) => !sharedLower.has(k.toLowerCase()) && normalizeTagName(k),
      )
    : [];

  async function add(raw: string) {
    const name = normalizeTagName(raw);
    if (!name) {
      onError(TAG_NAME_HINT);
      return false;
    }
    setBusy(true);
    try {
      return await actions.onAdd(track.id, name);
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) {
      setAdding(false);
      return;
    }
    if (await add(draft)) setDraft("");
  }

  if (list.length === 0 && suggestions.length === 0 && !editable) return null;

  return (
    <div
      className={removable ? "tag-row tag-row-removable" : "tag-row"}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {list.map(({ tag, link }) => (
        <span
          key={tag.id}
          className={
            tagFilter === tag.id ? "tag-chip tag-chip-selected" : "tag-chip"
          }
        >
          <button
            type="button"
            className="tag-chip-name"
            title={`${linkTitle(tag, link.addedByEmail, link.addedAt)} · click to filter`}
            onClick={() => onTagClick(tag.id)}
          >
            {tag.name}
          </button>
          {removable && (
            <button
              type="button"
              className="tag-chip-x"
              title={`Remove ${tag.name} from this track (for everyone)`}
              aria-label={`Remove tag ${tag.name}`}
              onClick={() => actions.onRemove(track.id, tag.id)}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {suggestions.map((k) => (
        <button
          key={k}
          type="button"
          className="tag-suggest"
          disabled={busy}
          title={`#${k} is a keyword in your comment — click to share it as a band tag`}
          onClick={() => void add(k)}
        >
          #{k} +
        </button>
      ))}
      {editable &&
        (adding ? (
          <form className="tag-add-form" onSubmit={onSubmit}>
            <input
              autoFocus
              value={draft}
              disabled={busy}
              list={TAG_NAMES_LIST_ID}
              maxLength={65}
              placeholder="tag"
              aria-label={`Add tag to ${track.filename}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setDraft("");
                  setAdding(false);
                }
              }}
              onBlur={() => {
                if (!draft.trim()) setAdding(false);
              }}
            />
          </form>
        ) : (
          <button
            type="button"
            className="tag-add"
            title="Add a band tag"
            aria-label={`Add tag to ${track.filename}`}
            onClick={() => setAdding(true)}
          >
            +
          </button>
        ))}
    </div>
  );
}

/** Tag filter dropdown, grouped by category, with per-tag track counts. */
export function TagFilterSelect({
  tags,
  counts,
  value,
  onChange,
}: {
  tags: Tag[];
  counts: ReadonlyMap<string, number>;
  value: string | null;
  onChange: (tagId: string | null) => void;
}) {
  if (tags.length === 0) return null;
  const groups = groupByCategory(tags);
  return (
    <select
      className={value ? "tagSelect tagSelectActive" : "tagSelect"}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label="Filter by tag"
    >
      <option value="">tags…</option>
      {groups.map(([category, list]) => {
        const options = list.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({counts.get(t.id) ?? 0})
          </option>
        ));
        return groups.length === 1 && category == null ? (
          options
        ) : (
          <optgroup key={category ?? ""} label={category ?? "uncategorized"}>
            {options}
          </optgroup>
        );
      })}
    </select>
  );
}

function groupByCategory(tags: Tag[]): [string | null, Tag[]][] {
  const groups = new Map<string | null, Tag[]>();
  for (const t of [...tags].sort(compareTags)) {
    const list = groups.get(t.category) ?? [];
    list.push(t);
    groups.set(t.category, list);
  }
  return [...groups];
}

/** Find another tag whose name matches case-insensitively (merge target). */
function findOther(tags: Tag[], name: string, selfId: string) {
  const others = tags.filter(
    (t) => t.id !== selfId && t.name.toLowerCase() === name.toLowerCase(),
  );
  return others.find((t) => t.name === name) ?? others[0] ?? null;
}

export type TagManagerActions = {
  /** Resolves false on failure (error already reported). */
  onUpdate: (
    tagId: string,
    patch: { name?: string; category?: string | null },
  ) => Promise<boolean>;
  onDelete: (tagId: string) => Promise<void>;
};

/** Band tag list: rename (merges on name clash), set category, delete. */
export function TagManager({
  tags,
  counts,
  actions,
  onError,
  onClose,
}: {
  tags: Tag[];
  counts: ReadonlyMap<string, number>;
  actions: TagManagerActions;
  onError: (message: string | null) => void;
  onClose: () => void;
}) {
  const categories = [
    ...new Set(tags.flatMap((t) => (t.category ? [t.category] : []))),
  ].sort((a, b) => a.localeCompare(b));
  const sorted = [...tags].sort(compareTags);

  return (
    <div className="account-panel tag-manager">
      <div className="tag-manager-head">
        <span>
          Band tags ({tags.length}) — shared by everyone. Renaming a tag onto
          an existing name merges them.
        </span>
        <button type="button" className="filterButton" onClick={onClose}>
          close
        </button>
      </div>
      <datalist id={CATEGORY_LIST_ID}>
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      {sorted.length === 0 ? (
        <p className="tag-manager-empty">
          No tags yet. Add one on a track with “+”.
        </p>
      ) : (
        <table className="tag-manager-table">
          <thead>
            <tr>
              <th>name</th>
              <th>category</th>
              <th className="num">tracks</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((tag) => (
              <TagManagerRow
                // Remount after a rename so drafts reset to the stored value.
                key={`${tag.id}:${tag.name}:${tag.category ?? ""}`}
                tag={tag}
                tags={tags}
                count={counts.get(tag.id) ?? 0}
                actions={actions}
                onError={onError}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TagManagerRow({
  tag,
  tags,
  count,
  actions,
  onError,
}: {
  tag: Tag;
  tags: Tag[];
  count: number;
  actions: TagManagerActions;
  onError: (message: string | null) => void;
}) {
  const [name, setName] = useState(tag.name);
  const [category, setCategory] = useState(tag.category ?? "");
  const [busy, setBusy] = useState(false);

  async function commitName() {
    const next = normalizeTagName(name);
    if (!next) {
      onError(TAG_NAME_HINT);
      setName(tag.name);
      return;
    }
    if (next === tag.name) {
      setName(tag.name);
      return;
    }
    const target = findOther(tags, next, tag.id);
    if (
      target &&
      !window.confirm(
        `Merge “${tag.name}” into “${target.name}”? Tracks tagged ${tag.name} get ${target.name}, and ${tag.name} is removed.`,
      )
    ) {
      setName(tag.name);
      return;
    }
    setBusy(true);
    const ok = await actions.onUpdate(tag.id, { name: next });
    setBusy(false);
    if (!ok) setName(tag.name);
  }

  async function commitCategory() {
    const next = category.trim() || null;
    if (next === tag.category) return;
    setBusy(true);
    const ok = await actions.onUpdate(tag.id, { category: next });
    setBusy(false);
    if (!ok) setCategory(tag.category ?? "");
  }

  return (
    <tr>
      <td>
        <input
          value={name}
          disabled={busy}
          maxLength={65}
          aria-label={`Name of tag ${tag.name}`}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void commitName()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setName(tag.name);
          }}
        />
      </td>
      <td>
        <input
          value={category}
          disabled={busy}
          maxLength={40}
          list={CATEGORY_LIST_ID}
          placeholder="—"
          aria-label={`Category of tag ${tag.name}`}
          onChange={(e) => setCategory(e.target.value)}
          onBlur={() => void commitCategory()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setCategory(tag.category ?? "");
          }}
        />
      </td>
      <td className="num">{count}</td>
      <td>
        <button
          type="button"
          className="release-btn"
          disabled={busy}
          title={`Delete ${tag.name} from every track`}
          onClick={() => {
            if (
              window.confirm(
                count > 0
                  ? `Delete tag “${tag.name}”? It is removed from ${count} track(s) for everyone.`
                  : `Delete tag “${tag.name}”?`,
              )
            ) {
              setBusy(true);
              void actions.onDelete(tag.id).finally(() => setBusy(false));
            }
          }}
        >
          delete
        </button>
      </td>
    </tr>
  );
}
