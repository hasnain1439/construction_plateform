/**
 * QA-B-09 · plan-version notes. A new version stores a small JSON note (what changed, with the
 * values) and every reader renders it in its own language — Plan versions and Control → Delay
 * "What happened". Notes written before this change ("Mumty walls & roof slab: startNoEarlierThan",
 * "RAIN · 2026-10-11 – 2026-10-12") are rendered readably too; any other text is shown as stored.
 */
import { hasKey, tr, type Lang, type MessageKey } from '../../core/i18n/index.js';
import { day } from '../../core/pdf/templates.js';

type Change = { field: string; from?: unknown; to?: unknown };
type Note = { t: 'MILESTONE_EDITED'; milestone: string; changes: Change[] } | { t: 'STOPPAGE_APPROVED'; reason: string; from: string; to: string };

const FIELDS = ['startNoEarlierThan', 'workDays', 'curingDays', 'name', 'dependsOn', 'billingStageId'] as const;

/** Stored note of a milestone edit (`changes` as audited: { field: { from, to } | value }). */
export function milestoneEditedNote(milestone: string, changes: Record<string, unknown>): string {
  const list: Change[] = Object.entries(changes).map(([field, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) && 'to' in v ? { field, from: (v as { from?: unknown }).from ?? null, to: (v as { to?: unknown }).to ?? null } : { field, to: Array.isArray(v) ? null : (v ?? null) },
  );
  return JSON.stringify({ t: 'MILESTONE_EDITED', milestone, changes: list } satisfies Note);
}

/** Stored note of an approved stoppage. */
export function stoppageApprovedNote(reason: string, dates: string[]): string {
  const sorted = [...dates].sort();
  return JSON.stringify({ t: 'STOPPAGE_APPROVED', reason, from: sorted[0] ?? '', to: sorted.at(-1) ?? '' } satisfies Note);
}

const fieldLabel = (lang: Lang, field: string) => ((FIELDS as readonly string[]).includes(field) ? tr(lang, `plan.field.${field}` as MessageKey) : field);
const dateText = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? day(v) : String(v ?? ''));

function changeText(lang: Lang, c: Change): string {
  switch (c.field) {
    case 'startNoEarlierThan':
      return c.to ? tr(lang, 'plan.change.startNoEarlierThan', { date: dateText(c.to) }) : tr(lang, 'plan.change.startNoEarlierThanRemoved');
    case 'workDays':
    case 'curingDays':
      return c.to !== undefined && c.to !== null ? tr(lang, `plan.change.${c.field}`, { from: String(c.from ?? '—'), to: String(c.to) }) : tr(lang, 'plan.change.other', { field: fieldLabel(lang, c.field) });
    case 'name':
      return typeof c.to === 'string' ? tr(lang, 'plan.change.name', { name: c.to }) : tr(lang, 'plan.change.other', { field: fieldLabel(lang, c.field) });
    case 'dependsOn':
      return tr(lang, 'plan.change.dependsOn');
    case 'billingStageId':
      return tr(lang, 'plan.change.billingStageId');
    default:
      return tr(lang, 'plan.change.other', { field: fieldLabel(lang, c.field) });
  }
}

const reasonLabel = (lang: Lang, reason: string) => {
  const key = `report.v.reason.${reason}`;
  return hasKey(key) ? tr(lang, key) : reason;
};

function parse(note: string): Note | null {
  if (!note.startsWith('{"t":')) return null;
  try {
    const n = JSON.parse(note) as Note;
    return n && (n.t === 'MILESTONE_EDITED' || n.t === 'STOPPAGE_APPROVED') ? n : null;
  } catch {
    return null;
  }
}

const LEGACY_EDIT = /^(.+): ((?:startNoEarlierThan|workDays|curingDays|name|dependsOn|billingStageId)(?:, (?:startNoEarlierThan|workDays|curingDays|name|dependsOn|billingStageId))*)$/;
const LEGACY_STOPPAGE = /^([A-Z_]+) · (\d{4}-\d{2}-\d{2})(?: – (\d{4}-\d{2}-\d{2}))?$/;

/** The note in `lang` (null stays null). */
export function renderPlanNote(lang: Lang, note: string | null): string | null {
  if (!note) return note;
  const n = parse(note);
  if (n?.t === 'MILESTONE_EDITED') return tr(lang, 'plan.note.edited', { milestone: n.milestone, changes: n.changes.map((c) => changeText(lang, c)).join(', ') });
  if (n?.t === 'STOPPAGE_APPROVED') return tr(lang, 'plan.note.stoppage', { reason: reasonLabel(lang, n.reason), dates: n.from === n.to ? day(n.from) : `${day(n.from)} – ${day(n.to)}` });
  const edit = LEGACY_EDIT.exec(note);
  if (edit) return tr(lang, 'plan.note.edited', { milestone: edit[1], changes: edit[2]!.split(', ').map((field) => tr(lang, 'plan.change.other', { field: fieldLabel(lang, field) })).join(', ') });
  const stop = LEGACY_STOPPAGE.exec(note);
  if (stop) return tr(lang, 'plan.note.stoppage', { reason: reasonLabel(lang, stop[1]!), dates: stop[3] ? `${day(stop[2]!)} – ${day(stop[3])}` : day(stop[2]!) });
  return note;
}
