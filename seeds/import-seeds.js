#!/usr/bin/env node
/**
 * Offline/CLI helper to build or append to a compartmentalized dimension SQLite DB.
 *
 * Usage:
 *   node seeds/import-seeds.js <dimension> <type> <input.txt> [seedsDir]
 *
 * Example:
 *   node seeds/import-seeds.js overworld village ./villages.txt
 *   node seeds/import-seeds.js nether bastion_fortress ./nether.txt
 *   node seeds/import-seeds.js end zero_cycle ./end.txt
 */
import { mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const VALID_DIMENSIONS = new Set(["overworld", "nether", "end"]);

const [dimension, type, inputFile, customDir] = process.argv.slice(2);
if (!dimension || !type || !inputFile || !VALID_DIMENSIONS.has(dimension)) {
  console.error("Usage: node seeds/import-seeds.js <overworld|nether|end> <type> <input.txt> [seedsDir]");
  process.exit(1);
}

const seedsDir = resolve(customDir || process.env.SEEDS_DIR || "./data/seeds");
mkdirSync(seedsDir, { recursive: true });
const dbPath = join(seedsDir, `${dimension}.db`);

const rawLines = readFileSync(resolve(inputFile), "utf8").split(/\r?\n/);
const seeds = [];
for (const line of rawLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  seeds.push(trimmed);
}

if (seeds.length === 0) {
  console.error("No seeds found in input file.");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS seeds (
    type TEXT NOT NULL,
    seq  INTEGER NOT NULL,
    seed TEXT NOT NULL,
    PRIMARY KEY (type, seq)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS type_counts (
    type  TEXT PRIMARY KEY,
    count INTEGER NOT NULL
  ) WITHOUT ROWID;
`);

const existing = db.prepare("SELECT count FROM type_counts WHERE type = ?").get(type);
let nextSeq = existing ? Number(existing.count) : 0;

const insertStmt = db.prepare("INSERT INTO seeds (type, seq, seed) VALUES (?, ?, ?)");
const upsertCount = db.prepare(`
  INSERT INTO type_counts (type, count) VALUES (?, ?)
  ON CONFLICT(type) DO UPDATE SET count = excluded.count
`);

db.exec("BEGIN");
try {
  for (const seed of seeds) {
    insertStmt.run(type, nextSeq, seed);
    nextSeq++;
  }
  upsertCount.run(type, nextSeq);
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
}

db.exec("ANALYZE");
db.close();

console.log(`Imported ${seeds.length} seeds into ${dbPath} (type=${type}, total=${nextSeq})`);
