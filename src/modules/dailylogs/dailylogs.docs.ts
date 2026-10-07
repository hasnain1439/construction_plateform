import { errors, jsonBody } from '../../core/openapi/registry.js';
import { AUTH, IDS, READ_403, WRITE_403, createdResp, ex, idParam, ok, page, path } from '../inventory/docs.shared.js';
import { dailyLogBody, dailyLogsQuery, updateDailyLogBody } from './dailylogs.schema.js';

const T = 'Daily Logs';
const LOG = '0199a8c0-0000-7000-8000-000000000d11';
const ACCESS = 'THEKEDAR, PM, MUNSHI with access to the project (outside → 404).';

const log = {
  id: LOG,
  project: { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla' },
  logDate: '2026-10-06',
  note: 'Power cut 2–5 PM, generator used for the mixer',
  conditions: ['CURING', 'POWER_CUT'],
  workDone: '1F column curing day 10, water given twice',
  author: { id: '0199a8c0-0000-7000-8000-000000000004', name: 'Rafaqat Ali', role: 'MUNSHI' },
  photos: [{ id: IDS.photo, mimeType: 'image/jpeg', url: 'https://res.cloudinary.com/demo/image/authenticated/…', thumbUrl: 'https://res.cloudinary.com/demo/image/authenticated/w_320/…' }],
  voiceNotes: [],
  editable: true,
  lateSync: false,
  clientId: '0199a8c0-0000-7000-8000-00000000ab01',
  deviceCreatedAt: '2026-10-06T12:40:00.000Z',
  createdAt: '2026-10-06T12:41:02.000Z',
  updatedAt: '2026-10-06T12:41:02.000Z',
};

export function registerDailyLogsDocs(): void {
  path(T, 'post', '/api/v1/projects/{id}/daily-logs', {
    summary: 'Write (or update today’s) daily log',
    description:
      `${ACCESS} One log per person per project per day (default today, Asia/Karachi; up to 7 days back). Sending again for a day you already logged updates it — only on the same day, else \`409 LOG_LOCKED\`. ` +
      'A repeated `clientId` returns the saved log (200). Photos are SITE_PHOTO attachments, voice notes VOICE_NOTE (≤ 2 MB). `lateSync` = received more than 48 h after `deviceCreatedAt`.',
    request: {
      params: idParam('Project'),
      body: jsonBody(dailyLogBody, {
        today: ex('Today’s log from the app', {
          conditions: ['CURING', 'POWER_CUT'],
          workDone: '1F column curing day 10, water given twice',
          note: 'Power cut 2–5 PM',
          clientId: '0199a8c0-0000-7000-8000-00000000ab01',
          deviceCreatedAt: '2026-10-06T17:40:00+05:00',
        }),
      }),
    },
    responses: {
      ...createdResp('Created (200 when it updated today’s log or replayed a clientId)', log),
      ...errors({ 400: ['VALIDATION_ERROR', 'FUTURE_DATE', 'DATE_TOO_OLD', 'INVALID_ATTACHMENT'], ...AUTH, 403: WRITE_403, 404: ['PROJECT_NOT_FOUND'], 409: ['LOG_LOCKED', 'PROJECT_LOCKED'] }),
    },
  });
  path(T, 'get', '/api/v1/projects/{id}/daily-logs', {
    summary: 'Daily logs of a project',
    description: `${ACCESS} Newest day first; photo thumbnails and voice-note links are signed (10 min).`,
    request: { params: idParam('Project'), query: dailyLogsQuery },
    responses: { ...ok('Logs', [log], page(1)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403, 404: ['PROJECT_NOT_FOUND'] }) },
  });
  path(T, 'get', '/api/v1/daily-logs/{id}', {
    summary: 'One log with the day around it',
    description: `${ACCESS} \`summary\`: hazri marked that day, material used, kharcha of the day — a MUNSHI sees only his own kharcha (\`scope: MINE\`), the office the whole project.`,
    request: { params: idParam('Daily log') },
    responses: {
      ...ok('Log', {
        ...log,
        summary: {
          hazri: { full: 7, half: 1, absent: 0, present: 8 },
          usage: [{ material: { id: IDS.cement, name: 'Cement OPC', unit: 'bag' }, quantity: 30 }],
          kharcha: { scope: 'MINE', entries: 2, totalPaisa: '420000' },
        },
      }),
      ...errors({ ...AUTH, 403: READ_403, 404: ['DAILY_LOG_NOT_FOUND'] }),
    },
  });
  path(T, 'patch', '/api/v1/daily-logs/{id}', {
    summary: 'Change today’s log',
    description: 'The author only, and only on the log’s day (else `409 LOG_LOCKED`).',
    request: { params: idParam('Daily log'), body: jsonBody(updateDailyLogBody, { note: ex('Add to the note', { note: 'Power cut 2–5 PM, generator used for the mixer' }) }) },
    responses: { ...ok('Log', log), ...errors({ 400: ['VALIDATION_ERROR', 'INVALID_ATTACHMENT'], ...AUTH, 403: WRITE_403, 404: ['DAILY_LOG_NOT_FOUND'], 409: ['LOG_LOCKED'] }) },
  });
}
