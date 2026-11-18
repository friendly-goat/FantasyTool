import { useEffect, useId, useRef, useState } from "react";
import type { Team } from "../../shared/types.ts";
import { Avatar } from "./Avatar.tsx";

export interface MenuItem {
  label: string;
  onSelect: () => void;
}

interface Props {
  team: Team | undefined;
  /** A line under the team name, such as who is signed in. */
  note?: string;
  items: MenuItem[];
}

/**
 * The desktop header's menu behind the user's team avatar: theme, change
 * team, switch league, sign out. On a phone the same items sit in the More
 * sheet (MobileNav) and this menu is hidden.
 */
export function AccountMenu({ team, note, items }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="account" ref={root}>
      <button
        ref={button}
        type="button"
        className="account-button"
        aria-label="Settings and account"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        {team ? (
          <Avatar url={team.avatarUrl} name={team.teamName} size="sm" />
        ) : (
          <span className="avatar avatar-sm" aria-hidden="true" />
        )}
        <svg className="account-chevron" viewBox="0 0 12 8" aria-hidden="true">
          <path d="M1.5 1.75l4.5 4.5 4.5-4.5" />
        </svg>
      </button>
      {open && (
        <div className="account-menu" id={menuId}>
          {team && (
            <div className="account-head">
              <Avatar url={team.avatarUrl} name={team.teamName} />
              <div>
                <p className="account-team">{team.teamName}</p>
                <p className="quiet">{note ?? team.managerName}</p>
              </div>
            </div>
          )}
          <ul>
            {items.map((item) => (
              <li key={item.label}>
                <button
                  type="button"
                  className="account-item"
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
