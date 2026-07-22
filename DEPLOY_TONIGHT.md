# Deploy FightSlate tonight

## Before starting

Create:

1. A GitHub repository
2. A Render account
3. A Resend account with a verified sending domain

## Push the project

```bash
git init
git add .
git commit -m "Launch FightSlate"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

## Create the Render Blueprint

1. In Render, select **New**, then **Blueprint**.
2. Connect the GitHub repository.
3. Select `render.yaml`.
4. Enter the secret environment variables when prompted.

Use:

```text
RESEND_API_KEY=re_...
EMAIL_FROM=FightSlate <alerts@YOURDOMAIN.com>
EMAIL_REPLY_TO=support@YOURDOMAIN.com
```

Render creates the web service, PostgreSQL database, and two cron jobs. Render cron schedules use UTC.

## Verify

Open:

```text
https://YOUR-SERVICE.onrender.com/health
https://YOUR-SERVICE.onrender.com/
https://YOUR-SERVICE.onrender.com/admin.html
```

The health response should show `ok: true`, at least 20 events, and `mode: postgres`.

## Test the mailing list

Subscribe with an address you control. Confirm the message. In Render, open the cron job and use **Trigger Run** to test a notification manually.

## Custom domain

Add the domain to the web service in Render. Then add `APP_URL=https://YOURDOMAIN.com` to the web service and both cron jobs, and redeploy. Without `APP_URL`, the app automatically uses Render's generated hostname.

## What still requires account access

The final GitHub push, Render Blueprint creation, DNS changes, and Resend domain verification require your credentials and cannot be completed from this build environment.
