# Security review (common web vulnerabilities)
Reviewer: Hendrik
Date: 2026-02-26 
Scope: `backend/src/index.ts`, selected frontend rendering patterns

## Checked categories
- Auth bypass / privilege checks
- Injection (SQL/command)
- XSS / HTML injection
- CSRF / request forgery
- Session/cookie security
- Clickjacking and browser hardening headers
- Brute-force login abuse

## Findings

### ✅ No direct SQL/command injection paths found in reviewed code
- Data access is performed via Prisma delegates with typed query objects.
- No use of `eval`, `Function`, `child_process`, or raw SQL execution in application code was found in the reviewed paths.

### ✅ No obvious stored/reflected XSS sinks found in reviewed frontend paths
- No `dangerouslySetInnerHTML` usage found.
- User-provided content appears rendered through React text nodes in the reviewed UI paths.

### ⚠️ Previously missing baseline hardening response headers (fixed)
- Added defensive headers globally:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - `Strict-Transport-Security` in production

### ⚠️ Previously missing login brute-force throttling (fixed)
- Added in-memory, per-IP+email failed-login throttling:
  - window: 15 minutes
  - max failed attempts: 10
  - temporary block returns HTTP `429` + `Retry-After`

### ℹ️ CSRF / request-forgery posture (partially mitigated by existing code)
- Mutating endpoints are protected by an origin/referer guard in existing middleware.
- Session cookies are `httpOnly` and `secure` in production.
- `/auth/login` and `/auth/logout` are intentionally excluded from origin checks by existing logic.

## Notes
- In-memory throttling resets on process restart and does not coordinate across horizontal replicas.
- For production-grade anti-bruteforce in multi-instance deployments, move counters to shared storage (e.g., Redis).
