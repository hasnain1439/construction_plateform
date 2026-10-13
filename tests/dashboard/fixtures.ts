import { withSeedSnapshot, type Seeded } from '../helpers.js';

export { api, mockPdf, owner, pm, pmWithFinancials, pdfCalls, rs, today } from '../billing/fixtures.js';
export { munshi } from '../inventory/fixtures.js';

/**
 * The whole Malik & Sons demo (stock, labour & cash, billing) on top of the base test seed —
 * restored from its snapshot (tests/setup/demoSeeds.ts). Call it right after the reset.
 */
export async function seedMalikDemo(s: Seeded) {
  await withSeedSnapshot('malik_demo', s);
}

/** Malik & Sons stock + labour & cash demo (no billing), restored like `seedMalikDemo`. */
export async function seedMalikStockAndLabor(s: Seeded) {
  await withSeedSnapshot('malik_stock_labor', s);
}
