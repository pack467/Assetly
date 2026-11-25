-- AlterTable: Tambah kolom lastSeenAt pada Session (nullable, default createdAt untuk baris lama)
ALTER TABLE "Session"
  ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

UPDATE "Session"
  SET "lastSeenAt" = "createdAt"
  WHERE "lastSeenAt" IS NULL;
