import { describe, expect, it } from "vitest";
import { NBA_TEAMS, nbaTeam } from "../shared/nbaTeams.ts";
import { Cache } from "./cache.ts";
import { checkSvg, createLogoSource, logoUrl } from "./logos.ts";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

describe("nbaTeam", () => {
  it("knows all 30 teams with distinct IDs", () => {
    expect(NBA_TEAMS).toHaveLength(30);
    expect(new Set(NBA_TEAMS.map((team) => team.nbaId)).size).toBe(30);
    expect(new Set(NBA_TEAMS.map((team) => team.abbr)).size).toBe(30);
  });

  it("accepts other common spellings", () => {
    expect(nbaTeam("GS")?.abbr).toBe("GSW");
    expect(nbaTeam("sa")?.abbr).toBe("SAS");
    expect(nbaTeam("PHO")?.abbr).toBe("PHX");
    expect(nbaTeam(" was ")?.abbr).toBe("WAS");
    expect(nbaTeam("XYZ")).toBeNull();
    expect(nbaTeam(null)).toBeNull();
  });
});

describe("logos", () => {
  it("builds the light and dark addresses", () => {
    expect(logoUrl(1610612747, "light")).toBe("https://cdn.nba.com/logos/nba/1610612747/primary/L/logo.svg");
    expect(logoUrl(1610612747, "dark")).toBe("https://cdn.nba.com/logos/nba/1610612747/primary/D/logo.svg");
  });

  it("accepts SVG files and rejects anything else", () => {
    expect(checkSvg(SVG)).toBe(SVG);
    expect(checkSvg(`<?xml version="1.0"?>\n<!-- logo -->\n${SVG}`)).toContain("<svg");
    expect(() => checkSvg("<html><body>Not found</body></html>")).toThrow();
    expect(() => checkSvg(`<svg>${"x".repeat(400_000)}</svg>`)).toThrow();
  });

  it("downloads each logo once and waits before retrying a failure", async () => {
    let time = 0;
    const cache = new Cache({ storage: null, now: () => time });
    let calls = 0;
    let online = false;
    const getLogo = createLogoSource(
      cache,
      async () => {
        calls++;
        if (!online) throw new Error("offline");
        return SVG;
      },
      () => time,
    );

    expect(await getLogo(1, "light")).toBeNull();
    expect(await getLogo(1, "light")).toBeNull();
    expect(calls).toBe(1);

    online = true;
    time += 16 * 60_000;
    expect(await getLogo(1, "light")).toBe(SVG);
    expect(await getLogo(1, "light")).toBe(SVG);
    expect(calls).toBe(2);
  });
});
