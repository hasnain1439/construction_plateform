import { errors } from '../../core/openapi/registry.js';
import { AUTH, IDS, READ_403, WRITE_403, idParam, ok, page, path } from '../inventory/docs.shared.js';
import { notificationsQuery } from './notifications.schema.js';

const T = 'Notifications';
export const NOTIFICATION_EXAMPLE = {
  id: '0199a8c0-0000-7000-8000-000000000f01',
  type: 'CHEQUE_BOUNCED',
  severity: 'CRITICAL',
  title: 'Cheque bounced — DHA Phase 6 · 10 Marla',
  body: 'MCB cheque 118845 (Rs 11,00,000) from Ahmed Raza bounced: insufficient funds.',
  project: { id: IDS.dha, code: 'MSB-2026-012', name: 'DHA Phase 6 · 10 Marla' },
  refType: 'PAYMENT',
  refId: IDS.payment,
  actionUrl: `/projects/${IDS.dha}/billing/payments`,
  read: false,
  readAt: null,
  smsSent: true,
  createdAt: '2026-09-22T06:00:00.000Z',
};

export function registerNotificationsDocs(): void {
  path(T, 'get', '/api/v1/notifications', {
    summary: 'My notifications',
    description:
      'Every company user, own notifications only (newest first). A MUNSHI only gets site notifications (dispatch on the way, float sent, settlement returned) — never money ones; a PM without financials gets no billing / subscription ones. ' +
      'The same (type, record) reaches a user at most once per 24 h. CRITICAL ones (bounced cheque) also go out by SMS.',
    request: { query: notificationsQuery },
    responses: { ...ok('Notifications', [NOTIFICATION_EXAMPLE], page(1)), ...errors({ 400: ['VALIDATION_ERROR'], ...AUTH, 403: READ_403 }) },
  });
  path(T, 'get', '/api/v1/notifications/unread-count', {
    summary: 'Unread count (for the bell)',
    responses: { ...ok('Counts', { count: 7, critical: 1, warning: 4 }), ...errors({ ...AUTH, 403: READ_403 }) },
  });
  path(T, 'patch', '/api/v1/notifications/{id}/read', {
    summary: 'Mark one as read',
    request: { params: idParam('Notification') },
    responses: { ...ok('Notification', { ...NOTIFICATION_EXAMPLE, read: true, readAt: '2026-10-06T05:00:00.000Z' }), ...errors({ ...AUTH, 403: WRITE_403, 404: ['NOTIFICATION_NOT_FOUND'] }) },
  });
  path(T, 'patch', '/api/v1/notifications/read-all', {
    summary: 'Mark all as read',
    responses: { ...ok('How many were marked', { updated: 6 }), ...errors({ ...AUTH, 403: WRITE_403 }) },
  });
}
