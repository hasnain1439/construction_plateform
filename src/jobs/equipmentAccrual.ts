/**
 * Daily equipment accrual (01:30 Asia/Karachi): posts yesterday's internal hire and rent for every
 * company that has equipment (idempotent — safe to repeat; back-dated changes inside the lookback
 * window are corrected with adjustment rows). Cross-tenant, so it runs as prismaAdmin like the
 * other jobs; every query in runAccrualTx filters by tenantId explicitly.
 */
import { prismaAdmin } from '../core/db/prisma.js';
import { runAccrualTx, yesterday } from '../modules/equipment/accrual.js';

export async function runEquipmentAccrual(through = yesterday()): Promise<{ companies: number; rows: number; amountPaisa: bigint }> {
  const tenants = await prismaAdmin.equipmentMovement.findMany({ distinct: ['tenantId'], select: { tenantId: true } });
  let rows = 0;
  let amount = 0n;
  for (const { tenantId } of tenants) {
    const r = await prismaAdmin.$transaction((tx) => runAccrualTx(tx, tenantId, through), { timeout: 120_000 });
    rows += r.internalHire.rows + r.rental.rows;
    amount += r.internalHire.amountPaisa + r.rental.amountPaisa;
  }
  return { companies: tenants.length, rows, amountPaisa: amount };
}
