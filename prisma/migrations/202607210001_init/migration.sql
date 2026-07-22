CREATE TABLE "Event" (
  "id" TEXT PRIMARY KEY,
  "sport" TEXT NOT NULL,
  "promotion" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "headline" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "start" TIMESTAMP(3),
  "timeNote" TEXT NOT NULL,
  "venue" TEXT NOT NULL,
  "location" TEXT NOT NULL,
  "network" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "images" JSONB NOT NULL,
  "sources" JSONB NOT NULL,
  "fights" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Event_date_sport_status_idx" ON "Event"("date","sport","status");
CREATE TABLE "DevelopingMatchup" (
  "id" TEXT PRIMARY KEY,"title" TEXT NOT NULL,"status" TEXT NOT NULL,"confidence" INTEGER NOT NULL,
  "target" TEXT NOT NULL,"weight" TEXT NOT NULL,"summary" TEXT NOT NULL,"sources" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Subscriber" (
  "id" TEXT PRIMARY KEY,"email" TEXT NOT NULL UNIQUE,"status" TEXT NOT NULL DEFAULT 'PENDING',
  "boxing" BOOLEAN NOT NULL DEFAULT TRUE,"mma" BOOLEAN NOT NULL DEFAULT TRUE,
  "newFightAlerts" BOOLEAN NOT NULL DEFAULT TRUE,"upcomingAlerts" BOOLEAN NOT NULL DEFAULT TRUE,
  "reminderHours" INTEGER NOT NULL DEFAULT 24,"confirmTokenHash" TEXT,"unsubscribeTokenHash" TEXT,
  "confirmedAt" TIMESTAMP(3),"unsubscribedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Delivery" (
  "id" TEXT PRIMARY KEY,"subscriberId" TEXT NOT NULL,"eventId" TEXT,"type" TEXT NOT NULL,"dedupeKey" TEXT NOT NULL UNIQUE,
  "providerId" TEXT,"status" TEXT NOT NULL,"error" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Delivery_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE,
  CONSTRAINT "Delivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL
);
CREATE INDEX "Delivery_subscriberId_createdAt_idx" ON "Delivery"("subscriberId","createdAt");
