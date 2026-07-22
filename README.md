# FightSlate live launch package

Refreshed July 21, 2026.

## Run locally

```bash
npm install
npm test
npm start
```

Open `http://localhost:8787`.

Without `DATABASE_URL`, the app uses local JSON files. With `DATABASE_URL`, it uses PostgreSQL through Prisma.

## Production

See `DEPLOY_TONIGHT.md`. The Render Blueprint provisions a web service, PostgreSQL, new-fight alert cron, and upcoming-reminder cron.
