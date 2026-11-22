-- =====================================================================
-- CONSTRAINT TAMBAHAN (SQL) - Bagian 5.1 PROJECT_SPEC.md
-- =====================================================================

-- 1) Satu barang hanya boleh punya SATU peminjaman aktif (BR-02).
CREATE UNIQUE INDEX one_active_loan_per_asset
  ON "LoanItem" ("assetId")
  WHERE "returnedAt" IS NULL;

-- 2) Log aktivitas tidak boleh diubah atau dihapus (BR-13).
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog bersifat append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- 3) Cek nilai koordinat yang masuk akal.
ALTER TABLE "Evidence"
  ADD CONSTRAINT evidence_lat_range  CHECK ("latitude"  BETWEEN -90  AND 90),
  ADD CONSTRAINT evidence_lng_range  CHECK ("longitude" BETWEEN -180 AND 180);
