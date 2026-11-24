import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Allowed cosmetic keys and their max string lengths.
 * Add new keys here (e.g. "badge", "banner") without any DB schema migration.
 */
const ALLOWED_COSMETIC_KEYS = {
  title: 40,
  cardBg: 32,
  country: 8,
};

function sanitizeCosmetics(input, existing = {}) {
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
        result[key] = trimmed.slice(0, maxLen);
      }
    }
  }
  return result;
}

function parseCosmetics(raw) {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Lightweight, expandable SQLite profile store for player customizations.
 *
 * Stores each player's cosmetics as a compact JSON object keyed by Mojang UUID,
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
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_profiles_name
        ON profiles (name COLLATE NOCASE);
    `);

    this.stmtGetByUuid = this.db.prepare(
      "SELECT uuid, name, cosmetics, updated_at FROM profiles WHERE uuid = ?"
    );
    this.stmtGetByName = this.db.prepare(
      "SELECT uuid, name, cosmetics, updated_at FROM profiles WHERE name = ? COLLATE NOCASE LIMIT 1"
    );
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO profiles (uuid, name, cosmetics, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(uuid) DO UPDATE SET
        name = excluded.name,
        cosmetics = excluded.cosmetics,
        updated_at = excluded.updated_at
    `);
    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS count FROM profiles");

    console.log(`[profiles] opened ${this.dbPath} (${this.getCount()} profiles)`);
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

  /**
   * Ensures a player row exists on login and keeps their latest Mojang username synced.
   */
  ensureProfile(uuid, name) {
    const existing = this.getByUuid(uuid);
    if (existing) {
      if (existing.name !== name) {
        this.stmtUpsert.run(uuid, name, JSON.stringify(existing.cosmetics), Date.now());
      }
      return { ...existing, name };
    }
    const now = Date.now();
    this.stmtUpsert.run(uuid, name, "{}", now);
    return { uuid, name, cosmetics: {}, updatedAt: now };
  }

  getByUuid(uuid) {
    if (!this.db || !uuid) return null;
    const row = this.stmtGetByUuid.get(String(uuid));
    if (!row) return null;
    return {
      uuid: row.uuid,
      name: row.name,
      cosmetics: parseCosmetics(row.cosmetics),
      updatedAt: Number(row.updated_at),
    };
  }

  getByName(name) {
    if (!this.db || !name) return null;
    const row = this.stmtGetByName.get(String(name));
    if (!row) return null;
    return {
      uuid: row.uuid,
      name: row.name,
      cosmetics: parseCosmetics(row.cosmetics),
      updatedAt: Number(row.updated_at),
    };
  }

  getByIdentifier(id) {
    if (!id) return null;
    const trimmed = String(id).trim();
    if (!trimmed) return null;
    // Mojang UUIDs are 32 hex chars (or 36 with dashes)
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
    const merged = sanitizeCosmetics(patch, current.cosmetics);
    const now = Date.now();
    this.stmtUpsert.run(uuid, name, JSON.stringify(merged), now);
    return { uuid, name, cosmetics: merged, updatedAt: now };
  }
}
