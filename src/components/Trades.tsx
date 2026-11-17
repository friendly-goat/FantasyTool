import { useMemo, useState } from "react";
import { rosterPlayers } from "../../shared/analysis.ts";
import { POSITIONS, positionProfile, type TeamSituation } from "../../shared/insight.ts";
import type { ModelPlayer, StrengthModel } from "../../shared/strength.ts";
import {
  balance,
  evaluateTrade,
  findTrades,
  gradeWord,
  type FinderOptions,
  type FinderResult,
  type TradeIdea,
  type TradeResult,
  type TradeSide,
} from "../../shared/trade.ts";
import type { LeagueSnapshot, Team } from "../../shared/types.ts";
import { formatPoints, formatSigned } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { PlayerName } from "./PlayerName.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  model: StrengthModel | null;
  situations: Map<number, TeamSituation> | null;
  myRosterId: number;
}

type Goal = "best" | "position" | "send" | "get";

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
        <span className="grade-letter">{side.letter}</span>
        <span className="grade-word">{gradeWord(side.grade)}</span>
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

/** Where a trade sits between the two teams: the dot moves toward the team it favors. */
function Balance({ result, nameA, nameB, compact = false }: { result: TradeResult; nameA: string; nameB: string; compact?: boolean }) {
  const position = balance(result);
  const lean = Math.abs(position - 50);
  const favored = position < 50 ? nameA : nameB;
  const words =
    lean < 4 ? "Even trade" : lean < 12 ? `Slightly favors ${favored}` : lean < 25 ? `Favors ${favored}` : `Strongly favors ${favored}`;
  return (
    <div className={`balance${compact ? " balance-compact" : ""}`}>
      {!compact && (
        <div className="balance-names">
          <span>{nameA}</span>
          <span>{nameB}</span>
        </div>
      )}
      <div className="balance-track" role="img" aria-label={words}>
        <span className="balance-center" />
        <span className="balance-dot" style={{ left: `${position}%` }} />
      </div>
      <p className="balance-words">{words}</p>
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
export function Trades({ snapshot, model, situations, myRosterId }: Props) {
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


  const team = (rosterId: number) => snapshot.teams.find((candidate) => candidate.rosterId === rosterId);
  const result = useMemo(() => {
    if (!model || teamA === teamB || aGives.size + bGives.size === 0) return null;
    return evaluateTrade(model, snapshot, { teamA, teamB, aGives: [...aGives], bGives: [...bGives] });
  }, [model, snapshot, teamA, teamB, aGives, bGives]);

  const myTeam = snapshot.teams.find((candidate) => candidate.rosterId === myRosterId);
  const profile = useMemo(
    () => (model && myTeam ? positionProfile(model, snapshot, rosterPlayers(myTeam).map((player) => player.id)) : []),
    [model, snapshot, myTeam],
  );

  if (!model || !situations || !myTeam) {
    return <p className="quiet">The trade analyzer opens once player stats have loaded.</p>;
  }

  const withGames = (candidate: Team) =>
    rosterPlayers(candidate)
      .flatMap((player) => model.players.get(player.id) ?? [])
      .filter((player) => player.games > 0)
      .sort((x, y) => y.expected - x.expected);
  const ready = goal === "best" || goal === "position" || (goal === "send" && sendId) || (goal === "get" && getId);

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
      goal === "position" ? { getPosition: position } : goal === "send" ? { givePlayerId: sendId } : goal === "get" ? { getPlayerId: getId } : {};
    const target =
      goal === "get" ? (model!.players.get(getId)?.name ?? null) : goal === "send" ? (model!.players.get(sendId)?.name ?? null) : null;
    setTimeout(() => {
      setFound({ ...findTrades(model!, snapshot, myRosterId, situations!, options), model: model!, target });
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
                <div className="card balance-card">
                  <Balance result={result} nameA={a.teamName} nameB={b.teamName} />
                </div>
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

      <h2 className="section-title ideas-title">Find a trade</h2>
      <div className="table-scroll shape">
        <table className="players-table">
          <caption className="quiet">
            Your roster by position. Need is the weekly points a typical starter would add in the slots reserved for that position. Cover is how
            much of your best player's value the rest of your roster would make up if he left.
          </caption>
          <thead>
            <tr>
              <th scope="col">Position</th>
              <th scope="col">Your best</th>
              <th scope="col" className="num">Need</th>
              <th scope="col" className="num">Cover</th>
            </tr>
          </thead>
          <tbody>
            {profile.map((note) => (
              <tr key={note.position}>
                <th scope="row">{note.position}</th>
                <td>{note.best ? <PlayerName player={note.best} /> : "Nobody"}</td>
                <td className="num">{formatPoints(note.need)}</td>
                <td className="num">{formatPoints(note.cover)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
      {found && (
        <p className={`finder-outlook${found.outlook === "likely" ? "" : " quiet"}`}>
          {found.outlook === "none" &&
            (goal === "best" || goal === "position"
              ? "No trade helps your team right now with a fair chance of being accepted."
              : `No offer could be built around ${found.target ?? "that player"} without costing you more than a point a week.`)}
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
                {idea.reasons.length > 0 && (
                  <ul className="idea-reasons quiet">
                    {idea.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
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
                    <dd>{whole(idea.result.a.strengthChange)}</dd>
                  </div>
                  <div>
                    <dt>Chance they accept</dt>
                    <dd>
                      {percent.format(idea.chance)} <span className={`likelihood likelihood-${idea.likelihood.replace(" ", "-")}`}>{idea.likelihood}</span>
                    </dd>
                  </div>
                </dl>
                <Balance result={idea.result} nameA="You" nameB="Them" compact />
              </div>
              <button type="button" className="button button-plain" onClick={() => load(idea)}>
                Open in builder
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="quiet legend explain">
        <p>
          Each manager's letter says how good the trade is for their own team over the rest of the season: A is a
          big win, B a win, C about even, D a loss, F a big loss. Both can get an A when a trade suits both teams.
          The slider shows which team gains more, from the change in projected weekly score, the same number
          behind team strength.
        </p>
        <p>
          Ideas likely to be accepted (50% or better) come first, ranked by the weekly points they add for you
          multiplied by that chance. Less likely ones are shown only when nothing likely exists, and long shots
          (under 40%) only when there is nothing better. When you name a player, offers that cost you up to a
          point a week are allowed, since that is sometimes the price of a move you want.
          That chance is an estimate, not a measurement: mostly how much the trade helps the other team, partly
          whether it looks fair on the averages they can see, and a little on how much pressure their team is
          under (long absences, a losing record, a tough matchup this week).
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
