# RB-MS (Render Deploy ohne Blueprint)

Dieses Repository kann auf dem **Render Free Tier ohne Blueprint** deployed werden.

## Monorepo Struktur

- `backend/` – Node.js + TypeScript + Express + Prisma
- `frontend/` – React + Vite Static Site
- `docs/` – Dokumentation
- `infra/` – Infrastrukturartefakte

## Render Setup (ohne Blueprint)

### Backend als Render Web Service

Erstelle in Render einen neuen **Web Service** mit diesen Einstellungen:

- **Runtime:** Docker
- **Root Directory:** `backend`
- **Dockerfile Path:** `Dockerfile`
- **Docker Build Context:** `.`

Setze folgende **Environment Variables**:

- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_PASSWORD`
- `RUN_SEED` (optional)
- `NODE_ENV=production`

Hinweis: Beim Container-Start werden automatisch `prisma generate`, `prisma migrate deploy` und optional `prisma db seed` (bei `RUN_SEED=true`) ausgeführt.

### Frontend als Render Static Site

Erstelle in Render eine **Static Site** mit diesen Einstellungen:

- **Root Directory:** `frontend`
- **Build Command:** `npm install && npm run build`
- **Publish Directory:** `dist`

Setze folgende **Environment Variable**:

- `VITE_API_BASE_URL` (auf die URL des Backend-Services, z. B. `https://rbms-backend.onrender.com`)

## API Endpoints

- `GET /health`
- `GET /me` (Demo-User Response für Dev-Auth in Task 1)
- `POST /floorplans`
- `GET /floorplans`
- `GET /floorplans/:id`
- `POST /floorplans/:id/desks`
- `GET /floorplans/:id/desks`
- `POST /bookings`
- `GET /bookings?from=YYYY-MM-DD&to=YYYY-MM-DD&floorplanId=<optional>`
- `POST /recurring-bookings`
- `GET /recurring-bookings?floorplanId=<optional>`

## Breakglass Admin

Beim Seed wird ein Admin-User angelegt bzw. aktualisiert:

- Username: `admin@example.com`
- Passwort: kommt aus `ADMIN_PASSWORD` (ENV)
- Kein Passwort liegt im Repository.
