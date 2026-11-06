# Deployment notes

The live service (`fightslate-web` on Render) currently runs v1 from `main` and serves the July 21 snapshot, in which every event is now in the past. This branch has **not** been pushed or deployed.

## What changes on deploy

1. **Migration `202611050001_provenance_changes`** (additive; no data is dropped):
   * Adds provenance and lifecycle columns to `Event`, and normalizes v1 `"UFC / MMA"` to `"MMA"`.
   * Adds `EventChange`, `IngestionRun` and `SourceCache`.
   * Relaxes `DevelopingMatchup.confidence/weight` to nullable and adds `confirmSentAt` and `pendingPrefs` to `Subscriber`.
   * Existing rows get `announce = false`, so they never trigger new-fight emails.
2. **Pre-deploy `npm run seed`** runs a forced ingestion. The new 33 events are a bulk import (more than 15 new), so they are stored **without** new-fight alerts. The 21 July events stay in the database as past history.
3. **`render.yaml`** now uses an env group `fightslate-shared` for `TOKEN_SECRET`, Resend settings, `EMAIL_ENABLED` and optional API keys:
   * In v1 each service generated its own `TOKEN_SECRET`. Moving to the group gives the web service a new secret. That is safe today (0 subscribers), but any pending v1 confirmation links would stop working.
   * When the Blueprint syncs, Render will ask for the `sync: false` values. Leave the API keys empty unless you have them.
4. `ADMIN_TOKEN` stays Render-generated on the web service. Find it in the Render dashboard and use it at `/admin.html`. There is no fallback token: if it is unset or shorter than 24 characters, admin is disabled (HTTP 503).

## Steps

```bash
git push -u origin upgrade/trustworthy-release   # then open a PR and review
```

1. Merge to `main`. Render auto-deploys the web service, and the pre-deploy step migrates and seeds.
2. Check `https://fightslate-web.onrender.com/health`: expect `dataFresh: true`, `upcomingEvents ≥ 30` and `mode: postgres`.
3. Open `/admin.html` with the admin token, confirm a `curated` SUCCESS run and the review list, and run **Preview new-fight alerts** (a dry run).
4. Leave `EMAIL_ENABLED=false` until a Resend domain is verified and you have tested with your own address.

Rollback: redeploy the previous commit. The migration is additive, so v1 code still runs against the new schema.

## Email safety

Applies to both the web service and the cron jobs:

* Nothing is sent unless `EMAIL_ENABLED=true` **and** `RESEND_API_KEY` and `EMAIL_FROM` are set. Otherwise messages are logged as previews.
* New-fight alerts cover only events first seen **after** the subscriber confirmed, that are upcoming, have status `ANNOUNCED` or `CONFIRMED`, are not `missingFromSource`, and are not from a bulk import. Each subscriber gets **one digest** per run, and each event is announced to a subscriber at most once.
* Reminders require a real start time and an active status. The dedupe key includes the start time, so a rescheduled event gets one new reminder.
* `NOTIFY_MAX_PER_RUN` (default 200) caps emails per job run.
* Every email has a signed one-click unsubscribe link plus `List-Unsubscribe` and `List-Unsubscribe-Post` headers. Visiting the link with GET only shows a confirmation button, so link scanners can't unsubscribe people.
* Subscribe is rate-limited per IP and per address. The response is identical whether or not the address exists. An unauthenticated request can never alter an active subscription: changes need confirmation from the inbox.

## Ingestion schedule and cost

* The web service ingests at startup and every `INGEST_INTERVAL_MINUTES` (60) in-process. **No new paid Render cron was added.**
* Licensed connectors enforce their own minimum interval (UFCalendar 24h, Boxerbook 6h) to stay within free quotas. When skipped, they reuse their cached data.
* `/health` always returns 200 while the process is healthy, with staleness reported as `dataFresh`. Point an uptime monitor at it and alert on `dataFresh:false`.

## Known limitations

* Rate limiting is in-memory per instance. That's fine for one Render instance; use Redis or a database if you scale out.
* The schema has minor cosmetic drift inherited from the hand-written v1 migration (FK `ON UPDATE` actions, `updatedAt` defaults). It is harmless with `prisma migrate deploy`. If you ever use `migrate dev`, generate a baseline first.
* Fighter images in `public/assets/fighters/` came with v1 and have no recorded licence. Confirm rights before featuring them, or remove them. The UI shows them only when both fighters of a headliner have one.
* Verified with a Postgres engine (PGlite) and JSON storage locally, not yet on Render's managed Postgres.
