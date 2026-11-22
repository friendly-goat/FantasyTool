import { describe, expect, it } from "vitest";
import { NBA_TEAMS, nbaTeam } from "../shared/nbaTeams.ts";
import { Cache } from "./cache.ts";
import { AREA_FILL, contentBox, EDGE_FILL, normalizeLogo, pathBox, squareFrame } from "./logoShape.ts";
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
    expect(await getLogo(1, "light")).toBe(normalizeLogo(SVG));
    expect(await getLogo(1, "light")).toBe(normalizeLogo(SVG));
    expect(calls).toBe(2);
  });
});

describe("logo framing", () => {
  const close = (box: { minX: number; minY: number; maxX: number; maxY: number } | null, expected: number[]) => {
    expect(box).not.toBeNull();
    [box!.minX, box!.minY, box!.maxX, box!.maxY].forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 3));
  };

  it("measures paths with every command, absolute and relative", () => {
    close(pathBox("M10 10 L20 30 H5 V0 Z"), [5, 0, 20, 30]);
    close(pathBox("m10 10 l10 20 h-15 v-30 z"), [5, 0, 20, 30]);
    // A cubic bulges past its end points: from (0,0) to (10,0) with both controls at y=10 peaks at 7.5.
    close(pathBox("M0 0 C0 10 10 10 10 0"), [0, 0, 10, 7.5]);
    close(pathBox("M0 0 c0 10 10 10 10 0 s10 -10 10 0"), [0, -7.5, 20, 7.5]);
    // A quadratic with its control at y=10 peaks at 5.
    close(pathBox("M0 0 Q5 10 10 0 T20 0"), [0, -5, 20, 5]);
    // Half a circle of radius 5 from (0,0) to (10,0), bulging up (y down) or down, flags written together.
    close(pathBox("M0 0 A5 5 0 0 1 10 0"), [0, -5, 10, 0]);
    close(pathBox("M0 0a5 5 0 0010 0"), [0, 0, 10, 5]);
    // Extra pairs after a move are lines.
    close(pathBox("M0 0 10 10 20 -5"), [0, -5, 20, 10]);
  });

  it("measures shapes and leaves out clip paths", () => {
    const svg = `<svg viewBox="0 0 400 400"><clipPath id="c"><rect width="400" height="400"/></clipPath>
      <circle cx="200" cy="200" r="50"/><polygon points="100,150 120,160 110,170"/><rect x="240" y="190" width="20" height="40"/></svg>`;
    close(contentBox(svg), [100, 150, 260, 250]);
    expect(contentBox('<svg><g transform="scale(2)"><path d="M0 0L1 1"/></g></svg>')).toBeNull();
    expect(contentBox("<svg></svg>")).toBeNull();
  });

  it("frames every logo in a square of the same area, never past the edge share", () => {
    // A square drawing fills AREA_FILL of the side.
    const square = squareFrame({ minX: 50, minY: 50, maxX: 350, maxY: 350 });
    expect(300 / square.side).toBeCloseTo(AREA_FILL);
    expect(square.x + square.side / 2).toBeCloseTo(200);
    // A wide wordmark is held to EDGE_FILL of the width; a tall crest to EDGE_FILL of the height.
    expect(390 / squareFrame({ minX: 5, minY: 125, maxX: 395, maxY: 275 }).side).toBeCloseTo(EDGE_FILL);
    expect(460 / squareFrame({ minX: 60, minY: 16, maxX: 390, maxY: 476 }).side).toBeCloseTo(EDGE_FILL);
  });

  it("replaces the frame and size of the logo, and leaves a file it cannot measure as it came", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect x="50" y="50" width="300" height="300"/></svg>';
    const framed = normalizeLogo(svg);
    const side = 300 / AREA_FILL;
    expect(framed).toContain(`viewBox="${Number((200 - side / 2).toFixed(2))} ${Number((200 - side / 2).toFixed(2))} ${Number(side.toFixed(2))} ${Number(side.toFixed(2))}"`);
    expect(framed).not.toContain('width="400"');
    expect(framed).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(framed.match(/<svg/g)).toHaveLength(1);
    const odd = '<svg viewBox="0 0 10 10"><g transform="rotate(5)"><path d="M0 0L5 5"/></g></svg>';
    expect(normalizeLogo(odd)).toBe(odd);
  });
});
