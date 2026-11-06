# Data sources, coverage and limitations

_Last reviewed: 2026-11-05._

## Current coverage (snapshot verified 2026-11-05)

| | Events | Window | Official source |
|---|---|---|---|
| MMA | 10 (UFC 6, PFL 4) | Nov 7, 2026 to Jan 30, 2027 | ufc.com, pflmma.com event pages |
| Boxing | 23 | Nov 7, 2026 to Jan 23, 2027 | Matchroom, Queensberry, Top Rank, MVP, No Limit, UFC.com (Zuffa Boxing), Netflix Tudum |
| Developing | 2 | — | Media reports (shown as "not confirmed") |

* 6 boxing events have **no official source yet**: Perez vs Rivera, Price vs Kotaskova, Jones vs Pettus, Tokyo triple-header, Benavidez vs Cieslak, and Bank vs Alimkhanuly. They rely on ESPN's schedule or FightMag, are stored as `ANNOUNCED`, and show an "Unofficial source" badge. (PBC and Golden Boy's sites blocked automated reading.)
* **Start times** are filled in only where an official page states them; the rest show "Time TBA" and become all-day calendar entries. Officially timed: all UFC/PFL cards with a main event, plus MVPW-07, Tszyu vs Lara and Haney vs Paro.
* Items flagged in the data for a human to re-check:
  * The UFC Nov 7 main event changed after Sean Brady's reported withdrawal.
  * Zuffa Boxing 12: ESPN lists a different opponent for Sam Hickey.
  * Buatsi vs Hutchinson: interim or full WBC title is unclear.
  * Fury vs Joshua: ring walks around 1 AM UK are reported but unofficial.
  * PFL Khobar and Kigali list placeholder times.
* Spot-checked by hand against the live pages on 2026-11-05: UFC 334 (card, times), Haney vs Paro (Top Rank release), Fury vs Joshua (Netflix Tudum, Matchroom).

## Source review

Pricing and terms were read on 2026-11-05. Re-check before relying on them.

| Source | Use in FightSlate | Status |
|---|---|---|
| **Official promoter pages** (ufc.com, pflmma.com, Matchroom, Queensberry, Top Rank, MVP…) | Hand-verified snapshot in `data/events.json` | **Manual only.** ufc.com terms forbid "page-scrape", "robot", "spider" and building a database; pflmma.com §4 forbids scraping and aggregation. Don't automate these. |
| **UFCalendar API** (MMA: UFC, PFL, OKTAGON, BKFC, RIZIN) | `lib/connectors/ufcalendar.mjs`, enabled by `UFCALENDAR_API_KEY` | Free plan is 1,000 requests/month, and its developer terms allow commercial use. No bulk redistribution of the raw dataset. Fighter images need artist/licence credit (we don't use them). Default poll is once per 24h, about 18 requests (≈540/month). |
| **Boxerbook API** (boxing) | `lib/connectors/boxerbook.mjs`, enabled by `BOXERBOOK_API_KEY` | Free key is "personal, non-commercial and testing" only; **commercial use requires the App plan ($19/mo)**. Attribution "Data from Boxerbook" with links is required (the connector puts it in each event's sources). It has no main-event field, so the connector never guesses a headliner. Club shows are filtered out (a card needs a broadcaster or a title bout). |
| TheSportsDB | Not integrated | $9/mo tier looks plausible, but its terms page was unreachable. Verify before use. |
| SportsDataIO, Sportradar | Not integrated | Enterprise contracts, prices not published. |
| API-Sports MMA | Not integrated | Site blocked review; terms and pricing unverified. |
| BoxRec, Tapology, Sherdog, ESPN hidden APIs, ESPN-derived ICS feeds | **Do not use** | Scraping prohibited, or terms unverified. |

Nothing was purchased or signed up for. Both connectors are off by default.

### How sources combine

1. Events from every source are normalized and validated. Invalid events are rejected and logged in the run's `warnings`, never guessed.
2. Duplicates are merged when sport matches, dates are within 1 day, and the headliner pair appears on both cards. Official sources win field conflicts. A lower-ranked source reporting a cancellation or postponement is kept as a `conflict` and shown in the UI and admin review list.
3. Only an official source can make an event `CONFIRMED`. Aggregator-only events are `ANNOUNCED`.
4. If a source stops listing an upcoming event, it is flagged `missingFromSource` ("Needs re-check"), never deleted or auto-canceled.
5. If a source fails or is rate-limited, its last good payload is reused, so merged fields don't flap.

## Updating the curated snapshot

1. Re-check each event on the official page linked in its `sources`.
2. Edit `data/events.json`:
   * For times, set `startLocal` to the wall-clock time and IANA zone *exactly as printed* (for example `{"date":"2026-11-14","time":"21:00","zone":"America/New_York"}`). Ingestion converts it to UTC, DST-aware. Leave it out if no official time exists.
   * Use `status` values `ANNOUNCED | CONFIRMED | POSTPONED | CANCELED | COMPLETED`, and `statusReason` for context.
   * Mark a canceled bout with `"status": "CANCELED"` on the bout rather than deleting it, so saved-fight users see the change.
   * Update `retrievedAt` and `verifiedAt` to the check date.
3. Run `npm test`. It validates every entry, checks for duplicates, enforces the CONFIRMED-needs-official rule, and checks the time conversions.
4. Deploy. The pre-deploy `seed` runs an ingestion, so changes appear in the change log and in users' "changed" badges.

The admin dashboard lists events not re-verified within `REVERIFY_AFTER_DAYS` (default 7). The public site shows "Schedule may be out of date" when ingestion is older than `STALE_AFTER_HOURS` or most upcoming events need re-verification.

## Divergent copies

`~/Downloads/FightSlate/index.html` (outside this repo) is the **original July demo prototype** with invented fighters and odds. It is not this app and should not be deployed. A later "ChatGPT Site" prototype was mentioned but isn't available in this workspace, so it couldn't be compared. This repository is the source of truth.
