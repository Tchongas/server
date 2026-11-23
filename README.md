# TimeTrials Server

Ultra-lightweight in-memory WebSocket server for TimeTrials 1v1 rooms.

- **Single dependency**: `ws` (Node.js 22+ native `fetch` for Mojang verification)
- **No database / no ELO / no match history** (everything stays in memory)
- **Mojang-verified accounts only** (offline accounts are rejected)
- **Per-socket rate limiting** (30 msg/s, 8 KB max payload)

## Run Locally

```bash
cd server
npm install
npm start
```

Listens on `ws://0.0.0.0:8080/ws` by default (override with `PORT=8080`).
Health check endpoint: `GET http://localhost:8080/health`.
