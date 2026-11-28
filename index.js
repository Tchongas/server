import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SeedProvider } from "./seeds/seedProvider.js";
import { ProfileStore } from "./profiles/profileStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_XP_CFG = {
  scaling: "TIME",
  minSeconds: 60,
  base: 40,
  perUnit: 10,
  unitStep: 30,
  max: 250,
  multiplayerMultiplier: 1.5,
  winBonus: 35,
};

function parseXpConfig(raw, fallbackMinSeconds = 60) {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_XP_CFG, minSeconds: fallbackMinSeconds };
  }
  const scaling = String(raw.scaling || DEFAULT_XP_CFG.scaling).toUpperCase();
  const minSeconds = Number.isFinite(Number(raw.minSeconds)) && Number(raw.minSeconds) >= 0
    ? Math.floor(Number(raw.minSeconds)) : fallbackMinSeconds;
  const base = Number.isFinite(Number(raw.base)) ? Math.max(0, Math.floor(Number(raw.base))) : DEFAULT_XP_CFG.base;
  const perUnit = Number.isFinite(Number(raw.perUnit)) ? Math.max(0, Number(raw.perUnit)) : DEFAULT_XP_CFG.perUnit;
  const unitStep = Number.isFinite(Number(raw.unitStep)) && Number(raw.unitStep) > 0
    ? Number(raw.unitStep) : DEFAULT_XP_CFG.unitStep;
  const max = Number.isFinite(Number(raw.max)) && Number(raw.max) >= base
    ? Math.floor(Number(raw.max)) : Math.max(base, DEFAULT_XP_CFG.max);
  const multiplayerMultiplier = Number.isFinite(Number(raw.multiplayerMultiplier)) && Number(raw.multiplayerMultiplier) >= 1
    ? Number(raw.multiplayerMultiplier) : DEFAULT_XP_CFG.multiplayerMultiplier;
  const winBonus = Number.isFinite(Number(raw.winBonus)) ? Math.max(0, Math.floor(Number(raw.winBonus))) : DEFAULT_XP_CFG.winBonus;
  return { scaling, minSeconds, base, perUnit, unitStep, max, multiplayerMultiplier, winBonus };
}

function computeRunXp(xpCfg, { elapsedSeconds = 0, score = 0, multiplayer = false, winner = false }) {
  const cfg = xpCfg || DEFAULT_XP_CFG;
  if (elapsedSeconds < cfg.minSeconds) return 0;

  let units = 0;
  if (cfg.scaling === "SCORE") {
    units = Math.max(0, Number(score) || 0) / cfg.unitStep;
  } else if (cfg.scaling === "TIME") {
    units = Math.max(0, Number(elapsedSeconds) || 0) / cfg.unitStep;
  }

  let rawXp = Math.round(cfg.base + units * cfg.perUnit);
  rawXp = Math.min(cfg.max, Math.max(cfg.base, rawXp));

  if (multiplayer) {
    rawXp = Math.round(rawXp * cfg.multiplayerMultiplier);
    if (winner) {
      rawXp += cfg.winBonus;
    }
  }
  return Math.max(0, rawXp);
}

function parseSeedTypes(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const dim of ["overworld", "nether", "end"]) {
    const val = raw[dim];
    if (typeof val === "string" && val.trim()) {
      out[dim] = [val.trim().toLowerCase()];
    } else if (Array.isArray(val)) {
      const list = val.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean);
      if (list.length > 0) out[dim] = list;
    }
  }
  return out;
}

function loadModeFlags() {
  const flags = new Map([
    ["time_trial", {
      lastStanding: true,
      scoreMode: false,
      seedTypes: { overworld: ["village"] },
      xp: { ...DEFAULT_XP_CFG },
    }],
    ["craft_random_item", {
      lastStanding: false,
      scoreMode: true,
      seedTypes: {},
      xp: { ...DEFAULT_XP_CFG, scaling: "SCORE", base: 30, perUnit: 15, unitStep: 1 },
    }],
  ]);
  const candidates = [
    process.env.MODES_CONFIG,
    resolve(__dirname, "./modes.json"),
    resolve(__dirname, "../src/main/resources/timetrials_modes.json"),
  ].filter(Boolean);
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const cfg = JSON.parse(readFileSync(filePath, "utf8"));
      if (Array.isArray(cfg?.modes)) {
        for (const m of cfg.modes) {
          if (!m || typeof m.id !== "string") continue;
          const id = m.id.trim();
          const scoreMode = String(m.resultType || "").toUpperCase() === "SCORE"
            || String(m.tabListType || "").toUpperCase() === "SCORE";
          const lastStanding = !scoreMode && String(m.tabListType || "").toUpperCase() === "REMAINING_TIME";
          const fallbackMin = Number.isFinite(Number(m.minXpSeconds)) && Number(m.minXpSeconds) >= 0
            ? Math.floor(Number(m.minXpSeconds)) : 60;
          const xp = parseXpConfig(m.xp, fallbackMin);
          const seedTypes = parseSeedTypes(m.seedTypes);
          flags.set(id, { lastStanding, scoreMode, seedTypes, xp });
        }
        console.log(`[modes] loaded ${flags.size} mode definitions from ${filePath}`);
      }
      break;
    } catch (err) {
      console.warn(`[modes] failed to parse ${filePath}:`, err.message);
    }
  }
  return flags;
}

