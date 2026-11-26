import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Allowed cosmetic keys and their max string lengths.
 * Add new keys here (e.g. "badge", "banner") without any DB schema migration.
 */
const ALLOWED_COSMETIC_KEYS = {
  title: 40,
  cardBg: 32,
  country: 8,
};

const FALLBACK_UNLOCK_RULES = {
  title: {
    "Fisherman":    { stat: "fish_caught", target: 50 },
    "Pillager":     { stat: "kill_villager", target: 50 },
    "Pest Control": { event: "pest_control" },
    "Pro Choker":   { event: "pro_choker" },
  },
};

function loadCosmeticsRules() {
  const candidates = [
    process.env.COSMETICS_CONFIG,
    resolve(__dirname, "./cosmetics.json"),
    resolve(__dirname, "../../src/main/resources/timetrials_cosmetics.json"),
  ].filter(Boolean);

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const cfg = JSON.parse(readFileSync(filePath, "utf8"));
      const rules = {};
      const statKeys = new Set(["fish_caught", "kill_villager", "kill_endermite", "kill_silverfish"]);

      const addEntries = (category, list) => {
        if (!Array.isArray(list)) return;
        for (const item of list) {
          if (!item || typeof item.id !== "string" || !item.unlock) continue;
          const u = item.unlock;
          const rule = {};
          if (typeof u.stat === "string" && u.stat.trim() && Number(u.target) > 0) {
            rule.stat = u.stat.trim();
            rule.target = Math.floor(Number(u.target));
            statKeys.add(rule.stat);
          } else if (typeof u.event === "string" && u.event.trim()) {
            rule.event = u.event.trim();
          } else {
            continue;
          }
          if (!rules[category]) rules[category] = {};
          rules[category][item.id.trim()] = rule;
        }
      };

      addEntries("title", cfg.titles);
      addEntries("cardBg", cfg.cardBackgrounds);
      console.log(`[profiles] loaded cosmetics config from ${filePath}`);
      return { rules, statKeys };
    } catch (err) {
      console.warn(`[profiles] failed to parse cosmetics config ${filePath}:`, err.message);
    }
  }

  return {
    rules: FALLBACK_UNLOCK_RULES,
    statKeys: new Set(["fish_caught", "kill_villager", "kill_endermite", "kill_silverfish"]),
  };
}

const { rules: UNLOCK_RULES, statKeys: ALLOWED_STAT_KEYS } = loadCosmeticsRules();
export { UNLOCK_RULES };

function parseJsonObject(raw) {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isCosmeticUnlocked(unlocks, category, value) {
  if (!value) return true;
  const categoryRules = UNLOCK_RULES[category];
  if (!categoryRules || !(value in categoryRules)) {
    return true;
  }
  const owned = Array.isArray(unlocks?.[category]) ? unlocks[category] : [];
  return owned.includes(value);
}

function sanitizeCosmetics(input, existing = {}, unlocks = {}) {
  const result = { ...existing };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return result;
  }

  for (const [key, maxLen] of Object.entries(ALLOWED_COSMETIC_KEYS)) {
    if (!(key in input)) continue;
    const val = input[key];
    if (val === null || val === "") {
      delete result[key];
    } else if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.length === 0) {
        delete result[key];
      } else {
        const sliced = trimmed.slice(0, maxLen);
        if (isCosmeticUnlocked(unlocks, key, sliced)) {
          result[key] = sliced;
        }
      }
    }
  }
  return result;
}

/**
 * Lightweight, expandable SQLite profile store for player customizations,
 * cumulative online stats, and cosmetic unlocks.
 *
 * Stores cosmetics, stats, and unlocks as compact JSON columns keyed by Mojang UUID,
 * with a case-insensitive username index for fast client lookups.
 */
export class ProfileStore {
  constructor(dbPath) {
    this.dbPath = resolve(dbPath || process.env.PROFILES_DB || "./data/profiles.db");
    this.db = null;
  }

  init() {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS profiles (
        uuid       TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        cosmetics  TEXT NOT NULL DEFAULT '{}',
        stats      TEXT NOT NULL DEFAULT '{}',
        unlocks    TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_profiles_name
        ON profiles (name COLLATE NOCASE);
    `);

    // Safe migration for existing databases created before stats/unlocks columns
    this.ensureColumn("stats", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("unlocks", "TEXT NOT NULL DEFAULT '{}'");

    this.stmtGetByUuid = this.db.prepare(
      "SELECT uuid, name, cosmetics, stats, unlocks, updated_at FROM profiles WHERE uuid = ?"
    );
    this.stmtGetByName = this.db.prepare(
      "SELECT uuid, name, cosmetics, stats, unlocks, updated_at FROM profiles WHERE name = ? COLLATE NOCASE LIMIT 1"
    );
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO profiles (uuid, name, cosmetics, stats, unlocks, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(uuid) DO UPDATE SET
        name = excluded.name,
        cosmetics = excluded.cosmetics,
        stats = excluded.stats,
        unlocks = excluded.unlocks,
        updated_at = excluded.updated_at
    `);
    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS count FROM profiles");

    console.log(`[profiles] opened ${this.dbPath} (${this.getCount()} profiles)`);
  }

