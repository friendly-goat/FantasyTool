import { useEffect, useMemo, useState } from "react";
import { rosterPlayers } from "../../shared/analysis.ts";
import { deepestSpot, POSITIONS, positionProfile, type TeamSituation, thinnestSpot } from "../../shared/insight.ts";
import { bestNineLineup, type ModelPlayer, type Pickup, type StrengthModel } from "../../shared/strength.ts";
import {
  acceptance,
  evaluateTrade,
  likelihood,
  findTrades,
  playerValue,
  gradeWord,
  type FinderOptions,
  type FinderResult,
  type TradeIdea,
  type TradeOffer,
  reserveMoves,
  tradePhases,
  tradeStory,
  type TradeResult,
  type TradeSide,
  type Chance,
  type TradeStory,
} from "../../shared/trade.ts";
import type { LeagueSnapshot, Team } from "../../shared/types.ts";
import { formatPoints, formatRecord, formatSigned, formatWholeChange as whole, ordinal } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { EffectBar, RecordTag } from "./TeamEffect.tsx";
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

function RosterPicker({ team, model, chosen, onToggle, label, open, onOpenChange, rows }: {
  team: Team;
  model: StrengthModel;
  chosen: Set<string>;
  onToggle: (id: string) => void;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rows to show at least, so two rosters side by side line up; extra rows are empty slots. */
  rows: number;
}) {
  const roster = pickerRoster(team, model);
  const empty = Math.max(0, rows - roster.length);
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
                .map((player) => player.name)
                .join(", ")
            : open
              ? "Tick players to trade"
              : "Show players"}
        </span>
      </summary>
      <div className="roster-scroll">
        <table className="roster-table">
          <thead>
            <tr className="group-row">
              <th scope="col">Player</th>
              <th scope="col" className="num">Weekly value</th>
              <th scope="col" className="num">Avg</th>
              <th scope="col" className="num">Plays</th>
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
                    <PlayerCell player={player} />
                  </span>
                </th>
                <td className="num strong">{player.games > 0 ? formatPoints(player.expected) : "–"}</td>
                <td className="num">{player.games > 0 ? formatPoints(player.average) : "–"}</td>
                <td className="num quiet-cell">{player.games > 0 ? percent.format(player.availability) : "–"}</td>
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
                <td className="num quiet-cell">–</td>
                <td className="num quiet-cell">–</td>
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

