import { describe, expect, it } from "vitest";
import { editDistance, foldName, foldQuery, matchName, searchPlayers, typoAllowance } from "./playerSearch.ts";

const players = [
  { name: "Nikola Jokić", value: 60 },
  { name: "James Harden", value: 45 },
  { name: "LeBron James", value: 50 },
  { name: "Shai Gilgeous-Alexander", value: 58 },
  { name: "Karl-Anthony Towns", value: 44 },
  { name: "Royce O'Neale", value: 18 },
  { name: "Victor Wembanyama", value: 55 },
  { name: "Jaren Jackson Jr.", value: 40 },
  { name: "Jalen Johnson", value: 42 },
  { name: "Saddiq Bey", value: 27 },
  { name: "Luka Dončić", value: 62 },
];
const search = (query: string, limit = 8) => searchPlayers(players, query, (p) => p.name, (p) => p.value, limit).map((r) => r.item.name);

describe("foldName", () => {
  it("drops accents, case and punctuation, and reads hyphens as spaces", () => {
    expect(foldName("Luka Dončić").text).toBe("luka doncic");
    expect(foldName("Royce O'Neale").text).toBe("royce oneale");
    expect(foldName("Shai Gilgeous-Alexander").text).toBe("shai gilgeous alexander");
    expect(foldName("Jaren Jackson Jr.").text).toBe("jaren jackson jr");
    expect(foldQuery("  Luka   DON ")).toBe("luka don");
  });

  it("remembers where each character came from, for highlighting", () => {
    const folded = foldName("Royce O'Neale");
    expect(folded.from[folded.text.indexOf("n")]).toBe("Royce O'Neale".indexOf("N"));
  });
});

describe("matchName", () => {
  it("matches the start of a first name, a last name, or both", () => {
    expect(matchName("James Harden", "jam")?.kind).toBe("prefix");
    expect(matchName("LeBron James", "jam")?.kind).toBe("prefix");
    expect(matchName("LeBron James", "lebron j")?.kind).toBe("prefix");
    expect(matchName("James Harden", "harden james")?.kind).toBe("words");
    expect(matchName("James Harden", "james harden")?.kind).toBe("exact");
  });

  it("does not match a typed word against the middle of a name word, except as a fallback", () => {
    expect(matchName("Saddiq Bey", "ey")).toBeNull();
    expect(matchName("Victor Wembanyama", "bany")?.kind).toBe("inside");
  });

  it("matches initials", () => {
    expect(matchName("Shai Gilgeous-Alexander", "sga")?.kind).toBe("initials");
    expect(matchName("Karl-Anthony Towns", "kat")?.kind).toBe("initials");
  });

  it("forgives a slip once enough is typed", () => {
    expect(matchName("Nikola Jokić", "jokci")?.kind).toBe("typo");
    expect(matchName("Victor Wembanyama", "wembanyma")?.kind).toBe("typo");
    expect(matchName("Saddiq Bey", "bye")).toBeNull();
  });

  it("highlights what matched in the original name", () => {
    const name = "Luka Dončić";
    const match = matchName(name, "luka donc")!;
    expect(match.ranges.map(([start, end]) => name.slice(start, end))).toEqual(["Luka", "Donč"]);
    const initials = matchName("Shai Gilgeous-Alexander", "sga")!;
    expect(initials.ranges.map(([start, end]) => "Shai Gilgeous-Alexander".slice(start, end))).toEqual(["S", "G", "A"]);
  });
});

describe("searchPlayers", () => {
  it("puts the better player first among equally good matches", () => {
    expect(search("j")).toEqual(["Nikola Jokić", "LeBron James", "James Harden", "Jalen Johnson", "Jaren Jackson Jr."]);
    expect(search("james")).toEqual(["LeBron James", "James Harden"]);
  });

  it("ranks a better match above a better player", () => {
    expect(search("ja")[0]).toBe("LeBron James");
    expect(search("jalen")).toEqual(["Jalen Johnson"]);
    expect(search("jaren jackson")).toEqual(["Jaren Jackson Jr."]);
  });

  it("finds names typed without accents or punctuation", () => {
    expect(search("doncic")).toEqual(["Luka Dončić"]);
    expect(search("oneale")).toEqual(["Royce O'Neale"]);
    expect(search("o'neale")).toEqual(["Royce O'Neale"]);
    expect(search("gilgeous alex")).toEqual(["Shai Gilgeous-Alexander"]);
  });

  it("shows slips only when nothing matches properly", () => {
    expect(search("jokci")).toEqual(["Nikola Jokić"]);
    expect(search("harden")).toEqual(["James Harden"]);
  });

  it("returns nothing for an empty query and keeps to the limit", () => {
    expect(search("   ")).toEqual([]);
    expect(search("a", 2)).toHaveLength(2);
  });
});

describe("editDistance", () => {
  it("counts a swap of neighbors as one edit and stops early past the limit", () => {
    expect(editDistance("jokci", "jokic", 1)).toBe(1);
    expect(editDistance("abc", "xyz", 1)).toBe(2);
    expect(typoAllowance(3)).toBe(0);
    expect(typoAllowance(5)).toBe(1);
    expect(typoAllowance(8)).toBe(2);
  });
});
