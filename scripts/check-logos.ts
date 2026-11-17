// Logo check: downloads every NBA team logo (light and dark versions) from
// the NBA's image server and reports any that fail. It also writes
// .cache/logo-preview.html, which shows them all at the app's size on light
// and dark backgrounds, so you can see they look consistent.
//
//   npm run check:logos
//
// It makes 60 requests, one per logo.

import { mkdir, writeFile } from "node:fs/promises";
import { NBA_TEAMS } from "../shared/nbaTeams.ts";
import { downloadLogo, type LogoVariant } from "../server/logos.ts";

const VARIANTS: LogoVariant[] = ["light", "dark"];

async function main() {
  const rows: string[] = [];
  let failures = 0;

  for (const team of NBA_TEAMS) {
    const cells: string[] = [];
    const notes: string[] = [];
    for (const variant of VARIANTS) {
      try {
        const svg = await downloadLogo(team.nbaId, variant);
        const data = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
        cells.push(`<td class="${variant}"><img src="${data}" alt=""><span>${team.abbr}</span></td>`);
        notes.push(`${variant} ${(svg.length / 1024).toFixed(1)} KB`);
      } catch (error) {
        failures++;
        cells.push(`<td class="${variant}">failed</td>`);
        notes.push(`${variant} FAILED (${error instanceof Error ? error.message : error})`);
      }
    }
    console.log(`${team.abbr.padEnd(4)} ${notes.join(", ")}`);
    rows.push(`<tr><th>${team.name}</th>${cells.join("")}</tr>`);
  }

  const html = `<!doctype html><meta charset="utf-8"><title>Team logos</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; }
  th { text-align: left; padding: 0.3rem 1rem 0.3rem 0; font-weight: 500; }
  td { padding: 0.4rem 1rem; }
  td.light { background: #f6f7fb; color: #4a5470; }
  td.dark { background: #1c2538; color: #9ba7be; }
  img { width: 18px; height: 18px; object-fit: contain; vertical-align: middle; margin-right: 0.3rem; }
</style>
<h1>Team logos</h1>
<table><tr><th>Team</th><th>Light theme</th><th>Dark theme</th></tr>${rows.join("\n")}</table>`;

  await mkdir(".cache", { recursive: true });
  await writeFile(".cache/logo-preview.html", html);

  console.log(
    failures === 0
      ? "\nAll 60 logos downloaded. Open .cache/logo-preview.html to see them."
      : `\n${failures} of 60 logos failed. The app shows the abbreviation alone for those.`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
