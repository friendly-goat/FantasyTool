import { useCallback, useEffect, useMemo, useState } from "react";
import { teamSituations } from "../shared/insight.ts";
import { buildModel, leagueStrength } from "../shared/strength.ts";
import type { AppConfig, LeagueSnapshot, PlayerRef, StatsReport } from "../shared/types.ts";
import {
  getConfig,
  getLeague,
  getStats,
  loadMyRosterId,
  loadSavedLeagueId,
  saveLeagueId,
  saveMyRosterId,
} from "./api.ts";
import { Activity } from "./components/Activity.tsx";
import { LeaguePicker } from "./components/LeaguePicker.tsx";
import { Matchups } from "./components/Matchups.tsx";
import { MyTeam } from "./components/MyTeam.tsx";
import { OpenPlayerContext } from "./components/PlayerName.tsx";
import { PlayerPanel } from "./components/PlayerPanel.tsx";
import { Players } from "./components/Players.tsx";
import { Standings } from "./components/Standings.tsx";
import { StatsNotice } from "./components/StatsNotice.tsx";
import { Strength } from "./components/Strength.tsx";
import { TeamChooser } from "./components/TeamChooser.tsx";
import { Teams } from "./components/Teams.tsx";
import { Trades } from "./components/Trades.tsx";
import { formatAgo, formatDate } from "./format.ts";
import { useTheme } from "./theme.ts";

