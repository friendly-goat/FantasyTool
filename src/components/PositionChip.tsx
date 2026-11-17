/** Colored label for a lineup slot or player position, in the same colors everywhere. */
export function PositionChip({ label }: { label: string }) {
  return <span className={`chip chip-${label.toLowerCase()}`}>{label}</span>;
}

/** A player's positions as a row of colored labels. */
export function PositionChips({ positions }: { positions: string[] }) {
  if (positions.length === 0) return null;
  return (
    <span className="chips">
      {positions.map((position) => (
        <PositionChip key={position} label={position} />
      ))}
    </span>
  );
}
