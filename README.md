# RB-MS (Render-first Monorepo)

Dieses Repository ist auf **Render Blueprint Deployments** ausgelegt. Nach Merge in `main` brauchst du in Render nur:

1. **New +** → **Blueprint** auswählen.
2. GitHub Repo verbinden.
3. Fehlende Secrets setzen.
4. Deploy starten.

Keine lokale Vorbereitung ist notwendig.

## Monorepo Struktur

- `backend/` – Node.js + TypeScript + Express + Prisma
- `frontend/` – React + Vite Static Site
- `docs/` – Dokumentation
- `infra/` – Infrastrukturartefakte
- `render.yaml` – Render Blueprint Definition

## Was der Blueprint erstellt

`render.yaml` erzeugt automatisch:

1. **Managed PostgreSQL** (`rbms-postgres`)
2. **Backend Web Service** (`rbms-backend`, Docker)
3. **Frontend Static Site** (`rbms-frontend`)

## Render Secrets / ENV Variablen

Diese Werte setzt du im Render UI (oder beim ersten Blueprint-Deploy):

### Backend

- `JWT_SECRET` (**required**, secret)
- `ADMIN_PASSWORD` (**required**, secret, wird nur fürs Seeding verwendet)
- `RUN_SEED` (optional, default `false`; auf `true` setzen wenn Seed im Pre-Deploy laufen soll)

`DATABASE_URL` wird automatisch aus der Render-Postgres-Ressource verbunden.

### Frontend

- `VITE_API_BASE_URL` (**required**) – URL vom Backend-Service, z. B. `https://rbms-backend.onrender.com`

## Automatisierung im Deploy

Backend Deploy Ablauf:

1. Docker Build (`backend/Dockerfile`)
2. `preDeployCommand`:
   - `npx prisma migrate deploy`
   - optional `npx prisma db seed` wenn `RUN_SEED=true`
3. App Start via `npm run start`

## API Endpoints

- `GET /health`
- `GET /me` (Demo-User Response für Dev-Auth in Task 1)

## Breakglass Admin

Beim Seed wird ein Admin-User angelegt bzw. aktualisiert:

- Username: `admin@example.com`
- Passwort: kommt aus `ADMIN_PASSWORD` (ENV)
- Kein Passwort liegt im Repository.
