import { useId, useState } from "react";
import { daysBetween, type InjuryNews, NEAR_DAYS, returnOutlook } from "../../shared/injury.ts";
import { formatDay } from "../format.ts";

/**
 * A player's entry on the league's injury report: the predicted return date
 * as the report gives it, when the app plans on him being back, and the
 * report's note behind an info button (tap to open, so a phone screen is not
 * filled with it).
 */
export function InjuryNote({ injury }: { injury: InjuryNews }) {
  const [open, setOpen] = useState(false);
  const noteId = useId();
  const outlook = returnOutlook(injury);
  const today = injury.asOf;

  const headline = injury.returnDate ? (
    <>
      <span className="injury-note-label">Predicted return</span>
      {formatDay(injury.returnDate, today)}
    </>
  ) : injury.seasonOut ? (
    "Out for the season"
  ) : (
    "No predicted return date"
  );

  let plan: string | null = null;
  if (outlook.kind === "window" && injury.returnDate) {
    const expected = formatDay(outlook.window.expected, today);
    if (injury.reevaluation) {
      plan = `The report's date is a re-evaluation, so the app treats it as the earliest he could be back and plans on about ${expected}.`;
    } else if (daysBetween(today, injury.returnDate) > NEAR_DAYS) {
      plan = `Dates this far out often slip, so the app plans on about ${expected}.`;
    }
  } else if (outlook.kind === "unknown") {
    plan = "Without a date, the app expects him to miss about as long again as he already has.";
  }

  return (
    <section className="injury-note" aria-label="Injury report">
      <div className="injury-note-row">
        <span className="injury">{injury.status}</span>
        <p className="injury-note-headline">{headline}</p>
        {injury.description && (
          <button
            type="button"
            className="info-button"
            aria-expanded={open}
            aria-controls={noteId}
            aria-label={open ? "Hide the injury note" : "Show the injury note"}
            onClick={() => setOpen((value) => !value)}
          >
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
              <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="10" cy="6.25" r="1.1" fill="currentColor" />
              <path d="M10 9v5.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      {plan && <p className="quiet injury-note-plan">{plan}</p>}
      {open && (
        <div id={noteId} className="injury-note-detail">
          <p>{injury.description}</p>
          <p className="quiet">From the league injury report, read {formatDay(injury.asOf, today)}.</p>
        </div>
      )}
    </section>
  );
}
