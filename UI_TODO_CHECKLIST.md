# UI TODO Checklist – FIND → FIX → PROOF

## PHASE 1 – FIND (Root Causes)

### A) Kalender roter Rand
- Root cause Kalender-Red-Rand: `frontend/src/styles.css:73` (`.day-btn.has-bookings` setzt roten Inset-Rand über `var(--resource-busy)`).
- Zweite Stelle: `frontend/src/styles.css:78` (`.day-btn.today.has-bookings` ergänzt ebenfalls roten Inset-Rand).

### B) Stornierung global (alle Ressourcentypen)
- Root cause Storno-Fehlerbild: uneinheitliche Delete-Implementierungen statt eines zentralen API-Calls.
  - Der zentrale Header-Pfad (`frontend/src/api.ts:16-24`) ergänzt im Dev-Bypass den Auth-Header `x-dev-user`.
  - Der vorherige lokale Sonderweg in `BookingApp` nutzte diesen Header nicht, wodurch Stornos je nach Modus als 401/403 fehlschlagen konnten.
  - Logging war nicht durchgängig als Click/Request/Response/Catch umgesetzt.

### C) Pulse Animation
- Root cause Pulse-Wirkung zu schwach/inkonsistent: 
  - `frontend/src/styles.css:93-95` + `305` nutzen einen sehr subtilen Halo + geringe Scale-Differenz.
  - `frontend/src/styles.css:106` kann die Animation bei Hover/Selection auf fast unsichtbar (`opacity:.05`) drosseln.
  - Kein Debug-Attribut am Marker für „free“-Status vorhanden (kein direkter data-proof im DOM).

## PHASE 2 – FIX
- Kalender: rote Inset-Ränder aus Day-Buttons entfernt (`has-bookings`, `today.has-bookings`).
- Storno global: zentrale Funktion `cancelBooking(bookingId)` in `frontend/src/api/bookings.ts` eingeführt (DELETE `/bookings/:id`, Guard, Error-Propagation, Hard-Logs).
- Alle relevanten UIs auf zentrale Storno-Funktion umgestellt: User-Dialog (`BookingApp`) + Admin-Delete (`AdminRouter`).
- Pulse: dedizierter Halo-Layer (`<div className="pulseHalo" />`) + `resourcePulse` Keyframes gemäß Vorgabe + `prefers-reduced-motion` Fallback + Marker-Debug (`data-free`).

## PHASE 3 – PROOF
- Kalender-Red-Rand: Code-Scan ohne `ring-red|border-red|outline-red` durchgeführt.
- Storno-Logs: Instrumentierung im Code vorhanden (`[CANCEL] click/request/response/body/error`) für reproduzierbaren Netzwerk-Nachweis.
- Pulse: CSS enthält `animation: resourcePulse`; Marker enthält `data-free`.
