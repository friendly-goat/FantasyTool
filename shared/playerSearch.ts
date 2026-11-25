// Type-ahead player search: finds players as a name is typed. Built to feel
// right with very little typed and to forgive how people type names:
//
// - Accents, case and punctuation don't matter: "jokic" finds Jokić, "oneale"
//   or "o'neale" finds O'Neale, "gilgeous alexander" finds Gilgeous-Alexander.
// - Any part of the name can start the match: a first name ("james" finds James
//   Harden and LeBron James), a last name ("bey"), or both in either order
//   ("harden james", "lebron j").
// - Initials work for the names people shorten ("sga", "kat").
// - A small slip still finds him ("jokci", "wembanyma"), once enough is typed.
//
// Matches are ranked by how good the match is, then by the player's value, so
// the player you most likely mean is first after a letter or two.

/** One way a name was matched, best first. */
export type MatchKind = "exact" | "prefix" | "words" | "initials" | "inside" | "typo";
const KIND_ORDER: MatchKind[] = ["exact", "prefix", "words", "initials", "inside", "typo"];

/** A name made comparable: lower case, no accents or punctuation, one space between words. */
interface Folded {
  text: string;
  /** For each character of `text`, where it came from in the original name. */
  from: number[];
  /** Each word's start and end in `text`. */
  words: { start: number; end: number }[];
}

/** Characters dropped when comparing ("O'Neale", "Jr.") and ones read as a space ("Gilgeous-Alexander"). */
const DROPPED = /['’‘.`,]/;
const SPACES = /[\s\-_/]/;

/** Folds text for comparing: lower case, accents and punctuation off, hyphens as spaces. */
export function foldName(name: string): Folded {
  let text = "";
  const from: number[] = [];
  for (let index = 0; index < name.length; index++) {
    const character = name[index]!;
    if (DROPPED.test(character)) continue;
    if (SPACES.test(character)) {
      if (text.length > 0 && !text.endsWith(" ")) {
        text += " ";
        from.push(index);
      }
      continue;
    }
    for (const plain of character.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()) {
      text += plain;
      from.push(index);
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    from.pop();
  }
  const words: Folded["words"] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index === text.length || text[index] === " ") {
      if (index > start) words.push({ start, end: index });
      start = index + 1;
    }
  }
  return { text, from, words };
}

/** A query folded the same way as names. */
export function foldQuery(query: string): string {
  return foldName(query).text;
}

/** Edits (insert, delete, change, swap of two neighbors) between two short strings, stopping past `limit`. */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, index) => index)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1]![j]! + 1, row[j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      row.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    rows.push(row);
  }
  return rows[a.length]![b.length]!;
}

/** Typos forgiven in a typed word: none for short ones (too many names would match), then one, then two. */
export function typoAllowance(length: number): number {
  return length >= 7 ? 2 : length >= 4 ? 1 : 0;
}

export interface NameMatch {
  kind: MatchKind;
  /** Parts of the original name that matched, as [start, end) character ranges, for highlighting. */
  ranges: [number, number][];
}

/**
 * How a folded query matches a name, or null for no match. Each typed word must match the start of
 * a different word of the name.
 */
export function matchName(name: string, query: string): NameMatch | null {
  if (!query) return null;
  const folded = foldName(name);
  const tokens = query.split(" ");
  const range = (start: number, end: number): [number, number] => [folded.from[start]!, folded.from[end - 1]! + 1];

  if (folded.text === query) return { kind: "exact", ranges: [range(0, folded.text.length)] };

  // Every typed word starts a different word of the name: in order is "prefix", any order "words".
  const assign = (inOrder: boolean, matches: (token: string, word: { start: number; end: number }) => number) => {
    const used = new Set<number>();
    const ranges: [number, number][] = [];
    let after = -1;
    for (const token of tokens) {
      let found = -1;
      let length = 0;
      for (let index = inOrder ? after + 1 : 0; index < folded.words.length; index++) {
        if (used.has(index)) continue;
        length = matches(token, folded.words[index]!);
        if (length > 0) {
          found = index;
          break;
        }
      }
      if (found < 0) return null;
      used.add(found);
      after = found;
      const word = folded.words[found]!;
      ranges.push(range(word.start, Math.min(word.end, word.start + length)));
    }
    return ranges.sort((x, y) => x[0] - y[0]);
  };
  const startsWith = (token: string, word: { start: number; end: number }) =>
    folded.text.startsWith(token, word.start) && token.length <= word.end - word.start ? token.length : 0;
  const inOrder = assign(true, startsWith);
  if (inOrder) return { kind: "prefix", ranges: inOrder };
  const anyOrder = assign(false, startsWith);
  if (anyOrder) return { kind: "words", ranges: anyOrder };

  // Initials, for two letters or more typed as one word: "sga", "kat".
  const squeezed = query.replace(/ /g, "");
  if (tokens.length === 1 && squeezed.length >= 2 && folded.words.length >= 2) {
    const initials = folded.words.map((word) => folded.text[word.start]).join("");
    if (initials.startsWith(squeezed)) {
      return { kind: "initials", ranges: folded.words.slice(0, squeezed.length).map((word) => range(word.start, word.start + 1)) };
    }
  }

  // Inside a word, for three letters or more: "bany" in Wembanyama.
  if (tokens.length === 1 && query.length >= 3) {
    const at = folded.text.indexOf(query);
    if (at >= 0) return { kind: "inside", ranges: [range(at, at + query.length)] };
  }

  // A slip in each typed word, against the start of a name word of about the same length.
  const nearly = assign(false, (token, word) => {
    const allowance = typoAllowance(token.length);
    if (allowance === 0) return folded.text.startsWith(token, word.start) ? token.length : 0;
    const wordText = folded.text.slice(word.start, word.end);
    for (const length of [token.length, token.length - 1, token.length + 1]) {
      if (length <= 0 || length > wordText.length) continue;
      if (editDistance(token, wordText.slice(0, length), allowance) <= allowance) return length;
    }
    return 0;
  });
  if (nearly) return { kind: "typo", ranges: nearly };
  return null;
}

export interface SearchResult<T> {
  item: T;
  match: NameMatch;
}

/**
 * The players matching a typed query, best first: by how good the match is, then by `value` (higher
 * first), then by name. An empty query matches nobody (show your own starting list instead).
 */
export function searchPlayers<T>(items: T[], query: string, name: (item: T) => string, value: (item: T) => number, limit = 8): SearchResult<T>[] {
  const folded = foldQuery(query);
  if (!folded) return [];
  const found: (SearchResult<T> & { order: number; value: number; name: string })[] = [];
  for (const item of items) {
    const match = matchName(name(item), folded);
    if (match) found.push({ item, match, order: KIND_ORDER.indexOf(match.kind), value: value(item), name: name(item) });
  }
  // A slip is only worth showing when nothing better matched.
  const best = found.length > 0 ? Math.min(...found.map((entry) => entry.order)) : 0;
  return found
    .filter((entry) => entry.match.kind !== "typo" || best === KIND_ORDER.indexOf("typo"))
    .sort((a, b) => a.order - b.order || b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ item, match }) => ({ item, match }));
}
