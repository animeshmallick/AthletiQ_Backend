/**
 * Every route of the API, found from the router itself: signed-out people get nothing but the
 * public routes, coaches get nothing meant for admins, and no input makes the server fail.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { getApp, makeAcademy, makeStudent, setToday, tokenFor } from '../helpers/factories';

interface Found {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  admin: boolean;
  coach: boolean;
}

const SRC = path.join(__dirname, '../../src');

/** Reads the mounts in routes.ts and the routes of each router file. */
function allRoutes(): Found[] {
  const main = readFileSync(path.join(SRC, 'routes.ts'), 'utf8');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.ts')) files.push(path.join(d, e.name));
  };
  walk(path.join(SRC, 'modules'));
  const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const out: Found[] = [];
  for (const m of main.matchAll(/api\.use\('([^']+)',\s*(requireAdmin,\s*)?(\w+)\)/g)) {
    const [, base, guard, router] = m;
    const rx = new RegExp(
      `\\b${router}\\s*\\.(get|post|put|patch|delete)\\(\\s*'([^']*)'((?:,\\s*\\w+)*)`,
      'g',
    );
    for (const r of text.matchAll(rx))
      out.push({
        method: r[1] as Found['method'],
        path: `/api/v1${base}${r[2] === '/' ? '' : r[2]}`,
        admin: !!guard || /requireAdmin/.test(r[3] ?? ''),
        coach: /requireCoach/.test(r[3] ?? ''),
      });
  }
  return out;
}

// Switching role is authorised by the refresh cookie, not the access token.
const PUBLIC =
  /^\/api\/v1\/(auth\/(invite|password-reset|accept-invite|reset-password|login|logout|refresh|switch-role)|public\/|client-events$)/;
const send = (r: Found, url: string, token?: string, body?: unknown) => {
  const q = request(getApp())[r.method](url).set('X-Requested-With', 'XMLHttpRequest');
  if (token) void q.set('Authorization', `Bearer ${token}`);
  return r.method === 'get' || r.method === 'delete' ? q : q.send(body ?? {});
};
const fill = (p: string, id: string) =>
  p.replace(/:(date|weekStart)\b/g, '2026-03-16').replace(/:\w+/g, id);

const routes = allRoutes();

describe('every route', () => {
  it('finds them', () => {
    expect(routes.length).toBeGreaterThan(130);
    expect(routes.filter((r) => r.admin).length).toBeGreaterThan(40);
  });

  it('is closed to signed-out people unless public', async () => {
    const open: string[] = [];
    for (const r of routes) {
      const res = await send(r, fill(r.path, randomUUID()));
      if (res.status >= 500) open.push(`${r.method} ${r.path} ${res.status}`);
      if (!PUBLIC.test(r.path) && res.status !== 401)
        open.push(`${r.method} ${r.path} ${res.status}`);
    }
    expect(open).toEqual([]);
  }, 120_000);

  it('keeps coaches out of admin routes and admins out of coach routes', async () => {
    const a = await makeAcademy();
    const wrong: string[] = [];
    const coach = await tokenFor(a.coach);
    const admin = await tokenFor(a.admin);
    for (const r of routes) {
      if (!r.admin && !r.coach) continue;
      const res = await send(r, fill(r.path, randomUUID()), r.admin ? coach : admin);
      if (res.status !== 403) wrong.push(`${r.method} ${r.path} ${res.status}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('never fails on unknown ids, odd ids or bad input', async () => {
    setToday('2026-03-16');
    const a = await makeAcademy();
    const s = await makeStudent(
      { batchId: a.batch.id, joiningDate: '2026-03-02', fullName: 'Asha' },
      a.admin.id,
    );
    const tokens = [await tokenFor(a.admin), await tokenFor(a.coach)];
    const ids = [randomUUID(), 'not-an-id', s.id, a.batch.id];
    const bodies = [
      {},
      { batchId: a.batch.id, date: '2026-13-45', amount: -5, records: 'x' },
      { batchId: a.batch.id, studentId: s.id, date: '2026-03-16', reason: '\u0000', amount: 1e15 },
      [],
      'text',
    ];
    const queries = [
      '',
      '?page=-1&pageSize=99999&from=x&to=y&month=zz&date=2026-99-99',
      `?batchId=${a.batch.id}&studentId=${s.id}&date=2026-03-16&from=2026-03-01&to=2026-03-31&month=2026-03-01&originalDate=2026-03-16&search=%25_%27%22`,
      '?from=2026-03-31&to=2026-03-01&batchId=nope&sort=drop&status=zzz&search[]=a&search[b]=c',
      '?from=0000-01-01&to=9999-12-31&search=%00',
    ];
    const failed: string[] = [];
    for (const r of routes) {
      // These end the sign-in used here, or do real work best tested on their own.
      if (/auth\/(logout|change-password|switch-role)|jobs\/invoices\/run/.test(r.path)) continue;
      if (r.method === 'delete' && r.path.includes('/students/:id')) continue;
      for (const token of tokens)
        for (const id of /:\w+/.test(r.path) ? ids : [''])
          for (const x of r.method === 'get' ? queries : bodies) {
            const url = fill(r.path, id) + (typeof x === 'string' && r.method === 'get' ? x : '');
            const res = await send(r, url, token, x);
            if (res.status >= 500)
              failed.push(
                `${r.method} ${r.path} ${id === s.id ? 'student' : id === a.batch.id ? 'batch' : id} ${JSON.stringify(x).slice(0, 90)} ${res.status}`,
              );
          }
    }
    expect([...new Set(failed)]).toEqual([]);
  }, 600_000);
});
