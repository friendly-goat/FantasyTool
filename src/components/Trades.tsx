import { useEffect, useMemo, useState } from "react";
import { rosterPlayers } from "../../shared/analysis.ts";
import { deepestSpot, POSITIONS, positionProfile, type TeamSituation, thinnestSpot } from "../../shared/insight.ts";
import { bestNineLineup, type ModelPlayer, type Pickup, type StrengthModel } from "../../shared/strength.ts";
import {
  acceptance,
  evaluateTrade,
  chanceWord,
  findTrades,
  playerValue,
  gradeWord,
  type FinderOptions,
  type TradeOffer,
  reserveMoves,
  tradePhases,
  tradeStory,
  type TradeResult,
  type TradeSide,
  type Chance,
  type TradeStory,
} from "../../shared/trade.ts";
import {
  evaluateThreeTeam,
  findThreeTeamTrades,
  type FinderIdea,
  isThreeTeam,
  type MixedFinderResult,
  type ThreeTeamChance,
  type ThreeTeamIdea,
  type ThreeTeamOffer,
  type ThreeTeamResult,
  threeTeamAcceptance,
  threeTeamProblem,
  threeTeamStory,
  withThreeTeam,
} from "../../shared/threeTeam.ts";
import type { LeagueSnapshot, Team } from "../../shared/types.ts";
import { formatPoints, formatRecord, formatSigned, formatWholeChange as whole } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { ChanceTag, EffectBar, RecordTag } from "./TeamEffect.tsx";
import { PlayerName } from "./PlayerName.tsx";
import { PlayerCell } from "./PlayerCell.tsx";
import { PlayerMoves } from "./PlayerMoves.tsx";
import { PositionChip } from "./PositionChip.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  model: StrengthModel | null;
  situations: Map<number, TeamSituation> | null;
  myRosterId: number;
  /** A trade sent here from another tab (top moves on My team), to open in the builder. */
  incoming?: { offer: TradeOffer; at: number } | null;
}

/** A short label for a waiver pickup in a trade. */
function pickupLabel(pickup: Pickup): string {
  return pickup.forInjured ? `Waiver pickup until ${pickup.forInjured.name} is back` : "Waiver pickup";
}

type Goal = "best" | "position" | "send" | "get" | "injured";

const formatBackDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });
const tone = (grade: number) => (grade >= 57 ? "up" : grade <= 43 ? "down" : "");

function names(players: ModelPlayer[]) {
  return players.map((player, index) => (
    <span key={player.id}>
      {index > 0 && ", "}
      <PlayerName player={player} />
    </span>
  ));
}

/** Whether the screen is wide enough to show both rosters open by default. */
/** A team's players for the builder, best first. */
function pickerRoster(team: Team, model: StrengthModel): ModelPlayer[] {
  return rosterPlayers(team)
    .flatMap((player) => model.players.get(player.id) ?? [])
    .sort((a, b) => b.expected - a.expected);
}

/** In a three-team trade, where a ticked player goes: one of the other two teams. */
interface Destinations {
  options: Team[];
  of: (playerId: string) => number;
  onChange: (playerId: string, to: number) => void;
}

