/** Library keys (useLibraryShortcuts), as shown to the user. */
const LIBRARY_KEYS: { keys: string[]; action: string }[] = [
  { keys: ["j", "k"], action: "move focus down / up" },
  { keys: ["enter", "p"], action: "play the focused track" },
  {
    keys: ["space"],
    action: "pause / resume what is playing (never changes the track)",
  },
  { keys: ["c"], action: "comment on the focused track" },
  { keys: ["esc"], action: "leave the comment field, keep focus" },
  { keys: ["?"], action: "show / hide this list" },
];

/** Panel listing the library keys (toggled by the ? button or key). */
export function KeyMap({ onClose }: { onClose: () => void }) {
  return (
    <section className="account-panel keymap" aria-label="Keyboard shortcuts">
      <div className="tag-manager-head">
        <span>
          Library keys. Clicking a row focuses it; only play changes what is
          playing. Keys are ignored while typing in a field.
        </span>
        <button type="button" className="filterButton" onClick={onClose}>
          close
        </button>
      </div>
      <table className="keymap-table">
        <tbody>
          {LIBRARY_KEYS.map(({ keys, action }) => (
            <tr key={action}>
              <th scope="row">
                {keys.map((k, i) => (
                  <span key={k}>
                    {i > 0 && <span className="keymap-or"> / </span>}
                    <kbd>{k}</kbd>
                  </span>
                ))}
              </th>
              <td>{action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
