import { useId } from "react";
import { formatStrength, STRENGTH_STARS } from "../format.ts";

// Team strength as stars: five, filled to the rating (a 4.04 fills four and a sliver of the
// fifth). Above 5 the five are full and turn gold with a soft glow: rarer than a full set.

const STAR = "M12 2.6l2.85 5.98 6.55.82-4.83 4.52 1.25 6.5L12 17.2l-5.82 3.22 1.25-6.5L2.6 9.4l6.55-.82z";
const WIDTH = 24 * STRENGTH_STARS;

export function StrengthStars({ score, size = "md" }: { score: number; size?: "sm" | "md" }) {
  // React's ids contain colons, which a url(#…) reference does not always accept.
  const clip = `stars-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const rating = score / 100;
  const beyond = rating > STRENGTH_STARS;
  const filled = Math.max(0, Math.min(1, rating / STRENGTH_STARS)) * WIDTH;
  const stars = Array.from({ length: STRENGTH_STARS }, (_, index) => (
    <path key={index} d={STAR} transform={`translate(${index * 24} 0)`} />
  ));
  return (
    <svg
      className={`strength-stars strength-stars-${size}${beyond ? " is-beyond" : ""}`}
      viewBox={`0 0 ${WIDTH} 24`}
      role="img"
      aria-label={`${formatStrength(score)} out of ${STRENGTH_STARS}${beyond ? ", above the top of the scale" : ""}`}
    >
      <clipPath id={clip}>
        <rect x="0" y="0" width={filled} height="24" />
      </clipPath>
      <g className="strength-stars-empty">{stars}</g>
      <g className="strength-stars-full" clipPath={`url(#${clip})`}>
        {stars}
      </g>
    </svg>
  );
}
