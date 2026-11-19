import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { teamSituations } from "../shared/insight.ts";
import { buildModel, leagueStrength } from "../shared/strength.ts";
import { registerModel } from "./search.ts";
import type { TradeOffer } from "../shared/trade.ts";
import type { AppConfig, LeagueSnapshot, PlayerRef, StatsReport } from "../shared/types.ts";
import {
  getConfig,
  getLeague,
  getStats,
  loadMyRosterId,
  loadSavedLeagueId,
  saveLeagueId,
  saveMyRosterId,
  getSession,
  type Session,
  SIGNED_OUT_EVENT,
  signOut,
} from "./api.ts";
import { Activity } from "./components/Activity.tsx";
import { SignIn } from "./components/SignIn.tsx";
import { Draft } from "./components/Draft.tsx";
import { LeaguePicker } from "./components/LeaguePicker.tsx";
import { Matchups } from "./components/Matchups.tsx";
import { MyTeam } from "./components/MyTeam.tsx";
import { OpenPlayerContext } from "./components/PlayerName.tsx";
import { PlayerPanel } from "./components/PlayerPanel.tsx";
import { Players } from "./components/Players.tsx";
import { StatsNotice } from "./components/StatsNotice.tsx";
import { type RankingMode, Rankings } from "./components/Rankings.tsx";
import { AccountMenu } from "./components/AccountMenu.tsx";
import { MobileNav, ViewIcon } from "./components/MobileNav.tsx";
import { TeamChooser } from "./components/TeamChooser.tsx";
import { Teams } from "./components/Teams.tsx";
import { Trades } from "./components/Trades.tsx";
import { formatAgo, formatDate } from "./format.ts";
import { useTheme } from "./theme.ts";

