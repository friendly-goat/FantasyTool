import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { foldQuery, searchPlayers, type NameMatch } from "../../shared/playerSearch.ts";
import type { ModelPlayer } from "../../shared/strength.ts";
import { formatPoints } from "../format.ts";
import { PositionChips } from "./PositionChip.tsx";
import { TeamTag } from "./TeamTag.tsx";

// A type-ahead box for picking one player: type part of a name and the players
// who match appear underneath, best match and best player first (matching in
// shared/playerSearch.ts). Arrow keys and Enter pick from the keyboard, a tap
// or click picks with a finger or mouse. Before anything is typed it suggests
// the best players to choose from. The picked player shows as a chip that can
// be cleared or changed.

/** A player that can be picked, and the fantasy team that has him. */
export interface SearchOption {
  player: ModelPlayer;
  owner: string;
  /** How long he is out ("Out 7 weeks"), in place of the injury report's status; null for none. */
  tag?: string | null;
}

/** A player who matches but cannot be picked here, and why ("On your team"). */
export interface UnavailableOption {
  player: ModelPlayer;
  reason: string;
  tag?: string | null;
}

/** Suggestions shown at most, typed or not. */
const SHOWN = 8;
/** Players named that cannot be picked here, shown below the rest so the user knows why. */
const UNAVAILABLE_SHOWN = 2;
/** Phone layout, where the box moves up the screen to leave room above the keyboard. */
const PHONE = "(max-width: 720px)";

