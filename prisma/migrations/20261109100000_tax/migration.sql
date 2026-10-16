-- Step 18 · Tax (off by default).
-- * TenantSettings: sales tax authority, STRN, default WHT % for the payment form.
-- * Project: tax override (INHERIT / ON / OFF) + authority / rate for a project in another province.
-- * Client: NTN (tax-wise invoice register, WHT summary).
-- * Invoice: tax snapshot frozen at issue (taxable base, authority, seller NTN / STRN, buyer NTN).
-- * ClientPayment: WHT % and the client's withholding certificate (number, date, attachment).
-- No new tables: every column lives on an existing tenant table (RLS / grants unchanged).

-- CreateEnum
CREATE TYPE "TaxAuthority" AS ENUM ('PRA', 'SRB', 'KPRA', 'ICT');

-- CreateEnum
CREATE TYPE "ProjectTaxMode" AS ENUM ('INHERIT', 'ON', 'OFF');

-- AlterTable
ALTER TABLE "TenantSettings"
  ADD COLUMN "taxAuthority" "TaxAuthority",
  ADD COLUMN "taxStrn" TEXT,
  ADD COLUMN "whtDefaultRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 8;

-- AlterTable
ALTER TABLE "Project"
  ADD COLUMN "taxMode" "ProjectTaxMode" NOT NULL DEFAULT 'INHERIT',
  ADD COLUMN "taxAuthority" "TaxAuthority",
  ADD COLUMN "taxRatePercent" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "Client" ADD COLUMN "ntn" TEXT;

-- AlterTable
ALTER TABLE "Invoice"
  ADD COLUMN "taxableBasePaisa" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "taxAuthority" "TaxAuthority",
  ADD COLUMN "sellerNtn" TEXT,
  ADD COLUMN "sellerStrn" TEXT,
  ADD COLUMN "buyerNtn" TEXT;

-- Before Step 18 the tax base was the whole subtotal.
UPDATE "Invoice" SET "taxableBasePaisa" = GREATEST("subtotalPaisa", 0) WHERE "taxPaisa" > 0;

-- AlterTable
ALTER TABLE "ClientPayment"
  ADD COLUMN "whtRatePercent" DECIMAL(5,2),
  ADD COLUMN "whtCertificateNo" TEXT,
  ADD COLUMN "whtCertificateDate" DATE,
  ADD COLUMN "whtCertificateAttachmentId" UUID;
