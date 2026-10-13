import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prismaAdmin } from '../../src/core/db/prisma.js';
import { maskEmail } from '../../src/modules/auth/deliveryLog.js';
import { mailProvider, SesMailProvider, trySendMail, useMailProviderForTests } from '../../src/modules/auth/mail.provider.js';
import { useFreshDatabase } from '../helpers.js';

/** SES is mocked with aws-sdk-client-mock: no request leaves the machine. */
const ses = mockClient(SESv2Client);
useFreshDatabase();

const config = { region: 'eu-west-1', from: 'Munshi App <no-reply@mail.example.pk>', accessKeyId: 'AKIATEST', secretAccessKey: 'secret', configurationSet: 'transactional' };

beforeEach(() => ses.reset());
afterEach(() => useMailProviderForTests(undefined));

describe('SesMailProvider (mocked SDK)', () => {
  it('sends a SendEmail (v2) with text + html, the sender and configuration set, and returns the MessageId', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-0001' });
    const result = await new SesMailProvider(config).send({ to: 'owner@example.pk', subject: 'Hello', text: 'Plain', html: '<p>Rich</p>' });
    expect(result).toEqual({ providerId: 'ses-0001' });

    const calls = ses.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      FromEmailAddress: 'Munshi App <no-reply@mail.example.pk>',
      Destination: { ToAddresses: ['owner@example.pk'] },
      Content: {
        Simple: {
          Subject: { Data: 'Hello', Charset: 'UTF-8' },
          Body: { Text: { Data: 'Plain', Charset: 'UTF-8' }, Html: { Data: '<p>Rich</p>', Charset: 'UTF-8' } },
        },
      },
      ConfigurationSetName: 'transactional',
    });
  });

  it('text-only mail has no Html part', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-0002' });
    await new SesMailProvider({ region: 'eu-west-1', from: 'no-reply@mail.example.pk' }).send({ to: 'a@b.pk', subject: 's', text: 't' });
    expect(ses.commandCalls(SendEmailCommand)[0]!.args[0].input.Content?.Simple?.Body).toEqual({ Text: { Data: 't', Charset: 'UTF-8' } });
  });

  it('every send is logged: SENT with the SES id and a masked address; a refusal is FAILED and trySendMail does not throw', async () => {
    useMailProviderForTests(new SesMailProvider(config));
    expect(mailProvider().name).toBe('ses');

    ses.on(SendEmailCommand).resolvesOnce({ MessageId: 'ses-0003' }).rejectsOnce(new Error('MessageRejected: Email address is not verified.'));
    await mailProvider().send({ to: 'khalid@maliksons.pk', subject: 'Invite', text: 'x', type: 'INVITE' });
    await trySendMail({ to: 'nobody@unverified.pk', subject: 'Code', text: 'Your code is 123456', type: 'OTP' });

    const rows = await prismaAdmin.messageDelivery.findMany({ where: { channel: 'EMAIL' }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.type, r.provider, r.status, r.to, r.providerId])).toEqual([
      ['INVITE', 'ses', 'SENT', 'k***@maliksons.pk', 'ses-0003'],
      ['OTP', 'ses', 'FAILED', 'n***@unverified.pk', null],
    ]);
    expect(rows[1]!.error).toContain('MessageRejected');
  });

  it('maskEmail', () => {
    expect(maskEmail('khalid@maliksons.pk')).toBe('k***@maliksons.pk');
    expect(maskEmail('broken')).toBe('***');
  });
});
