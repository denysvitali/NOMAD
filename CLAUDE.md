# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NOMAD (Navigation Organizer for Maps, Activities & Destinations) is a self-hosted, real-time collaborative travel planner. Monorepo with a React frontend (`/client`) and Node.js Express backend (`/server`). Version 2.6.0, licensed AGPL-3.0.

## Development Commands

### Server (Express + SQLite)
```bash
cd server
pnpm install
pnpm run dev          # nodemon auto-restart on port 3001
pnpm start            # production mode
```

### Client (React + Vite)
```bash
cd client
pnpm install
pnpm run dev          # Vite dev server on port 5173 (proxies /api, /uploads, /ws to :3001)
pnpm run build        # production build (runs prebuild for icon generation first)
pnpm run preview      # preview production build
```

### Docker
```bash
docker compose up    # runs on port 3000, mounts ./data and ./uploads
```

The Dockerfile is a multi-stage build: builds client in stage 1, then copies dist into server's `/public` directory. Production image uses Node 22-alpine.

## Architecture

- **Backend:** Express.js with CommonJS modules, SQLite via `better-sqlite3` (WAL mode), JWT auth (24h), WebSocket (`ws`) for real-time sync
- **Frontend:** React 19 with ES modules, Vite, Tailwind CSS 3, Zustand for state, Leaflet for maps, PWA with Workbox
- **Real-time:** WebSocket on `/ws` path with room-based (per-trip) architecture, 30s heartbeat
- **Auth:** JWT + optional OIDC/OAuth2 (Google, Apple, Keycloak, Authentik). First registered user becomes admin.

### Server Structure (`/server/src/`)
- `index.js` — Express app setup, middleware, route registration
- `config.js` — JWT secret generation/persistence
- `websocket.js` — WebSocket server for live sync
- `scheduler.js` — Cron jobs (auto-backups)
- `db/database.js` — SQLite schema initialization
- `middleware/auth.js` — JWT authentication middleware
- `routes/` — REST API routes (~20 files), all served under `/api/*`

### Client Structure (`/client/src/`)
- `App.jsx` — Router setup, auth gating
- `api/` — Axios HTTP client (`client.js`) and WebSocket wrapper (`websocket.js`)
- `store/` — Zustand stores (auth, trip, settings, vacay)
- `pages/` — Page-level components
- `components/` — Feature-organized UI components (Planner/, Map/, Places/, Budget/, Collab/, etc.)
- `i18n/` — Internationalization (English, German)

### Addon System
Feature-togglable modules managed via admin panel and stored in the database: Vacay (vacation planner), Atlas (world map stats), Collab (chat/notes/polls), Dashboard Widgets.

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 3001 dev, 3000 Docker) |
| `JWT_SECRET` | Auth secret (auto-generated if missing, persisted to `/data/.jwt_secret`) |
| `ALLOWED_ORIGINS` | CORS whitelist (comma-separated) |
| `DEMO_MODE` | Enable demo mode |
| `NODE_ENV` | `development` or `production` |

## Notable Conventions

- No test framework or linter is configured — there are no automated tests
- No TypeScript — pure JavaScript throughout
- Server uses CommonJS (`require`), client uses ES modules (`import`)
- Database migrations are handled inline in `db/database.js` schema initialization
- File uploads go to `/uploads/` (files, covers subdirectories)
- The health check endpoint is `GET /api/health`
