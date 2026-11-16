import { useCallback, useEffect, useState } from "react";
import type { AppConfig, LeagueSnapshot, PlayerRef, StatsReport } from "../shared/types.ts";
import { getConfig, getLeague, getStats, loadSavedLeagueId, saveLeagueId } from "./api.ts";
import { Activity } from "./components/Activity.tsx";
import { LeaguePicker } from "./components/LeaguePicker.tsx";
import { Matchups } from "./components/Matchups.tsx";
import { OpenPlayerContext } from "./components/PlayerName.tsx";
import { PlayerPanel } from "./components/PlayerPanel.tsx";
import { Players } from "./components/Players.tsx";
import { Standings } from "./components/Standings.tsx";
import { StatsNotice } from "./components/StatsNotice.tsx";
import { Teams } from "./components/Teams.tsx";
import { formatAgo, formatDate } from "./format.ts";
import { useTheme } from "./theme.ts";

const VIEWS = ["Standings", "Teams", "Players", "Matchups", "Activity"] as const;
/** How often to ask the server for progress while stats are downloading. */
const STATS_POLL_MS = 2500;
type View = (typeof VIEWS)[number];

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<LeagueSnapshot | null>(null);
  const [stats, setStats] = useState<StatsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("Standings");
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
      setStats(await getStats(id, retry));
    } catch {
      // The league views still work without stats; the next poll or refresh tries again.
    }
  }, []);

  useEffect(() => {
    if (loadedLeagueId) void loadStats(loadedLeagueId);
  }, [loadedLeagueId, loadStats]);

  useEffect(() => {
    if (!loadedLeagueId || stats?.status !== "syncing") return;
    const timer = setTimeout(() => void loadStats(loadedLeagueId), STATS_POLL_MS);
    return () => clearTimeout(timer);
  }, [loadedLeagueId, stats, loadStats]);

  function openLeague(id: string) {
    saveLeagueId(id);
    setSnapshot(null);
    setStats(null);
    setLeagueId(id);
  }

  function switchLeague() {
    saveLeagueId(null);
    setSnapshot(null);
    setStats(null);
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

      {snapshot && (
        <OpenPlayerContext.Provider value={setOpenPlayer}>
          <nav className="tabs" aria-label="League views">
            {VIEWS.map((name) => (
              <button
                key={name}
                type="button"
                className="tab"
                aria-current={view === name ? "page" : undefined}
                onClick={() => setView(name)}
              >
                {name}
              </button>
            ))}
          </nav>

          {(view === "Teams" || view === "Players") && stats && (
            <StatsNotice stats={stats} onRetry={() => void loadStats(snapshot.league.id, true)} />
          )}

          {view === "Standings" && <Standings snapshot={snapshot} onOpenTeam={openTeam} />}
          {view === "Teams" && (
            <Teams
              snapshot={snapshot}
              stats={stats}
              selectedRosterId={selectedRosterId}
              onSelect={setSelectedRosterId}
            />
          )}
          {view === "Players" && <Players snapshot={snapshot} stats={stats} />}
          {view === "Matchups" && <Matchups snapshot={snapshot} stats={stats} onOpenTeam={openTeam} />}
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
