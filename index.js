import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const SERVER_VERSION = "0.1.0";
const MAX_PAYLOAD_BYTES = 8 * 1024;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MSGS = 30;
const COUNTDOWN_SECONDS = 5;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// In-memory state (no DB, no ELO, no match history)
const sessionsByToken = new Map(); // resumeToken -> Session
const roomsByCode = new Map();     // code -> Room
const matchesById = new Map();     // matchId -> Match

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

function generateSeed() {
  // Signed 64-bit integer safe for JS Number (53-bit)
  const buf = randomBytes(6);
  const val = buf.readUIntBE(0, 6);
  return Math.random() < 0.5 ? -val : val;
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
    players: room.players.map((p) => ({ name: p.name, ready: p.ready })),
  };
  for (const p of room.players) {
    send(p.session.ws, payload);
  }
}

function leaveRoom(session) {
  if (!session.roomCode) return;
  const room = roomsByCode.get(session.roomCode);
  session.roomCode = null;
  if (!room) return;

  room.players = room.players.filter((p) => p.session !== session);
  if (room.players.length === 0) {
    roomsByCode.delete(room.code);
  } else {
    if (room.owner === session.name) {
      room.owner = room.players[0].name;
    }
    broadcastRoom(room);
  }
}

function startMatchFromRoom(room) {
  const matchId = randomUUID();
  const overworldSeed = generateSeed();
  const match = {
    id: matchId,
    roomCode: room.code,
    mode: room.mode,
    lastStanding: room.mode === "time_trial",
    overworldSeed,
    players: room.players.map((p) => p.session),
    loaded: new Set(),
    results: new Map(), // uuid -> { name, time, status, forfeited }
    startedAt: 0,
    finished: false,
  };
  matchesById.set(matchId, match);

  for (const s of match.players) {
    s.matchId = matchId;
    const opponents = match.players.filter((o) => o !== s).map((o) => o.name);
    send(s.ws, {
      type: "match_assigned",
      matchId,
      overworldSeed,
      startsAt: 0,
      mode: match.mode,
      opponents,
    });
  }
  console.log(`[match] ${matchId} assigned (${match.mode}, seed=${overworldSeed}, room=${room.code})`);
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
    standings.map(({ name, time, status }) => ({ name, time, status })),
    winner ? winner.time : 0
  );
}

function finishMatch(match, winnerName, standings, winnerTime = 0) {
  if (match.finished) return;
  match.finished = true;
  matchesById.delete(match.id);

  const finishTime = winnerTime || (match.startedAt > 0 ? Math.max(0, Date.now() - match.startedAt) : 0);
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
  }

  // Keep the room alive for the next round with ready flags reset
  const room = roomsByCode.get(match.roomCode);
  if (room) {
    for (const p of room.players) {
      p.ready = false;
    }
    broadcastRoom(room);
  }

  console.log(`[match] ${match.id} finished — winner=${winnerName ?? "DRAW"} (${finishTime}ms)`);
}

// HTTP server (simple health check + WS upgrade)
const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: roomsByCode.size, matches: matchesById.size }));
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

wss.on("connection", (ws) => {
  let session = null;
  let rateWindowStart = Date.now();
  let rateCount = 0;

  send(ws, { type: "hello", serverVersion: SERVER_VERSION });

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
      const verified = await verifyMojangSession(msg.username, msg.serverId);
      if (!verified) {
        sendError(ws, "auth_failed", "Mojang authentication failed. Offline accounts are not allowed.");
        return;
      }
      const resumeToken = randomBytes(24).toString("hex");
      session = {
        ws,
        name: verified.name,
        uuid: verified.uuid,
        resumeToken,
        roomCode: null,
        matchId: null,
      };
      sessionsByToken.set(resumeToken, session);
      send(ws, { type: "login_ok", name: session.name, uuid: session.uuid, resumeToken });
      console.log(`[auth] ${session.name} logged in`);
      return;
    }

    // --- Resume ---
    if (type === "resume") {
      const existing = typeof msg.resumeToken === "string" ? sessionsByToken.get(msg.resumeToken) : null;
      if (!existing) {
        sendError(ws, "auth_failed", "Invalid or expired resume token.");
        return;
      }
      existing.ws = ws;
      session = existing;
      send(ws, { type: "login_ok", name: session.name, uuid: session.uuid, resumeToken: session.resumeToken });
      return;
    }

    // All remaining messages require an authenticated session
    if (!session) {
      sendError(ws, "unauthenticated", "Please log in first.");
      return;
    }

    // --- Presence ---
    if (type === "activity") {
      return;
    }

    // --- Rooms ---
    if (type === "room_create") {
      leaveRoom(session);
      const mode = typeof msg.mode === "string" && msg.mode.trim() ? msg.mode.trim() : "time_trial";
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
      if (room.players.length >= 2) {
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
      if (!mode) return;
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
      if (!room) return;
      const slot = room.players.find((p) => p.session === session);
      if (!slot) return;
      slot.ready = !slot.ready;
      broadcastRoom(room);

      if (room.players.length === 2 && room.players.every((p) => p.ready)) {
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

    if (type === "split") {
      const match = matchesById.get(msg.matchId);
      if (!match || !match.players.includes(session) || match.finished) return;
      for (const s of match.players) {
        if (s !== session) {
          send(s.ws, {
            type: "split_relay",
            matchId: match.id,
            playerName: session.name,
            splitType: String(msg.splitType || ""),
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
      const elapsed = match.startedAt > 0 ? Math.max(0, Date.now() - match.startedAt) : 0;

      match.results.set(session.uuid, {
        name: session.name,
        time: elapsed,
        status: match.lastStanding ? "Time's Up" : "Finished",
        forfeited: false,
      });

      if (match.lastStanding) {
        broadcastMatchNotice(match, `${session.name} ran out of time at ${formatMs(elapsed)}!`);
      } else {
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
  });

  ws.on("close", () => {
    if (!session || session.ws !== ws) return;
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

httpServer.listen(PORT, HOST, () => {
  console.log(`[timetrials-server] listening on ws://${HOST}:${PORT}/ws`);
});
