// The 30 NBA teams: the abbreviation the app shows, and the NBA's own team
// ID, which is what the NBA's logo images are filed under.
//
// This is a lookup table for display only. Nothing in the analysis reads it.

export interface NbaTeam {
  abbr: string;
  nbaId: number;
  name: string;
}

export const NBA_TEAMS: readonly NbaTeam[] = [
  { abbr: "ATL", nbaId: 1610612737, name: "Atlanta Hawks" },
  { abbr: "BOS", nbaId: 1610612738, name: "Boston Celtics" },
  { abbr: "BKN", nbaId: 1610612751, name: "Brooklyn Nets" },
  { abbr: "CHA", nbaId: 1610612766, name: "Charlotte Hornets" },
  { abbr: "CHI", nbaId: 1610612741, name: "Chicago Bulls" },
  { abbr: "CLE", nbaId: 1610612739, name: "Cleveland Cavaliers" },
  { abbr: "DAL", nbaId: 1610612742, name: "Dallas Mavericks" },
  { abbr: "DEN", nbaId: 1610612743, name: "Denver Nuggets" },
  { abbr: "DET", nbaId: 1610612765, name: "Detroit Pistons" },
  { abbr: "GSW", nbaId: 1610612744, name: "Golden State Warriors" },
  { abbr: "HOU", nbaId: 1610612745, name: "Houston Rockets" },
  { abbr: "IND", nbaId: 1610612754, name: "Indiana Pacers" },
  { abbr: "LAC", nbaId: 1610612746, name: "LA Clippers" },
  { abbr: "LAL", nbaId: 1610612747, name: "Los Angeles Lakers" },
  { abbr: "MEM", nbaId: 1610612763, name: "Memphis Grizzlies" },
  { abbr: "MIA", nbaId: 1610612748, name: "Miami Heat" },
  { abbr: "MIL", nbaId: 1610612749, name: "Milwaukee Bucks" },
  { abbr: "MIN", nbaId: 1610612750, name: "Minnesota Timberwolves" },
  { abbr: "NOP", nbaId: 1610612740, name: "New Orleans Pelicans" },
  { abbr: "NYK", nbaId: 1610612752, name: "New York Knicks" },
  { abbr: "OKC", nbaId: 1610612760, name: "Oklahoma City Thunder" },
  { abbr: "ORL", nbaId: 1610612753, name: "Orlando Magic" },
  { abbr: "PHI", nbaId: 1610612755, name: "Philadelphia 76ers" },
  { abbr: "PHX", nbaId: 1610612756, name: "Phoenix Suns" },
  { abbr: "POR", nbaId: 1610612757, name: "Portland Trail Blazers" },
  { abbr: "SAC", nbaId: 1610612758, name: "Sacramento Kings" },
  { abbr: "SAS", nbaId: 1610612759, name: "San Antonio Spurs" },
  { abbr: "TOR", nbaId: 1610612761, name: "Toronto Raptors" },
  { abbr: "UTA", nbaId: 1610612762, name: "Utah Jazz" },
  { abbr: "WAS", nbaId: 1610612764, name: "Washington Wizards" },
];

// Other spellings seen across data sources.
const ALIASES: Record<string, string> = {
  BRK: "BKN",
  NJN: "BKN",
  CHO: "CHA",
  GS: "GSW",
  NO: "NOP",
  NOR: "NOP",
  NY: "NYK",
  PHO: "PHX",
  SA: "SAS",
  UTAH: "UTA",
  WSH: "WAS",
};

const BY_ABBR = new Map(NBA_TEAMS.map((team) => [team.abbr, team]));

/** The team for an abbreviation in any common spelling, or null. */
export function nbaTeam(abbr: string | null | undefined): NbaTeam | null {
  if (!abbr) return null;
  const key = abbr.trim().toUpperCase();
  return BY_ABBR.get(ALIASES[key] ?? key) ?? null;
}
