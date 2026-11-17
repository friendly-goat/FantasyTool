import type {
  LeagueSnapshot,
  LeagueSummary,
  Matchup,
  MatchupSlot,
  PlayerRef,
  StarterSlot,
  Team,
  Transaction,
  TransactionSide,
  TransactionType,
  UserLeagues,
} from "../shared/types.ts";
import type {
  FetchJson,
  RawLeague,
  RawMatchup,
  RawPlayer,
  RawRoster,
  RawState,
  RawTransaction,
  RawUser,
} from "./sleeper.ts";

const SPORT = "nba";
/** How many weeks of transactions to load, counting back from this week. */
const TRANSACTION_WEEKS = 3;
const MAX_TRANSACTIONS = 40;
/** Lineup slots that hold non-starting players. */
const NON_STARTING_SLOTS = new Set(["BN", "IR", "TAXI"]);

export type PlayerMap = Record<string, PlayerRef>;

/** Reduces Sleeper's large player map to the few fields the app uses. */
export function trimPlayers(raw: unknown): PlayerMap {
  const players: PlayerMap = {};
  if (!raw || typeof raw !== "object") return players;
  for (const [id, value] of Object.entries(raw as Record<string, RawPlayer>)) {
    if (!value || typeof value !== "object") continue;
    const name =
      value.full_name ||
      [value.first_name, value.last_name].filter(Boolean).join(" ") ||
      `Player ${id}`;
    const positions =
      value.fantasy_positions?.filter(Boolean) ??
      (value.position ? [value.position] : []);
    players[id] = {
      id,
      name,
      team: value.team ?? null,
      positions,
      injuryStatus: value.injury_status || null,
    };
  }
  return players;
}

export async function loadPlayers(fetchJson: FetchJson): Promise<PlayerMap> {
  return trimPlayers(await fetchJson(`/players/${SPORT}`));
}

