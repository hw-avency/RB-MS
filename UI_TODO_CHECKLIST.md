# UI TODO Checklist – FIND → FIX → PROOF

## PHASE 1 – FIND (Root Causes)

### A) Kalender roter Rand
- Root cause Kalender-Red-Rand: `frontend/src/styles.css:73` (`.day-btn.has-bookings` setzt roten Inset-Rand über `var(--resource-busy)`).
- Zweite Stelle: `frontend/src/styles.css:78` (`.day-btn.today.has-bookings` ergänzt ebenfalls roten Inset-Rand).

### B) Stornierung Nicht-Raum (Tisch/Parkplatz)
- Root cause Storno-Fehlerbild: `frontend/src/BookingApp.tsx:1089-1122`.
  - Kein harter `bookingId`-Guard vor API-Call (nur indirekt via Array, keine explizite Validierung pro ID).
  - API-Aufruf läuft in `Promise.all(...)` ohne Netzwerk-Debug (kein `status`, kein Response-Snippet).
  - Fehler werden geschluckt (`catch (_error)`), dadurch kein brauchbarer Fehlernachweis in Konsole.

### C) Pulse Animation
- Root cause Pulse-Wirkung zu schwach/inkonsistent: 
  - `frontend/src/styles.css:93-95` + `305` nutzen einen sehr subtilen Halo + geringe Scale-Differenz.
  - `frontend/src/styles.css:106` kann die Animation bei Hover/Selection auf fast unsichtbar (`opacity:.05`) drosseln.
  - Kein Debug-Attribut am Marker für „free“-Status vorhanden (kein direkter data-proof im DOM).

## PHASE 2 – FIX
- Kalender: rote Inset-Ränder aus Day-Buttons entfernt (`has-bookings`, `today.has-bookings`).
- Storno Nicht-Raum: `submitPopupCancel` auf harten single-booking Ablauf mit Guard + Await + Debug-Logs umgestellt (`CANCEL_CLICK`, `CANCEL_API_START`, `CANCEL_API_DONE`, `CANCEL_API_ERR`).
- Pulse: dedizierter Halo-Layer (`<div className="pulseHalo" />`) + `resourcePulse` Keyframes gemäß Vorgabe + `prefers-reduced-motion` Fallback + Marker-Debug (`data-free`).

## PHASE 3 – PROOF
- Kalender-Red-Rand: Code-Scan ohne `ring-red|border-red|outline-red` durchgeführt.
- Storno-Logs: Instrumentierung im Code vorhanden; Runtime-End-to-End aktuell durch fehlende Backend-ENV (`DATABASE_URL`) nicht ausführbar.
- Pulse: CSS enthält `animation: resourcePulse`; Marker enthält `data-free`.
