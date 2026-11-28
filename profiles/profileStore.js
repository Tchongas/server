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
      const validIds = { title: new Set(), cardBg: new Set(["default"]) };
      const statKeys = new Set(["fish_caught", "kill_villager", "kill_endermite", "kill_silverfish"]);

      const addEntries = (category, list) => {
        if (!Array.isArray(list)) return;
        for (const item of list) {
          if (!item || typeof item.id !== "string") continue;
          const id = item.id.trim();
          if (!id) continue;
          if (validIds[category]) validIds[category].add(id);
          if (!item.unlock) continue;
          const u = item.unlock;
          const rule = {};
          if (typeof u.stat === "string" && u.stat.trim() && Number(u.target) > 0) {
            rule.stat = u.stat.trim();
            rule.target = Math.floor(Number(u.target));
            statKeys.add(rule.stat);
          } else if (Number(u.level) > 0) {
            rule.level = Math.floor(Number(u.level));
          } else if (typeof u.event === "string" && u.event.trim()) {
            rule.event = u.event.trim();
          } else {
            continue;
          }
          if (!rules[category]) rules[category] = {};
          rules[category][id] = rule;
        }
      };

      addEntries("title", cfg.titles);
      addEntries("cardBg", cfg.cardBackgrounds);
      console.log(`[profiles] loaded cosmetics config from ${filePath}`);
      return { rules, validIds, statKeys };
    } catch (err) {
      console.warn(`[profiles] failed to parse cosmetics config ${filePath}:`, err.message);
    }
  }

  return {
    rules: FALLBACK_UNLOCK_RULES,
    validIds: {
      title: new Set(Object.keys(FALLBACK_UNLOCK_RULES.title)),
      cardBg: null, // Do not reject new client cardBg IDs if server cosmetics.json is absent
    },
    statKeys: new Set(["fish_caught", "kill_villager", "kill_endermite", "kill_silverfish"]),
  };
}

const { rules: UNLOCK_RULES, validIds: VALID_COSMETIC_IDS, statKeys: ALLOWED_STAT_KEYS } = loadCosmeticsRules();
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

export function computeLevel(totalXp) {
  let remaining = Math.max(0, Math.floor(Number(totalXp) || 0));
  let level = 0;
  while (true) {
    const needed = 100 + level * 50;
    if (remaining < needed) {
      return { level, xpIntoLevel: remaining, xpForNextLevel: needed };
    }
    remaining -= needed;
    level++;
  }
}

function isCosmeticUnlocked(unlocks, category, value, level = 0) {
  if (!value) return true;
  if (category === "cardBg") {
    // Allow any safe ID format so new client backgrounds aren't rejected before server config sync,
    // while still enforcing unlock rules below if the ID has one.
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(value)) {
      return false;
    }
  } else {
    // Whitelist titles against the known catalog so arbitrary client strings cannot be equipped
    const validSet = VALID_COSMETIC_IDS[category];
    if (validSet && !validSet.has(value)) {
      return false;
    }
  }
  const categoryRules = UNLOCK_RULES[category];
  if (!categoryRules || !(value in categoryRules)) {
    return true;
  }
  const rule = categoryRules[value];
  if (rule.level && level >= rule.level) {
    return true;
  }
  const owned = Array.isArray(unlocks?.[category]) ? unlocks[category] : [];
  return owned.includes(value);
}

function sanitizeCosmetics(input, existing = {}, unlocks = {}, level = 0) {
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
        if (isCosmeticUnlocked(unlocks, key, sliced, level)) {
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
        xp         INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_profiles_name
        ON profiles (name COLLATE NOCASE);
    `);

    // Safe migration for existing databases created before stats/unlocks/xp columns
    this.ensureColumn("stats", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("unlocks", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("xp", "INTEGER NOT NULL DEFAULT 0");

    this.stmtGetByUuid = this.db.prepare(
      "SELECT uuid, name, cosmetics, stats, unlocks, xp, updated_at FROM profiles WHERE uuid = ?"
    );
    this.stmtGetByName = this.db.prepare(
      "SELECT uuid, name, cosmetics, stats, unlocks, xp, updated_at FROM profiles WHERE name = ? COLLATE NOCASE LIMIT 1"
    );
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO profiles (uuid, name, cosmetics, stats, unlocks, xp, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uuid) DO UPDATE SET
        name = excluded.name,
        cosmetics = excluded.cosmetics,
        stats = excluded.stats,
        unlocks = excluded.unlocks,
        xp = excluded.xp,
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
    const xp = Number(row.xp) || 0;
    return {
      uuid: row.uuid,
      name: row.name,
      cosmetics: parseJsonObject(row.cosmetics),
      stats: parseJsonObject(row.stats),
      unlocks: parseJsonObject(row.unlocks),
      xp,
      level: computeLevel(xp).level,
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
          existing.xp,
          Date.now()
        );
      }
      return { ...existing, name };
    }
    const now = Date.now();
    this.stmtUpsert.run(uuid, name, "{}", "{}", "{}", 0, now);
    return { uuid, name, cosmetics: {}, stats: {}, unlocks: {}, xp: 0, level: 0, updatedAt: now };
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
    const merged = sanitizeCosmetics(patch, current.cosmetics, current.unlocks, current.level);
    const now = Date.now();
    this.stmtUpsert.run(
      uuid,
      name,
      JSON.stringify(merged),
      JSON.stringify(current.stats),
      JSON.stringify(current.unlocks),
      current.xp,
      now
    );
    return { ...current, name, cosmetics: merged, updatedAt: now };
  }

  addXp(uuid, name, amount) {
    const current = this.ensureProfile(uuid, name);
    const gain = Math.max(0, Math.min(500, Math.floor(Number(amount) || 0)));
    if (gain <= 0) {
      return { profile: current, xpGained: 0, leveledUp: false, newlyUnlocked: [] };
    }
    const nextXp = current.xp + gain;
    const nextLevel = computeLevel(nextXp).level;
    const leveledUp = nextLevel > current.level;

    const nextUnlocks = {};
    for (const [cat, list] of Object.entries(current.unlocks)) {
      if (Array.isArray(list)) nextUnlocks[cat] = [...list];
    }

    const newlyUnlocked = [];
    for (const [category, rules] of Object.entries(UNLOCK_RULES)) {
      if (!nextUnlocks[category]) nextUnlocks[category] = [];
      const owned = new Set(nextUnlocks[category]);
      for (const [id, rule] of Object.entries(rules)) {
        if (owned.has(id)) continue;
        if (rule.level && nextLevel >= rule.level) {
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
      JSON.stringify(current.stats),
      JSON.stringify(nextUnlocks),
      nextXp,
      now
    );
    const profile = {
      ...current,
      name,
      xp: nextXp,
      level: nextLevel,
      unlocks: nextUnlocks,
      updatedAt: now,
    };
    return { profile, xpGained: gain, leveledUp, newlyUnlocked };
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
        const clamped = Math.min(delta, 200);
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
      current.xp,
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