const VIEWS = ["My team", "Standings", "Strength", "Teams", "Players", "Matchups", "Trades", "Activity"] as const;
/** How often to ask the server for progress while stats are downloading. */
const STATS_POLL_MS = 2500;
const LAST_SEASON_POLL_MS = 20000;
type View = (typeof VIEWS)[number];

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<LeagueSnapshot | null>(null);
  const [stats, setStats] = useState<StatsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("My team");
  const [myRosterId, setMyRosterId] = useState<number | null>(null);
  const [choosingTeam, setChoosingTeam] = useState(false);
  /** Sleeper user ID from the league picker, used once to find the user's team. */
  const [pickedUserId, setPickedUserId] = useState<string | null>(null);
  const [openMatchupId, setOpenMatchupId] = useState<number | null>(null);
  const [selectedRosterId, setSelectedRosterId] = useState<number | null>(null);
  const [openPlayer, setOpenPlayer] = useState<PlayerRef | null>(null);
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    getConfig()
      .then((loaded) => {
        setConfig(loaded);
        setLeagueId(loaded.defaultLeagueId ?? loadSavedLeagueId());
      })
      .catch(() =>
        setError("The local server is not answering. Start it with npm run dev and reload."),
      );
  }, []);

  const load = useCallback(async (id: string, refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await getLeague(id, refresh));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The league could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (leagueId) void load(leagueId, false);
  }, [leagueId, load]);

  // Player stats load separately from the league, because the first
  // download of a season takes a minute or two. While it runs, the server
  // is asked for progress every few seconds.
  const loadedLeagueId = snapshot?.league.id ?? null;
  const loadStats = useCallback(async (id: string, retry = false) => {
    try {
      const next = await getStats(id, retry);
      // While a download runs, the server is asked for progress every few
      // seconds. Keep the same player data when nothing but progress changed,
      // so the model and anything built on it (like a trade search) stay put.
      setStats((previous) =>
        previous &&
        previous.status === next.status &&
        previous.syncedAt === next.syncedAt &&
        previous.lastSeason === next.lastSeason
          ? { ...next, players: previous.players, unmatchedRostered: previous.unmatchedRostered }
          : next,
      );
    } catch {
      // The league views still work without stats; the next poll or refresh tries again.
    }
  }, []);

  useEffect(() => {
    if (loadedLeagueId) void loadStats(loadedLeagueId);
  }, [loadedLeagueId, loadStats]);

  useEffect(() => {
    if (!loadedLeagueId || !stats) return;
    // Last season downloads after this one; check on it less often.
    const wait =
      stats.status === "syncing" ? STATS_POLL_MS : stats.status === "ready" && stats.lastSeason === "loading" ? LAST_SEASON_POLL_MS : 0;
    if (!wait) return;
    const timer = setTimeout(() => void loadStats(loadedLeagueId), wait);
    return () => clearTimeout(timer);
  }, [loadedLeagueId, stats, loadStats]);

  // Work out which team is the user's: the saved choice for this league, or
  // the team owned by the username they searched with.
  useEffect(() => {
    if (!snapshot) return;
    const known = (rosterId: number | null) =>
      rosterId !== null && snapshot.teams.some((team) => team.rosterId === rosterId);
    const saved = loadMyRosterId(snapshot.league.id);
    if (known(saved)) {
      setMyRosterId(saved);
      return;
    }
    const owned = snapshot.teams.find((team) => pickedUserId && team.ownerId === pickedUserId);
    if (owned) saveMyRosterId(snapshot.league.id, owned.rosterId);
    setMyRosterId(owned?.rosterId ?? null);
  }, [snapshot, pickedUserId]);

  // The strength model behind the Strength and Trades tabs. Rebuilt only
  // when the league or the stats change.
  const statsPlayers = stats?.players;
  const model = useMemo(
    () => (snapshot && stats && statsPlayers && Object.keys(statsPlayers).length > 0 ? buildModel(snapshot, stats) : null),
    // Rebuilt only when the league or the player data change, not on progress updates.
    [snapshot, statsPlayers],
  );
  const strengths = useMemo(
    () => (snapshot && model ? leagueStrength(snapshot, model) : null),
    [snapshot, model],
  );

  const situations = useMemo(
    () => (snapshot && model && strengths ? teamSituations(snapshot, model, strengths) : null),
    [snapshot, model, strengths],
  );

  function chooseTeam(rosterId: number) {
    if (snapshot) saveMyRosterId(snapshot.league.id, rosterId);
    setMyRosterId(rosterId);
    setChoosingTeam(false);
    setView("My team");
  }

  function openLeague(id: string, userId?: string) {
    saveLeagueId(id);
    setSnapshot(null);
    setStats(null);
    setMyRosterId(null);
    setPickedUserId(userId ?? null);
    setLeagueId(id);
  }

  function openMatchup(matchupId: number) {
    setOpenMatchupId(matchupId);
    setView("Matchups");
  }

  function switchLeague() {
    saveLeagueId(null);
    setSnapshot(null);
    setStats(null);
    setMyRosterId(null);
    setError(null);
    setLeagueId(null);
  }

  function openTeam(rosterId: number) {
    setSelectedRosterId(rosterId);
    setView("Teams");
  }


  if (!config) {
    return <main className="page">{error ? <p className="notice notice-error">{error}</p> : <p className="quiet">Loading…</p>}</main>;
  }

  if (!leagueId) {
    return (
      <main className="page">
        <LeaguePicker onOpen={openLeague} />
      </main>
    );
  }

  const canSwitch = !config.defaultLeagueId;
  const myTeam = snapshot?.teams.find((team) => team.rosterId === myRosterId);

  return (
    <main className="page">
      <header className="league-header">
        <div>
          <h1 className="league-name">{snapshot?.league.name ?? "Loading league…"}</h1>
          {snapshot && (
            <p className="quiet">
              {snapshot.league.season} season, week {snapshot.week}
            </p>
          )}
        </div>
        <div className="league-actions">
          {snapshot && (
            <span className="quiet" title={formatDate(snapshot.fetchedAt)}>
              Updated {formatAgo(snapshot.fetchedAt)}
            </span>
          )}
          <button
            type="button"
            className="button"
            disabled={loading}
            onClick={() => void load(leagueId, true)}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          {canSwitch && (
            <button type="button" className="button button-plain" onClick={switchLeague}>
              Switch league
            </button>
          )}
          <button type="button" className="button button-plain" onClick={toggleTheme}>
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
        </div>
      </header>

      {config.mock && (
        <p className="notice">
          This is sample data. Stop the server and run <code>npm run dev</code> to load your league.
        </p>
      )}
      {snapshot?.stale && (
        <p className="notice notice-warn">
          Sleeper could not be reached. Showing data from {formatDate(snapshot.fetchedAt)}.
        </p>
      )}
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
          {canSwitch && !snapshot && " Check the league ID, or switch to another league."}
        </p>
      )}

      {snapshot && (myRosterId === null || choosingTeam) && (
        <TeamChooser snapshot={snapshot} onChoose={chooseTeam} />
      )}

      {snapshot && myTeam && !choosingTeam && (
        <OpenPlayerContext.Provider value={setOpenPlayer}>
          <nav className="tabs" aria-label="League views">
            {VIEWS.map((name) => (
              <button
                key={name}
                type="button"
                className="tab"
                aria-current={view === name ? "page" : undefined}
                onClick={() => {
                  setView(name);
                  setOpenMatchupId(null); // the Matchups tab opens on the list
                }}
              >
                {name}
              </button>
            ))}
          </nav>

          {(view === "My team" || view === "Teams" || view === "Players" || view === "Strength" || view === "Trades") &&
            stats &&
            (stats.status !== "ready" || view === "My team" || view === "Teams" || view === "Players") && (
            <StatsNotice stats={stats} onRetry={() => void loadStats(snapshot.league.id, true)} />
          )}

          {view === "My team" && (
            <MyTeam
              snapshot={snapshot}
              stats={stats}
              model={model}
              strengths={strengths}
              team={myTeam}
              onChangeTeam={() => setChoosingTeam(true)}
              onOpenMatchup={openMatchup}
            />
          )}
          {view === "Standings" && (
            <Standings snapshot={snapshot} myRosterId={myRosterId} onOpenTeam={openTeam} />
          )}
          {view === "Strength" && (
            <Strength snapshot={snapshot} strengths={strengths} myRosterId={myRosterId} onOpenTeam={openTeam} />
          )}
          {/* Kept mounted while hidden, so a trade in progress survives switching tabs. */}
          <div hidden={view !== "Trades"}>
            <Trades
              key={myTeam.rosterId}
              snapshot={snapshot}
              model={model}
              situations={situations}
              myRosterId={myTeam.rosterId}
            />
          </div>
          {view === "Teams" && (
            <Teams
              snapshot={snapshot}
              stats={stats}
              myRosterId={myRosterId}
              selectedRosterId={selectedRosterId}
              onSelect={setSelectedRosterId}
            />
          )}
          {view === "Players" && <Players snapshot={snapshot} stats={stats} />}
          {view === "Matchups" && (
            <Matchups
              snapshot={snapshot}
              stats={stats}
              myRosterId={myRosterId}
              openMatchupId={openMatchupId}
              onOpenMatchup={setOpenMatchupId}
              onOpenTeam={openTeam}
            />
          )}
          {view === "Activity" && <Activity snapshot={snapshot} />}

          {openPlayer && (
            <PlayerPanel
              key={openPlayer.id}
              snapshot={snapshot}
              stats={stats}
              player={openPlayer}
              onClose={() => setOpenPlayer(null)}
            />
          )}
        </OpenPlayerContext.Provider>
      )}
    </main>
  );
}