function RosterPicker({ team, model, chosen, onToggle, label, open, onOpenChange, rows, destinations }: {
  team: Team;
  model: StrengthModel;
  chosen: Set<string>;
  onToggle: (id: string) => void;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rows to show at least, so rosters side by side line up; extra rows are empty slots. */
  rows: number;
  /** Three-team trades only: each ticked player gets a choice of where he goes. */
  destinations?: Destinations;
}) {
  const roster = pickerRoster(team, model);
  const empty = Math.max(0, rows - roster.length);
  const teamName = (rosterId: number) => destinations?.options.find((option) => option.rosterId === rosterId)?.teamName ?? "";
  return (
    <details className="card trade-roster" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
      <summary className="trade-roster-summary">
        <Avatar url={team.avatarUrl} name={team.teamName} size="sm" />
        <span className="trade-roster-title">
          <span className="my-card-title">{label}</span>
          <RecordTag team={team} />
        </span>
        <span className="quiet trade-roster-picked">
          {chosen.size > 0
            ? roster
                .filter((player) => chosen.has(player.id))
                .map((player) => (destinations ? `${player.name} to ${teamName(destinations.of(player.id))}` : player.name))
                .join(", ")
            : open
              ? "Tick players to trade"
              : "Show players"}
        </span>
      </summary>
      <div className="roster-scroll">
        <table className={destinations ? "roster-table roster-table-three" : "roster-table"}>
          <thead>
            <tr className="group-row">
              <th scope="col">Player</th>
              <th scope="col" className="num">Weekly value</th>
              <th scope="col" className="num roster-extra">Avg</th>
              <th scope="col" className="num roster-extra">Plays</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((player) => (
              <tr key={player.id} className={chosen.has(player.id) ? "picked" : undefined}>
                <th scope="row">
                  <span className="pick-row">
                    <label className="pick">
                      <input
                        type="checkbox"
                        checked={chosen.has(player.id)}
                        onChange={() => onToggle(player.id)}
                        aria-label={`Trade ${player.name}`}
                      />
                    </label>
                    <span className="pick-player">
                      <PlayerCell player={player} />
                      {destinations && chosen.has(player.id) && (
                        <label className="dest">
                          <span>To</span>
                          <select
                            value={destinations.of(player.id)}
                            onChange={(event) => destinations.onChange(player.id, Number(event.target.value))}
                            aria-label={`Where ${player.name} goes`}
                          >
                            {destinations.options.map((option) => (
                              <option key={option.rosterId} value={option.rosterId}>
                                {option.teamName}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </span>
                  </span>
                </th>
                <td className="num strong">{player.games > 0 ? formatPoints(player.expected) : "–"}</td>
                <td className="num roster-extra">{player.games > 0 ? formatPoints(player.average) : "–"}</td>
                <td className="num quiet-cell roster-extra">{player.games > 0 ? percent.format(player.availability) : "–"}</td>
              </tr>
            ))}
            {/* Only to line up with the other roster; on a phone the two are stacked, so they go. */}
            {Array.from({ length: empty }, (_, index) => (
              <tr key={`empty-${index}`} className="roster-empty hide-narrow" aria-hidden="true">
                <th scope="row">
                  <span className="pick-row">
                    <span className="pick pick-empty" />
                    <span className="pcell">
                      <span className="pcell-name">
                        <span className="roster-empty-name">Empty slot</span>
                      </span>
                      <span className="pcell-meta roster-empty-meta">
                        <PositionChip label="C" />
                      </span>
                    </span>
                  </span>
                </th>
                <td className="num quiet-cell">–</td>
                <td className="num quiet-cell roster-extra">–</td>
                <td className="num quiet-cell roster-extra">–</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}


/** Players who join (green +) and leave (red −) one team in a trade, with each one's player value. */
/**
 * A player's value above a typical free agent. At or below that level it
 * reads "free-agent level" rather than 0.00: he is worth no more than the
 * players anyone can pick up.
 */
function PlayerValue({ model, player }: { model: StrengthModel; player: ModelPlayer }) {
  const value = playerValue(model, player);
  if (value < 0.005) {
    return (
      <span className="quiet" title="Worth no more a week than a typical free agent">
        Free-agent level
      </span>
    );
  }
  return (
    <>
      {formatPoints(value)}
      <span className="quiet"> value</span>
    </>
  );
}

/** In a three-team trade, which team each player comes from and goes to. */
interface Routes {
  from: (playerId: string) => string;
  to: (playerId: string) => string;
}

/** The players in the trade itself, joining and leaving (in a three-team trade, from and to whom). */
function MoveList({ side, model, routes }: { side: TradeSide; model: StrengthModel; routes?: Routes }) {
  const value = (player: ModelPlayer) => <PlayerValue model={model} player={player} />;
  return (
    <PlayerMoves
      moves={[
        ...side.gets.map((player) => ({ player, joins: true, value: value(player), note: routes && `From ${routes.from(player.id)}` })),
        ...side.gives.map((player) => ({ player, joins: false, value: value(player), note: routes && `To ${routes.to(player.id)}` })),
      ]}
    />
  );
}

/**
 * What the team would do after the trade, kept apart from it: IR moves,
 * waiver pickups and drops. None of it is part of the offer.
 */
function TeamManagement({ side, model, team }: { side: TradeSide; model: StrengthModel; team: Team | undefined }) {
  const teamName = team?.teamName ?? "This team";
  const value = (player: ModelPlayer) => <PlayerValue model={model} player={player} />;
  const reserve = reserveMoves(side, team?.reserve ?? [], model);
  const moves = [
    ...side.pickups.map((pickup) => ({
      player: pickup.player,
      joins: true,
      note: pickupLabel(pickup),
      value: value(pickup.player),
    })),
    ...side.drops.map((player) => ({ player, joins: false, note: "Dropped to make room", value: value(player) })),
    ...side.leaving.map(({ player, when }) => ({
      player,
      joins: false,
      note: `Dropped when ${when.name} is back`,
      value: value(player),
    })),
  ];
  if (reserve.length === 0 && moves.length === 0) return null;
  return (
    <section className="team-moves" aria-label={`Team management for ${teamName}`}>
      <h4 className="team-moves-title">Team management</h4>
      <p className="quiet team-moves-note">Not part of the trade: roster moves {teamName} would make after it.</p>
      {reserve.length > 0 && (
        <ul className="team-moves-ir">
          {reserve.map((line) => (
            <li key={line}>
              <span className="team-moves-ir-tag">IR</span>
              {line}
            </li>
          ))}
        </ul>
      )}
      {moves.length > 0 && <PlayerMoves moves={moves} />}
    </section>
  );
}

function SideResult({
  side,
  team,
  scale,
  model,
  routes,
}: {
  side: TradeSide;
  team: Team | undefined;
  scale: number;
  model: StrengthModel;
  routes?: Routes;
}) {
  const strengthTone = side.strengthChange > 0 ? "up" : side.strengthChange < 0 ? "down" : "";
  const phases = useMemo(() => tradePhases(model, side), [model, side]);
  return (
    <div className="card grade-card">
      <div className="team-cell">
        <Avatar url={team?.avatarUrl ?? null} name={team?.teamName ?? "?"} />
        <div>
          <span className="league-option-name">{team?.teamName}</span>
          <span className="team-meta">
            <span className="quiet manager">{team?.managerName}</span>
            {team && <RecordTag team={team} />}
          </span>
        </div>
      </div>
      <p className={`grade ${tone(side.grade)}`}>
        <span className="grade-letter">{side.letter}</span>
        <span className="grade-word">{gradeWord(side.grade)}</span>
      </p>

      <MoveList side={side} model={model} routes={routes} />
      <TeamManagement side={side} model={model} team={team} />

      <div className="effect-block">
        <div className="effect-head">
          <span className="effect-title">Team effect</span>
          <span className={`effect-value ${strengthTone}`}>{whole(side.strengthChange)} strength</span>
        </div>
        <EffectBar
          change={side.strengthChange}
          scale={scale}
          label={`Team strength ${side.strengthBefore} to ${side.strengthAfter}`}
        />
        <p className="quiet effect-note">
          Strength {side.strengthBefore} to {side.strengthAfter}. Projected weekly score{" "}
          {formatPoints(side.projectedAfter)} ({formatSigned(side.teamChange)}).
        </p>
        {phases && (
          <dl className="phases" aria-label={`Weekly score change around ${phases.player.name}'s return`}>
            <div>
              <dt>While {phases.player.name} is out</dt>
              <dd className={phases.whileOut > 0.05 ? "up" : phases.whileOut < -0.05 ? "down" : ""}>
                {formatSigned(phases.whileOut)} <span className="quiet">a week</span>
              </dd>
              <dd className="quiet phases-when">
                {phases.weeksOut === 1 ? "This week" : `Next ${phases.weeksOut} weeks`}
              </dd>
            </div>
            <div>
              <dt>After he is back</dt>
              <dd className={phases.afterBack > 0.05 ? "up" : phases.afterBack < -0.05 ? "down" : ""}>
                {formatSigned(phases.afterBack)} <span className="quiet">a week</span>
              </dd>
              <dd className="quiet phases-when">From about {formatBackDate(phases.backAround)}</dd>
            </div>
          </dl>
        )}
      </div>

      <dl className="grade-facts">
        <div>
          <dt>Player value in</dt>
          <dd>{formatPoints(side.valueReceived)}</dd>
        </div>
        <div>
          <dt>Player value out</dt>
          <dd>{formatPoints(side.valueSent)}</dd>
        </div>
        <div>
          <dt>Fit with roster</dt>
          <dd className={side.fit >= 1 ? "up" : side.fit <= -1 ? "down" : ""}>{formatSigned(side.fit)}</dd>
        </div>
      </dl>
    </div>
  );
}

/** Who the trade favors on player value alone: the dot moves toward the side that gets more. */
function ValueBalance({ result, nameA, nameB, compact = false }: { result: TradeResult; nameA: string; nameB: string; compact?: boolean }) {
  const position = result.valueBalance;
  const lean = Math.abs(position - 50);
  const favored = position < 50 ? nameA : nameB;
  const words =
    lean < 2.5
      ? "Even on player value"
      : lean < 7.5
        ? `Slightly favors ${favored} on player value`
        : lean < 15
          ? `Favors ${favored} on player value`
          : `Strongly favors ${favored} on player value`;
  return (
    <div className={`balance${compact ? " balance-compact" : ""}`}>
      {!compact && (
        <div className="balance-names">
          <span>{nameA}</span>
          <span className="balance-title">Player value</span>
          <span>{nameB}</span>
        </div>
      )}
      <div className="balance-track" role="img" aria-label={words}>
        <span className="balance-center" />
        <span className="balance-dot" style={{ left: `${position}%` }} />
      </div>
      <p className="balance-words">{words}</p>
      {!compact && (
        <p className="quiet balance-detail">
          {nameA} gets {formatPoints(result.a.valueReceived)} and {nameB} gets {formatPoints(result.b.valueReceived)} a
          week of player value: each player's own weekly value above a typical free agent, before any team context.
        </p>
      )}
    </div>
  );
}

function StoryBlock({ story }: { story: TradeStory }) {
  return (
    <div className="story">
      <p className={`story-kind kind-${story.kind}`}>{story.headline}</p>
      <ul className="idea-reasons quiet">
        {story.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
    </div>
  );
}

/** Both team-effect bars share one scale, so they can be compared. */
function effectScale(result: TradeResult): number {
  return Math.max(30, Math.abs(result.a.strengthChange), Math.abs(result.b.strengthChange));
}

/** One line that agrees with the grades and the chance shown below it. */
function verdict(result: TradeResult, chance: number, nameA: string, nameB: string): string {
  const pct = percent.format(chance);
  const first =
    result.a.grade >= 57 ? `Helps ${nameA}` : result.a.grade <= 43 ? `Costs ${nameA}` : `About even for ${nameA}`;
  const { step } = chanceWord(chance);
  const but = result.a.grade >= 57 ? "but" : "and";
  const outcome = [
    `${but} ${nameB} would almost certainly turn it down`,
    `${but} ${nameB} would likely turn it down`,
    `${but} ${nameB} would probably turn it down`,
    `and ${nameB} could go either way`,
    `and ${nameB} might accept`,
    `and ${nameB} would likely accept`,
    `and ${nameB} would almost certainly accept`,
  ][step];
  return `${first}, ${outcome} (${pct}).`;
}

/** A three-team idea in the finder: who sends whom where, why, each team's grade and the chance both accept. */
function ThreeTeamIdeaCard({
  idea,
  teamName,
  mine,
  players,
  onOpen,
}: {
  idea: ThreeTeamIdea;
  teamName: (rosterId: number) => string;
  mine: number;
  players: (ids: string[]) => ModelPlayer[];
  onOpen: () => void;
}) {
  const [you, ...others] = idea.result.sides;
  return (
    <li className="card idea idea-three">
      <div className="idea-main">
        <p className="idea-kind">Three-team trade</p>
        <RouteList offer={idea.offer} teamName={teamName} mine={mine} players={players} />
        <StoryBlock story={idea.story} />
      </div>
      <div className="idea-side">
        <dl className="idea-facts">
          <div>
            <dt>You</dt>
            <dd className={tone(you.grade)}>{you.letter}</dd>
          </div>
          {others.map((side) => (
            <div key={side.rosterId}>
              <dt className="idea-team" title={teamName(side.rosterId)}>
                {teamName(side.rosterId)}
              </dt>
              <dd className={tone(side.grade)}>{side.letter}</dd>
            </div>
          ))}
          <div>
            <dt>Your strength</dt>
            <dd className={you.strengthChange > 0 ? "up" : you.strengthChange < 0 ? "down" : ""}>{whole(you.strengthChange)}</dd>
          </div>
          <div>
            <dt>Chance both accept</dt>
            <dd>
              <ChanceTag chance={idea.chance} showPercent />
            </dd>
          </div>
        </dl>
        <p className="quiet idea-each">
          {idea.chances.map((entry, index) => (
            <span key={entry.rosterId}>
              {index > 0 && ", "}
              {teamName(entry.rosterId)} {percent.format(entry.chance)}
            </span>
          ))}
        </p>
      </div>
      <button type="button" className="button button-plain" onClick={onOpen}>
        Open in builder
      </button>
    </li>
  );
}

/** The three-team verdict: your grade, then whether both others are likely to agree. */
function threeVerdict(result: ThreeTeamResult, chance: number, name: (rosterId: number) => string): string {
  const [you, b, c] = result.sides;
  const pct = percent.format(chance);
  const first =
    you.grade >= 57 ? `Helps ${name(you.rosterId)}` : you.grade <= 43 ? `Costs ${name(you.rosterId)}` : `About even for ${name(you.rosterId)}`;
  const both = `${name(b.rosterId)} and ${name(c.rosterId)}`;
  const but = you.grade >= 57 ? "but" : "and";
  const outcome = [
    `${but} ${both} would almost certainly not both agree`,
    `${but} getting both ${both} to agree is unlikely`,
    `${but} ${both} would probably not both agree`,
    `and whether ${both} both agree is a toss-up`,
    `and ${both} might both agree`,
    `and ${both} would likely both agree`,
    `and ${both} would almost certainly both agree`,
  ][chanceWord(chance).step];
  return `${first}, ${outcome} (${pct}).`;
}

function ChanceParts({ chance }: { chance: Chance }) {
  return (
    <ul className="chance-parts quiet">
      {chance.parts.map((part) => (
        <li key={part.label}>
          <span>{part.label}</span>
          <span className={part.points > 0 ? "up" : part.points < 0 ? "down" : ""}>
            {part.points > 0 ? "+" : part.points < 0 ? "\u2212" : ""}
            {Math.abs(part.points)} pts
          </span>
        </li>
      ))}
    </ul>
  );
}

function ChanceBlock({ chance, name }: { chance: Chance; name: string }) {
  return (
    <div className="chance-block">
      <h3 className="my-card-title">Chance {name} accepts</h3>
      <p className="chance-figure">
        <ChanceTag chance={chance.chance} showPercent />
      </p>
      <ChanceParts chance={chance} />
    </div>
  );
}

/** Both other managers' chances, each with its parts, and the chance they both say yes. */
function ThreeChanceBlock({ chance, teamName }: { chance: ThreeTeamChance; teamName: (rosterId: number) => string }) {
  return (
    <div className="chance-block">
      <h3 className="my-card-title">Chance both accept</h3>
      <p className="chance-figure">
        <ChanceTag chance={chance.chance} showPercent />
      </p>
      <p className="quiet chance-note">Both have to say yes, so their two chances are multiplied.</p>
      {chance.each.map((entry) => (
        <div key={entry.rosterId} className="chance-each">
          <p className="chance-each-title">
            <span>{teamName(entry.rosterId)}</span>
            <span>
              <ChanceTag chance={entry.chance.chance} showPercent />
            </span>
          </p>
          <ChanceParts chance={entry.chance} />
        </div>
      ))}
    </div>
  );
}

/**
 * Player value for each of three teams: what it gets and sends, and the net,
 * as a bar from the middle. The three-team version of the player value
 * slider: no team context, just each player's own value above a free agent.
 */
function ValueSplit({ result, teamOf }: { result: ThreeTeamResult; teamOf: (rosterId: number) => Team | undefined }) {
  const scale = Math.max(3, ...result.sides.map((side) => Math.abs(side.valueChange)));
  return (
    <div className="value-split">
      <p className="balance-title">Player value</p>
      <ul>
        {result.sides.map((side) => {
          const team = teamOf(side.rosterId);
          const net = side.valueChange;
          return (
            <li key={side.rosterId} className="value-split-row">
              <span className="value-split-team">
                <Avatar url={team?.avatarUrl ?? null} name={team?.teamName ?? "?"} size="sm" />
                <span className="value-split-name">{team?.teamName}</span>
              </span>
              <span className="quiet value-split-flow">
                Gets {formatPoints(side.valueReceived)}, sends {formatPoints(side.valueSent)}
              </span>
              <EffectBar change={net} scale={scale} label={`${team?.teamName ?? "Team"}: ${formatSigned(net)} a week of player value`} />
              <span className={`value-split-net ${net >= 0.5 ? "up" : net <= -0.5 ? "down" : ""}`}>{formatSigned(net)}</span>
            </li>
          );
        })}
      </ul>
      <p className="quiet balance-detail">
        Each team's player value in and out a week: each player's own weekly value above a typical free agent, before
        any team context.
      </p>
    </div>
  );
}

/** Who sends whom where, one line per pair of teams, in the order the deal goes round. */
function RouteList({
  offer,
  teamName,
  mine,
  players,
}: {
  offer: ThreeTeamOffer;
  teamName: (rosterId: number) => string;
  mine: number;
  players: (ids: string[]) => ModelPlayer[];
}) {
  const legs: { from: number; to: number; ids: string[] }[] = [];
  for (const move of offer.moves) {
    const leg = legs.find((entry) => entry.from === move.from && entry.to === move.to);
    if (leg) leg.ids.push(move.playerId);
    else legs.push({ from: move.from, to: move.to, ids: [move.playerId] });
  }
  const who = (rosterId: number, start: boolean) => (rosterId === mine ? (start ? "You" : "you") : teamName(rosterId));
  // What you send first, then the rest of the deal in the order it goes round.
  const ordered = [...legs.filter((leg) => leg.from === mine), ...legs.filter((leg) => leg.from !== mine)];
  return (
    <ul className="routes">
      {ordered.map((leg) => (
        <li key={`${leg.from}-${leg.to}`}>
          <strong>{who(leg.from, true)}</strong> {leg.from === mine ? "send" : "sends"}{" "}
          {names(players(leg.ids))} to <strong>{who(leg.to, false)}</strong>
        </li>
      ))}
    </ul>
  );
}

/** Build a trade between two teams and see a grade and strength change for each. */
export function Trades({ snapshot, model, situations, myRosterId, incoming = null }: Props) {
  const others = snapshot.teams.filter((team) => team.rosterId !== myRosterId);
  const [teamA, setTeamA] = useState(myRosterId);
  const [teamB, setTeamB] = useState(others[0]?.rosterId ?? myRosterId);
  const [aGives, setAGives] = useState<Set<string>>(new Set());
  const [bGives, setBGives] = useState<Set<string>>(new Set());
  const [teamC, setTeamC] = useState<number | null>(null);
  const [cGives, setCGives] = useState<Set<string>>(new Set());
  // Three-team trades: where each ticked player goes, when not the default (A to B, B to C, C to A).
  const [dest, setDest] = useState<Record<string, number>>({});
  const [found, setFound] = useState<
    (MixedFinderResult & { model: StrengthModel; target: string | null; threeTeam: boolean }) | null
  >(null);
  const [allowThree, setAllowThree] = useState(false);
  const [searching, setSearching] = useState(false);
  const [goal, setGoal] = useState<Goal>("best");
  const [position, setPosition] = useState("SF");
  const [sendId, setSendId] = useState("");
  const [getId, setGetId] = useState("");
  // Both sides start closed; opening an idea in the builder opens both.
  const [openSides, setOpenSides] = useState({ a: false, b: false, c: false });

  const scrollToBuilder = (behavior: ScrollBehavior) =>
    // After the tab is shown and the builder has the trade.
    requestAnimationFrame(() => document.getElementById("trade-builder")?.scrollIntoView({ behavior, block: "start" }));

  function loadOffer(offer: TradeOffer, behavior: ScrollBehavior) {
    setTeamA(offer.teamA);
    setTeamB(offer.teamB);
    setTeamC(null);
    setAGives(new Set(offer.aGives));
    setBGives(new Set(offer.bGives));
    setCGives(new Set());
    setDest({});
    setOpenSides({ a: true, b: true, c: false });
    scrollToBuilder(behavior);
  }

  function loadThree(offer: ThreeTeamOffer) {
    const [first, second, third] = offer.teams;
    const from = (rosterId: number) => new Set(offer.moves.filter((move) => move.from === rosterId).map((move) => move.playerId));
    setTeamA(first);
    setTeamB(second);
    setTeamC(third);
    setAGives(from(first));
    setBGives(from(second));
    setCGives(from(third));
    setDest(Object.fromEntries(offer.moves.map((move) => [move.playerId, move.to])));
    setOpenSides({ a: true, b: true, c: true });
    scrollToBuilder("smooth");
  }

  useEffect(() => {
    // A trade sent for an earlier choice of your team is not loaded.
    if (incoming && incoming.offer.teamA === myRosterId) loadOffer(incoming.offer, "auto");
    // Only a newly sent trade, told apart by `at`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.at]);


  const team = (rosterId: number) => snapshot.teams.find((candidate) => candidate.rosterId === rosterId);
  const teamName = (rosterId: number) => team(rosterId)?.teamName ?? "Another team";
  const three = teamC !== null;
  const result = useMemo(() => {
    if (!model || three || teamA === teamB || aGives.size + bGives.size === 0) return null;
    return evaluateTrade(model, snapshot, { teamA, teamB, aGives: [...aGives], bGives: [...bGives] });
  }, [model, snapshot, three, teamA, teamB, aGives, bGives]);

  // ---- Three-team builder ----
  const threeOffer = useMemo((): ThreeTeamOffer | null => {
    if (teamC === null) return null;
    const teams: [number, number, number] = [teamA, teamB, teamC];
    // By default the deal goes round: A to B, B to C, C to A.
    const fallback = (from: number) => (from === teamA ? teamB : from === teamB ? teamC : teamA);
    const to = (playerId: string, from: number) => {
      const chosen = dest[playerId];
      return chosen !== undefined && chosen !== from && teams.includes(chosen) ? chosen : fallback(from);
    };
    const moves = [
      ...[...aGives].map((playerId) => ({ playerId, from: teamA, to: to(playerId, teamA) })),
      ...[...bGives].map((playerId) => ({ playerId, from: teamB, to: to(playerId, teamB) })),
      ...[...cGives].map((playerId) => ({ playerId, from: teamC, to: to(playerId, teamC) })),
    ];
    return { teams, moves };
  }, [teamA, teamB, teamC, aGives, bGives, cGives, dest]);
  const threeProblem = threeOffer && threeOffer.moves.length > 0 ? threeTeamProblem(threeOffer, teamName) : null;
  const threeResult = useMemo(
    () => (model && threeOffer && threeOffer.moves.length > 0 && !threeProblem ? evaluateThreeTeam(model, snapshot, threeOffer) : null),
    [model, snapshot, threeOffer, threeProblem],
  );
  const threeChance = useMemo(
    () => (threeResult ? threeTeamAcceptance(threeResult, (rosterId) => situations?.get(rosterId)?.urgency ?? 0) : null),
    [threeResult, situations],
  );
  const threeStoryText = useMemo(
    () => (model && threeResult ? threeTeamStory(model, snapshot, threeResult) : null),
    [model, snapshot, threeResult],
  );

  // Roster needs for both builder teams, behind the explanation of a trade.
  const builderProfiles = useMemo(() => {
    if (!model || teamA === teamB) return null;
    const of = (rosterId: number) => {
      const found = snapshot.teams.find((candidate) => candidate.rosterId === rosterId);
      return found ? positionProfile(model, snapshot, rosterPlayers(found).map((player) => player.id)) : [];
    };
    return { mine: of(teamA), theirs: of(teamB) };
  }, [model, snapshot, teamA, teamB]);
  const chance = useMemo(
    () => (result ? acceptance(result.b, situations?.get(teamB)?.urgency ?? 0) : null),
    [result, situations, teamB],
  );
  const story = useMemo(
    () =>
      model && result && builderProfiles
        ? tradeStory(model, snapshot, result, builderProfiles, situations?.get(teamB))
        : null,
    [model, snapshot, result, builderProfiles, situations, teamB],
  );

  const myTeam = snapshot.teams.find((candidate) => candidate.rosterId === myRosterId);
  const profile = useMemo(
    () => (model && myTeam ? positionProfile(model, snapshot, rosterPlayers(myTeam).map((player) => player.id)) : []),
    [model, snapshot, myTeam],
  );
  const thinnest = thinnestSpot(profile);
  const deepest = deepestSpot(profile);
  const lineup = useMemo(
    () => (model && myTeam ? bestNineLineup(model, rosterPlayers(myTeam).map((player) => player.id)) : []),
    [model, myTeam],
  );

  if (!model || !situations || !myTeam) {
    return <p className="quiet">The trade analyzer opens once player stats have loaded.</p>;
  }

  const withGames = (candidate: Team) =>
    rosterPlayers(candidate)
      .flatMap((player) => model.players.get(player.id) ?? [])
      .filter((player) => player.games > 0)
      .sort((x, y) => y.expected - x.expected);
  const ready =
    goal === "best" || goal === "position" || goal === "injured" || (goal === "send" && sendId) || (goal === "get" && getId);

  const toggle = (set: Set<string>, update: (next: Set<string>) => void) => (id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update(next);
  };

  function chooseTeam(which: "a" | "b" | "c", rosterId: number) {
    if (which === "a") {
      setTeamA(rosterId);
      setAGives(new Set());
    } else if (which === "b") {
      setTeamB(rosterId);
      setBGives(new Set());
    } else {
      setTeamC(rosterId);
      setCGives(new Set());
    }
  }

  function addThirdTeam() {
    const next = snapshot.teams.find((candidate) => candidate.rosterId !== teamA && candidate.rosterId !== teamB);
    if (!next) return;
    setTeamC(next.rosterId);
    setCGives(new Set());
    setOpenSides((sides) => ({ ...sides, c: sides.a || sides.b }));
  }

  function removeThirdTeam() {
    setTeamC(null);
    setCGives(new Set());
    setDest({});
  }

  function findIdeas() {
    setSearching(true);
    // Let the "Searching" label paint before the search starts.
    const options: FinderOptions =
      goal === "position"
        ? { getPosition: position }
        : goal === "send"
          ? { givePlayerId: sendId }
          : goal === "get"
            ? { getPlayerId: getId }
            : goal === "injured"
              ? { getInjured: true }
              : {};
    const target =
      goal === "get" ? (model!.players.get(getId)?.name ?? null) : goal === "send" ? (model!.players.get(sendId)?.name ?? null) : null;
    const threeTeam = allowThree;
    setTimeout(() => {
      const two = findTrades(model!, snapshot, myRosterId, situations!, options);
      // Three-team trades only when asked, ranked with the two-team ideas by the same rules.
      const mixed = threeTeam
        ? withThreeTeam(two, findThreeTeamTrades(model!, snapshot, myRosterId, situations!, options), options)
        : withThreeTeam(two, [], options);
      setFound({ ...mixed, model: model!, target, threeTeam });
      setSearching(false);
    }, 30);
  }

  function load(idea: FinderIdea) {
    if (isThreeTeam(idea)) loadThree(idea.offer);
    else loadOffer(idea.offer, "smooth");
  }

  const a = team(teamA);
  const b = team(teamB);
  const c = teamC !== null ? team(teamC) : undefined;
  const rows = Math.max(...[a, b, c].map((entry) => (entry ? pickerRoster(entry, model).length : 0)));
  const destinationsFor = (from: number): Destinations | undefined =>
    threeOffer
      ? {
          options: threeOffer.teams.filter((rosterId) => rosterId !== from).flatMap((rosterId) => team(rosterId) ?? []),
          of: (playerId) => threeOffer.moves.find((move) => move.playerId === playerId)?.to ?? from,
          onChange: (playerId, to) => setDest((current) => ({ ...current, [playerId]: to })),
        }
      : undefined;
  const routes: Routes | undefined = threeOffer
    ? {
        from: (playerId) => teamName(threeOffer.moves.find((move) => move.playerId === playerId)?.from ?? -1),
        to: (playerId) => teamName(threeOffer.moves.find((move) => move.playerId === playerId)?.to ?? -1),
      }
    : undefined;
  const threeScale = threeResult ? Math.max(30, ...threeResult.sides.map((side) => Math.abs(side.strengthChange))) : 30;
  const teamSelect = (which: "a" | "b" | "c", value: number, label: string) => (
    <label>
      {label}
      <select value={value} onChange={(event) => chooseTeam(which, Number(event.target.value))}>
        {snapshot.teams.map((option) => (
          <option key={option.rosterId} value={option.rosterId}>
            {option.teamName} ({formatRecord(option.wins, option.losses, option.ties)}
            {option.rosterId === myRosterId ? ", you" : ""})
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section aria-label="Trades">
      <div className="filters finder">
        <label>
          I want to
          <select
            value={goal}
            onChange={(event) => {
              setGoal(event.target.value as Goal);
              setFound(null);
            }}
          >
            <option value="best">see the best trades for my team</option>
            <option value="position">get a player at a position</option>
            <option value="send">trade away one of my players</option>
            <option value="get">get a specific player</option>
            <option value="injured">trade for an injured player</option>
          </select>
        </label>
        {goal === "position" && (
          <label>
            Position
            <select value={position} onChange={(event) => { setPosition(event.target.value); setFound(null); }}>
              {POSITIONS.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
        )}
        {goal === "send" && (
          <label>
            Player
            <select value={sendId} onChange={(event) => { setSendId(event.target.value); setFound(null); }}>
              <option value="">Choose one of your players</option>
              {withGames(myTeam).map((player) => (
                <option key={player.id} value={player.id}>{player.name} ({player.positions.join("/")})</option>
              ))}
            </select>
          </label>
        )}
        {goal === "get" && (
          <label>
            Player
            <select value={getId} onChange={(event) => { setGetId(event.target.value); setFound(null); }}>
              <option value="">Choose a player on another team</option>
              {others.map((other) => (
                <optgroup key={other.rosterId} label={other.teamName}>
                  {withGames(other).map((player) => (
                    <option key={player.id} value={player.id}>{player.name} ({player.positions.join("/")})</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={allowThree}
            onChange={(event) => {
              setAllowThree(event.target.checked);
              setFound(null);
            }}
          />
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
          Include three-team trades
        </label>
        <button type="button" className="button" disabled={searching || !ready} onClick={findIdeas}>
          {searching ? "Searching…" : "Find trades"}
        </button>
      </div>

      {found && found.model !== model && (
        <p className="notice">
          Projections have been updated since this search (for example, last season's stats arrived). Search
          again for fresh results.
        </p>
      )}
      {found?.ideas.some((idea) => idea.depth > 1) && (
        <p className="finder-outlook quiet">
          No simple swap stood a good chance, so the search also built packages: one of your spare players added, or
          two of their players for one of yours.
        </p>
      )}
      {found && (
        <p className={`finder-outlook${found.outlook === "likely" ? "" : " quiet"}`}>
          {found.outlook === "none" &&
            (goal === "injured"
              ? "No injured player on another team is worth trading for right now: none would raise your team's strength over the rest of the season with a fair chance of being accepted."
              : goal === "best" || goal === "position"
              ? "No trade helps your team right now with a fair chance of being accepted."
              : `No realistic offer for ${found.target ?? "that player"}: every trade found would cost you more than a point a week or be a big loss for the other team, even with packages.`)}
          {found.outlook === "likely" &&
            (found.ideas.filter((idea) => idea.likelihood === "likely").length < 3
              ? `Only ${found.ideas.filter((idea) => idea.likelihood === "likely").length === 1 ? "one offer has" : "a few offers have"} an even chance or better of being accepted.`
              : null)}
          {found.outlook === "possible" &&
            "None of these has an even chance of being accepted, but they stand a fair one. These are the closest."}
          {found.outlook === "long-shot" &&
            `There is no realistic offer${found.target ? ` for ${found.target}` : ""} right now. These have the best odds, but all are long shots.`}
        </p>
      )}
      {found && found.ideas.length > 0 && (
        <ul className="ideas">
          {found.ideas.map((idea) =>
            isThreeTeam(idea) ? (
              <ThreeTeamIdeaCard
                key={idea.offer.moves.map((move) => `${move.playerId}>${move.to}`).join("+")}
                idea={idea}
                teamName={teamName}
                mine={myRosterId}
                players={(ids) => ids.flatMap((id) => model.players.get(id) ?? [])}
                onOpen={() => load(idea)}
              />
            ) : (
              <li key={`${idea.offer.aGives.join("+")}-${idea.offer.bGives.join("+")}`} className="card idea">
                <div className="idea-main">
                  <p className="idea-deal">
                    Send {names(idea.result.a.gives)} to {team(idea.offer.teamB)?.teamName} for {names(idea.result.a.gets)}
                  </p>
                  <StoryBlock story={idea.story} />
                </div>
                <div className="idea-side">
                  <dl className="idea-facts">
                    <div>
                      <dt>You</dt>
                      <dd className={tone(idea.result.a.grade)}>{idea.result.a.letter}</dd>
                    </div>
                    <div>
                      <dt>Them</dt>
                      <dd className={tone(idea.result.b.grade)}>{idea.result.b.letter}</dd>
                    </div>
                    <div>
                      <dt>Your strength</dt>
                      <dd className={idea.result.a.strengthChange > 0 ? "up" : idea.result.a.strengthChange < 0 ? "down" : ""}>
                        {whole(idea.result.a.strengthChange)}
                      </dd>
                    </div>
                    <div>
                      <dt>Their strength</dt>
                      <dd className={idea.result.b.strengthChange > 0 ? "up" : idea.result.b.strengthChange < 0 ? "down" : ""}>
                        {whole(idea.result.b.strengthChange)}
                      </dd>
                    </div>
                    <div>
                      <dt>Chance they accept</dt>
                      <dd>
                        <ChanceTag chance={idea.chance} showPercent />
                      </dd>
                    </div>
                  </dl>
                  <ValueBalance result={idea.result} nameA="you" nameB="them" compact />
                </div>
                <button type="button" className="button button-plain" onClick={() => load(idea)}>
                  Open in builder
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      {found?.threeTeam && !found.ideas.some(isThreeTeam) && (
        <div className="three-left-out">
          {found.bestThreeLeftOut && found.bestThreeLeftOut.likelihood !== "long shot" ? (
            <>
              <p className="finder-outlook quiet">
                No three-team trade ranked among these: it needs two managers to agree, so it has to be good for both.
                The closest one:
              </p>
              <ul className="ideas">
                <ThreeTeamIdeaCard
                  idea={found.bestThreeLeftOut}
                  teamName={teamName}
                  mine={myRosterId}
                  players={(ids) => ids.flatMap((id) => model.players.get(id) ?? [])}
                  onOpen={() => load(found.bestThreeLeftOut!)}
                />
              </ul>
            </>
          ) : (
            <p className="finder-outlook quiet">
              Three-team trades were searched too, but none stood a fair chance: both other managers would have to
              agree.
            </p>
          )}
        </div>
      )}

      <h2 className="section-title ideas-title" id="trade-builder">Build a trade</h2>
      <div className="filters">
        {teamSelect("a", teamA, "Team")}
        {teamSelect("b", teamB, three ? "With" : "Trading with")}
        {teamC !== null && (
          <span className="third-team">
            {teamSelect("c", teamC, "And")}
            <button type="button" className="button button-plain button-small" onClick={removeThirdTeam} aria-label="Remove the third team">
              Remove
            </button>
          </span>
        )}
        {teamC === null && (
          <button type="button" className="button button-plain add-team" onClick={addThirdTeam}>
            <span aria-hidden="true">+</span> Add a third team
          </button>
        )}
        {(aGives.size > 0 || bGives.size > 0 || cGives.size > 0) && (
          <button
            type="button"
            className="button button-plain"
            onClick={() => {
              setAGives(new Set());
              setBGives(new Set());
              setCGives(new Set());
              setDest({});
            }}
          >
            Clear trade
          </button>
        )}
      </div>

      {three && threeOffer && c ? (
        <>
          {threeResult && threeChance ? (
            <div className="trade-result" role="status">
              <div className="card balance-card">
                <ValueSplit result={threeResult} teamOf={team} />
              </div>
              <p className="verdict">{threeVerdict(threeResult, threeChance.chance, teamName)}</p>
              <div className="my-cards my-cards-three">
                {threeResult.sides.map((side) => (
                  <SideResult key={side.rosterId} side={side} team={team(side.rosterId)} scale={threeScale} model={model} routes={routes} />
                ))}
              </div>
              {threeStoryText && (
                <div className="card story-card">
                  <div>
                    <h3 className="my-card-title">Why, from {teamName(teamA)}'s side</h3>
                    <StoryBlock story={threeStoryText} />
                  </div>
                  <ThreeChanceBlock chance={threeChance} teamName={teamName} />
                </div>
              )}
            </div>
          ) : threeProblem ? (
            // Three different teams are needed at all; anything else is a step still to take.
            <p className={threeProblem.startsWith("Choose") ? "notice notice-warn" : "quiet trade-hint"}>{threeProblem}</p>
          ) : (
            <p className="quiet trade-hint">
              Tick the players each team would send. Each one goes round to the next team unless you choose another.
            </p>
          )}
          {a && b && (
            <div className="trade-rosters trade-rosters-three">
              {([
                [a, aGives, setAGives, "a"],
                [b, bGives, setBGives, "b"],
                [c, cGives, setCGives, "c"],
              ] as const).map(([entry, chosen, update, key]) => (
                <RosterPicker
                  key={key}
                  team={entry}
                  model={model}
                  chosen={chosen}
                  onToggle={toggle(chosen, update)}
                  label={`${entry.teamName} sends`}
                  open={openSides[key]}
                  onOpenChange={(open) => setOpenSides((sides) => ({ ...sides, [key]: open }))}
                  rows={rows}
                  destinations={destinationsFor(entry.rosterId)}
                />
              ))}
            </div>
          )}
        </>
      ) : teamA === teamB ? (
        <p className="notice notice-warn">Choose two different teams.</p>
      ) : (
        a &&
        b && (
          <>
            {result ? (
              <div className="trade-result" role="status">
                <div className="card balance-card">
                  <ValueBalance result={result} nameA={a.teamName} nameB={b.teamName} />
                </div>
                {chance && <p className="verdict">{verdict(result, chance.chance, a.teamName, b.teamName)}</p>}
                <div className="my-cards">
                  <SideResult side={result.a} team={a} scale={effectScale(result)} model={model} />
                  <SideResult side={result.b} team={b} scale={effectScale(result)} model={model} />
                </div>
                {story && chance && (
                  <div className="card story-card">
                    <div>
                      <h3 className="my-card-title">Why, from {a.teamName}'s side</h3>
                      <StoryBlock story={story} />
                    </div>
                    <ChanceBlock chance={chance} name={b.teamName} />
                  </div>
                )}
              </div>
            ) : (
              <p className="quiet trade-hint">Tick the players each team would send to see a grade for both managers.</p>
            )}
            <div className="trade-rosters">
              <RosterPicker
                team={a}
                model={model}
                chosen={aGives}
                onToggle={toggle(aGives, setAGives)}
                label={`${a.teamName} sends`}
                open={openSides.a}
                onOpenChange={(open) => setOpenSides((sides) => ({ ...sides, a: open }))}
                rows={rows}
              />
              <RosterPicker
                team={b}
                model={model}
                chosen={bGives}
                onToggle={toggle(bGives, setBGives)}
                label={`${b.teamName} sends`}
                open={openSides.b}
                onOpenChange={(open) => setOpenSides((sides) => ({ ...sides, b: open }))}
                rows={rows}
              />
            </div>
          </>
        )
      )}

      <h2 className="section-title ideas-title" id="trade-finder">
        Find a trade
      </h2>
      <div className="card my-shape">
        <div className="my-shape-lineup">
          <h3 className="my-card-title">Your best nine</h3>
          <table className="players-table lineup-table">
            <thead>
              <tr>
                <th scope="col">Slot</th>
                <th scope="col">Player</th>
                <th scope="col" className="num">Weekly value</th>
              </tr>
            </thead>
            <tbody>
              {lineup.map(({ slot, player }, index) => (
                <tr key={`${slot}-${index}`}>
                  <td>
                    <PositionChip label={slot} />
                  </td>
                  <td>{player ? <PlayerCell player={player} /> : <span className="quiet">Nobody eligible</span>}</td>
                  <td className="num">{player ? formatPoints(player.expected) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="quiet my-shape-note">
            The starters your strength score is built on, placed in Sleeper's nine slots. Weekly value is what
            a player locks on his own in an average week.
          </p>
        </div>
        <div className="my-shape-positions">
          <h3 className="my-card-title">By position</h3>
          <table className="players-table position-table">
            <thead>
              <tr>
                <th scope="col">Position</th>
                <th scope="col" className="num">Need</th>
                <th scope="col" className="num">Cover</th>
              </tr>
            </thead>
            <tbody>
              {profile.map((note) => (
                <tr key={note.position}>
                  <th scope="row">
                    <span className="position-row">
                      <PositionChip label={note.position} />
                      {thinnest?.position === note.position && <span className="spot-tag spot-thin">Thinnest</span>}
                      {deepest?.position === note.position && <span className="spot-tag spot-deep">Most depth</span>}
                    </span>
                  </th>
                  <td className="num">{formatPoints(note.need)}</td>
                  <td className="num">{formatPoints(note.cover)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="quiet my-shape-note">
            Need is the weekly points a typical starter would add in the slots reserved for that position. Cover
            is how much of your best player there the rest of your roster would make up if he left.
          </p>
        </div>
      </div>

      <div className="quiet legend explain">
        <p>
          Each manager's letter says how good the trade is for their own team over the rest of the season: A is a
          big win, B a win, C about even, D a loss, F a big loss. Both can get an A when a trade suits both teams.
          The top slider compares player value alone: each player's own weekly value above a typical free agent,
          with no team context. The bar on each team's card is the trade in context: the change in that team's
          strength. The gap between the two is fit: a trade worth more to a team than its player value usually
          fills a thin position, adds depth, or covers for an injury. Trade ideas are still ranked the same way;
          this only explains them.
        </p>
        <p>
          Ideas with an even chance or better of being accepted (50% and up) come first, ranked by the weekly points they add for you
          multiplied by that chance. Less likely ones are shown only when none reach even odds, and long shots
          (under 35%) only when there is nothing better. When you name a player, offers that cost you up to a
          point a week are allowed, since that is sometimes the price of a move you want.
          A three-team trade needs both other managers to say yes, so its chance is their two chances
          multiplied, and it is ranked with the two-team ideas by the same rules.
          That chance is an estimate, not a measurement. Managers overvalue their own players, so an even trade
          comes out at about a third: they count their own players 8% higher on the averages, and a loss to their
          team weighs twice as much as a gain of the same size. It adds three limited parts: what they see on the averages, what the trade does to their team
          (which they sense through their own needs), and the pressure they are under. One bad part pulls the chance down however good the others look. The builder shows how many
          points each part adds or takes away.
        </p>
        <p>
          Weekly value is what a player is expected to lock in an average week, allowing for games he misses.
          Rosters are run as a manager would run them, before and after the trade alike: a player marked out goes
          on IR if a slot is free, an open roster spot is filled with the free agent who helps most (for a player
          on IR, only while he is out), and a team with too many players drops its least valuable one.
        </p>
        <p>
          An injured player counts from the injury report's return date: nothing while he is out, his usual level
          once back. Dates further away are taken a little later and less exactly, and a "re-evaluated" date is the
          earliest he could return, not when he will. The card splits the trade into the weeks he is out and the
          weeks after; the grade covers both. His player value counts only the weeks he plays, since an IR slot and a
          pickup cover him while he is out. Managers see an injured player's average scaled down by the share of
          the season he will miss, a little more for the games in front of them, which makes them more willing to
          trade him.
        </p>
      </div>
    </section>
  );
}
