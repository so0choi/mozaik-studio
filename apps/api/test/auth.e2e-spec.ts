import request from 'supertest';
import { loadConfig } from '../src/config';
import { createApp, PASSWORD, TestCtx } from './helpers';

describe('auth', () => {
  let ctx: TestCtx;
  beforeAll(async () => (ctx = await createApp()));
  afterAll(() => ctx.close());

  it('logs in with correct password and sets an httpOnly SameSite=Lax cookie', async () => {
    const res = await request(ctx.server).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: 'alice' });
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/^studio_token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i);
    expect(cookie).toMatch(/Max-Age=43200|Expires=/i);
  });

  it('rejects wrong password and unknown user with the same message', async () => {
    for (const body of [
      { username: 'alice', password: 'nope' },
      { username: 'ghost', password: PASSWORD },
      {},
    ]) {
      const res = await request(ctx.server).post('/api/auth/login').send(body);
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('아이디 또는 비밀번호가 맞지 않습니다.');
    }
  });

  it('401 without cookie on protected routes, me works with cookie, logout clears it', async () => {
    expect((await request(ctx.server).get('/api/jobs')).status).toBe(401);
    expect((await request(ctx.server).get('/api/auth/me')).status).toBe(401);
    const login = await request(ctx.server).post('/api/auth/login').send({ username: 'bob', password: PASSWORD });
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const me = await request(ctx.server).get('/api/auth/me').set('Cookie', cookie);
    expect(me.body).toEqual({ username: 'bob' });
    const out = await request(ctx.server).post('/api/auth/logout').set('Cookie', cookie);
    expect(out.status).toBe(200);
    expect((out.headers['set-cookie'] as unknown as string[])[0]).toMatch(/studio_token=;/);
  });

  it('rejects a tampered token', async () => {
    const res = await request(ctx.server).get('/api/jobs').set('Cookie', 'studio_token=abc.def.ghi');
    expect(res.status).toBe(401);
  });
});

describe('auth with COOKIE_SECURE=true', () => {
  it('adds Secure to the cookie', async () => {
    const c = await createApp({ COOKIE_SECURE: 'true' });
    const res = await request(c.server).post('/api/auth/login').send({ username: 'alice', password: PASSWORD });
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/Secure/i);
    await c.close();
  });
});

describe('config', () => {
  it('refuses to load without JWT_SECRET', () => {
    expect(() => loadConfig({ DATA_DIR: '/tmp/x' } as any)).toThrow(/JWT_SECRET/);
  });
});

describe('auth with AUTH_DISABLED=true', () => {
  it('lets requests through as AUTH_ANON_USER without a cookie, and jobs belong to that user', async () => {
    const ctx = await createApp({ AUTH_DISABLED: 'true', AUTH_ANON_USER: 'alice' });
    try {
      const me = await request(ctx.server).get('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body).toEqual({ username: 'alice', authDisabled: true });
      const up = await request(ctx.server).post('/api/jobs').attach('file', Buffer.alloc(100), 'clip.mp4');
      expect(up.status).toBe(201);
      const list = await request(ctx.server).get('/api/jobs');
      expect(list.body.map((j: any) => j.id)).toEqual([up.body.id]);
    } finally {
      await ctx.close();
    }
  });

  it('defaults the anonymous user to guest', async () => {
    const ctx = await createApp({ AUTH_DISABLED: 'true' });
    try {
      expect((await request(ctx.server).get('/api/auth/me')).body.username).toBe('guest');
    } finally {
      await ctx.close();
    }
  });

  it('keeps requiring login when AUTH_DISABLED is not "true"', async () => {
    const ctx = await createApp({ AUTH_DISABLED: 'false' });
    try {
      expect((await request(ctx.server).get('/api/auth/me')).status).toBe(401);
    } finally {
      await ctx.close();
    }
  });
});
