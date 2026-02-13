# Phase 0 – Repository State (Read-only Findings)

## 1) Requested Git Commands

### `git status`
```
On branch work
nothing to commit, working tree clean
```

### `git log -n 15 --oneline`
```
7468679 Create AGENTS.md
2250afe Merge pull request #24 from hw-avency/codex/fix-mitarbeiter-ui-layout-issues
6d87c66 Fix admin Mitarbeiter panel layout and overflow
5871b65 Merge pull request #23 from hw-avency/codex/improve-admin-desk-repositioning-and-sync-bookings
c86ce83 Add desk reposition mode and desk/list hover sync
da67e6f Merge pull request #22 from hw-avency/codex/add-booking-modes-and-backend-endpoints
0dd577c Add range and recurring series booking modes
275660d Merge pull request #21 from hw-avency/codex/add-employee-management-and-booking-dropdown
04bd2e4 Add employee-based booking selection and named occupancy list
7399afe Merge pull request #20 from hw-avency/codex/redesign-admin-mode-ui-for-canvas-interaction
564d5b0 Redesign admin mode into tabbed editor layout
c744e0c Merge pull request #19 from hw-avency/codex/implement-employee-directory-and-booking-improvements
3b9709d Add employee directory and booking selector flow
ed58902 Merge pull request #18 from hw-avency/codex/add-rename-functionality-for-floorplans-and-desks
408c6ad Add admin rename flows for floorplans and desks
```

### `git diff --stat origin/main...HEAD`
```
fatal: ambiguous argument 'origin/main...HEAD': unknown revision or path not in the working tree.
```

### `git diff --stat main...HEAD`
```
fatal: ambiguous argument 'main...HEAD': unknown revision or path not in the working tree.
```

### Branch/remote reality check
- No `origin` remote configured.
- Only branch detected: `work`.
- Therefore branch-to-main diff cannot be computed in this environment.

## 2) File summaries (max 10 bullets)

1. `AGENTS.md` requires small reviewable changes and Render-safe deployability (backend Docker service + frontend static site).
2. Required env vars are explicitly documented: backend `DATABASE_URL`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`; frontend `VITE_API_BASE_URL`.
3. `README.md` confirms root-based API routes (no `/api`) and Render setup without blueprint.
4. Backend startup/deploy expectation includes Prisma generate + migrate deploy (and optional seed).
5. `frontend/package.json` uses Vite + TS build (`tsc -b && vite build`), React 18.
6. `backend/package.json` uses TypeScript compile (`tsc -p`), runtime `node dist/index.js`, Prisma scripts included.
7. Frontend API base is `import.meta.env.VITE_API_BASE_URL || window.location.origin` in `frontend/src/api.ts`.
8. Frontend stores admin auth token in `localStorage` key `adminToken`.
9. Login flow: frontend POSTs `/admin/login`, stores token, then uses bearer token for `/admin/*` endpoints.
10. `/me` is called on bootstrap and currently returns a static demo user from backend (`demo@example.com`), with client intentionally ignoring `/me` failures.

## 3) Confirmed auth/base-url flows

### Frontend/Backend base URLs
- Frontend runtime base URL: `VITE_API_BASE_URL` or fallback to same-origin.
- README examples mention possible backend Render host (`https://rbms-backend.onrender.com`) but as example only.
- No canonical deployed production URL is hardcoded in source.

### Token storage
- Admin token key: `localStorage['adminToken']`.
- No MSAL/Entra cache code found.

### Login bootstrap flow
- On app init, frontend calls `/me`; if email exists, it sets booking identity fields.
- `/me` errors are swallowed to keep defaults.
- Admin mode is client-state driven by presence of `adminToken` in localStorage.

### Logout flow
- `logoutAdmin()` removes `adminToken` from localStorage and clears state.
- No backend logout endpoint is called.
- On API 401, frontend also clears token and exits admin mode.

## 4) "What is actually deployed now" verification status

- Direct deployment verification is **not reliably possible** from this environment:
  - Render URLs in repo are examples, not guaranteed active deployment targets.
  - External health checks to guessed URLs returned proxy `403 CONNECT tunnel failed`.
  - Git remotes are absent, so this workspace cannot compare against `origin/main`.

# Phase 1 – Plan before code edits

1. Add this report file under `docs/` to preserve the requested read-only findings.
2. Keep application/runtime code unchanged to avoid accidental behavior drift.
3. Run frontend build (`npm run build`) to ensure TypeScript/Vite remains green.
4. Run backend build (`npm run build`) to ensure backend TypeScript remains green.
5. Commit the documentation-only change with a clear message.
6. Open PR with the same findings and caveats about missing `origin/main` and deployment URL ambiguity.