// My team and Trades are the heart of the app and lead the desktop bar, set apart.
// Matchups is kept but hidden from the navigation for now: Sleeper's own matchup screen is
// better until ours catches up. Take it out of HIDDEN_VIEWS to bring it back.
const VIEWS = ["My team", "Trades", "Rankings", "Draft", "Teams", "Players", "Activity", "Matchups"] as const;
const HIDDEN_VIEWS: readonly View[] = ["Matchups"];
const NAV_VIEWS = VIEWS.filter((name) => !HIDDEN_VIEWS.includes(name));
const CORE_VIEWS: readonly View[] = ["My team", "Trades"];
/** How often to ask the server for the league while the page is open. It decides whether Sleeper is asked. */
const LEAGUE_POLL_MS = 2 * 60_000;
/** How soon to ask again when the server answered with saved data while fetching newer data. */
const REFRESHING_RECHECK_MS = 5_000;
/** How often to ask the server for progress while stats are downloading. */
const STATS_POLL_MS = 2500;
const LAST_SEASON_POLL_MS = 20000;
type View = (typeof VIEWS)[number];
// On a phone, the tab bar holds these (Trades in the middle, set apart); the rest sit under More.
const PHONE_TABS = ["My team", "Rankings", "Trades", "Draft"] as const satisfies readonly View[];
const PHONE_MORE = NAV_VIEWS.filter((name) => !(PHONE_TABS as readonly View[]).includes(name));

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<LeagueSnapshot | null>(null);
  const [stats, setStats] = useState<StatsReport | null>(null);
  const [live, setLive] = useState(false);
  // Ticks every minute so "Updated 3 minutes ago" stays true.
  const [, setClock] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("My team");
  const [myRosterId, setMyRosterId] = useState<number | null>(null);
  const [choosingTeam, setChoosingTeam] = useState(false);
  /** Sleeper user ID from the league picker, used once to find the user's team. */
  const [pickedUserId, setPickedUserId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [openMatchupId, setOpenMatchupId] = useState<number | null>(null);
  const [rankingMode, setRankingMode] = useState<RankingMode>("standings");
  // A trade sent from another tab to the builder; `at` tells a repeat apart.
  const [builderOffer, setBuilderOffer] = useState<{ offer: TradeOffer; at: number } | null>(null);
  const [selectedRosterId, setSelectedRosterId] = useState<number | null>(null);
  const [openPlayer, setOpenPlayer] = useState<PlayerRef | null>(null);
  const { theme, toggleTheme } = useTheme();
  const [session, setSession] = useState<Session | null>(null);

  // Who is signed in comes first: without a sign-in the server answers nothing else.
  useEffect(() => {
    getSession()
      .then(setSession)
      .catch(() => setError("The server is not answering. Start it with npm run dev and reload."));
    const signedOut = () => setSession((current) => (current ? { ...current, role: null } : current));
    window.addEventListener(SIGNED_OUT_EVENT, signedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, signedOut);
  }, []);
  const signedIn = !!session && (!session.authRequired || session.role !== null);

  useEffect(() => {
    if (!signedIn) return;
    getConfig()
      .then((loaded) => {
        setConfig(loaded);
        setLeagueId(loaded.defaultLeagueId ?? loadSavedLeagueId());
      })
      .catch(() => setError("The local server is not answering. Start it with npm run dev and reload."));
  }, [signedIn]);

  const load = useCallback(async (id: string): Promise<LeagueSnapshot | null> => {
    try {
      const next = await getLeague(id);
      // Only newer data replaces the snapshot, so the team model is not rebuilt
      // (and a trade search not reset) every time the page checks in.
      setSnapshot((current) =>
        current && current.league.id === next.league.id && current.fetchedAt === next.fetchedAt ? current : next,
      );
      setLive(next.live === true);
      setError(null);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The league could not be loaded.");
      return null;
    }
  }, []);

  // The server keeps league data fresh by itself (more often while games are
  // on). The page checks in every couple of minutes while it is visible, and
  // again shortly after the server says a newer copy is on its way.
  useEffect(() => {
    if (!leagueId) return;
    let cancelled = false;
    let recheck: number | undefined;
    const run = async () => {
      const next = await load(leagueId);
      if (cancelled) return;
      window.clearTimeout(recheck);
      if (next?.refreshing) recheck = window.setTimeout(() => void run(), REFRESHING_RECHECK_MS);
    };
    void run();
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, LEAGUE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    const clock = window.setInterval(() => setClock((tick) => tick + 1), 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(recheck);
      window.clearInterval(poll);
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
    };
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
      stats.status === "syncing"
        ? STATS_POLL_MS
        : stats.status === "ready" && stats.lastSeason === "loading"
          ? LAST_SEASON_POLL_MS
          : 0;
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
    () =>
      {
        if (!snapshot || !stats || !statsPlayers || Object.keys(statsPlayers).length === 0) return null;
        const built = buildModel(snapshot, stats);
        // So the trade search can build the same model off the page's thread.
        registerModel(built, snapshot, stats);
        return built;
      },
    // Rebuilt only when the league or the player data change, not on progress updates.
    [snapshot, statsPlayers],
  );
  const strengths = useMemo(() => (snapshot && model ? leagueStrength(snapshot, model) : null), [snapshot, model]);

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

  function openTrade(offer: TradeOffer) {
    setBuilderOffer({ offer, at: Date.now() });
    setView("Trades");
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

  if (session && !signedIn) {
    return <SignIn onSignedIn={(role) => setSession({ authRequired: true, role })} />;
  }

  if (!config) {
    return (
      <main className="page">
        {error ? <p className="notice notice-error">{error}</p> : <p className="quiet">Loading…</p>}
      </main>
    );
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
  const selectView = (name: View) => {
    setView(name);
    setOpenMatchupId(null); // the Matchups tab opens on the list
  };
  const signOutNow = () => {
    void signOut().then(() => setSession({ authRequired: true, role: null }));
  };
  // Settings: in the account menu on a wide screen, the More sheet on a phone.
  const settingsItems = [
    { label: theme === "dark" ? "Light mode" : "Dark mode", onSelect: toggleTheme },
    ...(canSwitch ? [{ label: "Switch league", onSelect: switchLeague }] : []),
    ...(myTeam ? [{ label: "Change my team", onSelect: () => setChoosingTeam(true) }] : []),
    ...(session?.authRequired
      ? [{ label: `Sign out${session.role === "admin" ? " (admin)" : ""}`, onSelect: signOutNow }]
      : []),
  ];

  const showNav = Boolean(snapshot && myTeam && !choosingTeam);
  const accountNote = session?.authRequired
    ? `${myTeam?.managerName ?? "Signed in"}, ${session.role === "admin" ? "admin" : "viewer"}`
    : undefined;

  return (
    <>
      <header className="app-bar">
        <div className="app-bar-inner">
          <div className="brand">
            <h1 className="brand-name">Fantasy Tool</h1>
            {snapshot && (
              <p className="quiet brand-sub">
                {snapshot.league.season} season, week {snapshot.week}
              </p>
            )}
          </div>
          {showNav && (
            <nav className="app-nav" aria-label="League views">
              {NAV_VIEWS.map((name, index) => {
                const core = CORE_VIEWS.includes(name);
                const previous = index > 0 ? NAV_VIEWS[index - 1] : undefined;
                return (
                  <Fragment key={name}>
                    {previous && core !== CORE_VIEWS.includes(previous) && (
                      <span className="app-nav-divider" aria-hidden="true" />
                    )}
                    <button
                      type="button"
                      className={core ? "app-nav-item app-nav-core" : "app-nav-item"}
                      data-view={name}
                      aria-current={view === name ? "page" : undefined}
                      onClick={(event) => {
                        event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
                        selectView(name);
                      }}
                    >
                      {core && <ViewIcon name={name} size={18} />}
                      {name}
                    </button>
                  </Fragment>
                );
              })}
            </nav>
          )}
          <div className="app-bar-status">
            {live && (
              <span className="live-pill" title="NBA games are on, so league data updates every couple of minutes">
                <span className="live-dot" aria-hidden="true" />
                Games on
              </span>
            )}
            {snapshot && (
              <span
                className="quiet updated"
                title={`From Sleeper ${formatDate(snapshot.fetchedAt)}. Updates on its own.`}
              >
                Updated {formatAgo(snapshot.fetchedAt)}
              </span>
            )}
          </div>
          {/* On a phone these settings sit in the More sheet (MobileNav) instead. */}
          <AccountMenu team={showNav ? myTeam : undefined} note={accountNote} items={settingsItems} />
        </div>
      </header>

      <main className="page">
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

        {snapshot && (myRosterId === null || choosingTeam) && <TeamChooser snapshot={snapshot} onChoose={chooseTeam} />}

        {snapshot && myTeam && !choosingTeam && (
          <OpenPlayerContext.Provider value={setOpenPlayer}>
            <MobileNav
              primary={PHONE_TABS}
              featured="Trades"
              more={PHONE_MORE}
              view={view}
              onSelect={(name) => {
                selectView(name);
                window.scrollTo({ top: 0 });
              }}
              settings={settingsItems}
              open={moreOpen}
              onOpenChange={setMoreOpen}
            />

            {(view === "My team" ||
              view === "Teams" ||
              view === "Players" ||
              (view === "Rankings" && rankingMode === "strength") ||
              view === "Trades") &&
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
                situations={situations}
                onOpenTrade={openTrade}
              />
            )}
            {view === "Rankings" && (
              <Rankings
                mode={rankingMode}
                onModeChange={setRankingMode}
                snapshot={snapshot}
                strengths={strengths}
                myRosterId={myRosterId}
                onOpenTeam={openTeam}
              />
            )}
            {/* Kept mounted while hidden, so a trade in progress survives switching tabs. */}
            <div hidden={view !== "Trades"}>
              <Trades
                key={myTeam.rosterId}
                snapshot={snapshot}
                model={model}
                situations={situations}
                myRosterId={myTeam.rosterId}
                incoming={builderOffer}
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
                model={model}
                canMarkLocks={session?.role === "admin" || session?.authRequired === false}
                myRosterId={myRosterId}
                openMatchupId={openMatchupId}
                onOpenMatchup={setOpenMatchupId}
                onOpenTeam={openTeam}
              />
            )}
            {view === "Draft" && (
              <Draft leagueId={snapshot.league.id} snapshot={snapshot} model={model} myRosterId={myTeam.rosterId} />
            )}
            {view === "Activity" && <Activity snapshot={snapshot} model={model} myRosterId={myRosterId} />}

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
    </>
  );
}
