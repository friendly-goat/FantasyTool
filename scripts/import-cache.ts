// Copies everything saved in .cache/ (league data, player list, box scores,
// logos) into the database at DATABASE_URL, so an app using that database
// starts with it instead of downloading it all again.
//
//   DATABASE_URL=postgres://localhost/fantasytool npm run db:import
//
// Safe to run more than once: entries are replaced, box scores are added or
// updated, nothing is deleted.

import { readdir } from "node:fs/promises";
import { FileStorage, createPostgresStorage } from "../server/storage.ts";

// A DATABASE_URL given on the command line (such as Heroku's) wins over the
// one in .env, so the copy never lands in the wrong database by accident.
const fromCommandLine = process.env.DATABASE_URL?.trim();
try {
  process.loadEnvFile(".env");
} catch {
  // No .env: the command line has to give DATABASE_URL.
}

const DIR = ".cache";
const url = fromCommandLine || process.env.DATABASE_URL?.trim();

async function main() {
  if (!url) throw new Error("Set DATABASE_URL to the database to copy into.");
  const target = url.replace(/\/\/[^@]*@/, "//…@");
  console.log(`Copying ${DIR}/ into ${target}`);
  const files = new FileStorage(DIR);
  const database = createPostgresStorage(url);
  try {
    const names = (await readdir(DIR)).filter((name) => name.endsWith(".json"));
    let entries = 0;
    let lines = 0;
    for (const name of names) {
      const key = name.slice(0, -".json".length);
      if (key.startsWith("stats-") && !key.startsWith("stats-v2-")) {
        console.log(`  ${key}: skipped (an older format the app no longer reads)`);
        continue;
      }
      if (key.startsWith("locks-")) continue; // Lock marks are not a cache; they stay where they were made.
      if (key.startsWith("stats-")) {
        const saved = await files.readLines(key);
        if (saved.lines.length === 0) continue;
        await database.writeLines(key, saved.syncedAt ?? Date.now(), saved.lines);
        lines += saved.lines.length;
        console.log(`  ${key}: ${saved.lines.length} box-score lines`);
      } else {
        const entry = await files.readEntry(key);
        if (!entry) continue;
        await database.writeEntry(key, entry);
        entries++;
      }
    }
    console.log(`Copied ${entries} cache entries and ${lines} box-score lines into the database.`);
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error("Import failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
