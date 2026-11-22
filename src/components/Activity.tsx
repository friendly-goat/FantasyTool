import { useEffect, useMemo, useState } from "react";
import { moveEffect, type MoveEffect } from "../../shared/activity.ts";
import { rosterPlayers } from "../../shared/analysis.ts";
import type { StrengthModel } from "../../shared/strength.ts";
import type { LeagueSnapshot, Team, Transaction, TransactionSide } from "../../shared/types.ts";
import { formatDate, formatSigned, formatStrength, formatStrengthChange } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { type Move, PlayerMoves } from "./PlayerMoves.tsx";
import { EffectBar, RecordTag } from "./TeamEffect.tsx";

const TYPE_NAMES: Record<Transaction["type"], string> = {
  trade: "Trade",
  waiver: "Waiver claim",
  free_agent: "Free agent move",
  other: "Roster move",
};

type Filter = "all" | Transaction["type"];
const FILTERS: { filter: Filter; label: string }[] = [
  { filter: "all", label: "All" },
  { filter: "trade", label: "Trades" },
  { filter: "waiver", label: "Waivers" },
  { filter: "free_agent", label: "Free agents" },
  { filter: "other", label: "Other" },
];

/** The smallest strength change the bars are drawn against, so a tiny move draws a tiny bar. */
const MIN_SCALE = 25;
/** How long each slice of measuring may run before the page gets a turn. */
const SLICE_MS = 40;

/** What one team gained (+) and gave up (−) in a transaction, with what has happened to them since. */
function moves(side: TransactionSide, effect: MoveEffect | undefined): Move[] {
  const gone = new Set(effect?.since.gone);
  const back = new Set(effect?.since.back);
  return [
    ...side.adds.map((player) => ({ player, joins: true, note: gone.has(player.id) ? "No longer on the team" : undefined })),
    ...side.picks.map((pick) => ({ player: pick, joins: true, note: "Draft pick" })),
    ...side.drops.map((player) => ({ player, joins: false, note: back.has(player.id) ? "Back on the team now" : undefined })),
  ];
}

/**
 * Measures each side of each transaction a slice at a time, newest first, so
 * the tab opens at once and the effects fill in without freezing the page.
 */
function useEffects(model: StrengthModel | null, snapshot: LeagueSnapshot) {
  const [effects, setEffects] = useState<Map<string, MoveEffect>>(new Map());
  useEffect(() => {
    setEffects(new Map());
    if (!model) return;
    const rosters = new Map(snapshot.teams.map((team) => [team.rosterId, rosterPlayers(team).map((player) => player.id)]));
    const queue = snapshot.transactions.flatMap((transaction) =>
      transaction.sides
        .filter((side) => rosters.has(side.rosterId) && side.adds.length + side.drops.length > 0)
        .map((side) => ({ key: `${transaction.id}:${side.rosterId}`, side })),
    );
    let timer = 0;
    let index = 0;
    const step = () => {
      const start = performance.now();
      const done = new Map<string, MoveEffect>();
      while (index < queue.length && performance.now() - start < SLICE_MS) {
        const { key, side } = queue[index++]!;
        done.set(key, moveEffect(model, rosters.get(side.rosterId)!, side));
      }
      setEffects((current) => new Map([...current, ...done]));
      if (index < queue.length) timer = window.setTimeout(step, 0);
    };
    timer = window.setTimeout(step, 0);
    return () => window.clearTimeout(timer);
  }, [model, snapshot]);
  return effects;
}

function TeamEffect({ effect, scale, measuring }: { effect: MoveEffect | undefined; scale: number; measuring: boolean }) {
  if (!effect) {
    return (
      <div className="activity-effect">
        <div className="effect-head">
          <span className="effect-title">Team effect</span>
          <span className="effect-value quiet">{measuring ? "Measuring…" : "–"}</span>
        </div>
        <EffectBar change={0} scale={scale} label="Team effect not measured" />
        <p className="quiet effect-note">{measuring ? " " : "Needs player stats."}</p>
      </div>
    );
  }
  const tone = effect.strengthChange > 0 ? "up" : effect.strengthChange < 0 ? "down" : "";
  return (
    <div className="activity-effect">
      <div className="effect-head">
        <span className="effect-title">Team effect</span>
        <span className={`effect-value ${tone}`}>{formatStrengthChange(effect.strengthChange)} strength</span>
      </div>
      <EffectBar
        change={effect.strengthChange}
        scale={scale}
        label={`Team strength ${formatStrength(effect.strengthWithout)} without this move, ${formatStrength(effect.strengthWith)} with it, out of 5`}
      />
      <p className="quiet effect-note">{formatSigned(effect.change)} points a week</p>
    </div>
  );
}

