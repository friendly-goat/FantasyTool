const GROUPS: Record<string, string> = {
  PG: "guard",
  SG: "guard",
  G: "guard",
  SF: "forward",
  PF: "forward",
  F: "forward",
  C: "center",
};

/** Small colored label for a lineup slot or player position. */
export function PositionChip({ label }: { label: string }) {
  return <span className={`chip chip-${GROUPS[label] ?? "flex"}`}>{label}</span>;
}
