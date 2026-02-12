# RB-MS Monorepo (Task 1 Grundgerüst)

Dieses Repository enthält ein lokal lauffähiges Minimal-Setup mit End-to-End-Flow.

## Stack-Entscheidung

- **Backend:** Node.js + TypeScript + Express
- **ORM/Migrationen:** Prisma
- **Datenbank:** PostgreSQL
- **Frontend:** React + Vite + TypeScript
- **Orchestrierung:** Docker Compose

## Monorepo-Struktur

- `backend/` – API, Prisma Schema/Migrationen/Seed
- `frontend/` – Demo-UI, ruft `/health` und `/me` ab
- `infra/` – Infrastruktur-Hinweise
- `docs/` – Architektur-Notizen

## Schnellstart

Voraussetzung: Docker + Docker Compose.

```bash
docker compose up --build
```

Danach sind folgende Ports erreichbar:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3000`
- PostgreSQL: `localhost:5432`

## API-Endpunkte

- `GET /health` → `{ "status": "ok" }`
- `GET /me` → Demo-Admin-User aus der DB

## Migrationen & Seed

Beim Container-Start des Backends wird automatisch ausgeführt:

1. `prisma migrate deploy`
2. `prisma db seed`

Damit ist die DB beim Start direkt vorbereitet und enthält einen Demo-User:

- `admin@example.com` (Role `ADMIN`)

## Wichtige Umgebungsvariablen

Backend:

- `PORT` (Default in Compose: `3000`)
- `DATABASE_URL` (in Compose auf Postgres-Service gesetzt)

Postgres:

- `POSTGRES_DB=rbms`
- `POSTGRES_USER=postgres`
- `POSTGRES_PASSWORD=postgres`

## CI

GitHub Actions führt für Backend und Frontend aus:

- Lint
- Build
- Minimaler Smoke/Test
