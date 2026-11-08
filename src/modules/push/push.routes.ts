import { Router } from 'express';
import { z } from 'zod';
import { noContent, ok } from '../../lib/http.js';
import { parse } from '../../lib/validation.js';
import { currentUser } from '../../middleware/auth.js';
import { tasksFor } from '../tasks/tasks.service.js';
import { pushEnabled, registerDevice, unregisterDevice } from './push.service.js';

/** Mounted at /api/v1/me: the signed-in user's own devices. */
export const pushRouter = Router();

const Token = z.string().trim().min(20).max(4096);

pushRouter.post('/devices', async (req, res) => {
  const user = currentUser(req);
  const body = parse(
    z.object({ token: Token, platform: z.enum(['android', 'ios', 'web']).default('android') }),
    req.body,
  );
  await registerDevice(user.id, body.token, body.platform);
  ok(res, { registered: true, pushEnabled: pushEnabled() });
});

/** Called on sign-out so the device stops receiving this user's notifications. */
pushRouter.delete('/devices', async (req, res) => {
  const user = currentUser(req);
  const body = parse(z.object({ token: Token }), req.body);
  await unregisterDevice(user.id, body.token);
  noContent(res);
});

/** What needs the signed-in user's attention now (header bell + tab badges). */
pushRouter.get('/tasks', async (req, res) => {
  ok(res, await tasksFor(currentUser(req)));
});
