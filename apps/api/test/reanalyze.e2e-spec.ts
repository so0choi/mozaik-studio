import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { createApp, login, TestCtx } from './helpers';

async function newJob(ctx: TestCtx, user = 'alice') {
  const res = await request(ctx.server).post('/api/jobs').set('Cookie', await login(ctx, user)).attach('file', Buffer.alloc(100), 'clip.mp4');
  return res.body.id as string;
}
const seed = (ctx: TestCtx, id: string, files: Record<string, Buffer | object>) => {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(ctx.dataDir, 'jobs', id, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.isBuffer(content) ? content : JSON.stringify(content));
  }
};
const has = (ctx: TestCtx, id: string, rel: string) => fs.existsSync(path.join(ctx.dataDir, 'jobs', id, rel));

describe('POST /jobs/:id/reanalyze', () => {
  let ctx: TestCtx;
  let id: string;
  let cookie: string;
  const post = (user = cookie, jid = id) => request(ctx.server).post(`/api/jobs/${jid}/reanalyze`).set('Cookie', user);
  const setState = (state: string) =>
    ctx.redis.hset(`job:${id}:status`, { state, progress: '100', updatedAt: new Date(Date.now() - 5000).toISOString() });

  beforeEach(async () => {
    ctx = await createApp();
    id = await newJob(ctx);
    cookie = await login(ctx);
    await ctx.redis.del('queue:analyze');
    seed(ctx, id, {
      'tracks.json': { tracks: [] },
      'review.json': { items: [] },
      'output.mp4': Buffer.alloc(4),
      'output.edits.json': {},
      'find_person.json': {},
      'find_dismissed.json': {},
      'normalized.mp4': Buffer.alloc(4),
      'meta.json': { fps: 30 },
      'thumbs/t1.jpg': Buffer.alloc(4),
      'manual/m1.json': { x: 1 },
      'edits.json': {
        version: 1,
        visible: ['t1'],
        groups: [['t1', 't2']],
        splits: [{ track: 't1', frame: 3 }],
        manual: [{ id: 'm1', note: 'keep' }],
        reviewed: ['r1'],
        effects: { default: { type: 'blur', strength: 3 }, background: { type: 'mosaic' }, overrides: { t1: { type: 'color', color: '#112233' }, m1: { type: 'blur', strength: 5 } } },
      },
    });
    await setState('ready');
  });
  afterEach(() => ctx.close());

  it('202, status queued, pushes analyze message', async () => {
    const r = await post();
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: true });
    const q = await ctx.redis.lrange('queue:analyze', 0, -1);
    expect(q.map((s: string) => JSON.parse(s))).toEqual([{ jobId: id }]);
    const h = await ctx.redis.hgetall(`job:${id}:status`);
    expect(h.state).toBe('queued');
    expect(h.progress).toBe('0');
    const job = await request(ctx.server).get(`/api/jobs/${id}`).set('Cookie', cookie);
    expect(job.body.state).toBe('queued');
  });

  it('resets edits but keeps manual and default/background effects', async () => {
    await post();
    const e = (await request(ctx.server).get(`/api/jobs/${id}/edits`).set('Cookie', cookie)).body;
    expect(e).toEqual({
      version: 1,
      visible: [],
      groups: [],
      splits: [],
      manual: [{ id: 'm1', note: 'keep' }],
      reviewed: [],
      effects: { default: { type: 'blur', strength: 3 }, background: { type: 'mosaic' }, overrides: { m1: { type: 'blur', strength: 5 } } },
    });
  });

  it('leaves edits absent when none existed', async () => {
    fs.rmSync(path.join(ctx.dataDir, 'jobs', id, 'edits.json'));
    expect((await post()).status).toBe(202);
    expect(has(ctx, id, 'edits.json')).toBe(false);
  });

  it('removes derived files and keeps originals', async () => {
    await post();
    for (const f of ['tracks.json', 'review.json', 'output.mp4', 'output.edits.json', 'find_person.json', 'find_dismissed.json', 'thumbs']) {
      expect(has(ctx, id, f)).toBe(false);
    }
    for (const f of ['normalized.mp4', 'meta.json', 'manual/m1.json']) expect(has(ctx, id, f)).toBe(true);
    const files = fs.readdirSync(path.join(ctx.dataDir, 'jobs', id));
    expect(files.some((f) => f.startsWith('original'))).toBe(true);
  });

  it.each(['queued', 'normalizing', 'analyzing', 'rendering'])('409 while %s', async (state) => {
    await setState(state);
    const r = await post();
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('분석이나 렌더가 진행 중입니다.');
    expect(await ctx.redis.llen('queue:analyze')).toBe(0);
    expect(has(ctx, id, 'tracks.json')).toBe(true);
  });

  it('409 when a render request is pending', async () => {
    await ctx.redis.set(`job:${id}:render_requested`, String(Date.now()));
    expect((await post()).status).toBe(409);
  });

  it("404 for another user's job", async () => {
    expect((await post(await login(ctx, 'bob'))).status).toBe(404);
    expect(await ctx.redis.llen('queue:analyze')).toBe(0);
  });
});