const MODE_FLAGS = loadModeFlags();

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const SEEDS_DIR = process.env.SEEDS_DIR || "./data/seeds";
const PROFILES_DB = process.env.PROFILES_DB || "./data/profiles.db";
const RELEASES_DIR = resolve(process.env.RELEASES_DIR || resolve(__dirname, "./releases"));
const SERVER_VERSION = "0.2.0";

function loadReleaseInfo() {
  const manifestPath = resolve(RELEASES_DIR, "release.json");
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
    const version = typeof raw.version === "string" ? raw.version.trim() : "";
    if (!version) return null;

    const externalUrl = typeof raw.downloadUrl === "string" && raw.downloadUrl.trim() ? raw.downloadUrl.trim() : "";
    const file = typeof raw.file === "string" ? raw.file.trim() : "";
    let jarPath = file ? resolve(RELEASES_DIR, file) : "";
    if (jarPath && !jarPath.startsWith(RELEASES_DIR + sep)) {
      console.warn(`[update] ignoring unsafe release file path: ${file}`);
      jarPath = "";
    }

    let sha256 = typeof raw.sha256 === "string" ? raw.sha256.trim() : "";
    let size = 0;
    let hasLocalJar = false;

    if (jarPath && existsSync(jarPath)) {
      const buf = readFileSync(jarPath);
      size = buf.length;
      if (!sha256) {
        sha256 = createHash("sha256").update(buf).digest("hex");
      }
      hasLocalJar = true;
    }

    console.log(`[update] latest mod version=${version} (${hasLocalJar ? `${file}, ${size} bytes` : externalUrl || "no jar yet"})`);
    return {
      version,
      file,
      jarPath,
      hasLocalJar,
      size,
      sha256,
      downloadPath: externalUrl || "/api/update/download",
    };
  } catch (err) {
    console.warn(`[update] failed to read ${manifestPath}:`, err.message);
    return null;
  }
}

let releaseInfo = loadReleaseInfo();

const seedProvider = new SeedProvider(SEEDS_DIR);
seedProvider.init();
const profileStore = new ProfileStore(PROFILES_DB);
profileStore.init();
process.on("SIGHUP", () => {
  console.log("[seeds] SIGHUP received — reloading SQLite seed packs & release info...");
  seedProvider.reload();
  releaseInfo = loadReleaseInfo();
});
const MAX_PAYLOAD_BYTES = 8 * 1024;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MSGS = 30;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_WS_PER_IP = 5;
const HTTP_RATE_WINDOW_MS = 60 * 1000;
const COUNTDOWN_SECONDS = 5;
const LOBBY_WAIT_MS = 15000;
const LOBBY_LOCK_REMAINING_MS = 6000;
const LOBBY_FULL_WAIT_MS = 3000;
const MIN_MATCH_PLAYERS = 2;
const MAX_MATCH_PLAYERS = 6;
const MAX_ROOM_PLAYERS = 8;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// In-memory state (no DB, no ELO, no match history)
const sessionsByToken = new Map(); // resumeToken -> Session
const sessionsByUuid = new Map();  // uuid -> Session (prevents duplicate logins / self-matchmaking)
const wsCountByIp = new Map();     // ip -> active WS count
const httpRateByIp = new Map();    // ip:bucket -> { start, count }
const roomsByCode = new Map();     // code -> Room (both private rooms and public matchmaking lobbies)
const matchesById = new Map();     // matchId -> Match
const recentMatchStats = new Map(); // matchId -> { uuids: Set, submitted: Set, expiresAt }
const queuesByMode = new Map();    // mode -> Set<Session> (legacy/unused once lobbies are active)

function findOpenPublicLobby(mode, uuid) {
  const now = Date.now();
  let best = null;
  for (const room of roomsByCode.values()) {
    if (!room.publicLobby || room.mode !== mode) continue;
    if (room.players.length >= MAX_MATCH_PLAYERS) continue;
    // Lock the lobby once 6 seconds or fewer remain on its countdown
    if (room.countdownEndsAt > 0 && room.countdownEndsAt - now <= LOBBY_LOCK_REMAINING_MS) continue;
    if (room.players.some((p) => p.session.uuid === uuid)) continue;
    if (!best || room.players.length > best.players.length) {
      best = room;
    }
  }
  return best;
}

function updatePublicLobbyTimer(room) {
  if (!room || !room.publicLobby) return;
  if (room.players.length < MIN_MATCH_PLAYERS) {
    if (room.startTimer) {
      clearTimeout(room.startTimer);
      room.startTimer = null;
    }
    room.countdownEndsAt = 0;
    return;
  }

  const now = Date.now();
  const desiredDelay = room.players.length >= MAX_MATCH_PLAYERS ? LOBBY_FULL_WAIT_MS : LOBBY_WAIT_MS;
  const remaining = room.countdownEndsAt > now ? room.countdownEndsAt - now : Infinity;

  if (!room.startTimer || desiredDelay < remaining) {
    if (room.startTimer) clearTimeout(room.startTimer);
    room.countdownEndsAt = now + desiredDelay;
    room.startTimer = setTimeout(() => {
      room.startTimer = null;
      if (!roomsByCode.has(room.code)) return;
      if (room.players.length < MIN_MATCH_PLAYERS) {
        room.countdownEndsAt = 0;
        broadcastRoom(room);
        return;
      }
      roomsByCode.delete(room.code);
      const sessions = room.players.map((p) => p.session);
      for (const s of sessions) {
        s.roomCode = null;
        s.queuedMode = null;
      }
      startMatch(room.mode, sessions, null);
    }, desiredDelay);
  }
}

