import type { Cache } from "./cache.ts";
import { normalizeLogo } from "./logoShape.ts";

// NBA team logos, from the NBA's own image server. Each team has two
// versions: one drawn for light backgrounds and one for dark ones. They are
// SVG, so they stay sharp at any size and every team's logo comes in the
// same format.
//
// The browser asks this server (GET /api/logos/:abbr/:variant); this server
// fetches each logo once, reframes it so every team's logo shows at the same
// visual size (`normalizeLogo`, server/logoShape.ts), and keeps it in the
// cache. Logo files are never stored in the repo.

export type LogoVariant = "light" | "dark";

const MAX_BYTES = 300_000;

export function logoUrl(nbaId: number, variant: LogoVariant): string {
  const folder = variant === "dark" ? "D" : "L";
  return `https://cdn.nba.com/logos/nba/${nbaId}/primary/${folder}/logo.svg`;
}

/** Throws unless the text looks like a single, reasonably sized SVG image. */
export function checkSvg(text: string): string {
  if (text.length > MAX_BYTES) throw new Error("Logo file is unexpectedly large");
  const start = text.replace(/^﻿/, "").trimStart();
  const body = start.startsWith("<?xml") ? start.slice(start.indexOf("?>") + 2).trimStart() : start;
  const opening = body.replace(/^(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*/i, "");
  if (!/^<svg[\s>]/i.test(opening)) throw new Error("Logo file is not an SVG image");
  return text;
}

export async function downloadLogo(
  nbaId: number,
  variant: LogoVariant,
  fetchText: (url: string) => Promise<string> = defaultFetchText,
): Promise<string> {
  return normalizeLogo(checkSvg(await fetchText(logoUrl(nbaId, variant))));
}

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Logo request failed (${response.status})`);
  return response.text();
}

const LOGO_TTL = 30 * 24 * 60 * 60_000;
const RETRY_AFTER = 15 * 60_000;

/**
 * Logos through the cache. A logo is downloaded at most once every 30 days;
 * after a failed download the same logo is not tried again for 15 minutes,
 * so a page full of players makes at most one request per logo.
 */
export function createLogoSource(
  cache: Cache,
  fetchText?: (url: string) => Promise<string>,
  now: () => number = Date.now,
) {
  const failedAt = new Map<string, number>();

  return async function getLogo(nbaId: number, variant: LogoVariant): Promise<string | null> {
    // v2: reframed to the same visual size (logos saved before that are downloaded again).
    const key = `logo-v2-${nbaId}-${variant}`;
    const failed = failedAt.get(key);
    if (failed !== undefined && now() - failed < RETRY_AFTER) {
      // Use a saved copy if there is one, even an old one, without asking again.
      if ((await cache.age(key)) === null) return null;
      const kept = await cache.get<string>(key, Infinity, () => Promise.reject(new Error("No saved logo")));
      return kept.value;
    }
    try {
      const result = await cache.get(key, LOGO_TTL, () => downloadLogo(nbaId, variant, fetchText));
      // A stale result means the download failed and an older copy was used.
      if (result.stale) failedAt.set(key, now());
      else failedAt.delete(key);
      return result.value;
    } catch {
      failedAt.set(key, now());
      return null;
    }
  };
}
