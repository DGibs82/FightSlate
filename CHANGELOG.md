# Changelog

## 2.0.0 (unreleased, branch `upgrade/trustworthy-release`)

### Security
- Removed the `ADMIN_TOKEN || 'change-me'` fallback. Admin is disabled unless a 24+ character token is set, and the comparison is constant-time.
- Removed the `TOKEN_SECRET || 'dev-only-change-me'` fallback. The secret is required in production; local dev generates a random per-checkout secret.
- `render.yaml`: one shared `TOKEN_SECRET` for the web service and cron jobs (previously each generated its own).
- Added a CSP and other security headers, a 16 KB body limit, 400 responses for malformed JSON, and rate limits on subscribe and admin.
- Hardened static file serving against path traversal. Removed the publicly served `index.old.html` and `admin.old.html`.
- Subscribe can no longer reset an active subscriber to pending or change their preferences without inbox confirmation. Confirmation links expire after 48h.

### Correctness
- Fixed per-event "Calendar" downloads, which returned the whole calendar (`?q=` was sent but the server read `?id=`).
- Removed the hardcoded "Refreshed July 21, 2026" label, the July 25 Spence vs Tszyu hero, and `/health`'s hardcoded `updated` date. All are now computed from data.
- Replaced the stale July snapshot (all events past) with 33 events verified on 2026-11-05 and refreshed the developing matchups.
- MMA events used `"UFC / MMA"` as the sport, so filters missed them. Now normalized to `MMA`.
- ICS: line folding, `STATUS`, `SEQUENCE`, `LAST-MODIFIED`, canceled/postponed events marked `CANCELLED`, and all-day entries with an exclusive end for TBA times.
- Times are stored as official local time + IANA zone and converted with DST awareness. The UI shows the user's time zone and venue time.

### Email
- New subscribers no longer receive one email per existing event. Alerts are now one digest, only for events added after confirmation.
- Every email has a working unsubscribe link. v1 created an unsubscribe token but never sent it.
- Added `EMAIL_ENABLED` (default off), dry-run jobs, a per-run cap, HTML escaping, and suppression of announcements for bulk imports.

### Data and ingestion
- Ingestion engine with per-source run logs, retries with backoff, last-good cache, change history, provenance (`sources`, `retrievedAt`, `verifiedAt`, `firstSeenAt`), deduplication, conflict surfacing and freshness reporting.
- Optional licensed connectors for UFCalendar (MMA) and Boxerbook (boxing), off by default.
- Strict separation: only official sources can make an event CONFIRMED, and rumors are never in calendars or alerts.

### Product
- Rebuilt UI: Boxing/MMA filters, promotion, date range, status, an official-only toggle, search, month grouping, empty states, and a data-freshness bar.
- My Slate: local-first saved events and followed fighters, change highlighting (time, date, status, venue, broadcaster, opponent, canceled bouts) with "mark as seen", and a personal calendar feed.
- Event dialog with segments, title-fight markers, canceled bouts, sources, change history and Google Calendar link. Basic fighter view built from on-file bouts only.
- Admin dashboard: freshness, review queue, ingestion runs, change log, and alert previews.
- Accessibility: skip link, labelled controls, `aria-pressed` toggles, live regions, focus styles, reduced-motion support. Mobile layout verified at 390px.

### Tests
- 51 tests (`npm test`) covering deduplication, time zones and DST, lifecycle, provenance and ingestion failure modes, calendar correctness, favorites and change detection, notification safety, admin and token security, and HTTP hardening.