export function currentWeek(state: RawState): number {
  return Math.max(1, state.week ?? state.leg ?? 1);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function points(whole: number | undefined, decimal: number | undefined): number {
  return (whole ?? 0) + (decimal ?? 0) / 100;
}

function lookup(players: PlayerMap, id: string): PlayerRef {
  return (
    players[id] ?? {
      id,
      name: `Unknown player (${id})`,
      team: null,
      positions: [],
      injuryStatus: null,
    }
  );
}

export function buildTeams(
  league: RawLeague,
  rosters: RawRoster[],
  users: RawUser[],
  players: PlayerMap,
): Team[] {
  const usersById = new Map(users.map((user) => [user.user_id, user]));
  const startingSlots = (league.roster_positions ?? []).filter(
    (slot) => !NON_STARTING_SLOTS.has(slot),
  );

  const teams = rosters.map((roster): Team => {
    const rosterId = roster.roster_id ?? 0;
    const owner = roster.owner_id ? usersById.get(roster.owner_id) : undefined;
    const managerName = owner?.display_name || owner?.username || "No manager";
    const starterIds = roster.starters ?? [];
    const reserveIds = roster.reserve ?? [];
    const taken = new Set([...starterIds, ...reserveIds]);

    // Sleeper uses "0" for an empty lineup slot.
    const starters: StarterSlot[] = starterIds.map((id, index) => ({
      slot: startingSlots[index] ?? "UTIL",
      player: id && id !== "0" ? lookup(players, id) : null,
    }));

    return {
      rosterId,
      ownerId: roster.owner_id ?? null,
      managerName,
      teamName: owner?.metadata?.team_name || `Team ${managerName}`,
      avatarUrl: owner?.avatar
        ? `https://sleepercdn.com/avatars/thumbs/${owner.avatar}`
        : null,
      rank: 0,
      wins: roster.settings?.wins ?? 0,
      losses: roster.settings?.losses ?? 0,
      ties: roster.settings?.ties ?? 0,
      pointsFor: points(roster.settings?.fpts, roster.settings?.fpts_decimal),
      pointsAgainst: points(
        roster.settings?.fpts_against,
        roster.settings?.fpts_against_decimal,
      ),
      starters,
      bench: (roster.players ?? [])
        .filter((id) => !taken.has(id))
        .map((id) => lookup(players, id)),
      reserve: reserveIds.map((id) => lookup(players, id)),
    };
  });

  // Standings order: wins first, then points scored as the tiebreaker.
  teams.sort(
    (a, b) =>
      b.wins - a.wins || a.losses - b.losses || b.pointsFor - a.pointsFor,
  );
  teams.forEach((team, index) => {
    team.rank = index + 1;
  });
  return teams;
}

export function buildMatchups(
  raw: RawMatchup[],
  league: RawLeague = {},
  players: PlayerMap = {},
): Matchup[] {
  const startingSlots = (league.roster_positions ?? []).filter(
    (slot) => !NON_STARTING_SLOTS.has(slot),
  );
  const byId = new Map<number, Matchup>();
  for (const entry of raw) {
    // A null matchup_id means the team has a bye this week.
    if (entry.matchup_id == null || entry.roster_id == null) continue;

    const starterIds = entry.starters ?? [];
    const credited = (id: string, index?: number): number | null =>
      entry.players_points?.[id] ?? (index != null ? entry.starters_points?.[index] : null) ?? null;

    const starters: MatchupSlot[] = starterIds.map((id, index) => {
      const filled = Boolean(id) && id !== "0";
      return {
        slot: startingSlots[index] ?? "UTIL",
        player: filled ? lookup(players, id) : null,
        points: filled ? credited(id, index) : null,
      };
    });
    const starting = new Set(starterIds);
    const bench: MatchupSlot[] = (entry.players ?? [])
      .filter((id) => !starting.has(id))
      .map((id) => ({ slot: "BN", player: lookup(players, id), points: credited(id) }));

    const matchup = byId.get(entry.matchup_id) ?? {
      matchupId: entry.matchup_id,
      sides: [],
    };
    matchup.sides.push({
      rosterId: entry.roster_id,
      points: entry.custom_points ?? entry.points ?? 0,
      starters,
      bench,
    });
    byId.set(entry.matchup_id, matchup);
  }
  return [...byId.values()].sort((a, b) => a.matchupId - b.matchupId);
}

function transactionType(type: string | undefined): TransactionType {
  return type === "trade" || type === "waiver" || type === "free_agent"
    ? type
    : "other";
}

function ordinal(n: number): string {
  const suffix = ["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? "th";
  return `${n}${suffix}`;
}

export function buildTransactions(
  rawByWeek: { week: number; items: RawTransaction[] }[],
  players: PlayerMap,
): Transaction[] {
  const transactions: Transaction[] = [];
  for (const { week, items } of rawByWeek) {
    for (const item of items) {
      if (item.status !== "complete" || !item.transaction_id) continue;

      const sides = new Map<number, TransactionSide>();
      const side = (rosterId: number): TransactionSide => {
        let existing = sides.get(rosterId);
        if (!existing) {
          existing = { rosterId, adds: [], drops: [], picks: [] };
          sides.set(rosterId, existing);
        }
        return existing;
      };

      for (const rosterId of item.roster_ids ?? []) side(rosterId);
      for (const [playerId, rosterId] of Object.entries(item.adds ?? {})) {
        side(rosterId).adds.push(lookup(players, playerId));
      }
      for (const [playerId, rosterId] of Object.entries(item.drops ?? {})) {
        side(rosterId).drops.push(lookup(players, playerId));
      }
      for (const pick of item.draft_picks ?? []) {
        if (pick.owner_id == null) continue;
        side(pick.owner_id).picks.push(
          `${pick.season ?? ""} ${ordinal(pick.round ?? 0)}-round pick`.trim(),
        );
      }

      transactions.push({
        id: item.transaction_id,
        type: transactionType(item.type),
        createdAt: new Date(item.created ?? 0).toISOString(),
        week: item.leg ?? week,
        sides: [...sides.values()],
      });
    }
  }
  transactions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return transactions.slice(0, MAX_TRANSACTIONS);
}

/** Pulls everything about one league and assembles it for the UI. */
/** Playoff start week and team count, when Sleeper reports both sensibly. */
export function playoffSettings(league: RawLeague): LeagueSnapshot["league"]["playoffs"] {
  const startWeek = league.settings?.playoff_week_start;
  const teams = league.settings?.playoff_teams;
  if (!Number.isInteger(startWeek) || !Number.isInteger(teams)) return null;
  if ((startWeek as number) < 1 || (teams as number) < 2) return null;
  return { startWeek: startWeek as number, teams: teams as number };
}

export async function buildSnapshot(
  leagueId: string,
  fetchJson: FetchJson,
  players: PlayerMap,
  now: () => number = Date.now,
): Promise<LeagueSnapshot> {
  const id = encodeURIComponent(leagueId);
  const [state, league, rosters, users] = await Promise.all([
    fetchJson(`/state/${SPORT}`) as Promise<RawState>,
    fetchJson(`/league/${id}`) as Promise<RawLeague | null>,
    fetchJson(`/league/${id}/rosters`),
    fetchJson(`/league/${id}/users`),
  ]);
  if (!league || !league.league_id) {
    throw new Error(`Sleeper has no league with ID ${leagueId}.`);
  }

  const week = currentWeek(state ?? {});
  const weeks: number[] = [];
  for (let w = week; w >= 1 && weeks.length < TRANSACTION_WEEKS; w--) weeks.push(w);

  const [matchups, ...transactionsByWeek] = await Promise.all([
    fetchJson(`/league/${id}/matchups/${week}`),
    ...weeks.map((w) => fetchJson(`/league/${id}/transactions/${w}`)),
  ]);

  return {
    fetchedAt: new Date(now()).toISOString(),
    stale: false,
    league: {
      id: league.league_id,
      name: league.name ?? "Unnamed league",
      season: league.season ?? state?.season ?? "",
      seasonStartDate: state?.season_start_date ?? null,
      status: league.status ?? "unknown",
      totalRosters: league.total_rosters ?? asArray(rosters).length,
      rosterPositions: league.roster_positions ?? [],
      scoringSettings: league.scoring_settings ?? {},
      playoffs: playoffSettings(league),
    },
    week,
    teams: buildTeams(league, asArray<RawRoster>(rosters), asArray<RawUser>(users), players),
    matchups: buildMatchups(asArray<RawMatchup>(matchups), league, players),
    transactions: buildTransactions(
      weeks.map((w, index) => ({
        week: w,
        items: asArray<RawTransaction>(transactionsByWeek[index]),
      })),
      players,
    ),
  };
}

/** Finds a Sleeper user by username and lists their NBA leagues. */
export async function loadUserLeagues(
  username: string,
  fetchJson: FetchJson,
): Promise<UserLeagues> {
  const [user, state] = await Promise.all([
    fetchJson(`/user/${encodeURIComponent(username)}`) as Promise<RawUser | null>,
    fetchJson(`/state/${SPORT}`) as Promise<RawState>,
  ]);
  if (!user?.user_id) {
    throw new Error(`Sleeper has no user named "${username}".`);
  }
  const season = state?.league_season ?? state?.season ?? String(new Date().getFullYear());
  const leagues = asArray<RawLeague>(
    await fetchJson(`/user/${user.user_id}/leagues/${SPORT}/${season}`),
  );
  return {
    user: { id: user.user_id, displayName: user.display_name ?? username },
    season,
    leagues: leagues
      .filter((league) => league.league_id)
      .map(
        (league): LeagueSummary => ({
          id: league.league_id!,
          name: league.name ?? "Unnamed league",
          season: league.season ?? season,
          totalRosters: league.total_rosters ?? 0,
        }),
      ),
  };
}
