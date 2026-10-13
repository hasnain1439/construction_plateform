/**
 * Loaded before anything else (`node --import ./dist/instrument.js dist/server.js`, and as the
 * first import of server.ts) so Sentry can instrument Express / http / pg. Does nothing
 * when SENTRY_DSN is empty.
 */
import { initSentry } from './core/observability/sentry.js';

initSentry();
