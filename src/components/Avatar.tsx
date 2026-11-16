import { useState } from "react";

function initials(name: string): string {
  const words = name.replace(/^Team\s+/i, "").split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => [...word][0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

/** Team avatar from Sleeper, falling back to initials when there is none. */
export function Avatar({ url, name, size = "md" }: { url: string | null; name: string; size?: "sm" | "md" | "lg" }) {
  const [failed, setFailed] = useState(false);
  const className = `avatar avatar-${size}`;
  if (url && !failed) {
    return <img className={className} src={url} alt="" loading="lazy" onError={() => setFailed(true)} />;
  }
  return (
    <span className={className} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
