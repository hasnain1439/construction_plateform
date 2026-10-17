/**
 * QA-B-26 · the milestones the schedule generator makes, by template key (`<STAGE>.<PART>`), with
 * their English names. A milestone keeps its generated name (English) in the database; the apps
 * translate it by `templateKey` (milestone DTOs) and the report files by `milestone.<key>` in the
 * server catalogue. A milestone the company renamed has `templateKey: null` (its own name is shown).
 */
export const MILESTONE_NAMES = {
  'FOUNDATION_PLINTH.EXCAVATION': 'Excavation (khudai)',
  'FOUNDATION_PLINTH.FOUNDATION': 'Foundation & DPC',
  'FOUNDATION_PLINTH.PLINTH_FILL': 'Plinth filling (bharai)',
  'GF_STRUCTURE.WALLS': 'Ground floor — columns & brickwork',
  'GF_STRUCTURE.SLAB': 'Ground floor — roof slab (lenter)',
  'F1_STRUCTURE.WALLS': 'First floor — columns & brickwork',
  'F1_STRUCTURE.SLAB': 'First floor — roof slab (lenter)',
  'F2_STRUCTURE.WALLS': 'Second floor — columns & brickwork',
  'F2_STRUCTURE.SLAB': 'Second floor — roof slab (lenter)',
  'F3_STRUCTURE.WALLS': 'Third floor — columns & brickwork',
  'F3_STRUCTURE.SLAB': 'Third floor — roof slab (lenter)',
  'MUMTY_ROOF.STRUCTURE': 'Mumty walls & roof slab',
  'MUMTY_ROOF.WATERPROOFING': 'Roof waterproofing & filling',
  'PLASTER_MEP.MEP': 'Electrical & plumbing rough-in',
  'PLASTER_MEP.PLASTER': 'Plaster (inside & outside)',
  'FINISHING.TILES': 'Flooring & wall tiles',
  'FINISHING.PAINT': 'Paint',
} as const;

export type MilestoneTemplateKey = keyof typeof MILESTONE_NAMES;

export const isTemplateKey = (key: string): key is MilestoneTemplateKey => Object.hasOwn(MILESTONE_NAMES, key);

/** The template key when the milestone still has its generated name, else null (renamed / custom). */
export function templateKeyOf(m: { key: string; name: string }): MilestoneTemplateKey | null {
  return isTemplateKey(m.key) && MILESTONE_NAMES[m.key] === m.name ? m.key : null;
}
