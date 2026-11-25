import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { teamSituations } from "../shared/insight.ts";
import { buildModel, leagueStrength } from "../shared/strength.ts";
import { registerModel } from "./search.ts";
import { loadScheduleAhead, loadedScheduleAhead } from "./scheduleAhead.ts";
import { modelFingerprint } from "./modelInputs.ts";
import { clearSaved, readSaved, savedKeys, writeSaved } from "./saved.ts";
import type { TradeOffer } from "../shared/trade.ts";
import type { AppConfig, LeagueSnapshot, PlayerRef, ScheduleAhead, StatsReport } from "../shared/types.ts";
import {
  getConfig,
  getDraft,
  getLeague,
  getStats,
  loadMyRosterId,
  loadSavedLeagueId,
  saveLeagueId,
  saveMyRosterId,
  getSession,
  OfflineError,
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
import { TeamPanel } from "./components/TeamPanel.tsx";
import { OpenTeamContext } from "./components/TeamName.tsx";
import { PlayerPanel } from "./components/PlayerPanel.tsx";
import { Players } from "./components/Players.tsx";
import { StatsNotice } from "./components/StatsNotice.tsx";
import { type RankingMode, Rankings } from "./components/Rankings.tsx";
import { AccountMenu } from "./components/AccountMenu.tsx";
import { MobileNav, ViewIcon } from "./components/MobileNav.tsx";
import { TeamChooser } from "./components/TeamChooser.tsx";
import { LineupPlan } from "./components/LineupPlan.tsx";
import { Teams } from "./components/Teams.tsx";
import { Trades } from "./components/Trades.tsx";
import { formatAgo, formatDate } from "./format.ts";
import { useTheme } from "./theme.ts";
import { useBackToClose } from "./sheetGestures.ts";

// My team and Trades are the heart of the app and lead the desktop bar, set apart.
// Matchups is kept but hidden from the navigation for now: Sleeper's own matchup screen is
// better until ours catches up. Take it out of HIDDEN_VIEWS to bring it back.
// Lineup plan is experimental and shown to the admin only, last on the desktop bar and in More.
const VIEWS = ["My team", "Trades", "Rankings", "Draft", "Teams", "Players", "Activity", "Matchups", "Lineup plan"] as const;
const HIDDEN_VIEWS: readonly View[] = ["Matchups"];
const ADMIN_VIEWS: readonly View[] = ["Lineup plan"];
const NAV_VIEWS = VIEWS.filter((name) => !HIDDEN_VIEWS.includes(name) && !ADMIN_VIEWS.includes(name));
const CORE_VIEWS: readonly View[] = ["My team", "Trades"];
/** How often to ask the server for the league while the page is open. It answers from memory and decides whether Sleeper is asked. */
const LEAGUE_POLL_MS = 60_000;
/** How soon to ask again when the server answered with saved data while fetching newer data. */
const REFRESHING_RECHECK_MS = 5_000;
/** How often to ask the server for progress while stats are downloading. */
const STATS_POLL_MS = 2500;
/** How long the model waits for the NBA schedule before playing made-up weeks (when none is saved). */
const SCHEDULE_WAIT_MS = 6000;
/** The longest a trade search waits for this visit's data before running on what it has. */
const SETTLE_MAX_MS = 15_000;
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
  /** The server could not be reached on the last try; saved data is on screen. */
  const [offline, setOffline] = useState(false);
  const [view, setView] = useState<View>("My team");
  // Where a team was opened from (Standings, Team strength, Matchups), for the Teams page's Back
  // button: that view, its name, and how far down it was scrolled.
  const [cameFrom, setCameFrom] = useState<{ view: View; label: string; scroll: number } | null>(null);
  const returnScroll = useRef<number | null>(null);
  const goBack = () => {
    if (!cameFrom) return;
    returnScroll.current = cameFrom.scroll;
    setView(cameFrom.view);
    setCameFrom(null);
  };
  // The phone's back gesture (or the browser's Back) goes back the same way.
  useBackToClose(cameFrom !== null && view === "Teams", goBack);
  // Back lands where the page was left.
  useLayoutEffect(() => {
    if (returnScroll.current === null) return;
    window.scrollTo({ top: returnScroll.current, behavior: "instant" });
    returnScroll.current = null;
  }, [view]);
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
  // A fantasy team's card, opened from its name in the trade area (TeamName).
  const [openTeamCard, setOpenTeamCard] = useState<number | null>(null);
  const { theme, toggleTheme } = useTheme();
  const [session, setSession] = useState<Session | null>(null);

  // The app opens on what this browser saved last time (src/saved.ts): the sign-in, the settings
  // and the league's data, so it shows straight away, even while the server wakes up. The server
  // is asked for all of it at once, and its answers replace the saved copies. Without a sign-in
  // the server answers nothing else and the sign-in screen shows.
  useEffect(() => {
    let current = true;
    void Promise.all([readSaved<Session>(savedKeys.session), readSaved<AppConfig>(savedKeys.config)]).then(([savedSession, savedConfig]) => {
      if (!current || !savedSession || !savedConfig) return;
      if (savedSession.authRequired && savedSession.role === null) return;
      setSession((known) => known ?? savedSession);
      setConfig((known) => known ?? savedConfig);
      setLeagueId((known) => known ?? savedConfig.defaultLeagueId ?? loadSavedLeagueId());
    });
    getSession()
      .then((loaded) => {
        setSession(loaded);
        void writeSaved(savedKeys.session, loaded);
      })
      .catch(() => {
        // With saved data on screen, a server that is not answering is shown by its age.
        if (!sessionRef.current) setError("The server is not answering. Check your connection and reload.");
      });
    const signedOut = () => {
      void clearSaved();
      setSession((known) => (known ? { ...known, role: null } : { authRequired: true, role: null }));
    };
    window.addEventListener(SIGNED_OUT_EVENT, signedOut);
    return () => {
      current = false;
      window.removeEventListener(SIGNED_OUT_EVENT, signedOut);
    };
  }, []);
  const signedIn = !!session && (!session.authRequired || session.role !== null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    if (!signedIn) return;
    getConfig()
      .then((loaded) => {
        setConfig(loaded);
        void writeSaved(savedKeys.config, loaded);
        setLeagueId((known) => loaded.defaultLeagueId ?? known ?? loadSavedLeagueId());
      })
      .catch(() => {
        if (!configRef.current) setError("The server is not answering. Check your connection and reload.");
      });
  }, [signedIn]);

  // Whether this visit's own answers are in (not just saved copies): the league, the stats it
  // points to, and the schedule. A trade search waits for them (a few seconds at most), so its
  // ideas are not overtaken a moment later.
  const [leagueFetched, setLeagueFetched] = useState(false);
  const [scheduleFetched, setScheduleFetched] = useState(false);
  const [latestStatsVersion, setLatestStatsVersion] = useState<string | null | undefined>(undefined);
  const [settleTimedOut, setSettleTimedOut] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettleTimedOut(true), SETTLE_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [leagueId]);

  const load = useCallback(async (id: string): Promise<LeagueSnapshot | null> => {
    try {
      const next = await getLeague(id);
      // Only newer data replaces the snapshot; the model is rebuilt only if what it reads changed.
      setSnapshot((current) =>
        current && current.league.id === next.league.id && current.fetchedAt === next.fetchedAt ? current : next,
      );
      setLive(next.live === true);
      setLatestStatsVersion(next.statsVersion ?? null);
      if (!next.refreshing) setLeagueFetched(true);
      setError(null);
      setOffline(false);
      void writeSaved(savedKeys.league(id), next);
      return next;
    } catch (cause) {
      if (cause instanceof OfflineError) setOffline(true);
      else setError(cause instanceof Error ? cause.message : "The league could not be loaded.");
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
    // The saved copy shows while the server answers.
    void readSaved<LeagueSnapshot>(savedKeys.league(leagueId)).then((saved) => {
      if (!cancelled && saved) setSnapshot((current) => current ?? saved);
    });
    void readSaved<StatsReport>(savedKeys.stats(leagueId)).then((saved) => {
      if (!cancelled && saved) setStats((current) => current ?? saved);
    });
    let rechecks = 0;
    const run = async () => {
      const next = await load(leagueId);
      if (cancelled) return;
      window.clearTimeout(recheck);
      if (next?.refreshing && rechecks < 3) {
        rechecks += 1;
        recheck = window.setTimeout(() => void run(), REFRESHING_RECHECK_MS);
      } else if (next) {
        // Still refreshing after a few checks: what the server has is what there is for now.
        setLeagueFetched(true);
      }
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
      // Keep the same player data when its version (or, without one, the sync) is unchanged, so
      // the model and anything built on it (like a trade search) stay put.
      setStats((previous) => {
        const same =
          previous &&
          (previous.version && next.version
            ? previous.version === next.version
            : previous.status === next.status && previous.syncedAt === next.syncedAt && previous.lastSeason === next.lastSeason);
        return same ? { ...next, players: previous.players, unmatchedRostered: previous.unmatchedRostered, allowed: previous.allowed } : next;
      });
      if (next.status === "ready" && Object.keys(next.players).length > 0) void writeSaved(savedKeys.stats(id), next);
    } catch {
      // The league views still work without stats; the next poll or refresh tries again.
    }
  }, []);

  // Stats are asked for when this visit's league answer points to a version the page does not
  // have (or none is known), not on every check-in: the report is the biggest download.
  const statsVersion = stats?.version;
  const askedForVersion = useRef<string | null | undefined>(undefined);
  const [answeredVersion, setAnsweredVersion] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!loadedLeagueId || !leagueFetched) return;
    if (latestStatsVersion && statsVersion === latestStatsVersion) return;
    // Asked once per version the league points to (the answer may already be a step newer).
    const wanted = latestStatsVersion ?? null;
    if (askedForVersion.current === wanted) return;
    askedForVersion.current = wanted;
    void loadStats(loadedLeagueId).then(() => setAnsweredVersion(wanted));
  }, [loadedLeagueId, leagueFetched, latestStatsVersion, statsVersion, loadStats]);

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

  // The NBA schedule the model plays its weeks on. The model waits for it a few seconds at most:
  // without it (still loading on the server, or no schedule) it plays made-up weeks, and is
  // rebuilt once if the schedule arrives later.
  const scheduleWeek = snapshot?.week ?? 0;
  const [schedule, setSchedule] = useState<ScheduleAhead | null | undefined>(undefined);
  useEffect(() => {
    if (!loadedLeagueId) return;
    const ready = loadedScheduleAhead(loadedLeagueId, scheduleWeek);
    if (ready) {
      setSchedule(ready);
      setScheduleFetched(true);
      return;
    }
    setSchedule(undefined);
    let live = true;
    const key = savedKeys.schedule(loadedLeagueId, scheduleWeek);
    // A saved schedule is used straight away; the server's replaces it only if it differs.
    void readSaved<ScheduleAhead>(key).then((saved) => {
      if (live && saved) setSchedule((current) => (current === undefined ? saved : current));
    });
    const timer = window.setTimeout(() => live && setSchedule((current) => (current === undefined ? null : current)), SCHEDULE_WAIT_MS);
    void loadScheduleAhead(loadedLeagueId, scheduleWeek).then((loaded) => {
      if (!live) return;
      setScheduleFetched(true);
      if (loaded) {
        setSchedule((current) => (current && JSON.stringify(current) === JSON.stringify(loaded) ? current : loaded));
        if (loaded.status === "ready") void writeSaved(key, loaded);
      } else setSchedule((current) => (current === undefined ? null : current));
    });
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [loadedLeagueId, scheduleWeek]);

  // The snapshot the model is built from: replaced only when something the model reads changes
  // (src/modelInputs.ts), not on every refresh of live points, so the model, the top moves and a
  // trade search in progress are not redone for nothing.
  const modelInputs = useRef<{ fingerprint: string; snapshot: LeagueSnapshot } | null>(null);
  const modelSnapshot = useMemo(() => {
    if (!snapshot) return null;
    const fingerprint = modelFingerprint(snapshot);
    if (modelInputs.current?.fingerprint === fingerprint) return modelInputs.current.snapshot;
    modelInputs.current = { fingerprint, snapshot };
    return snapshot;
  }, [snapshot]);

  // The strength model behind the Strength and Trades tabs. Rebuilt only when the league's
  // model inputs, the player data or the schedule change.
  const statsPlayers = stats?.players;
  const model = useMemo(
    () =>
      {
        if (!modelSnapshot || !stats || !statsPlayers || Object.keys(statsPlayers).length === 0 || schedule === undefined) return null;
        const built = buildModel(modelSnapshot, stats, undefined, schedule);
        // So the trade search can build the same model off the page's thread.
        registerModel(built, modelSnapshot, stats, schedule);
        return built;
      },
    // Rebuilt only when the league, the player data or the schedule change, not on progress updates.
    [modelSnapshot, statsPlayers, schedule],
  );
  const strengths = useMemo(() => (modelSnapshot && model ? leagueStrength(modelSnapshot, model) : null), [modelSnapshot, model]);

  const situations = useMemo(
    () => (modelSnapshot && model && strengths ? teamSituations(modelSnapshot, model, strengths) : null),
    [modelSnapshot, model, strengths],
  );

  const statsCurrent =
    !!stats &&
    stats.status !== "syncing" &&
    (stats.status === "unconfigured" ||
      stats.version === latestStatsVersion ||
      (answeredVersion !== undefined && answeredVersion === (latestStatsVersion ?? null)));
  const settled = settleTimedOut || (leagueFetched && scheduleFetched && statsCurrent);

  // Once the visit's data is in, the draft board is fetched quietly too, so its tab opens at once.
  useEffect(() => {
    if (!settled || !loadedLeagueId) return;
    const id = loadedLeagueId;
    const timer = window.setTimeout(() => {
      getDraft(id)
        .then((result) => writeSaved(savedKeys.draft(id), result.board))
        .catch(() => {});
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [settled, loadedLeagueId]);

  function chooseTeam(rosterId: number) {
    if (snapshot) saveMyRosterId(snapshot.league.id, rosterId);
    setMyRosterId(rosterId);
    setChoosingTeam(false);
    setView("My team");
  }

  function resetData() {
    setSnapshot(null);
    setStats(null);
    setLeagueFetched(false);
    setScheduleFetched(false);
    setLatestStatsVersion(undefined);
    setSettleTimedOut(false);
    askedForVersion.current = undefined;
    setAnsweredVersion(undefined);
  }

  function openLeague(id: string, userId?: string) {
    saveLeagueId(id);
    resetData();
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
    void clearSaved();
    resetData();
    setMyRosterId(null);
    setError(null);
    setLeagueId(null);
  }

  function openTeam(rosterId: number) {
    if (view !== "Teams") {
      const label = view === "Rankings" ? (rankingMode === "strength" ? "Team strength" : "Standings") : view;
      setCameFrom({ view, label, scroll: window.scrollY });
    }
    setSelectedRosterId(rosterId);
    setView("Teams");
    window.scrollTo({ top: 0, behavior: "instant" });
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
    setCameFrom(null); // a tab starts fresh: no way back to where a team was opened from
    setOpenMatchupId(null); // the Matchups tab opens on the list
  };
  const signOutNow = () => {
    void clearSaved();
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
  // The admin (or anyone when running without passwords) also sees the experimental views.
  const isAdmin = session?.role === "admin" || session?.authRequired === false;
  const navViews: readonly View[] = isAdmin ? [...NAV_VIEWS, ...ADMIN_VIEWS] : NAV_VIEWS;
  const phoneMore: readonly View[] = isAdmin ? [...PHONE_MORE, ...ADMIN_VIEWS] : PHONE_MORE;
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
              {navViews.map((name, index) => {
                const core = CORE_VIEWS.includes(name);
                const previous = index > 0 ? navViews[index - 1] : undefined;
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
        {offline && snapshot && (
          <p className="notice notice-warn" role="status">
            Can't reach the server right now. Showing data saved {formatAgo(snapshot.fetchedAt)}; it updates on its own when
            the connection is back.
          </p>
        )}
        {offline && !snapshot && (
          <p className="notice notice-error" role="alert">
            Can't reach the server. Check your connection; the app tries again on its own.
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
          <OpenTeamContext.Provider value={setOpenTeamCard}>
            <MobileNav
              primary={PHONE_TABS}
              featured="Trades"
              more={phoneMore}
              view={view}
              onSelect={(name) => {
                // Tapping the tab you are on scrolls back to the top, as on an iPhone.
                window.scrollTo({ top: 0, behavior: name === view ? "smooth" : "auto" });
                selectView(name);
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
                snapshot={modelSnapshot ?? snapshot}
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
                snapshot={modelSnapshot ?? snapshot}
                strengths={strengths}
                model={model}
                stats={stats}
                myRosterId={myRosterId}
                onOpenTeam={openTeam}
              />
            )}
            {/* Kept mounted while hidden, so a trade in progress survives switching tabs. */}
            <div hidden={view !== "Trades"}>
              <Trades
                key={myTeam.rosterId}
                snapshot={modelSnapshot ?? snapshot}
                model={model}
                settled={settled}
                situations={situations}
                myRosterId={myTeam.rosterId}
                incoming={builderOffer}
              />
            </div>
            {view === "Teams" && (
              <Teams
                snapshot={snapshot}
                modelSnapshot={modelSnapshot ?? snapshot}
                model={model}
                strengths={strengths}
                stats={stats}
                myRosterId={myRosterId}
                selectedRosterId={selectedRosterId}
                onSelect={setSelectedRosterId}
                back={cameFrom ? { label: cameFrom.label, onBack: goBack } : null}
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
              <Draft leagueId={snapshot.league.id} snapshot={modelSnapshot ?? snapshot} model={model} myRosterId={myTeam.rosterId} />
            )}
            {view === "Activity" && <Activity snapshot={snapshot} model={model} myRosterId={myRosterId} />}
            {view === "Lineup plan" && isAdmin && (
              <LineupPlan snapshot={modelSnapshot ?? snapshot} model={model} myRosterId={myTeam.rosterId} canMark={isAdmin} />
            )}

            {openPlayer && (
              <PlayerPanel
                key={openPlayer.id}
                snapshot={snapshot}
                stats={stats}
                player={openPlayer}
                onClose={() => setOpenPlayer(null)}
              />
            )}
            {openTeamCard !== null && (
              <TeamPanel
                key={openTeamCard}
                snapshot={snapshot}
                modelSnapshot={modelSnapshot ?? snapshot}
                model={model}
                strengths={strengths}
                stats={stats}
                rosterId={openTeamCard}
                myRosterId={myRosterId}
                onClose={() => setOpenTeamCard(null)}
              />
            )}
          </OpenTeamContext.Provider>
          </OpenPlayerContext.Provider>
        )}
      </main>
    </>
  );
}
