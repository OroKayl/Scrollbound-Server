# Scrollbound Server (Phase A)

Shared-world backend for the friends beta. Holds one live map (POIs owned by AI clans **and** real players), siege declarations, a server-run weekly siege, and per-player cloud saves. Serves the game client too, so friends just open the URL.

> **Status:** Phase A = the backend foundation. The game client is **not yet wired** to talk to it (that's Phase B). Right now the server runs and serves the game, but the game still plays solo until we add the login + sync code to `Scrollbound.html`.

## Run it locally first

```bash
cd server
npm install
# optional: copy the game in so the URL serves it
mkdir -p public && cp ../Scrollbound.html public/index.html
INVITE_CODE=letmein SIEGE_MINUTES=5 npm start
# open http://localhost:3000
```

## Config (environment variables)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | 3000 | Port to listen on (hosts set this automatically) |
| `INVITE_CODE` | `SCROLLBOUND` | The code friends type to log in |
| `SIEGE_MINUTES` | 60 | Minutes between siege windows (use 5 for testing) |
| `DATA_FILE` | `./data.json` | Where the world + saves are stored |

## API (for Phase B client wiring)

- `POST /api/login` `{name, code}` → `{token, playerId, save, world}`
- `GET  /api/state` (Bearer token) → `{world, save, you}`
- `POST /api/save` `{token, save, power, guild}` → `{ok}`
- `POST /api/siege/declare` `{token, poiId}` → `{ok, world}`
- `POST /api/siege/cancel` `{token}` → `{ok, world}`

`world.territories[poiId]` = `{type:'ai'|'player', id, name}` or `null` (unclaimed).

## Deploy options (~$5/mo for a 15-friend beta)

**Railway** (easiest): push this `server/` folder to a GitHub repo → New Project → Deploy from repo → set `INVITE_CODE` in Variables. Railway auto-detects Node and runs `npm start`.

**Fly.io**: `cd server && fly launch` (uses the Dockerfile) → `fly secrets set INVITE_CODE=...` → `fly deploy`.

**Render**: New Web Service from repo → build `npm install`, start `npm start` → add `INVITE_CODE` env.

## ⚠️ Data durability

The JSON file lives on the container's disk, which most hosts **wipe on redeploy/restart**. For the beta that may be OK; to keep saves permanently, mount a volume and set `DATA_FILE` to it (e.g. Fly volume at `/data`, `DATA_FILE=/data/data.json`), or swap the file store for a managed database later.
