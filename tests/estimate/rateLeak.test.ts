/**
 * Rupee rates never leak through text: BoQ lump-sum lines carry their rulebook rate in `formula`
 * ("Covered 3950 sq ft × Rs 180 per sq ft", "Lump sum Rs 85000") and the estimate `parameters`
 * map holds the rulebook Rs rates. Without fields.rates every endpoint that returns estimate lines
 * (live BoQ preview, revisions, writes, compare, owner shopping list) or quote results must not
 * contain a rupee amount anywhere.
 */
import { describe, expect, it } from 'vitest';
import { withoutRupees } from '../../src/modules/estimate/rateRedaction.js';
import { api, bearer, loginMobile, SEED, useFreshDatabase } from '../helpers.js';

const seeded = useFreshDatabase();
const owner = async () => bearer((await loginMobile(SEED.malik.owner.phone, SEED.malik.owner.password)).accessToken);
const pm = async () => bearer((await loginMobile(SEED.malik.pm.phone, SEED.malik.pm.password)).accessToken);

const RUPEES = /(?:Rs\.?|PKR|₨)\s*\d/;
type Line = { id: string; kind: string; suppliedBy: string; formula: string; trace: string[] };
const linesOf = (d: { sections: Array<{ lines: Line[] }> }) => d.sections.flatMap((s) => s.lines);
const texts = (d: { sections: Array<{ lines: Line[] }> }) => linesOf(d).flatMap((l) => [l.formula, ...l.trace]);

const QUOTE_INPUTS = { plot: { unit: 'MARLA', size: 10 }, coveredAreaSqft: 3950, floors: 2, mumty: true, structureType: 'FRAMED', contractType: 'FULL' };

/** Every estimate / quote endpoint a viewer can read, as raw JSON text. */
async function readAll(auth: Record<string, string>) {
  const dha = seeded().projects.dha.id;
  const list = (await api().get(`/api/v1/projects/${dha}/estimates`).set(auth)).body.data as Array<{ id: string }>;
  const [rev2, rev1] = list;
  const out: Record<string, unknown> = {};
  const get = async (name: string, path: string) => {
    const res = await api().get(path).set(auth);
    expect(res.status, `${name}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    out[name] = res.body.data;
  };
  await get('live', `/api/v1/projects/${dha}/estimate`);
  await get('list', `/api/v1/projects/${dha}/estimates`);
  await get('rev2', `/api/v1/estimates/${rev2!.id}`);
  await get('rev1', `/api/v1/estimates/${rev1!.id}`);
  await get('compare', `/api/v1/estimates/${rev1!.id}/compare/${rev2!.id}`);
  await get('shopping', `/api/v1/projects/${dha}/owner-shopping-list`);
  const quotes = (await api().get('/api/v1/quotes?limit=50').set(auth)).body.data as Array<{ id: string }>;
  expect(quotes.length).toBeGreaterThan(0);
  await get('quote', `/api/v1/quotes/${quotes[0]!.id}`);
  await get('quoteRevisions', `/api/v1/quotes/${quotes[0]!.id}/revisions`);
  const preview = await api().post('/api/v1/quotes/preview').set(auth).send({ inputs: QUOTE_INPUTS });
  expect(preview.status, JSON.stringify(preview.body).slice(0, 300)).toBe(200);
  out['preview'] = preview.body.data;
  return out as Record<string, never> & { live: { boq: { sections: Array<{ lines: Line[] }>; parameters: Record<string, unknown> } }; rev2: { id: string; sections: Array<{ lines: Line[] }>; parameters: Record<string, unknown> } };
}

function expectNoRupees(all: Record<string, unknown>) {
  for (const [name, body] of Object.entries(all)) expect(JSON.stringify(body), name).not.toMatch(RUPEES);
}

async function denyRates(userId: string) {
  const res = await api().put(`/api/v1/users/${userId}/permission-overrides`).set(await owner()).send({ overrides: [{ key: 'fields.rates', effect: 'DENY' }] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

describe('withoutRupees', () => {
  it('turns every generated rate phrase into rate-free wording', () => {
    expect(withoutRupees('1125 cft × Rs 150 per cft')).toBe('1125 cft × rulebook rate');
    expect(withoutRupees('Footprint 1125 sq ft × plinth 2 ft = 2250 cft × Rs 60 per cft')).toBe('Footprint 1125 sq ft × plinth 2 ft = 2250 cft × rulebook rate');
    expect(withoutRupees('Covered 3950 sq ft × Rs 180 per sq ft')).toBe('Covered 3950 sq ft × rulebook rate');
    expect(withoutRupees('6 wet rooms × Rs 25,000')).toBe('6 wet rooms × rulebook rate');
    expect(withoutRupees('Lump sum Rs 85000')).toBe('Lump sum (rulebook rate)');
    expect(withoutRupees('Paid Rs. 1,250.50 to the site')).toBe('Paid (rate hidden) to the site');
    expect(withoutRupees('7% of (direct cost + site overheads)')).toBe('7% of (direct cost + site overheads)');
  });
});

describe('formula / trace without fields.rates', () => {
  it('the owner (fields.rates) still sees the rulebook rates in the text', async () => {
    const all = await readAll(await owner());
    expect(texts(all.rev2).some((t) => RUPEES.test(t))).toBe(true);
    expect(texts(all.live.boq).some((t) => RUPEES.test(t))).toBe(true);
    expect(Object.keys(all.rev2.parameters)).toContain('mepElectricalRsPerSqft');
  });

  it('a PM without fields.rates gets no rupee amount on any endpoint (and no Rs parameters)', async () => {
    await denyRates(seeded().users.bilal.id);
    const p = await pm();
    const all = await readAll(p);
    expectNoRupees(all);
    // the lump-sum lines are still there, with a rate-free formula
    const mep = linesOf(all.rev2).find((l) => l.kind === 'LUMP_SUM')!;
    expect(mep.formula).toMatch(/rulebook rate/);
    expect(Object.keys(all.rev2.parameters)).not.toContain('mepElectricalRsPerSqft');
    expect(Object.keys(all.rev2.parameters)).toContain('contingencyPercent');
    expect(Object.keys(all.live.boq.parameters)).not.toContain('mepElectricalRsPerSqft');

    // write responses use the same serializer: a quantity override on the DRAFT
    const line = linesOf(all.rev2).find((l) => l.suppliedBy === 'CONTRACTOR' && l.kind === 'LUMP_SUM')!;
    const patched = await api().patch(`/api/v1/estimates/${all.rev2.id}/lines/${line.id}`).set(p).send({ quantity: 10, note: 'Site count' });
    expect(patched.status, JSON.stringify(patched.body).slice(0, 300)).toBe(200);
    expect(JSON.stringify(patched.body.data)).not.toMatch(RUPEES);
    const regen = await api().post(`/api/v1/estimates/${all.rev2.id}/regenerate`).set(p).send({});
    expect(regen.status, JSON.stringify(regen.body).slice(0, 300)).toBe(200);
    expect(JSON.stringify(regen.body.data)).not.toMatch(RUPEES);
  });

  it('an Accountant-like role without fields.rates gets no rupee amount on any endpoint', async () => {
    const o = await owner();
    const roles = (await api().get('/api/v1/roles').set(o)).body.data as Array<{ id: string; key: string }>;
    const bilal = seeded().users.bilal.id;
    expect((await api().patch(`/api/v1/users/${bilal}/role`).set(o).send({ roleId: roles.find((r) => r.key === 'ACCOUNTANT')!.id })).status).toBe(200);
    await denyRates(bilal);
    expectNoRupees(await readAll(await pm()));
  });
});
