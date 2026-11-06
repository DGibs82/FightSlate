-- FightSlate v2: provenance, lifecycle, change history, ingestion monitoring.
-- Additive only; existing rows keep their data.

ALTER TABLE "Event"
  ADD COLUMN "timezone" TEXT,
  ADD COLUMN "startKind" TEXT,
  ADD COLUMN "broadcastVerified" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "statusReason" TEXT,
  ADD COLUMN "sourceIds" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "conflicts" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "missingFromSource" BOOLEAN NOT NULL DEFAULT FALSE,
  -- FALSE for events from bulk imports, so they don't trigger new-fight emails.
  ADD COLUMN "announce" BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing rows got announce = FALSE above; new rows default to TRUE.
ALTER TABLE "Event" ALTER COLUMN "announce" SET DEFAULT TRUE;

-- v1 stored MMA events as "UFC / MMA"; v2 uses "MMA".
UPDATE "Event" SET "sport" = 'MMA' WHERE "sport" = 'UFC / MMA';

CREATE TABLE "EventChange" (
  "id" TEXT PRIMARY KEY,
  "eventId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "field" TEXT,
  "bout" TEXT,
  "from" TEXT,
  "to" TEXT,
  "summary" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventChange_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "EventChange_eventId_createdAt_idx" ON "EventChange"("eventId", "createdAt");
CREATE INDEX "EventChange_createdAt_idx" ON "EventChange"("createdAt");

CREATE TABLE "IngestionRun" (
  "id" TEXT PRIMARY KEY,
  "source" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "received" INTEGER NOT NULL DEFAULT 0,
  "accepted" INTEGER NOT NULL DEFAULT 0,
  "rejected" INTEGER NOT NULL DEFAULT 0,
  "warnings" JSONB NOT NULL DEFAULT '[]',
  "error" TEXT,
  "meta" JSONB,
  "usedCacheFrom" TEXT
);
CREATE INDEX "IngestionRun_source_startedAt_idx" ON "IngestionRun"("source", "startedAt");
CREATE INDEX "IngestionRun_startedAt_idx" ON "IngestionRun"("startedAt");

CREATE TABLE "SourceCache" (
  "source" TEXT PRIMARY KEY,
  "events" JSONB NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL
);

ALTER TABLE "DevelopingMatchup"
  ADD COLUMN "sport" TEXT,
  ALTER COLUMN "confidence" DROP NOT NULL,
  ALTER COLUMN "weight" DROP NOT NULL;

ALTER TABLE "Subscriber"
  ADD COLUMN "confirmSentAt" TIMESTAMP(3),
  ADD COLUMN "pendingPrefs" JSONB;
