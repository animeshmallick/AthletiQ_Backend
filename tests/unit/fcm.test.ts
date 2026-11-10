import { describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { createFcmSender, parseServiceAccount } from '../../src/modules/push/fcm';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = {
  project_id: 'athletiq-test',
  client_email: 'push@athletiq-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

function fakeFetch(sendStatus: number, sendBody = '{}') {
  return jest.fn(async (url: string) => {
    if (String(url).includes('oauth2')) {
      return new Response(JSON.stringify({ access_token: 'at-123', expires_in: 3600 }), {
        status: 200,
      });
    }
    return new Response(sendBody, { status: sendStatus });
  }) as unknown as typeof fetch & jest.Mock;
}

describe('parseServiceAccount', () => {
  it('reads raw or base64 JSON and rejects incomplete keys', () => {
    expect(parseServiceAccount(undefined)).toBeNull();
    expect(parseServiceAccount('  ')).toBeNull();
    expect(parseServiceAccount(JSON.stringify(sa))).toMatchObject({ project_id: 'athletiq-test' });
    const b64 = Buffer.from(JSON.stringify(sa)).toString('base64');
    expect(parseServiceAccount(b64)).toMatchObject({ client_email: sa.client_email });
    expect(() => parseServiceAccount('{"project_id":"x"}')).toThrow(/must contain/);
  });
});

describe('createFcmSender', () => {
  it('authenticates once and sends a well-formed message', async () => {
    const f = fakeFetch(200);
    const send = createFcmSender(sa, f);
    expect(
      await send('tok-1', {
        category: 'sessions',
        icon: '⏰',
        title: 'T',
        body: 'B',
        link: '/x',
        tag: 'g',
        actions: [{ label: 'Go', link: '/y' }],
      }),
    ).toBe('ok');
    expect(await send('tok-2', { category: 'summaries', title: 'T2', body: 'B2' })).toBe('ok');
    const calls = f.mock.calls.map((c) => String(c[0]));
    expect(calls.filter((u) => u.includes('oauth2'))).toHaveLength(1); // token cached
    const [, init] = f.mock.calls[1] as [string, RequestInit];
    expect(String(f.mock.calls[1]![0])).toBe(
      'https://fcm.googleapis.com/v1/projects/athletiq-test/messages:send',
    );
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer at-123');
    expect(JSON.parse(init.body as string).message).toMatchObject({
      token: 'tok-1',
      notification: { title: '⏰ T', body: 'B' },
      data: {
        link: '/x',
        category: 'sessions',
        actions: JSON.stringify([{ label: 'Go', link: '/y' }]),
      },
      // Its own channel on Android; urgent, with sound, stacked by category on iPhone.
      android: {
        priority: 'high',
        notification: { tag: 'g', channel_id: 'sessions', default_sound: true },
      },
      apns: {
        headers: { 'apns-priority': '10', 'apns-collapse-id': 'g' },
        payload: {
          aps: {
            'thread-id': 'sessions',
            'interruption-level': 'time-sensitive',
            sound: 'default',
          },
        },
      },
      webpush: { headers: { Urgency: 'high', TTL: '86400' } },
    });
    const second = JSON.parse((f.mock.calls[2]![1] as RequestInit).body as string);
    expect(second.message.data.link).toBe('/');
    // Summaries are quiet: no sound, passive on iPhone, normal priority.
    expect(second.message.android).toMatchObject({
      priority: 'normal',
      notification: { channel_id: 'summaries' },
    });
    expect(second.message.android.notification.default_sound).toBeUndefined();
    expect(second.message.apns.payload.aps).toMatchObject({ 'interruption-level': 'passive' });
    expect(second.message.apns.payload.aps.sound).toBeUndefined();
  });

  it('reports uninstalled tokens and other failures', async () => {
    expect(
      await createFcmSender(sa, fakeFetch(404))('t', { category: 'money', title: 'a', body: 'b' }),
    ).toBe('invalid-token');
    expect(
      await createFcmSender(
        sa,
        fakeFetch(400, 'The registration token is not a valid FCM registration token'),
      )('t', { category: 'money', title: 'a', body: 'b' }),
    ).toBe('invalid-token');
    expect(
      await createFcmSender(sa, fakeFetch(500, 'oops'))('t', {
        category: 'money',
        title: 'a',
        body: 'b',
      }),
    ).toBe('error');
  });

  it('fails clearly when Google rejects the credentials', async () => {
    const f = jest.fn(
      async () => new Response('denied', { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      createFcmSender(sa, f)('t', { category: 'money', title: 'a', body: 'b' }),
    ).rejects.toThrow(/auth failed/);
  });
});
