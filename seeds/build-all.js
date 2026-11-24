#!/usr/bin/env node
/**
 * Builds compartmentalized SQLite seed DBs from server/seed-lists/<dimension>/<type>.txt
 *
 * Usage:
 *   node seeds/build-all.js [seedListsDir] [outputSeedsDir]
 *
 * Each <dimension> folder (overworld, nether, end) is compiled into <outputSeedsDir>/<dimension>.db.
 * Files are rebuilt atomically so running this on every deploy never duplicates seeds.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DIMENSIONS = ["overworld", "nether", "end"];
const listsDir = resolve(process.argv[2] || "./seed-lists");
const outDir = resolve(process.argv[3] || process.env.SEEDS_DIR || "./data/seeds");

mkdirSync(outDir, { recursive: true });

for (const dim of DIMENSIONS) {
  const dimDir = join(listsDir, dim);
  const dbPath = join(outDir, `${dim}.db`);
  const tmpPath = `${dbPath}.tmp`;

  if (!existsSync(dimDir)) {
    continue;
  }

  const files = readdirSync(dimDir)
    .filter((f) => extname(f).toLowerCase() === ".txt")
    .sort();

  const buckets = [];
  for (const file of files) {
    const type = basename(file, ".txt").trim();
    if (!type) continue;
    const rawLines = readFileSync(join(dimDir, file), "utf8").split(/\r?\n/);
    const seen = new Set();
    const seeds = [];
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      seeds.push(trimmed);
    }
    if (seeds.length > 0) {
      buckets.push({ type, seeds });
    }
  }

  if (buckets.length === 0) {
    console.log(`[build-seeds] ${dim}: 0 seeds found in ${dimDir} — skipping`);
    continue;
  }

  rmSync(tmpPath, { force: true });
  const db = new DatabaseSync(tmpPath);
  db.exec(`
    CREATE TABLE seeds (
      type TEXT NOT NULL,
      seq  INTEGER NOT NULL,
      seed TEXT NOT NULL,
      PRIMARY KEY (type, seq)
    ) WITHOUT ROWID;

    CREATE TABLE type_counts (
      type  TEXT PRIMARY KEY,
      count INTEGER NOT NULL
    ) WITHOUT ROWID;
  `);

  const insertSeed = db.prepare("INSERT INTO seeds (type, seq, seed) VALUES (?, ?, ?)");
  const insertCount = db.prepare("INSERT INTO type_counts (type, count) VALUES (?, ?)");

  let total = 0;
  db.exec("BEGIN");
  try {
    for (const { type, seeds } of buckets) {
      for (let seq = 0; seq < seeds.length; seq++) {
        insertSeed.run(type, seq, seeds[seq]);
      }
      insertCount.run(type, seeds.length);
      total += seeds.length;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    db.close();
    rmSync(tmpPath, { force: true });
    throw err;
  }

  db.exec("ANALYZE");
  db.close();

  renameSync(tmpPath, dbPath);
  console.log(`[build-seeds] ${dim}.db built (${total} seeds across ${buckets.length} types)`);
}
