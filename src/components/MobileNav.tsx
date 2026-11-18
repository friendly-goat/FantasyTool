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
  Rankings: (
    <>
      <rect x="3.75" y="12" width="5" height="8" rx="1.25" />
      <rect x="9.5" y="5" width="5" height="15" rx="1.25" />
      <rect x="15.25" y="9" width="5" height="11" rx="1.25" />
    </>
  ),
  Draft: (
    <>
      <rect x="3.75" y="4.25" width="16.5" height="15.5" rx="2.5" />
      <path d="M3.75 9.5h16.5M3.75 14.5h16.5M9.25 4.25v15.5M14.75 4.25v15.5" />
    </>
  ),
  Trades: <path d="M5.5 9h12.5l-3.25-3.25M18.5 15H6l3.25 3.25" />,
  More: (
    <>
      <circle cx="6" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="18" cy="12" r="1.4" />
    </>
  ),
};

function Icon({ name, size = 26 }: { name: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "Trades" ? 2.2 : 1.7}
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
  featured,
  more,
  view,
  onSelect,
  settings,
  open,
  onOpenChange,
}: {
  /** The views on the tab bar itself. */
  primary: readonly View[];
  /** The tab set apart on the bar, in an accent circle: the heart of the app. */
  featured?: View;
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
            className={name === featured ? "tab-bar-item tab-bar-featured" : "tab-bar-item"}
            aria-current={view === name ? "page" : undefined}
            onClick={() => choose(name)}
          >
            {name === featured ? (
              <span className="tab-bar-badge">
                <Icon name={name} size={22} />
              </span>
            ) : (
              <Icon name={name} />
            )}
            <span className="tab-bar-label">{name}</span>
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
          <span className="tab-bar-label">{inMore ? view : "More"}</span>
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
                    <path
                      d="M9.5 6l6 6-6 6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
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
