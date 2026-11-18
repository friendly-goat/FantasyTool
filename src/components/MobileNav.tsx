import { type ReactNode, useEffect, useRef } from "react";

/**
 * Phone navigation, in the way iPhone apps do it: a tab bar along the
 * bottom with the four views used most, and "More" for the rest and the
 * settings, in a sheet that slides up. Hidden on wider screens, which keep
 * the tabs at the top (styles.css).
 */

export interface MobileSetting {
  label: string;
  onSelect: () => void;
}

const ICONS: Record<string, ReactNode> = {
  "My team": (
    <>
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.75 20c.6-3.8 3.6-6 7.25-6s6.65 2.2 7.25 6" />
    </>
  ),
  Matchups: (
    <>
      <rect x="3.75" y="5" width="16.5" height="14" rx="2.5" />
      <path d="M12 5v14M7.5 10.5h1.5M15 13.5h1.5" />
    </>
  ),
  Trades: <path d="M5 8.5h13l-3.5-3.5M19 15.5H6l3.5 3.5" />,
  Players: (
    <>
      <circle cx="9" cy="9" r="3.25" />
      <path d="M3.75 19c.5-3 2.7-4.75 5.25-4.75S13.75 16 14.25 19M15.5 6.25a3.25 3.25 0 0 1 0 5.5M17.5 14.6c1.5.7 2.5 2.2 2.75 4.4" />
    </>
  ),
  More: (
    <>
      <circle cx="6" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="18" cy="12" r="1.4" />
    </>
  ),
};

function Icon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

export function MobileNav<View extends string>({
  primary,
  more,
  view,
  onSelect,
  settings,
  open,
  onOpenChange,
}: {
  /** The views on the tab bar itself. */
  primary: readonly View[];
  /** The views in the More sheet. */
  more: readonly View[];
  view: View;
  onSelect: (view: View) => void;
  settings: MobileSetting[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sheet = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = sheet.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const inMore = more.includes(view);
  const choose = (next: View) => {
    onOpenChange(false);
    onSelect(next);
  };

  return (
    <>
      <nav className="tab-bar" aria-label="League views">
        {primary.map((name) => (
          <button
            key={name}
            type="button"
            className="tab-bar-item"
            aria-current={view === name ? "page" : undefined}
            onClick={() => choose(name)}
          >
            <Icon name={name} />
            <span>{name}</span>
          </button>
        ))}
        <button
          type="button"
          className="tab-bar-item"
          aria-current={inMore ? "page" : undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          <Icon name="More" />
          {/* The view open from More takes the label, so you can see where you are. */}
          <span>{inMore ? view : "More"}</span>
        </button>
      </nav>

      <dialog
        ref={sheet}
        className="sheet"
        aria-label="More"
        onClose={() => onOpenChange(false)}
        onClick={(event) => {
          // A tap on the dimmed area above the sheet closes it.
          if (event.target === sheet.current) onOpenChange(false);
        }}
      >
        <div className="sheet-body">
          <div className="sheet-grabber" aria-hidden="true" />
          <ul className="sheet-list" aria-label="More views">
            {more.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className="sheet-row"
                  aria-current={view === name ? "page" : undefined}
                  onClick={() => choose(name)}
                >
                  {name}
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path d="M9.5 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
          {settings.length > 0 && (
            <ul className="sheet-list" aria-label="Settings">
              {settings.map((setting) => (
                <li key={setting.label}>
                  <button
                    type="button"
                    className="sheet-row"
                    onClick={() => {
                      onOpenChange(false);
                      setting.onSelect();
                    }}
                  >
                    {setting.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="button button-plain sheet-done" onClick={() => onOpenChange(false)}>
            Done
          </button>
        </div>
      </dialog>
    </>
  );
}
