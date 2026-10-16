/**
 * Step 15 · offline sync of site instructions (Munshi app). Pull table `site_instructions` (no
 * money); without changeorder.instruction.view only the caller's own. The push mutation
 * SITE_INSTRUCTION_CREATE lives in sync.push.ts and calls siteInstructions.createTx.
 */
import { dateOnly } from '../../core/utils/dates.js';
import { addDays } from '../labor/labor.shared.js';
import type { SyncRow, TableDef } from '../sync/sync.tables.js';
import { changeOrderCode, siteInstructionCode } from './totals.js';

export const CHANGE_ORDER_TABLE_PERMISSIONS: Record<string, string[]> = {
  site_instructions: ['changeorder.instruction.create', 'changeorder.instruction.view'],
};

export const CHANGE_ORDER_TABLES: TableDef[] = [
  {
    name: 'site_instructions',
    sources: ['SiteInstruction'],
    load: async (tx, sc, ids) => {
      const rows = await tx.siteInstruction.findMany({
        where: {
          tenantId: sc.a.tenantId,
          ...(ids ? { id: { in: ids } } : {}),
          projectId: { in: sc.projectIds },
          ...(sc.perms.has('changeorder.instruction.view') ? {} : { createdById: sc.a.userId }),
          OR: [{ status: 'NEW' }, { updatedAt: { gte: dateOnly(addDays(sc.day, -60)) } }],
        },
        orderBy: [{ projectId: 'asc' }, { number: 'asc' }],
      });
      const cos = rows.length
        ? await tx.changeOrder.findMany({ where: { tenantId: sc.a.tenantId, siteInstructionId: { in: rows.map((r) => r.id) } }, select: { id: true, number: true, siteInstructionId: true } })
        : [];
      return rows.map((r): SyncRow => {
        const co = cos.find((c) => c.siteInstructionId === r.id);
        return {
          id: r.id,
          projectId: r.projectId,
          number: r.number,
          code: siteInstructionCode(r.number),
          note: r.note,
          photoIds: r.photoIds,
          status: r.status,
          changeOrderId: co?.id ?? null,
          changeOrderCode: co ? changeOrderCode(co.number) : null,
          dismissReason: r.dismissReason,
          clientId: r.clientId,
          createdById: r.createdById,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        };
      });
    },
  },
];
