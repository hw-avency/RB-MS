# AVENCY Booking (Render Deploy ohne Blueprint)

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
- `GET /floorplans`
- `GET /floorplans/:id`
- `GET /floorplans/:id/desks`
- `POST /bookings`
- `GET /bookings?from=YYYY-MM-DD&to=YYYY-MM-DD&floorplanId=<optional>`
- `GET /occupancy?floorplanId=<id>&date=YYYY-MM-DD`
- `POST /recurring-bookings`
- `GET /recurring-bookings?floorplanId=<optional>`

## Breakglass Admin

- `POST /admin/login` mit `ADMIN_EMAIL` (Default `admin@example.com`) und `ADMIN_PASSWORD` liefert ein Bearer-Token.
- Alle `/admin/*` Endpoints benötigen `Authorization: Bearer <token>`.
- `JWT_SECRET` und `ADMIN_PASSWORD` sind Pflicht-Variablen.

### Admin Endpoints

- `POST /admin/floorplans`
- `PATCH /admin/floorplans/:id`
- `DELETE /admin/floorplans/:id`
- `POST /admin/floorplans/:id/desks`
- `PATCH /admin/desks/:id`
- `DELETE /admin/desks/:id`
- `GET /admin/bookings?date=YYYY-MM-DD&floorplanId=<optional>`
- `PATCH /admin/bookings/:id`
- `DELETE /admin/bookings/:id`
- `GET /admin/recurring-bookings?floorplanId=<optional>`
- `PATCH /admin/recurring-bookings/:id`
- `DELETE /admin/recurring-bookings/:id`
