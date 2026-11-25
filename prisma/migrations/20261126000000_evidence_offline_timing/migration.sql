-- AlterTable: Tambah kolom waktu unggah HP, selisih jam mentah, dan lama antrean offline pada Evidence
ALTER TABLE "Evidence"
  ADD COLUMN IF NOT EXISTS "uploadedAtDevice" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rawClockSkewSec" INTEGER,
  ADD COLUMN IF NOT EXISTS "offlineDelaySec" INTEGER;