function SideRow({
  side,
  team,
  mine,
  effect,
  scale,
  measuring,
}: {
  side: TransactionSide;
  team: Team | undefined;
  mine: boolean;
  effect: MoveEffect | undefined;
  scale: number;
  measuring: boolean;
}) {
  const empty = side.adds.length + side.drops.length === 0;
  return (
    <div className="activity-row">
      <div className="activity-team">
        <Avatar url={team?.avatarUrl ?? null} name={team?.teamName ?? "?"} />
        <div>
          <span className="activity-team-name">
            {team?.teamName ?? `Roster ${side.rosterId}`}
            {mine && <span className="mine">You</span>}
          </span>
          <span className="activity-team-meta">
            <span className="quiet">{team?.managerName}</span>
            {team && <RecordTag team={team} />}
          </span>
        </div>
      </div>
      <PlayerMoves moves={moves(side, effect)} empty="No players changed hands." />
      {empty ? <div className="activity-effect" /> : <TeamEffect effect={effect} scale={scale} measuring={measuring} />}
    </div>
  );
}

interface Props {
  snapshot: LeagueSnapshot;
  model: StrengthModel | null;
  myRosterId: number | null;
}

/**
 * The league's recent trades, waiver claims and free agent moves: who made
 * each, their record, and what the move does to their team's strength on
 * today's projections (shared/activity.ts; display only).
 */
export function Activity({ snapshot, model, myRosterId }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const teams = useMemo(() => new Map(snapshot.teams.map((team) => [team.rosterId, team])), [snapshot]);
  const effects = useEffects(model, snapshot);

  if (snapshot.transactions.length === 0) {
    return <p className="quiet">No trades, waiver claims or free agent moves in the last three weeks.</p>;
  }

  const counts = new Map<Filter, number>([["all", snapshot.transactions.length]]);
  for (const transaction of snapshot.transactions) counts.set(transaction.type, (counts.get(transaction.type) ?? 0) + 1);
  const shown = snapshot.transactions.filter((transaction) => filter === "all" || transaction.type === filter);
  const scale = Math.max(MIN_SCALE, ...[...effects.values()].map((effect) => Math.abs(effect.strengthChange)));
  const measuring = model !== null;

  return (
    <section aria-label="Recent activity">
      <div className="activity-toolbar">
        <div className="segmented" role="group" aria-label="Show">
          {FILTERS.filter((option) => counts.has(option.filter)).map((option) => (
            <button
              key={option.filter}
              type="button"
              className="segment"
              aria-pressed={filter === option.filter}
              onClick={() => setFilter(option.filter)}
            >
              {option.label} <span className="segment-count">{counts.get(option.filter)}</span>
            </button>
          ))}
        </div>
        <p className="quiet">
          The last three weeks. Team effect is what each move adds to that team's strength on today's projections.
        </p>
      </div>
      <ul className="activity">
        {shown.map((transaction) => (
          <li key={transaction.id} className={`activity-item type-${transaction.type}`}>
            <div className="activity-head">
              <span className="activity-type">{TYPE_NAMES[transaction.type]}</span>
              <time className="quiet" dateTime={transaction.createdAt}>
                {formatDate(transaction.createdAt)}
              </time>
            </div>
            {transaction.sides.map((side) => (
              <SideRow
                key={side.rosterId}
                side={side}
                team={teams.get(side.rosterId)}
                mine={side.rosterId === myRosterId}
                effect={effects.get(`${transaction.id}:${side.rosterId}`)}
                scale={scale}
                measuring={measuring}
              />
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