  ensureColumn(columnName, definition) {
    try {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN ${columnName} ${definition}`);
    } catch {
      // Column already exists
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  getCount() {
    if (!this.db) return 0;
    const row = this.stmtCount.get();
    return row ? Number(row.count) : 0;
  }

  rowToProfile(row) {
    if (!row) return null;
    return {
      uuid: row.uuid,
      name: row.name,
      cosmetics: parseJsonObject(row.cosmetics),
      stats: parseJsonObject(row.stats),
      unlocks: parseJsonObject(row.unlocks),
      updatedAt: Number(row.updated_at),
    };
  }

  /**
   * Ensures a player row exists on login and keeps their latest Mojang username synced.
   */
  ensureProfile(uuid, name) {
    const existing = this.getByUuid(uuid);
    if (existing) {
      if (existing.name !== name) {
        this.stmtUpsert.run(
          uuid,
          name,
          JSON.stringify(existing.cosmetics),
          JSON.stringify(existing.stats),
          JSON.stringify(existing.unlocks),
          Date.now()
        );
      }
      return { ...existing, name };
    }
    const now = Date.now();
    this.stmtUpsert.run(uuid, name, "{}", "{}", "{}", now);
    return { uuid, name, cosmetics: {}, stats: {}, unlocks: {}, updatedAt: now };
  }

  getByUuid(uuid) {
    if (!this.db || !uuid) return null;
    return this.rowToProfile(this.stmtGetByUuid.get(String(uuid)));
  }

  getByName(name) {
    if (!this.db || !name) return null;
    return this.rowToProfile(this.stmtGetByName.get(String(name)));
  }

  getByIdentifier(id) {
    if (!id) return null;
    const trimmed = String(id).trim();
    if (!trimmed) return null;
    if (/^[0-9a-f-]{32,36}$/i.test(trimmed)) {
      const byUuid = this.getByUuid(trimmed.replace(/-/g, ""));
      if (byUuid) return byUuid;
    }
    return this.getByName(trimmed);
  }

  getManyByNames(names) {
    const out = {};
    for (const raw of names.slice(0, 32)) {
      const name = String(raw || "").trim();
      if (!name) continue;
      const profile = this.getByName(name);
      if (profile) {
        out[profile.name] = profile;
      }
    }
    return out;
  }

  getManyByUuids(uuids) {
    const out = {};
    for (const raw of uuids.slice(0, 32)) {
      const uuid = String(raw || "").trim().replace(/-/g, "");
      if (!uuid) continue;
      const profile = this.getByUuid(uuid);
      if (profile) {
        out[profile.uuid] = profile;
      }
    }
    return out;
  }

  updateCosmetics(uuid, name, patch) {
    const current = this.ensureProfile(uuid, name);
    const merged = sanitizeCosmetics(patch, current.cosmetics, current.unlocks);
    const now = Date.now();
    this.stmtUpsert.run(
      uuid,
      name,
      JSON.stringify(merged),
      JSON.stringify(current.stats),
      JSON.stringify(current.unlocks),
      now
    );
    return { ...current, name, cosmetics: merged, updatedAt: now };
  }

  /**
   * Merges end-of-match vanilla stat deltas and triggered event flags into the player's
   * profile, evaluates all cosmetic unlock rules, and persists in a single SQLite write.
   */
  applyMatchStats(uuid, name, statDeltas = {}, events = []) {
    const current = this.ensureProfile(uuid, name);
    const nextStats = { ...current.stats };

    if (statDeltas && typeof statDeltas === "object" && !Array.isArray(statDeltas)) {
      for (const [key, rawVal] of Object.entries(statDeltas)) {
        if (!ALLOWED_STAT_KEYS.has(key)) continue;
        const delta = Math.floor(Number(rawVal));
        if (!Number.isFinite(delta) || delta <= 0) continue;
        // Cap single-match delta to prevent bogus/overflow values
        const clamped = Math.min(delta, 10000);
        nextStats[key] = (Number(nextStats[key]) || 0) + clamped;
      }
    }

    const eventSet = new Set(Array.isArray(events) ? events.map((e) => String(e)) : []);
    // Also evaluate per-match stat combos server-side
    if (Number(statDeltas?.kill_endermite) >= 1 && Number(statDeltas?.kill_silverfish) >= 1) {
      eventSet.add("pest_control");
    }

    const nextUnlocks = {};
    for (const [cat, list] of Object.entries(current.unlocks)) {
      if (Array.isArray(list)) {
        nextUnlocks[cat] = [...list];
      }
    }

    const newlyUnlocked = [];
    for (const [category, rules] of Object.entries(UNLOCK_RULES)) {
      if (!nextUnlocks[category]) {
        nextUnlocks[category] = [];
      }
      const owned = new Set(nextUnlocks[category]);
      for (const [id, rule] of Object.entries(rules)) {
        if (owned.has(id)) continue;
        let met = false;
        if (rule.stat && (Number(nextStats[rule.stat]) || 0) >= rule.target) {
          met = true;
        } else if (rule.event && eventSet.has(rule.event)) {
          met = true;
        }
        if (met) {
          owned.add(id);
          nextUnlocks[category].push(id);
          newlyUnlocked.push({ category, id });
        }
      }
    }

    const now = Date.now();
    this.stmtUpsert.run(
      uuid,
      name,
      JSON.stringify(current.cosmetics),
      JSON.stringify(nextStats),
      JSON.stringify(nextUnlocks),
      now
    );

    const profile = {
      ...current,
      name,
      stats: nextStats,
      unlocks: nextUnlocks,
      updatedAt: now,
    };
    return { profile, newlyUnlocked };
  }
}
