# Roadmap

## Next (data reliability)

1. **Turn on UFCalendar (free).** Its terms permit commercial use. Set `UFCALENDAR_API_KEY`, then watch `/admin.html` for merges and conflicts with the curated MMA cards for a week. Once it is reliable, the curated MMA entries can shrink to corrections only.
2. **Boxing licence decision.** Boxerbook's free key is for testing and non-commercial use only. Before any ads, affiliates or subscriptions, buy the App plan ($19/mo) or stay on curated boxing data. Contact info@boxerbook.com about public display on the free tier.
3. **Verification workflow.** Add an admin "mark verified" action and a correction form that writes to the database, so curated fixes don't require a deploy. Record the editor in `EventChange`.
4. **Change alerts by email.** Users who opt in get postponements, cancellations and opponent changes for events they saved. This needs server-side favorites (below).

## Fighter intelligence (only with licensed data)

* Profiles with record, age, reach and stance from the UFCalendar `/fighters` endpoints (MMA) and Boxerbook `/boxers` (boxing, paid tier). Show the provider and timestamp on every stat.
* Rankings and champions (`/rankings`, `/champions`), and "who's next" storylines.
* Result ingestion after events, so `COMPLETED` comes from a source, never inferred.
* Head-to-head comparison pages and SEO-friendly fighter/event URLs with `SportsEvent` structured data.

## Accounts and personalization

* Optional sign-in with magic link (reusing the confirmation-token flow) to sync local favorites across devices.
* Per-user signed calendar feed URLs, replacing the `ids=`/`fighters=` query feeds.
* Web push for "starting in 30 minutes" and card changes.

## Monetization (keep editorial separate)

1. **Affiliate "where to watch" links** (DAZN, Paramount+, Netflix, PPV). Disclose them clearly, and keep them out of event data and alerts' ranking.
2. **FightSlate Pro** at a few dollars a month: unlimited followed fighters, change alerts, early-prelim reminders, ad-free, multi-calendar feeds.
3. **Sponsorship of the weekly digest email**, labelled as sponsored.
4. **Odds and betting content only** with a licensed odds provider: provider, timestamp and jurisdiction on every line, responsible-gambling messaging, geo-gating, and no tips mixed into schedule data. Requires legal review per market.
5. **B2B calendar widget** for gyms, bars and media sites, which is only possible once data licences allow redistribution. Current UFCalendar and Boxerbook terms do **not** allow re-exposing their data as an API.

Each monetized feature changes licensing tier needs (Boxerbook commercial plan, UFCalendar terms on redistribution). Re-read provider terms before launch.
