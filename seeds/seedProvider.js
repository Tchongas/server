import { existsSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DIMENSIONS = ["overworld", "nether", "end"];

/**
 * Generates a random signed 64-bit Minecraft seed as a decimal string.
 * Stored/sent as a string because JS Number only has 53 bits of integer precision.
 */
export function generateRandomSeed() {
  return randomBytes(8).readBigInt64BE(0).toString();
}

/**
 * Compartmentalized read-only SQLite seed provider.
 *
 * Expects up to three independent SQLite files in `seedsDir`:
 *   - overworld.db
 *   - nether.db
 *   - end.db
 *
 * Schema per DB:
 *   CREATE TABLE seeds (
 *     type TEXT NOT NULL,
 *     seq  INTEGER NOT NULL,
 *     seed TEXT NOT NULL,
 *     PRIMARY KEY (type, seq)
 *   ) WITHOUT ROWID;
 *
 *   CREATE TABLE type_counts (
 *     type  TEXT PRIMARY KEY,
 *     count INTEGER NOT NULL
 *   ) WITHOUT ROWID;
 */
export class SeedProvider {
  constructor(seedsDir) {
    this.seedsDir = resolve(seedsDir || process.env.SEEDS_DIR || "./data/seeds");
    this.stores = new Map(); // dimension -> { db, stmtBySeq, types: [{ type, count }] }
  }

  init() {
    this.reload();
  }

  close() {
    for (const store of this.stores.values()) {
      try {
        store.db.close();
      } catch {
        // ignore close errors
      }
    }
    this.stores.clear();
  }

  reload() {
    this.close();

    for (const dim of DIMENSIONS) {
      const dbPath = join(this.seedsDir, `${dim}.db`);
      if (!existsSync(dbPath)) {
        console.log(`[seeds] ${dim}.db not found at ${dbPath} — using random fallback`);
        continue;
      }

      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const rows = db.prepare("SELECT type, count FROM type_counts WHERE count > 0").all();
        const types = rows.map((r) => ({ type: String(r.type), count: Number(r.count) }));
        const stmtBySeq = db.prepare("SELECT seed FROM seeds WHERE type = ? AND seq = ?");

        if (types.length === 0) {
          db.close();
          console.warn(`[seeds] ${dim}.db has no populated types — using random fallback`);
          continue;
        }

        this.stores.set(dim, { db, stmtBySeq, types });
        const total = types.reduce((acc, t) => acc + t.count, 0);
        console.log(`[seeds] loaded ${dim}.db (${total} seeds across ${types.length} types)`);
      } catch (err) {
        console.error(`[seeds] failed to open ${dbPath}:`, err.message);
      }
    }
  }

  /**
   * Picks a single seed for a dimension in O(1) time.
   * Falls back to a random 64-bit seed if no DB is loaded for that dimension.
   */
  pickSeed(dimension, preferredType = null) {
    const store = this.stores.get(dimension);
    if (!store || store.types.length === 0) {
      return { seed: generateRandomSeed(), type: "random", source: "fallback" };
    }

    let bucket = null;
    if (preferredType) {
      bucket = store.types.find((t) => t.type === preferredType) || null;
    }
    if (!bucket) {
      // Uniform across available types for variety
      bucket = store.types[randomInt(0, store.types.length)];
    }

    const seq = randomInt(0, bucket.count);
    const row = store.stmtBySeq.get(bucket.type, seq);
    if (!row || row.seed == null) {
      return { seed: generateRandomSeed(), type: "random", source: "fallback" };
    }

    return { seed: String(row.seed), type: bucket.type, source: "sqlite" };
  }

  /**
   * Picks independent seeds for Overworld, Nether, and End.
   */
  pickMatchSeeds(_mode, preferredTypes = {}) {
    const ow = this.pickSeed("overworld", preferredTypes.overworld || null);
    const nether = this.pickSeed("nether", preferredTypes.nether || null);
    const end = this.pickSeed("end", preferredTypes.end || null);

    return {
      overworldSeed: ow.seed,
      netherSeed: nether.seed,
      endSeed: end.seed,
      types: {
        overworld: ow.type,
        nether: nether.type,
        end: end.type,
      },
    };
  }

  getStats() {
    const stats = {};
    for (const dim of DIMENSIONS) {
      const store = this.stores.get(dim);
      if (!store) {
        stats[dim] = { loaded: false, total: 0, types: {} };
        continue;
      }
      const types = {};
      let total = 0;
      for (const t of store.types) {
        types[t.type] = t.count;
        total += t.count;
      }
      stats[dim] = { loaded: true, total, types };
    }
    return stats;
  }
}
