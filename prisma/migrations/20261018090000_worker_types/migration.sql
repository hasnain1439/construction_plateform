-- Company-defined worker types. A worker type IS the company's DAILY LaborRate row (key, labels in
-- three languages, daily rate, overtime multiplier, active flag); Worker.type holds its key (or "OTHER").

-- ─── Worker.type: enum → text (values kept; the index is rebuilt by Postgres) ─────────────────────
ALTER TABLE "Worker" ALTER COLUMN "type" TYPE TEXT USING "type"::text;

-- Only Worker.type used this enum (fails loudly if anything else still does).
DROP TYPE IF EXISTS "WorkerType";

-- ─── LaborRate: Roman Urdu / Urdu names + active flag ─────────────────────────────────────────────
ALTER TABLE "LaborRate" ADD COLUMN "labelRoman" TEXT,
ADD COLUMN "labelUrdu" TEXT,
ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- Backfill the default daily types of every company. The English label is replaced only while it
-- is still the old default (a company that renamed a type keeps its name).
UPDATE "LaborRate" r
SET "labelRoman" = COALESCE(r."labelRoman", d.roman),
    "labelUrdu"  = COALESCE(r."labelUrdu", d.urdu),
    "label"      = CASE WHEN r."label" = d.old THEN d.en ELSE r."label" END
FROM (VALUES
  ('MISTRI',             'Mistri',             'Mason',              'Mistri',             'مستری'),
  ('MISTRI_TILES',       'Mistri (tiles)',     'Tile mason',         'Mistri (tiles)',     'ٹائل مستری'),
  ('MAZDOOR',            'Mazdoor',            'Labourer',           'Mazdoor',            'مزدور'),
  ('STEEL_FIXER_HELPER', 'Steel-fixer helper', 'Steel-fixer helper', 'Steel fixer helper', 'اسٹیل فکسر ہیلپر'),
  ('CHOWKIDAR',          'Chowkidar',          'Watchman',           'Chowkidar',          'چوکیدار')
) AS d(key, old, en, roman, urdu)
WHERE r."kind" = 'DAILY' AND r."key" = d.key;

-- ─── Change tracking: phones pull the worker types (sync table worker_types) ──────────────────────
CREATE TRIGGER sync_track AFTER INSERT OR UPDATE OR DELETE ON "LaborRate"
  FOR EACH ROW EXECUTE FUNCTION sync_track('LaborRate', 'id', '', '');

-- RLS on "LaborRate" (ENABLE + FORCE + tenant_isolation) and the app_user grant come from
-- 20261006090000_master_data and cover the new columns; nothing to change.
