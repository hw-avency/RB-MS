# AVENCY Booking

## Architektur
- `backend/`: Node.js + Express + Prisma (Postgres)
- `frontend/`: Vite + React (Render Static Site)

## Deployment 

### Backend (Web Service)
- Root: `backend`
- Dockerfile: `backend/Dockerfile`
- Start läuft über `docker-entrypoint.sh` und führt u. a. `prisma migrate deploy` aus.

### Frontend (Static Site)
- Root: `frontend`
- Build Command: `npm install && npm run build`
- Publish Directory: `dist`

---

## Microsoft Entra ID (Single Tenant) einrichten

1. Azure Portal → **App registrations** → **New registration**
2. **Supported account types**: `Accounts in this organizational directory only` (Single tenant)
3. Redirect URI (Web):
   - `https://<BACKEND_HOST>/auth/entra/callback`
4. Optional Front-channel/Post-logout Redirect:
   - `https://<FRONTEND_HOST>/`
5. **Certificates & secrets**:
   - Client secret erzeugen, **Secret Value** sichern
6. API Permissions:
   - Für OIDC Login reichen Scopes `openid profile email`
   - Optional Microsoft Graph `User.Read` (delegated), falls später benötigt

**Wichtig:** Das Backend akzeptiert nur Logins mit `tid === ENTRA_TENANT_ID`.

---

## Auth Flows

### Primärer Login (Microsoft)
- Frontend Login-Seite zeigt nur **„Mit Microsoft anmelden“**
- Redirect auf `GET /auth/entra/start`
- Callback über `GET /auth/entra/callback`
- Backend setzt Session-Cookie (HttpOnly) und redirectet zurück ins Frontend

### Breakglass Login (versteckt)
- Nicht im UI verlinkt
- Nur direkt über `/#/breakglass`
- Nutzt `POST /auth/login` mit `ADMIN_EMAIL` / `ADMIN_PASSWORD`

### Session & Frontend-Auth
- Session ist die Single Source of Truth (Cookie-basiert)
- Frontend prüft Login-Status über `GET /auth/me`
- Logout über `POST /auth/logout`

---

## Environment Variables

### Backend (required)
- `NODE_ENV=production|development` (Render: **immer** `production`)
- `PORT=3000`
- `DATABASE_URL=postgresql://...`
- `SESSION_SECRET=<lange-zufällige-zeichenfolge>`
- `FRONTEND_URL=https://rb-ms-1.onrender.com`
- `CORS_ORIGIN=https://rb-ms-1.onrender.com` (oder identisch zu `FRONTEND_URL`)
- `COOKIE_SAMESITE=none` (prod) / `lax` (dev)
- `COOKIE_SECURE=true` (prod) / `false` (dev)

### Breakglass (required)
- `ADMIN_EMAIL=admin@example.com`
- `ADMIN_PASSWORD=<starkes-passwort>`

### Entra (required)
- `ENTRA_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
- `ENTRA_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
- `ENTRA_CLIENT_SECRET=<secret-value>`
- `ENTRA_REDIRECT_URI=https://rb-ms.onrender.com/auth/entra/callback`
- `ENTRA_POST_LOGIN_REDIRECT=https://rb-ms-1.onrender.com/#/`

### Entra (optional)
- `ENTRA_LOGOUT_REDIRECT=https://rb-ms-1.onrender.com/#/login`

### Dev/Test Auth Bypass (optional, niemals Produktion)
- `AUTH_BYPASS=true` aktiviert im Backend den Header-Bypass **nur** wenn `NODE_ENV != production` **und** der Dienst nicht auf Render läuft
- Mit Header `x-dev-user: admin` wird ein lokaler Admin-User (`dev@local`) gesetzt

### Frontend (required)
- `VITE_API_BASE_URL=https://rb-ms.onrender.com`

### Frontend (optional)
- `VITE_BREAKGLASS_PATH=/#/breakglass`
- `VITE_AUTH_BYPASS=true` erlaubt in Preview-Builds den Dev-Header bei `?devAuth=1`

**Hinweis:** Dev-Bypass wird nur mit `?devAuth=1` im URL-Query aktiv und sendet dann `x-dev-user: admin`.

---

## API (Auth-relevant)
- `GET /health`
- `GET /auth/entra/start`
- `GET /auth/entra/callback`
- `POST /auth/login` (Breakglass)
- `POST /auth/logout`
- `GET /auth/me`

## Qualitätschecks
- Frontend: `npm run build`
- Backend: `npm run build`
- Health: `GET /health` liefert `{ status: "ok" }`
- CORS + Cookie-Credentials für Frontend ↔ Backend aktiviert