/** The name with the matched parts in bold. */
function Highlighted({ name, match }: { name: string; match: NameMatch | null }) {
  if (!match) return <>{name}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of match.ranges) {
    if (start > at) parts.push(name.slice(at, start));
    parts.push(
      <mark key={start} className="ps-hit">
        {name.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < name.length) parts.push(name.slice(at));
  return <>{parts}</>;
}

/** One player in the list or the chip: name and injury, then position, NBA team and fantasy team. */
function PlayerLine({ player, match, note, tag }: { player: ModelPlayer; match: NameMatch | null; note: string; tag?: string | null }) {
  const shown = tag === undefined ? player.injuryStatus : tag;
  return (
    <span className="ps-player">
      <span className="ps-name">
        <span className="ps-name-text">
          <Highlighted name={player.name} match={match} />
        </span>
        {shown && <span className="injury">{shown}</span>}
      </span>
      <span className="ps-meta">
        <PositionChips positions={player.positions} />
        <TeamTag team={player.team} />
        <span className="ps-owner">{note}</span>
      </span>
    </span>
  );
}

type Row =
  | { kind: "group"; label: string }
  | { kind: "option"; option: SearchOption; match: NameMatch | null }
  | { kind: "unavailable"; option: UnavailableOption; match: NameMatch | null };

export function PlayerSearch({
  label,
  options,
  unavailable = [],
  value,
  onChange,
  placeholder = "Type a player's name",
  startLabel = "Best players to choose from",
}: {
  label: string;
  options: SearchOption[];
  unavailable?: UnavailableOption[];
  /** The picked player's id, or "" for none. */
  value: string;
  onChange: (playerId: string) => void;
  placeholder?: string;
  /** Heading over the suggestions shown before anything is typed. */
  startLabel?: string;
}) {
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const input = useRef<HTMLInputElement>(null);
  const chosenButton = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [focusChip, setFocusChip] = useState(false);
  const closing = useRef<number | undefined>(undefined);

  const chosen = options.find((option) => option.player.id === value) ?? null;

  const rows = useMemo<Row[]>(() => {
    const typed = foldQuery(query);
    if (!typed) {
      const best = [...options].sort((a, b) => b.player.expected - a.player.expected).slice(0, SHOWN);
      return best.length > 0 ? [{ kind: "group", label: startLabel }, ...best.map((option) => ({ kind: "option" as const, option, match: null }))] : [];
    }
    const found: Row[] = searchPlayers(options, query, (option) => option.player.name, (option) => option.player.expected, SHOWN).map(
      ({ item, match }) => ({ kind: "option", option: item, match }),
    );
    // A close match among players who can't be picked here, so a name that "isn't found" explains itself.
    const elsewhere =
      typed.length >= 3
        ? searchPlayers(unavailable, query, (option) => option.player.name, (option) => option.player.expected, UNAVAILABLE_SHOWN).filter(
            ({ match }) => match.kind === "exact" || match.kind === "prefix" || match.kind === "words",
          )
        : [];
    if (elsewhere.length > 0) {
      found.push({ kind: "group", label: "Can't be traded for" });
      for (const { item, match } of elsewhere) found.push({ kind: "unavailable", option: item, match });
    }
    return found;
  }, [query, options, unavailable, startLabel]);

  const picks = rows.flatMap((row, index) => (row.kind === "option" ? [index] : []));
  const optionCount = picks.length;

  // The first match is ready to pick as soon as something is typed, so Enter takes it.
  useEffect(() => {
    setActive(foldQuery(query) && picks.length > 0 ? picks[0]! : -1);
    // Only when the query (and so the list) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (active < 0 || !open) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId]);

  useEffect(() => {
    if (focusChip && chosen) {
      chosenButton.current?.focus();
      setFocusChip(false);
    }
  }, [focusChip, chosen]);

  useEffect(() => () => window.clearTimeout(closing.current), []);

  function pick(option: SearchOption, byKeyboard: boolean) {
    window.clearTimeout(closing.current);
    setOpen(false);
    setQuery("");
    onChange(option.player.id);
    // From the keyboard, focus moves to the chip; after a tap the box goes away and the phone's
    // keyboard closes with it.
    if (byKeyboard) setFocusChip(true);
  }

  function edit() {
    onChange("");
    setOpen(true);
    // The box replaces the chip on the next render.
    window.setTimeout(() => input.current?.focus(), 0);
  }

  function move(step: number) {
    if (picks.length === 0) return;
    const at = picks.indexOf(active);
    const next = at < 0 ? (step > 0 ? 0 : picks.length - 1) : (at + step + picks.length) % picks.length;
    setActive(picks[next]!);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      else move(-1);
    } else if (event.key === "Home" && open && picks.length > 0) {
      event.preventDefault();
      setActive(picks[0]!);
    } else if (event.key === "End" && open && picks.length > 0) {
      event.preventDefault();
      setActive(picks.at(-1)!);
    } else if (event.key === "Enter") {
      const row = rows[active];
      if (open && row?.kind === "option") {
        event.preventDefault();
        pick(row.option, true);
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
      } else if (query) {
        event.preventDefault();
        setQuery("");
      }
    }
  }

  function onFocus() {
    window.clearTimeout(closing.current);
    setOpen(true);
    // On a phone, bring the box up near the top of the screen so the suggestions fit above the
    // keyboard that is opening.
    if (window.matchMedia(PHONE).matches) {
      window.setTimeout(() => {
        const box = input.current?.getBoundingClientRect();
        if (box && box.top > 72) window.scrollBy({ top: box.top - 56, behavior: "smooth" });
      }, 250);
    }
  }

  function onBlur() {
    // A tap on a suggestion blurs the box before its click lands: wait for it.
    closing.current = window.setTimeout(() => setOpen(false), 150);
  }

  const typed = foldQuery(query);
  const announcement = !open
    ? ""
    : typed
      ? optionCount === 0
        ? "No players found."
        : `${optionCount} ${optionCount === 1 ? "player" : "players"} found. Use the arrow keys to choose.`
      : `${optionCount} suggestions.`;

  return (
    <div className="player-search">
      <label htmlFor={chosen ? undefined : inputId} className="ps-label" onClick={() => chosen && chosenButton.current?.focus()}>
        {label}
      </label>
      {chosen ? (
        <div className="ps-chosen">
          <button type="button" ref={chosenButton} className="ps-chosen-main" onClick={edit} aria-label={`${label}: ${chosen.player.name}. Change`}>
            <PlayerLine player={chosen.player} match={null} note={chosen.owner} tag={chosen.tag} />
          </button>
          <button type="button" className="ps-clear" onClick={edit} aria-label={`Clear ${chosen.player.name}`}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      ) : (
        <div className={`ps-field${open ? " is-open" : ""}`}>
          <svg className="ps-icon" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="M13 13l4.5 4.5" />
          </svg>
          <input
            ref={input}
            id={inputId}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open && rows.length > 0}
            aria-controls={listId}
            aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="go"
            placeholder={placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            onBlur={onBlur}
            onClick={() => setOpen(true)}
          />
          {query && (
            <button
              type="button"
              className="ps-clear"
              aria-label="Clear the name"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setQuery("");
                input.current?.focus();
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          )}
        </div>
      )}
      {!chosen && open && (rows.length > 0 || typed) && (
        <div className="ps-popover">
          {rows.length > 0 ? (
            <ul
              id={listId}
              role="listbox"
              aria-label={label}
              className="ps-list"
              // Keep focus in the box while a suggestion is pressed with a mouse.
              onMouseDown={(event) => event.preventDefault()}
            >
              {rows.map((row, index) =>
                row.kind === "group" ? (
                  <li key={`group-${row.label}`} role="presentation" className="ps-group">
                    {row.label}
                  </li>
                ) : row.kind === "option" ? (
                  <li
                    key={row.option.player.id}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    className={`ps-option${index === active ? " is-active" : ""}`}
                    onPointerMove={() => index !== active && setActive(index)}
                    onClick={() => pick(row.option, false)}
                  >
                    <PlayerLine player={row.option.player} match={row.match} note={row.option.owner} tag={row.option.tag} />
                    <span className="ps-value">
                      <strong>{formatPoints(row.option.player.expected)}</strong>
                      <span>a week</span>
                    </span>
                  </li>
                ) : (
                  <li key={`out-${row.option.player.id}`} id={`${listId}-${index}`} role="option" aria-disabled="true" aria-selected={false} className="ps-option is-unavailable">
                    <PlayerLine player={row.option.player} match={row.match} note={row.option.reason} tag={row.option.tag} />
                  </li>
                ),
              )}
            </ul>
          ) : (
            <p className="ps-empty">
              No player on another team matches “{query.trim()}”. Try part of the first or last name.
            </p>
          )}
        </div>
      )}
      <span className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

