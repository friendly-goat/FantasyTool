import { useEffect, useMemo, useState } from "react";
import { rosterPlayers } from "../../shared/analysis.ts";
import type { ModelPlayer, StrengthModel } from "../../shared/strength.ts";
import { evaluateTrade, suggestTrades, type TradeIdea, type TradeSide } from "../../shared/trade.ts";
import type { LeagueSnapshot, Team } from "../../shared/types.ts";
import { formatPoints, formatSigned } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { PlayerName } from "./PlayerName.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  model: StrengthModel | null;
  myRosterId: number;
}

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });
const whole = (value: number) => (value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : "0");
const tone = (grade: number) => (grade >= 57 ? "up" : grade <= 43 ? "down" : "");

function names(players: ModelPlayer[]) {
  return players.map((player, index) => (
    <span key={player.id}>
      {index > 0 && ", "}
      <PlayerName player={player} />
    </span>
  ));
}

function RosterPicker({ team, model, chosen, onToggle, label }: {
  team: Team;
  model: StrengthModel;
  chosen: Set<string>;
  onToggle: (id: string) => void;
  label: string;
}) {
  const roster = rosterPlayers(team)
    .flatMap((player) => model.players.get(player.id) ?? [])
    .sort((a, b) => b.expected - a.expected);
  return (
    <div className="card trade-roster">
      <h3 className="my-card-title">{label}</h3>
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
                  <label className="pick">
                    <input
                      type="checkbox"
                      checked={chosen.has(player.id)}
                      onChange={() => onToggle(player.id)}
                      aria-label={`Trade ${player.name}`}
                    />
                  </label>
                  <span className="player-name">
                    <PlayerName player={player} />
                  </span>
                  {player.injuryStatus && <span className="injury">{player.injuryStatus}</span>}
                  <span className="quiet player-meta">{player.positions.join("/")}</span>
                </th>
                <td className="num strong">{player.games > 0 ? formatPoints(player.expected) : "–"}</td>
                <td className="num">{player.games > 0 ? formatPoints(player.average) : "–"}</td>
                <td className="num quiet-cell">{player.games > 0 ? percent.format(player.availability) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SideResult({ side, team }: { side: TradeSide; team: Team | undefined }) {
  return (
    <div className="card grade-card">
      <div className="team-cell">
        <Avatar url={team?.avatarUrl ?? null} name={team?.teamName ?? "?"} />
        <div>
          <span className="league-option-name">{team?.teamName}</span>
          <span className="quiet manager">{team?.managerName}</span>
        </div>
      </div>
      <p className={`grade ${tone(side.grade)}`}>
        <span className="grade-number">{side.grade}</span>
        <span className="grade-letter">{side.letter}</span>
        <span className="quiet">trade grade, out of 100</span>
      </p>
      <dl className="grade-facts">
        <div>
          <dt>Team strength</dt>
          <dd>
            {side.strengthBefore} to {side.strengthAfter}{" "}
            <span className={side.strengthChange > 0 ? "up" : side.strengthChange < 0 ? "down" : ""}>
              ({whole(side.strengthChange)})
            </span>
          </dd>
        </div>
        <div>
          <dt>Projected weekly score</dt>
          <dd>
            {formatPoints(side.projectedAfter)} ({formatSigned(side.projectedAfter - side.projectedBefore)})
          </dd>
        </div>
      </dl>
      <p className="quiet">
        Sends {side.gives.length > 0 ? names(side.gives) : "nobody"}. Receives{" "}
        {side.gets.length > 0 ? names(side.gets) : "nobody"}.
        {side.adds.length > 0 && <> Assumes the open spot goes to free agent {names(side.adds)}.</>}
        {side.drops.length > 0 && <> Assumes {names(side.drops)} is dropped to make room.</>}
      </p>
    </div>
  );
}

function verdict(a: TradeSide, b: TradeSide, nameA: string, nameB: string): string {
  const good = (side: TradeSide) => side.grade >= 55;
  const bad = (side: TradeSide) => side.grade <= 45;
  if (good(a) && good(b)) return "Good for both teams. This is the kind of offer that gets accepted.";
  if (good(a) && bad(b)) return `Helps ${nameA} and hurts ${nameB}. Expect it to be turned down.`;
  if (bad(a) && good(b)) return `Helps ${nameB} and hurts ${nameA}.`;
  if (bad(a) && bad(b)) return "Makes both teams weaker.";
  if (good(a)) return `Helps ${nameA} and leaves ${nameB} about where it was.`;
  if (good(b)) return `Helps ${nameB} and leaves ${nameA} about where it was.`;
  if (bad(a)) return `Hurts ${nameA} without doing much for ${nameB}.`;
  if (bad(b)) return `Hurts ${nameB} without doing much for ${nameA}.`;
  return "Changes little for either team.";
}

/** Build a trade between two teams and see a grade and strength change for each. */
export function Trades({ snapshot, model, myRosterId }: Props) {
  const others = snapshot.teams.filter((team) => team.rosterId !== myRosterId);
  const [teamA, setTeamA] = useState(myRosterId);
  const [teamB, setTeamB] = useState(others[0]?.rosterId ?? myRosterId);
  const [aGives, setAGives] = useState<Set<string>>(new Set());
  const [bGives, setBGives] = useState<Set<string>>(new Set());
  const [ideas, setIdeas] = useState<TradeIdea[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Ideas are for the user's team as the rosters stand; a refresh clears them.
  useEffect(() => setIdeas(null), [model, myRosterId]);

  const team = (rosterId: number) => snapshot.teams.find((candidate) => candidate.rosterId === rosterId);
  const result = useMemo(() => {
    if (!model || teamA === teamB || aGives.size + bGives.size === 0) return null;
    return evaluateTrade(model, snapshot, { teamA, teamB, aGives: [...aGives], bGives: [...bGives] });
  }, [model, snapshot, teamA, teamB, aGives, bGives]);

  if (!model) return <p className="quiet">The trade analyzer opens once player stats have loaded.</p>;

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
    setTimeout(() => {
      setIdeas(suggestTrades(model!, snapshot, myRosterId));
      setSearching(false);
    }, 30);
  }

  function load(idea: TradeIdea) {
    setTeamA(idea.offer.teamA);
    setTeamB(idea.offer.teamB);
    setAGives(new Set(idea.offer.aGives));
    setBGives(new Set(idea.offer.bGives));
    document.getElementById("trade-builder")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const a = team(teamA);
  const b = team(teamB);
  const teamSelect = (which: "a" | "b", value: number, label: string) => (
    <label>
      {label}
      <select value={value} onChange={(event) => chooseTeam(which, Number(event.target.value))}>
        {snapshot.teams.map((option) => (
          <option key={option.rosterId} value={option.rosterId}>
            {option.teamName}
            {option.rosterId === myRosterId ? " (you)" : ""}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section aria-label="Trades">
      <h2 className="section-title" id="trade-builder">Build a trade</h2>
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
                <p className="verdict">{verdict(result.a, result.b, a.teamName, b.teamName)}</p>
                <div className="my-cards">
                  <SideResult side={result.a} team={a} />
                  <SideResult side={result.b} team={b} />
                </div>
              </div>
            ) : (
              <p className="quiet trade-hint">Tick the players each team would send to see a grade for both managers.</p>
            )}
            <div className="trade-rosters">
              <RosterPicker team={a} model={model} chosen={aGives} onToggle={toggle(aGives, setAGives)} label={`${a.teamName} sends`} />
              <RosterPicker team={b} model={model} chosen={bGives} onToggle={toggle(bGives, setBGives)} label={`${b.teamName} sends`} />
            </div>
          </>
        )
      )}

      <h2 className="section-title ideas-title">Trade ideas for your team</h2>
      <p className="quiet explain">
        One-for-one swaps that make your team stronger without making the other team weaker, where your player
        does not look clearly worse on average than the one you ask for.
      </p>
      {ideas === null ? (
        <button type="button" className="button" disabled={searching} onClick={findIdeas}>
          {searching ? "Searching…" : "Find trade ideas"}
        </button>
      ) : ideas.length === 0 ? (
        <p className="quiet">No one-for-one swap helps you without hurting the other team right now.</p>
      ) : (
        <div className="table-scroll">
          <table className="players-table">
            <thead>
              <tr>
                <th scope="col">You send</th>
                <th scope="col">You receive</th>
                <th scope="col">From</th>
                <th scope="col" className="num">Your grade</th>
                <th scope="col" className="num">Your strength</th>
                <th scope="col" className="num">Their grade</th>
                <th scope="col" className="num">Their strength</th>
                <th scope="col"><span className="visually-hidden">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {ideas.map((idea) => (
                <tr key={`${idea.offer.aGives[0]}-${idea.offer.bGives[0]}`}>
                  <th scope="row">{names(idea.result.a.gives)}</th>
                  <td>{names(idea.result.a.gets)}</td>
                  <td>{team(idea.offer.teamB)?.teamName}</td>
                  <td className={`num strong ${tone(idea.result.a.grade)}`}>
                    {idea.result.a.grade} {idea.result.a.letter}
                  </td>
                  <td className="num">{whole(idea.result.a.strengthChange)}</td>
                  <td className={`num ${tone(idea.result.b.grade)}`}>
                    {idea.result.b.grade} {idea.result.b.letter}
                  </td>
                  <td className="num">{whole(idea.result.b.strengthChange)}</td>
                  <td>
                    <button type="button" className="link-button" onClick={() => load(idea)}>
                      Open in builder
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="quiet legend explain">
        <p>
          The grade says how good the trade is for that manager: 50 means no real change, and each 4 points a
          week gained or lost moves it roughly from 50 to 73 or 27. It is based on the change in projected weekly
          score for the rest of the season, the same number behind team strength.
        </p>
        <p>
          Weekly value is what a player is expected to lock in an average week, allowing for games he misses.
          Rosters keep their size: a team that receives fewer players picks up the free agent who helps it most,
          and a team that receives more drops its least valuable player.
        </p>
      </div>
    </section>
  );
}
