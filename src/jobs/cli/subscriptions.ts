/**
 * Runs the subscription lifecycle once (same lock as the in-process scheduler).
 *   npm run jobs:subscriptions        (production: node dist/jobs/cli/subscriptions.js)
 * Note: running servers cache company status for up to 60 s.
 */
import { disconnectDatabases } from '../../core/db/prisma.js';
import { trackJobRun } from '../jobRuns.js';
import { runExclusive } from '../scheduler.js';
import { runSubscriptionLifecycle } from '../subscriptionLifecycle.js';

try {
  const result = await runExclusive('subscription-lifecycle', () => trackJobRun('subscription-lifecycle', () => runSubscriptionLifecycle()));
  if (result) {
    console.log('Subscription lifecycle done:');
    for (const [step, tenants] of Object.entries(result)) console.log(`  ${step.padEnd(13)} ${tenants.length}`);
  } else {
    console.log('Skipped: another instance is running the job.');
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await disconnectDatabases();
}
