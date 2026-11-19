import { useEffect, useRef, useState } from "react";
import type { SearchStage } from "../../shared/trade.ts";

// The trade search's progress: a bar that fills smoothly from the search's
// own reports (eased between them, and creeping a little while a step runs,
// so it never sits still), with the step it is on above it.

const WORDS: Record<SearchStage | "done", string> = {
  setup: "Getting every roster ready",
  swaps: "Trying every one-for-one swap",
  estimates: "Sizing up every two-team trade",
  closer: "Taking a closer look at the most promising",
  screening: "Screening the strongest offers",
  "first-look": "Test-running the best offers",
  measuring: "Playing out the finalists over the rest of the season",
  packages: "Building packages from the near-misses",
  done: "Done",
};

/** How far ahead of the last report the bar may creep while a step runs. */
const CREEP = 0.04;

export function SearchProgress({ share, stage }: { share: number; stage: SearchStage | "done" }) {
  const [shown, setShown] = useState(0);
  const target = useRef({ share, at: performance.now() });
  if (target.current.share !== share) target.current = { share, at: performance.now() };

  useEffect(() => {
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let frame = 0;
    const tick = (now: number) => {
      const { share: goal, at } = target.current;
      // While a step runs the bar creeps on, slowing as it goes, never past the next report's reach.
      const creep = goal >= 1 || still ? 0 : CREEP * (1 - Math.exp(-(now - at) / 2500));
      const aim = Math.min(goal >= 1 ? 1 : 0.995, goal + creep);
      setShown((value) => (still ? aim : Math.abs(aim - value) < 0.0005 ? aim : value + (aim - value) * (goal >= 1 ? 0.25 : 0.08)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const percent = Math.round(shown * 100);
  return (
    <div className={`search-progress${stage === "done" ? " is-done" : ""}`}>
      <div className="search-progress-head">
        <p className="search-progress-stage" key={stage} aria-live="polite">
          {WORDS[stage]}
        </p>
        <span className="search-progress-percent">{percent}%</span>
      </div>
      <div
        className="search-progress-track"
        role="progressbar"
        aria-label="Searching for trades"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="search-progress-fill" style={{ width: `${shown * 100}%` }} />
      </div>
    </div>
  );
}

/** Stand-ins for the idea cards while the search runs. */
export function IdeaSkeletons({ count = 3 }: { count?: number }) {
  return (
    <ul className="ideas idea-skeletons" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="card idea-skeleton" style={{ animationDelay: `${index * 120}ms` }}>
          <span className="idea-skeleton-line wide" />
          <span className="idea-skeleton-line" />
          <span className="idea-skeleton-line short" />
        </li>
      ))}
    </ul>
  );
}
