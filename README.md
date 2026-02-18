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

## Microsoft Entra ID (Multi-Tenant) einrichten

### App Registration
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

### Multi-Tenant Setup
Das System unterstützt mehrere Microsoft Entra Mandanten:
- **Primärer Tenant**: Via `ENTRA_TENANT_ID` Environment Variable (für Rückwärtskompatibilität)
- **Zusätzliche Tenants**: Im Admin-Bereich unter `/admin/tenants` konfigurieren
  - Für jeden Tenant die **Entra Tenant ID** (UUID) hinterlegen
  - Login-Seite zeigt automatisch einen Button pro konfiguriertem Tenant
  - Mitarbeiter werden beim ersten Login automatisch dem passenden Tenant zugeordnet

**Hinweis:** Tenants ohne Entra ID erscheinen nicht auf der Login-Seite.

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
- `ENTRA_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (Primary/Default Tenant)
- `ENTRA_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
- `ENTRA_CLIENT_SECRET=<secret-value>`
- `ENTRA_REDIRECT_URI=https://rb-ms.onrender.com/auth/entra/callback`
- `ENTRA_POST_LOGIN_REDIRECT=https://rb-ms-1.onrender.com/#/`

**Multi-Tenant:** Weitere Tenant IDs werden in der Datenbank über `/admin/tenants` konfiguriert.

### Entra (optional)
- `ENTRA_LOGOUT_REDIRECT=https://rb-ms-1.onrender.com/#/login`

### Backend (optional)
- `APP_TITLE=RB-MS` (fällt sonst auf `PAGE_TITLE`/`VITE_PAGE_TITLE` zurück)

### Dev/Test Auth Bypass (optional, niemals Produktion)
- `AUTH_BYPASS=true` aktiviert im Backend den Header-Bypass **nur** wenn `NODE_ENV != production` **und** der Dienst nicht auf Render läuft
- Mit Header `x-dev-user: admin` wird ein lokaler Admin-User (`dev@local`) gesetzt

### Frontend (required)
- `VITE_API_BASE_URL=https://rb-ms.onrender.com`

### Frontend (optional)
- `VITE_PAGE_TITLE=RB-MS`
- `COMPANY_LOGO_URL=https://.../logo.svg` (oder `VITE_COMPANY_LOGO_URL`) für das Header-Logo links
- `VITE_BREAKGLASS_PATH=/#/breakglass`
- `VITE_AUTH_BYPASS=true` erlaubt in Preview-Builds den Dev-Header bei `?devAuth=1`

**Hinweis:** Dev-Bypass wird nur mit `?devAuth=1` im URL-Query aktiv und sendet dann `x-dev-user: admin`.

---

## API (Auth-relevant)
- `GET /health`
- `GET /auth/entra/start?tenant=<tenant_id>` (optional tenant parameter for multi-tenant)
- `GET /auth/entra/callback`
- `GET /auth/tenants` (returns configured tenants with Entra IDs for login screen)
- `POST /auth/login` (Breakglass)
- `POST /auth/logout`
- `GET /auth/me`

## Multi-Tenant Setup

Das System unterstützt mehrere Microsoft Entra Mandanten:

### Konfiguration
1. **Primärer Tenant**: Via `ENTRA_TENANT_ID` Environment Variable (Rückwärtskompatibilität)
2. **Weitere Tenants**: In Admin UI unter `/admin/tenants` konfigurieren
   - Für jeden Tenant die **Microsoft Entra Tenant ID** (UUID) hinterlegen
   - Login-Seite zeigt automatisch einen Button pro konfiguriertem Tenant
   - Mitarbeiter werden beim ersten Login automatisch dem passenden Tenant zugeordnet

### Verhalten
- Tenants **ohne** Entra ID erscheinen nicht auf der Login-Seite
- Tenants **mit** Entra ID bekommen eigenen Login-Button mit Namen
- Backend validiert Login gegen den jeweiligen Tenant
- Automatische Zuordnung von Mitarbeitern basierend auf `entraTenantId`

## Qualitätschecks
- Frontend: `npm run build`
- Backend: `npm run build`
- Health: `GET /health` liefert `{ status: "ok", title: "..." }`
- CORS + Cookie-Credentials für Frontend ↔ Backend aktiviert

### Hinweis für CI/Codex-Runtime
- Falls `curl -I https://registry.npmjs.org/react` oder `npm ping --registry=https://registry.npmjs.org/` mit **403** fehlschlägt, ist der Runner durch Netzwerk-/Policy-Vorgaben blockiert.
- In dieser Situation keine lokalen Aussagen wie „Build verified“ treffen, wenn `npm ci`/`npm run build` nicht ausführbar sind.
- In Commit/PR klar dokumentieren: `Build in Codex env not possible due to npm registry 403; Render build is source of truth.`