function getClientIp(req) {
  const fwd = req?.headers?.["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) {
    return fwd.split(",")[0].trim();
  }
  return req?.socket?.remoteAddress || "unknown";
}

function allowHttpRequest(ip, bucket, maxPerWindow) {
  const key = `${ip}:${bucket}`;
  const now = Date.now();
  let rec = httpRateByIp.get(key);
  if (!rec || now - rec.start >= HTTP_RATE_WINDOW_MS) {
    rec = { start: now, count: 0 };
    httpRateByIp.set(key, rec);
  }
  rec.count++;
  return rec.count <= maxPerWindow;
}

// Periodic cleanup of expired resume tokens and stale HTTP rate buckets
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessionsByToken) {
    if (now - (s.lastSeenAt || 0) > SESSION_TTL_MS && (!s.ws || s.ws.readyState !== s.ws.OPEN)) {
      sessionsByToken.delete(token);
      if (sessionsByUuid.get(s.uuid) === s) {
        sessionsByUuid.delete(s.uuid);
      }
    }
  }
  for (const [key, rec] of httpRateByIp) {
    if (now - rec.start >= HTTP_RATE_WINDOW_MS) {
      httpRateByIp.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

let countsBroadcastTimer = null;
let lastCountsJson = "";

function computeModeCounts() {
  const counts = {};
  for (const room of roomsByCode.values()) {
    if (room.publicLobby && room.players.length > 0) {
      counts[room.mode] = (counts[room.mode] || 0) + room.players.length;
    }
  }
  for (const match of matchesById.values()) {
    if (!match.finished) {
      counts[match.mode] = (counts[match.mode] || 0) + match.players.length;
    }
  }
  return counts;
}

function sendModeCounts(ws) {
  send(ws, { type: "mode_counts", counts: computeModeCounts() });
}

function scheduleModeCountsBroadcast() {
  if (countsBroadcastTimer) return;
  countsBroadcastTimer = setTimeout(() => {
    countsBroadcastTimer = null;
    const payload = JSON.stringify({ type: "mode_counts", counts: computeModeCounts() });
    if (payload === lastCountsJson) return;
    lastCountsJson = payload;
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }, 1500);
}

function leaveQueue(session, notify = true) {
  if (!session || !session.queuedMode) return;
  const mode = session.queuedMode;
  session.queuedMode = null;
  const set = queuesByMode.get(mode);
  if (set) {
    set.delete(session);
    if (set.size === 0) queuesByMode.delete(mode);
  }
  if (notify) {
    send(session.ws, { type: "queue_state", inQueue: false, queueSize: 0, mode: "" });
  }
  scheduleModeCountsBroadcast();
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function sendError(ws, code, message) {
  send(ws, { type: "error", code, message });
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = "";
    const bytes = randomBytes(4);
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_CHARS[bytes[i] % ROOM_CODE_CHARS.length];
    }
    if (!roomsByCode.has(code)) return code;
  }
  return randomBytes(3).toString("hex").toUpperCase();
}

/**
 * Strict Mojang session verification (no offline accounts allowed).
 */
async function verifyMojangSession(username, serverId) {
  if (!username || !serverId) return null;
  const url = `https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${encodeURIComponent(username)}&serverId=${encodeURIComponent(serverId)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.status !== 200) return null;
    const data = await res.json();
    if (!data || !data.id || !data.name) return null;
    return { uuid: data.id, name: data.name };
  } catch (err) {
    console.warn("[auth] Mojang verification error:", err.message);
    return null;
  }
}

function broadcastRoom(room) {
  const payload = {
    type: "room_state",
    code: room.code,
    mode: room.mode,
    owner: room.owner,
    publicLobby: Boolean(room.publicLobby),
    countdownEndsAt: room.countdownEndsAt || 0,
    players: room.players.map((p) => ({
      name: p.name,
      ready: p.ready,
      cosmetics: { ...(p.session.cosmetics || {}), level: p.session.level || 0 },
    })),
  };
  for (const p of room.players) {
    send(p.session.ws, payload);
  }
}

function leaveRoom(session) {
  if (!session.roomCode) return;
  const room = roomsByCode.get(session.roomCode);
  session.roomCode = null;
  session.queuedMode = null;
  if (!room) return;

  room.players = room.players.filter((p) => p.session !== session);
  if (room.players.length === 0) {
    if (room.startTimer) {
      clearTimeout(room.startTimer);
      room.startTimer = null;
    }
    roomsByCode.delete(room.code);
  } else {
    if (room.owner === session.name) {
      room.owner = room.players[0].name;
    }
    if (room.publicLobby) {
      updatePublicLobbyTimer(room);
    }
    broadcastRoom(room);
  }
  if (room.publicLobby) {
    scheduleModeCountsBroadcast();
  }
}

function startMatch(mode, playerSessions, roomCode = null, seedChanged = false) {
  const matchId = randomUUID();
  const modeFlags = MODE_FLAGS.get(mode) || { lastStanding: false, scoreMode: false, seedTypes: {} };
  const { overworldSeed, netherSeed, endSeed, types } = seedProvider.pickMatchSeeds(mode, modeFlags.seedTypes || {});
  const now = Date.now();
  for (const [id, rec] of recentMatchStats) {
    if (rec.expiresAt <= now) {
      recentMatchStats.delete(id);
    }
  }
  const match = {
    id: matchId,
    roomCode,
    mode,
    seedChanged: Boolean(seedChanged),
    lastStanding: modeFlags.lastStanding,
    scoreMode: modeFlags.scoreMode,
    overworldSeed,
    netherSeed,
    endSeed,
    players: playerSessions,
    loaded: new Set(),
    seedVotes: new Set(),
    results: new Map(), // uuid -> { name, time, score, status, forfeited }
    statsSubmitted: new Set(),
    startedAt: 0,
    finished: false,
  };
  matchesById.set(matchId, match);
  recentMatchStats.set(matchId, {
    uuids: new Set(playerSessions.map((p) => p.uuid)),
    submitted: match.statsSubmitted,
    expiresAt: Date.now() + 2 * 60 * 60 * 1000,
  });

  for (const s of match.players) {
    s.matchId = matchId;
    const opponentSessions = match.players.filter((o) => o !== s);
    const opponents = opponentSessions.map((o) => o.name);
    const opponentProfiles = {};
    for (const o of opponentSessions) {
      opponentProfiles[o.name] = { ...(o.cosmetics || {}), level: o.level || 0 };
    }
    send(s.ws, {
      type: "match_assigned",
      matchId,
      overworldSeed,
      netherSeed,
      endSeed,
      startsAt: 0,
      mode: match.mode,
      seedChanged: match.seedChanged,
      opponents,
      opponentProfiles,
    });
  }
  scheduleModeCountsBroadcast();
  console.log(
    `[match] ${matchId} assigned (${match.mode}, ow=${overworldSeed}[${types.overworld}], nether=${netherSeed}[${types.nether}], end=${endSeed}[${types.end}], room=${roomCode ?? "queue"})`
  );
}

function startMatchFromRoom(room) {
  startMatch(room.mode, room.players.map((p) => p.session), room.code);
}

function formatMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const rem = ms % 1000;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(rem).padStart(3, "0")}`;
}

function broadcastMatchNotice(match, message) {
  for (const s of match.players) {
    send(s.ws, { type: "match_notice", matchId: match.id, message });
  }
}

function maybeCompleteMatch(match) {
  if (match.finished || match.results.size < match.players.length) return;

  const standings = Array.from(match.results.values()).sort((a, b) => {
    if (a.forfeited !== b.forfeited) return a.forfeited ? 1 : -1;
    // Score modes (e.g. craft_random_item): highest crafted item count wins
    if (match.scoreMode) return b.score - a.score;
    // Time Trial: longest survival time wins; race modes: fastest time wins
    return match.lastStanding ? b.time - a.time : a.time - b.time;
  });

  const winner = standings.length > 0 && !standings[0].forfeited ? standings[0] : null;
  if (winner) {
    winner.status = "Winner";
  }

  finishMatch(
    match,
    winner ? winner.name : null,
    standings.map(({ name, time, score, status }) => ({ name, time, score, status })),
    winner ? winner.time : 0
  );
}

function finishMatch(match, winnerName, standings, winnerTime = 0) {
  if (match.finished) return;
  match.finished = true;
  matchesById.delete(match.id);

  const finishTime = winnerTime || (match.startedAt > 0 ? Math.max(0, Date.now() - match.startedAt) : 0);
  const modeCfg = MODE_FLAGS.get(match.mode) || { xp: DEFAULT_XP_CFG };

  for (const s of match.players) {
    s.matchId = null;
    send(s.ws, {
      type: "match_result",
      matchId: match.id,
      winner: winnerName,
      finishTime,
      eloDelta: 0,
      standings,
    });

    // Award performance-scaled multiplayer XP if the player finished (not forfeited)
    const res = match.results.get(s.uuid);
    if (res && !res.forfeited) {
      const isWinner = Boolean(winnerName && s.name.toLowerCase() === winnerName.toLowerCase());
      const xpGain = computeRunXp(modeCfg.xp, {
        elapsedSeconds: Math.floor((res.time || 0) / 1000),
        score: res.score >= 0 ? res.score : 0,
        multiplayer: true,
        winner: isWinner,
      });
      if (xpGain > 0) {
        const { profile, newlyUnlocked } = profileStore.addXp(s.uuid, s.name, xpGain);
        s.xp = profile.xp;
        s.level = profile.level;
        s.unlocks = profile.unlocks;
        send(s.ws, {
          type: "profile_sync",
          stats: profile.stats,
          unlocks: profile.unlocks,
          xp: profile.xp,
          level: profile.level,
          newlyUnlocked,
        });
      }
    }
  }

  // Keep the room alive for the next round with ready flags reset
  if (match.roomCode) {
    const room = roomsByCode.get(match.roomCode);
    if (room) {
      for (const p of room.players) {
        p.ready = false;
      }
      broadcastRoom(room);
    }
  }
  scheduleModeCountsBroadcast();

  console.log(`[match] ${match.id} finished — winner=${winnerName ?? "DRAW"} (${finishTime}ms)`);
}

// HTTP server (health check, public read-only profile API, + WS upgrade)
const httpServer = createServer((req, res) => {
  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      rooms: roomsByCode.size,
      matches: matchesById.size,
      profiles: profileStore.getCount(),
      seeds: seedProvider.getStats(),
    }));
    return;
  }

  // Mod auto-update endpoints: GET /api/update/latest and GET /api/update/download
  if (pathname === "/api/update/latest") {
    if (!releaseInfo) {
      res.writeHead(404, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ error: "no_release_configured" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({
      version: releaseInfo.version,
      file: releaseInfo.file,
      size: releaseInfo.size,
      sha256: releaseInfo.sha256,
      downloadUrl: releaseInfo.downloadPath,
    }));
    return;
  }

  if (pathname === "/api/update/download") {
    if (!releaseInfo || !releaseInfo.hasLocalJar || !existsSync(releaseInfo.jarPath)) {
      res.writeHead(404, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ error: "release_jar_not_found" }));
      return;
    }
    const stat = statSync(releaseInfo.jarPath);
    res.writeHead(200, {
      "content-type": "application/java-archive",
      "content-length": stat.size,
      "content-disposition": `attachment; filename="${releaseInfo.file}"`,
      "access-control-allow-origin": "*",
    });
    createReadStream(releaseInfo.jarPath).pipe(res);
    return;
  }

  // Public seed fetch for Singleplayer runs: GET /api/seeds/next?mode=time_trial
  if (req.method === "GET" && pathname === "/api/seeds/next") {
    if (!allowHttpRequest(getClientIp(req), "seeds", 30)) {
      res.writeHead(429, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ error: "rate_limited" }));
      return;
    }
    const mode = parsedUrl.searchParams.get("mode") || "time_trial";
    const modeFlags = MODE_FLAGS.get(mode) || { seedTypes: {} };
    const picked = seedProvider.pickMatchSeeds(mode, modeFlags.seedTypes || {});
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify(picked));
    return;
  }

  // Batch lookup: GET /api/profiles?names=Alice,Bob or ?uuids=...
  if (req.method === "GET" && pathname === "/api/profiles") {
    if (!allowHttpRequest(getClientIp(req), "profiles", 60)) {
      res.writeHead(429, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ error: "rate_limited" }));
      return;
    }
    const namesParam = parsedUrl.searchParams.get("names");
    const uuidsParam = parsedUrl.searchParams.get("uuids");
    const profiles = namesParam
      ? profileStore.getManyByNames(namesParam.split(","))
      : uuidsParam
        ? profileStore.getManyByUuids(uuidsParam.split(","))
        : {};
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "public, max-age=30",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify({ profiles }));
    return;
  }

  // Single lookup: GET /api/profiles/<uuid-or-username>
  if (req.method === "GET" && pathname.startsWith("/api/profiles/")) {
    const id = decodeURIComponent(pathname.slice("/api/profiles/".length));
    const profile = profileStore.getByIdentifier(id);
    if (!profile) {
      res.writeHead(404, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify({ error: "profile_not_found" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "public, max-age=30",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify(profile));
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  maxPayload: MAX_PAYLOAD_BYTES,
});

wss.on("connection", (ws, req) => {
  const clientIp = getClientIp(req);
  const ipCount = (wsCountByIp.get(clientIp) || 0) + 1;
  if (ipCount > MAX_WS_PER_IP) {
    ws.close(4008, "too_many_connections");
    return;
  }
  wsCountByIp.set(clientIp, ipCount);
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("close", () => {
    const cur = (wsCountByIp.get(clientIp) || 1) - 1;
    if (cur <= 0) wsCountByIp.delete(clientIp);
    else wsCountByIp.set(clientIp, cur);
  });

  let session = null;
  let rateWindowStart = Date.now();
  let rateCount = 0;

  send(ws, {
    type: "hello",
    serverVersion: SERVER_VERSION,
    latestModVersion: releaseInfo ? releaseInfo.version : "",
    updateDownloadPath: releaseInfo ? releaseInfo.downloadPath : "",
    updateSha256: releaseInfo ? releaseInfo.sha256 : "",
  });

  ws.on("message", async (raw) => {
    // Simple per-socket rate limiter
    const now = Date.now();
    if (now - rateWindowStart >= RATE_LIMIT_WINDOW_MS) {
      rateWindowStart = now;
      rateCount = 0;
    }
    rateCount++;
    if (rateCount > RATE_LIMIT_MAX_MSGS) {
      sendError(ws, "rate_limited", "Too many messages.");
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      sendError(ws, "bad_json", "Invalid JSON.");
      return;
    }

    const type = msg?.type;
    if (typeof type !== "string") return;

    // --- Ping ---
    if (type === "ping") {
      send(ws, { type: "pong", sentAt: Number(msg.sentAt) || 0, serverAt: Date.now() });
      return;
    }

    // --- Login (Mojang verified only, no offline accounts) ---
    if (type === "login") {
      if (releaseInfo && releaseInfo.version && msg.modVersion !== releaseInfo.version) {
        sendError(ws, "outdated_client", `Update required: v${releaseInfo.version}`);
        ws.close(4001, "outdated_client");
        return;
      }
      const verified = await verifyMojangSession(msg.username, msg.serverId);
      if (!verified) {
        sendError(ws, "auth_failed", "Mojang authentication failed. Offline accounts are not allowed.");
        return;
      }
      const profile = profileStore.ensureProfile(verified.uuid, verified.name);
      // Invalidate any previous session for this UUID to prevent duplicate logins / self-matchmaking
      const prevSession = sessionsByUuid.get(verified.uuid);
      if (prevSession) {
        leaveQueue(prevSession, false);
        leaveRoom(prevSession);
        sessionsByToken.delete(prevSession.resumeToken);
        if (prevSession.ws && prevSession.ws !== ws && prevSession.ws.readyState === prevSession.ws.OPEN) {
          prevSession.ws.close(4002, "session_replaced");
        }
      }
      const resumeToken = randomBytes(24).toString("hex");
      session = {
        ws,
        name: verified.name,
        uuid: verified.uuid,
        cosmetics: profile.cosmetics,
        stats: profile.stats,
        unlocks: profile.unlocks,
        xp: profile.xp,
        level: profile.level,
        lastSpXpAt: 0,
        lastSeenAt: Date.now(),
        resumeToken,
        roomCode: null,
        queuedMode: null,
        matchId: null,
      };
      sessionsByToken.set(resumeToken, session);
      sessionsByUuid.set(verified.uuid, session);
      send(ws, {
        type: "login_ok",
        name: session.name,
        uuid: session.uuid,
        resumeToken,
        cosmetics: session.cosmetics,
        stats: session.stats,
        unlocks: session.unlocks,
        xp: session.xp,
        level: session.level,
      });
      sendModeCounts(ws);
      console.log(`[auth] ${session.name} logged in`);
      return;
    }

    // --- Resume ---
    if (type === "resume") {
      if (releaseInfo && releaseInfo.version && msg.modVersion !== releaseInfo.version) {
        sendError(ws, "outdated_client", `Update required: v${releaseInfo.version}`);
        ws.close(4001, "outdated_client");
        return;
      }
      const existing = typeof msg.resumeToken === "string" ? sessionsByToken.get(msg.resumeToken) : null;
      if (!existing) {
        sendError(ws, "auth_failed", "Invalid or expired resume token.");
        return;
      }
      existing.ws = ws;
      existing.lastSeenAt = Date.now();
      session = existing;
      send(ws, {
        type: "login_ok",
        name: session.name,
        uuid: session.uuid,
        resumeToken: session.resumeToken,
        cosmetics: session.cosmetics || {},
        stats: session.stats || {},
        unlocks: session.unlocks || {},
        xp: session.xp || 0,
        level: session.level || 0,
      });
      sendModeCounts(ws);
      return;
    }

    // All remaining messages require an authenticated session
    if (!session) {
      sendError(ws, "unauthenticated", "Please log in first.");
      return;
    }

    // --- Profile customization update ---
    if (type === "profile_update") {
      const updated = profileStore.updateCosmetics(session.uuid, session.name, msg.cosmetics);
      session.cosmetics = updated.cosmetics;
      send(ws, { type: "profile_ok", cosmetics: updated.cosmetics, updatedAt: updated.updatedAt });
      if (session.roomCode) {
        const room = roomsByCode.get(session.roomCode);
        if (room) broadcastRoom(room);
      }
      return;
    }

    // --- End-of-match vanilla stats & achievement events ---
    if (type === "match_stats") {
      const record = recentMatchStats.get(msg.matchId);
      if (!record || !record.uuids.has(session.uuid) || record.submitted.has(session.uuid)) {
        return;
      }
      record.submitted.add(session.uuid);
      const { profile, newlyUnlocked } = profileStore.applyMatchStats(
        session.uuid,
        session.name,
        msg.stats,
        msg.events
      );
      session.stats = profile.stats;
      session.unlocks = profile.unlocks;
      send(ws, {
        type: "profile_sync",
        stats: profile.stats,
        unlocks: profile.unlocks,
        xp: profile.xp,
        level: profile.level,
        newlyUnlocked,
      });
      if (newlyUnlocked.length > 0) {
        console.log(`[unlocks] ${session.name} unlocked: ${newlyUnlocked.map((u) => `${u.category}:${u.id}`).join(", ")}`);
      }
      return;
    }

    // --- Singleplayer finished run XP ---
    if (type === "singleplayer_finish") {
      const modeId = typeof msg.mode === "string" ? msg.mode.trim() : "time_trial";
      const elapsedSeconds = Math.floor(Number(msg.elapsedSeconds) || 0);
      const score = Math.max(0, Math.floor(Number(msg.score) || 0));
      const modeCfg = MODE_FLAGS.get(modeId) || { xp: DEFAULT_XP_CFG };
      const minSecs = modeCfg.xp?.minSeconds ?? 60;
      const nowMs = Date.now();
      if (elapsedSeconds >= minSecs && nowMs - (session.lastSpXpAt || 0) >= Math.max(15000, minSecs * 1000)) {
        const xpGain = computeRunXp(modeCfg.xp, {
          elapsedSeconds,
          score,
          multiplayer: false,
          winner: false,
        });
        if (xpGain > 0) {
          session.lastSpXpAt = nowMs;
          const { profile, newlyUnlocked } = profileStore.addXp(session.uuid, session.name, xpGain);
          session.xp = profile.xp;
          session.level = profile.level;
          session.unlocks = profile.unlocks;
          send(ws, {
            type: "profile_sync",
            stats: profile.stats,
            unlocks: profile.unlocks,
            xp: profile.xp,
            level: profile.level,
            newlyUnlocked,
          });
        }
      }
      return;
    }

    // --- Presence ---
    if (type === "activity") {
      return;
    }

    // --- Matchmaking Queue (Open Public Lobbies: min 2, max 6, auto-start countdown) ---
    if (type === "queue_join") {
      const mode = typeof msg.mode === "string" && msg.mode.trim() ? msg.mode.trim() : "time_trial";
      if (!MODE_FLAGS.has(mode)) {
        sendError(ws, "invalid_mode", "Unknown gamemode.");
        return;
      }
      leaveRoom(session);
      leaveQueue(session, false);

      let lobby = findOpenPublicLobby(mode, session.uuid);
      if (!lobby) {
        const code = generateRoomCode();
        lobby = {
          code,
          mode,
          owner: "",
          publicLobby: true,
          countdownEndsAt: 0,
          startTimer: null,
          players: [],
        };
        roomsByCode.set(code, lobby);
      }

      lobby.players.push({ session, name: session.name, ready: false });
      session.roomCode = lobby.code;
      session.queuedMode = mode;
      updatePublicLobbyTimer(lobby);
      broadcastRoom(lobby);
      scheduleModeCountsBroadcast();
      console.log(`[lobby] ${session.name} joined public ${mode} lobby ${lobby.code} (${lobby.players.length}/${MAX_MATCH_PLAYERS})`);
      return;
    }

    if (type === "queue_leave") {
      leaveQueue(session, true);
      leaveRoom(session);
      return;
    }

    // --- Rooms ---
    if (type === "room_create") {
      leaveRoom(session);
      const mode = typeof msg.mode === "string" && msg.mode.trim() ? msg.mode.trim() : "time_trial";
      if (!MODE_FLAGS.has(mode)) {
        sendError(ws, "invalid_mode", "Unknown gamemode.");
        return;
      }
      const code = generateRoomCode();
      const room = {
        code,
        mode,
        owner: session.name,
        players: [{ session, name: session.name, ready: false }],
      };
      roomsByCode.set(code, room);
      session.roomCode = code;
      broadcastRoom(room);
      console.log(`[room] ${session.name} created room ${code} (${mode})`);
      return;
    }

    if (type === "room_join") {
      const code = typeof msg.code === "string" ? msg.code.trim().toUpperCase() : "";
      const room = roomsByCode.get(code);
      if (!room) {
        sendError(ws, "room_not_found", "Room not found.");
        return;
      }
      if (room.players.some((p) => p.session === session)) {
        broadcastRoom(room);
        return;
      }
      if (room.players.length >= MAX_ROOM_PLAYERS) {
        sendError(ws, "room_full", "Room is full.");
        return;
      }
      leaveRoom(session);
      room.players.push({ session, name: session.name, ready: false });
      session.roomCode = code;
      broadcastRoom(room);
      console.log(`[room] ${session.name} joined room ${code}`);
      return;
    }

    if (type === "room_leave") {
      leaveRoom(session);
      return;
    }

    if (type === "room_set_mode") {
      if (!session.roomCode) return;
      const room = roomsByCode.get(session.roomCode);
      if (!room || room.owner !== session.name) return;
      const mode = typeof msg.mode === "string" && msg.mode.trim() ? msg.mode.trim() : null;
      if (!mode || !MODE_FLAGS.has(mode)) return;
      room.mode = mode;
      for (const p of room.players) {
        p.ready = false;
      }
      broadcastRoom(room);
      console.log(`[room] ${session.name} changed room ${room.code} mode to ${mode}`);
      return;
    }

    if (type === "room_kick") {
      if (!session.roomCode) return;
      const room = roomsByCode.get(session.roomCode);
      if (!room || room.owner !== session.name) return;
      const targetName = typeof msg.playerName === "string" ? msg.playerName.trim() : "";
      if (!targetName || targetName.toLowerCase() === session.name.toLowerCase()) return;
      const targetSlot = room.players.find((p) => p.name.toLowerCase() === targetName.toLowerCase());
      if (!targetSlot) return;
      room.players = room.players.filter((p) => p !== targetSlot);
      targetSlot.session.roomCode = null;
      sendError(targetSlot.session.ws, "kicked", "You were kicked from the room.");
      broadcastRoom(room);
      console.log(`[room] ${session.name} kicked ${targetSlot.name} from room ${room.code}`);
      return;
    }

    if (type === "room_ready") {
      if (!session.roomCode) return;
      const room = roomsByCode.get(session.roomCode);
      if (!room || room.owner !== session.name) return;
      if (room.players.length >= 2) {
        startMatchFromRoom(room);
      }
      return;
    }

    // --- Match ---
    if (type === "match_loaded") {
      const match = matchesById.get(msg.matchId);
      if (!match || !match.players.includes(session) || match.startedAt !== 0) return;
      match.loaded.add(session.uuid);
      if (match.loaded.size >= match.players.length) {
        match.startedAt = Date.now() + COUNTDOWN_SECONDS * 1000;
        for (const s of match.players) {
          send(s.ws, {
            type: "match_start",
            matchId: match.id,
            countdownSeconds: COUNTDOWN_SECONDS,
          });
        }
        console.log(`[match] ${match.id} all players loaded — starting ${COUNTDOWN_SECONDS}s countdown`);
      }
      return;
    }

    if (type === "match_chat") {
      const match = matchesById.get(msg.matchId);
      if (!match || !match.players.includes(session) || match.finished) return;
      const text = typeof msg.message === "string"
        ? msg.message.replace(/[\r\n\u0000-\u001F\u007F]/g, " ").trim().slice(0, 256)
        : "";
      if (!text) return;
      for (const s of match.players) {
        if (s !== session) {
          send(s.ws, {
            type: "match_chat",
            matchId: match.id,
            playerName: session.name,
            message: text,
          });
        }
      }
      return;
    }

    if (type === "split") {
      const match = matchesById.get(msg.matchId);
      if (!match || !match.players.includes(session) || match.finished) return;
      const splitType = String(msg.splitType || "").replace(/[\r\n\u0000-\u001F\u007F]/g, "").slice(0, 64);
      if (!splitType) return;
      for (const s of match.players) {
        if (s !== session) {
          send(s.ws, {
            type: "split_relay",
            matchId: match.id,
            playerName: session.name,
            splitType,
            at: Date.now(),
          });
        }
      }
      return;
    }

    if (type === "finish") {
      const match = matchesById.get(msg.matchId);
      if (!match || !match.players.includes(session) || match.finished) return;
      if (match.results.has(session.uuid)) return;
      // Reject finishes before the synchronized countdown has actually started the match
      if (match.startedAt <= 0 || Date.now() < match.startedAt) return;
      const elapsed = Math.max(0, Date.now() - match.startedAt);

      const rawScore = Number.isFinite(Number(msg.score)) ? Math.floor(Number(msg.score)) : 0;
      const score = match.scoreMode ? Math.max(0, Math.min(500, rawScore)) : -1;
      match.results.set(session.uuid, {
        name: session.name,
        time: elapsed,
        score,
        status: match.lastStanding || match.scoreMode ? "Time's Up" : "Finished",
        forfeited: false,
      });

      if (match.lastStanding) {
        broadcastMatchNotice(match, `${session.name} ran out of time at ${formatMs(elapsed)}!`);
      } else if (!match.scoreMode) {
        broadcastMatchNotice(match, `${session.name} finished in ${formatMs(elapsed)}!`);
      }

      maybeCompleteMatch(match);
      return;
    }

    if (type === "forfeit") {
      const match = matchesById.get(msg.matchId);
      if (!match || !match.players.includes(session) || match.finished) return;
      if (match.results.has(session.uuid)) return;
      const elapsed = match.startedAt > 0 ? Math.max(0, Date.now() - match.startedAt) : 0;

      match.results.set(session.uuid, {
        name: session.name,
        time: elapsed,
        status: "Forfeit",
        forfeited: true,
      });
      broadcastMatchNotice(match, `${session.name} forfeited the match.`);
      maybeCompleteMatch(match);
    }

    if (type === "vote") {
      const match = matchesById.get(msg.matchId);
      if (!match || !match.players.includes(session) || match.finished) return;
      if (msg.voteType !== "seed_change") return;
      if (match.seedChanged) return;
      if (match.startedAt <= 0) return;

      // Only allow seed-change votes within the first 40 seconds
      const elapsedMs = Date.now() - match.startedAt;
      if (elapsedMs > 40000) return;

      const accept = msg.accept !== false;
      if (accept) {
        match.seedVotes.add(session.uuid);
      } else {
        match.seedVotes.delete(session.uuid);
      }
      const votes = match.seedVotes.size;
      const needed = Math.max(1, Math.ceil((match.players.length * 2) / 3));
      const passed = votes >= needed;

      for (const s of match.players) {
        send(s.ws, {
          type: "vote_state",
          matchId: match.id,
          voteType: "seed_change",
          votes,
          needed,
          passed,
        });
      }

      if (passed) {
        match.finished = true;
        matchesById.delete(match.id);
        broadcastMatchNotice(match, "Seed change vote passed! Generating a new seed...");
        console.log(`[match] ${match.id} seed_change passed (${votes}/${needed}); restarting with new seed`);
        startMatch(match.mode, match.players, match.roomCode, true);
      }
    }
  });

  ws.on("close", () => {
    if (!session || session.ws !== ws) return;
    leaveQueue(session, false);
    leaveRoom(session);
    if (session.matchId) {
      const match = matchesById.get(session.matchId);
      if (match && !match.finished && !match.results.has(session.uuid)) {
        const elapsed = match.startedAt > 0 ? Math.max(0, Date.now() - match.startedAt) : 0;
        match.results.set(session.uuid, {
          name: session.name,
          time: elapsed,
          status: "Disconnected",
          forfeited: true,
        });
        broadcastMatchNotice(match, `${session.name} disconnected.`);
        maybeCompleteMatch(match);
      }
    }
  });
});

// 30s WebSocket heartbeat to terminate dead/half-open sockets
setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 30000).unref();

httpServer.listen(PORT, HOST, () => {
  console.log(`[timetrials-server] listening on ws://${HOST}:${PORT}/ws`);
});