/** The players in the trade itself, joining and leaving. */
function MoveList({ side, model }: { side: TradeSide; model: StrengthModel }) {
  const value = (player: ModelPlayer) => <PlayerValue model={model} player={player} />;
  return (
    <PlayerMoves
      moves={[
        ...side.gets.map((player) => ({ player, joins: true, value: value(player) })),
        ...side.gives.map((player) => ({ player, joins: false, value: value(player) })),
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

function SideResult({ side, team, scale, model }: { side: TradeSide; team: Team | undefined; scale: number; model: StrengthModel }) {
  const strengthTone = side.strengthChange > 0 ? "up" : side.strengthChange < 0 ? "down" : "";
  const phases = useMemo(() => tradePhases(model, side), [model, side]);
  return (
    <div className="card grade-card">
      <div className="team-cell">
        <Avatar url={team?.avatarUrl ?? null} name={team?.teamName ?? "?"} />
        <div>
          <span className="league-option-name">{team?.teamName}</span>
          <span className="quiet manager">
            {team?.managerName}
            {team && `, ${formatRecord(team.wins, team.losses, team.ties)}, ${ordinal(team.rank)}`}
          </span>
        </div>
      </div>
      <p className={`grade ${tone(side.grade)}`}>
        <span className="grade-letter">{side.letter}</span>
        <span className="grade-word">{gradeWord(side.grade)}</span>
      </p>

      <MoveList side={side} model={model} />
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
  const band = likelihood(chance);
  if (band === "likely") return `${first}, and ${nameB} would likely accept (${pct}).`;
  if (band === "possible") return `${first}, and ${nameB} could go either way (${pct}).`;
  return `${first}, ${result.a.grade >= 57 ? "but" : "and"} ${nameB} would likely turn it down (${pct}).`;
}

function ChanceBlock({ chance, name }: { chance: Chance; name: string }) {
  const band = likelihood(chance.chance);
  return (
    <div className="chance-block">
      <h3 className="my-card-title">Chance {name} accepts</h3>
      <p className="chance-figure">
        {percent.format(chance.chance)} <span className={`likelihood likelihood-${band.replace(" ", "-")}`}>{band}</span>
      </p>
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
    </div>
  );
}

/** Build a trade between two teams and see a grade and strength change for each. */
export function Trades({ snapshot, model, situations, myRosterId, incoming = null }: Props) {
  const others = snapshot.teams.filter((team) => team.rosterId !== myRosterId);
  const [teamA, setTeamA] = useState(myRosterId);
  const [teamB, setTeamB] = useState(others[0]?.rosterId ?? myRosterId);
  const [aGives, setAGives] = useState<Set<string>>(new Set());
  const [bGives, setBGives] = useState<Set<string>>(new Set());
  const [found, setFound] = useState<(FinderResult & { model: StrengthModel; target: string | null }) | null>(null);
  const [searching, setSearching] = useState(false);
  const [goal, setGoal] = useState<Goal>("best");
  const [position, setPosition] = useState("SF");
  const [sendId, setSendId] = useState("");
  const [getId, setGetId] = useState("");
  // Both sides start closed; opening an idea in the builder opens both.
  const [openSides, setOpenSides] = useState({ a: false, b: false });

  function loadOffer(offer: TradeOffer, behavior: ScrollBehavior) {
    setTeamA(offer.teamA);
    setTeamB(offer.teamB);
    setAGives(new Set(offer.aGives));
    setBGives(new Set(offer.bGives));
    setOpenSides({ a: true, b: true });
    // After the tab is shown and the builder has the trade.
    requestAnimationFrame(() => document.getElementById("trade-builder")?.scrollIntoView({ behavior, block: "start" }));
  }

  useEffect(() => {
    // A trade sent for an earlier choice of your team is not loaded.
    if (incoming && incoming.offer.teamA === myRosterId) loadOffer(incoming.offer, "auto");
    // Only a newly sent trade, told apart by `at`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.at]);


  const team = (rosterId: number) => snapshot.teams.find((candidate) => candidate.rosterId === rosterId);
  const result = useMemo(() => {
    if (!model || teamA === teamB || aGives.size + bGives.size === 0) return null;
    return evaluateTrade(model, snapshot, { teamA, teamB, aGives: [...aGives], bGives: [...bGives] });
  }, [model, snapshot, teamA, teamB, aGives, bGives]);

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

  function chooseTeam(which: "a" | "b", rosterId: number) {
    if (which === "a") {
      setTeamA(rosterId);
      setAGives(new Set());
    } else {
      setTeamB(rosterId);
      setBGives(new Set());
    }
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
    setTimeout(() => {
      setFound({ ...findTrades(model!, snapshot, myRosterId, situations!, options), model: model!, target });
      setSearching(false);
    }, 30);
  }

  function load(idea: TradeIdea) {
    loadOffer(idea.offer, "smooth");
  }

  const a = team(teamA);
  const b = team(teamB);
  const rows = Math.max(a ? pickerRoster(a, model).length : 0, b ? pickerRoster(b, model).length : 0);
  const teamSelect = (which: "a" | "b", value: number, label: string) => (
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
              ? `Only ${found.ideas.filter((idea) => idea.likelihood === "likely").length === 1 ? "one offer is" : "a few offers are"} likely to be accepted.`
              : null)}
          {found.outlook === "possible" &&
            "None of these is likely to be accepted, but they stand a fair chance. These are the closest."}
          {found.outlook === "long-shot" &&
            `There is no realistic offer${found.target ? ` for ${found.target}` : ""} right now. These have the best odds, but all are long shots.`}
        </p>
      )}
      {found && found.ideas.length > 0 && (
        <ul className="ideas">
          {found.ideas.map((idea) => (
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
                      {percent.format(idea.chance)} <span className={`likelihood likelihood-${idea.likelihood.replace(" ", "-")}`}>{idea.likelihood}</span>
                    </dd>
                  </div>
                </dl>
                <ValueBalance result={idea.result} nameA="you" nameB="them" compact />
              </div>
              <button type="button" className="button button-plain" onClick={() => load(idea)}>
                Open in builder
              </button>
            </li>
          ))}
        </ul>
      )}

      <h2 className="section-title ideas-title" id="trade-builder">Build a trade</h2>
      <div className="filters">
        {teamSelect("a", teamA, "Team")}
        {teamSelect("b", teamB, "Trading with")}
        {(aGives.size > 0 || bGives.size > 0) && (
          <button
            type="button"
            className="button button-plain"
            onClick={() => {
              setAGives(new Set());
              setBGives(new Set());
            }}
          >
            Clear trade
          </button>
        )}
      </div>

      {teamA === teamB ? (
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
          Ideas likely to be accepted (50% or better) come first, ranked by the weekly points they add for you
          multiplied by that chance. Less likely ones are shown only when nothing likely exists, and long shots
          (under 35%) only when there is nothing better. When you name a player, offers that cost you up to a
          point a week are allowed, since that is sometimes the price of a move you want.
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
