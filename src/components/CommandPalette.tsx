import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { MagnifyingGlassIcon, ArrowUpIcon, ArrowDownIcon } from "@phosphor-icons/react";
import { useModalDismiss } from "@/hooks/useModalDismiss";

/**
 * The course plotter: Ctrl/Cmd+K opens one field that reaches every page and a few app-wide
 * actions. Each destination also answers to what it shows ("net worth", "forecast", "backup"),
 * so it works for someone who knows what they want to see but not which of thirteen pages
 * holds it. Keyboard first: type, arrows, Enter; Escape or a click outside closes.
 */
export interface PaletteCommand {
  id: string;
  label: string;
  /** One short line shown beside the label: what the page shows or the action does. */
  about?: string;
  /** Extra words the query may match that are not worth showing. */
  keywords?: string;
  group: "Go to" | "Actions";
  icon: ReactNode;
  run: () => void;
}

/**
 * Every word of the query must appear in the label, the description or the keywords. Commands
 * whose label starts with the query come first, then other label matches, then matches found
 * only in the description or keywords; ties keep their original order.
 */
export function filterCommands<T extends { label: string; about?: string; keywords?: string }>(commands: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  const phrase = words.join(" ");
  return commands
    .flatMap((command, index) => {
      const label = command.label.toLowerCase();
      const haystack = `${label} ${command.about ?? ""} ${command.keywords ?? ""}`.toLowerCase();
      if (!words.every((word) => haystack.includes(word))) return [];
      const rank = label.startsWith(phrase) ? 0 : words.every((word) => label.includes(word)) ? 1 : 2;
      return [{ command, rank, index }];
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((match) => match.command);
}

const GROUPS = ["Go to", "Actions"] as const;

export default function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const { onBackdropClick, containerRef } = useModalDismiss(onClose);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  // Grouped for display, so the arrow keys walk the list in the order it is drawn.
  const results = useMemo(() => {
    const matches = filterCommands(commands, query);
    return GROUPS.flatMap((group) => matches.filter((command) => command.group === group));
  }, [commands, query]);
  const active = Math.min(cursor, Math.max(0, results.length - 1));

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, query]);

  const run = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const last = Math.max(0, results.length - 1); // an empty list must not leave a negative cursor
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor(active >= last ? 0 : active + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setCursor(active <= 0 ? last : active - 1); }
    else if (event.key === "Enter") { event.preventDefault(); run(results[active]); }
  };

  return (
    <motion.div
      className="palette-scrim"
      ref={containerRef}
      onClick={onBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Go to a page or run an action"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12 }}
    >
      <motion.div
        className="palette"
        initial={{ opacity: 0, y: -10, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="palette-input">
          <MagnifyingGlassIcon size={18} aria-hidden className="shrink-0 text-[hsl(var(--gold-ink))]" />
          {/* No autoFocus: useModalDismiss focuses this field itself, after noting where focus
              goes back to on close. autoFocus runs first, so the hook would note this field. */}
          <input
            type="text"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setCursor(0); }}
            onKeyDown={onKeyDown}
            placeholder="Where to? Try net worth, forecast or backup"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${results[active].id}` : undefined}
            aria-autocomplete="list"
            aria-label="Search pages and actions"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id={listId} ref={listRef} role="listbox" aria-label="Pages and actions">
          {results.length === 0 && (
            <p className="palette-empty">Nothing matches "{query.trim()}". Try a page name, or what you want to see.</p>
          )}
          {results.map((command, index) => (
            <div key={command.id} role="presentation">
              {(index === 0 || results[index - 1].group !== command.group) && (
                <p className="palette-group" role="presentation">{command.group}</p>
              )}
              <div
                id={`${listId}-${command.id}`}
                className="palette-option"
                role="option"
                aria-selected={index === active}
                onMouseMove={() => { if (index !== active) setCursor(index); }}
                onClick={() => run(command)}
              >
                <span className="palette-option-icon" aria-hidden="true">{command.icon}</span>
                <span className="truncate">{command.label}</span>
                {command.about && <small className="truncate">{command.about}</small>}
              </div>
            </div>
          ))}
        </div>
        <p className="palette-foot" aria-hidden="true">
          <span><kbd><ArrowUpIcon size={10} weight="bold" /></kbd><kbd><ArrowDownIcon size={10} weight="bold" /></kbd> move</span>
          <span><kbd>Enter</kbd> go</span>
          <span><kbd>Esc</kbd> close</span>
        </p>
      </motion.div>
    </motion.div>
  );
}
