# FightSlate

**Every fight. One calendar.** Upcoming boxing and MMA cards checked against official sources: start times in your time zone, broadcasters, saved fights with change alerts, calendar feeds and opt-in email alerts.

## Run locally

```bash
npm install
npm test        # 51 tests, no network or database needed
npm start       # http://localhost:8787
```

Without `DATABASE_URL` the app stores everything as JSON under `data/runtime/` (git-ignored). With `DATABASE_URL` it uses PostgreSQL through Prisma. Emails are **logged, not sent**, unless `EMAIL_ENABLED=true` (see `.env.example`).

Useful scripts:

| Command | What it does |
|---|---|
| `npm run ingest` | Run an ingestion now (curated snapshot + any enabled licensed source) |
| `npm run notify:new:dry` / `notify:upcoming:dry` | Show which alert emails *would* go out, without sending or recording them |
| `npm run seed` | Same as a forced ingestion; used by the Render pre-deploy step |

## How it works

```
data/events.json (hand-verified)  ─┐
UFCalendar API (optional, key)     ├─► lib/ingest.mjs ─► store (Postgres or JSON) ─► server.mjs ─► web UI, ICS feeds, JSON API
Boxerbook API (optional, key)     ─┘     normalise · validate · dedupe · diff                └► jobs/ ─► email alerts (Resend)
                                         change history · run log · freshness
```

* **`public/js/core.mjs`**: shared, dependency-free domain logic used by both the server and the browser. It covers normalization, DST-safe time conversion, lifecycle, deduplication, change detection and watchlists.
* **`lib/ingest.mjs`**: runs every source, records an `IngestionRun` per source, and caches each source's last good payload so an outage never empties the schedule. It records `EventChange` history, bumps the calendar `SEQUENCE` on material changes, and flags rather than deletes events a source stops listing.
* **`lib/ics.mjs`**: RFC 5545 output with line folding, `STATUS`, `SEQUENCE`, all-day events for TBA times, and canceled/postponed events kept as `STATUS:CANCELLED` so subscribed calendars update.
* **`lib/notify.mjs`**: digest-style new-fight alerts and reminders, with safety rules described in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#email-safety).
* **`public/app.js`**: the UI. Favorites (saved events, followed fighters) are local-first in `localStorage`, with no account needed. Each saved event keeps a snapshot, so postponements, cancellations, opponent swaps and time changes are highlighted.

## Data policy

* **Confirmed** requires an official promoter or broadcaster source. Events reported only by media or aggregators are *Announced* and labelled "Unofficial source".
* Rumored or negotiating matchups live in `data/developing.json`. They are shown separately and never appear in calendars or alerts.
* Every event carries its source URLs, retrieval dates and a `verifiedAt` date. The UI and `/health` show data freshness.

See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) for source coverage, licensing and how to update the snapshot.

## Endpoints

| Path | Notes |
|---|---|
| `GET /api/events` | `sport`, `promotion`, `status`, `q`, `from`, `to`, `fighter`, `ids`, `include=past` |
| `GET /api/events/:id` | event and change history |
| `GET /api/changes?since=&ids=` | change feed |
| `GET /api/meta` | freshness and promotions |
| `GET /api/fighters/:slug` | bouts on file for a fighter |
| `GET /api/calendar.ics` | `id`, `ids`, `fighters`, `sport`, `promotion`, `status`, `name`, `download=0` for subscriptions |
| `GET /health` | `dataFresh`, last ingest, counts |
| `/internal/*` | admin (Bearer `ADMIN_TOKEN`, 24+ chars; disabled if unset). The dashboard is at `/admin.html` |

More: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · [docs/ROADMAP.md](docs/ROADMAP.md) · [CHANGELOG.md](CHANGELOG.md)
