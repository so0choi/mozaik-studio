import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { RetentionService } from '../src/retention/retention.service';
import { JobRepo } from '../src/jobs/repo';
import { createApp, fixture, login, TestCtx } from './helpers';

async function newJob(ctx: TestCtx, user = 'alice', name = 'clip.mp4') {
  const res = await request(ctx.server).post('/api/jobs').set('Cookie', await login(ctx, user)).attach('file', Buffer.alloc(100), name);
  return res.body.id as string;
}
function seed(ctx: TestCtx, id: string, files: Record<string, Buffer | object>) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(ctx.dataDir, 'jobs', id, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.isBuffer(content) ? content : JSON.stringify(content));
  }
}
const review2 = {
  items: [
    { id: 'r1', type: 'gap', trackIds: ['t1'], startFrame: 1, endFrame: 5, box: [1, 1, 2, 2] },
    { id: 'r2', type: 'crossing', trackIds: ['t1', 't2'], startFrame: 10, endFrame: 20, box: [1, 1, 2, 2] },
  ],
};

describe('render gate, manual, output (A3)', () => {
  let ctx: TestCtx;
  let id: string;
  let cookie: string;
  const post = (p: string, body?: unknown) => request(ctx.server).post(`/api/jobs/${id}${p}`).set('Cookie', cookie).send(body as any);
  const putEdits = (e: unknown) => request(ctx.server).put(`/api/jobs/${id}/edits`).set('Cookie', cookie).send(e as any);

  beforeEach(async () => {
    ctx = await createApp();
    id = await newJob(ctx, 'alice', '결과 영상.final.mov');
    cookie = await login(ctx);
    seed(ctx, id, { 'tracks.json': fixture('tracks.sample.json'), 'review.json': review2 });
    await ctx.redis.hset(`job:${id}:status`, { state: 'ready', progress: '100', updatedAt: new Date(Date.now() - 5000).toISOString() });
  });
  afterEach(() => ctx.close());

  it('409 with count while review items are unreviewed; 202 + queue:render when all reviewed', async () => {
    let r = await post('/render');
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('확인 필요 항목 2건이 남았습니다.');
    expect((await putEdits({ version: 1, visible: [], groups: [], splits: [], manual: [], reviewed: ['r1'] })).status).toBe(200);
    r = await post('/render');
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('확인 필요 항목 1건이 남았습니다.');
    expect(await ctx.redis.llen('queue:render')).toBe(0);
    await putEdits({ version: 1, visible: [], groups: [], splits: [], manual: [], reviewed: ['r1', 'r2'] });
    r = await post('/render');
    expect(r.status).toBe(202);
    const q = await ctx.redis.lrange('queue:render', 0, -1);
    expect(q.map((s: string) => JSON.parse(s))).toEqual([{ jobId: id }]);
  });

  it('duplicate render request -> 409 and only one queue message', async () => {
    await putEdits({ version: 1, visible: [], groups: [], splits: [], manual: [], reviewed: ['r1', 'r2'] });
    expect((await post('/render')).status).toBe(202);
    const dup = await post('/render');
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe('이미 렌더 중입니다.');
    expect(await ctx.redis.llen('queue:render')).toBe(1);
  });

  it('409 while the worker reports rendering; allowed again after rendered or reverted to ready', async () => {
    await putEdits({ version: 1, visible: [], groups: [], splits: [], manual: [], reviewed: ['r1', 'r2'] });
    expect((await post('/render')).status).toBe(202);
    await ctx.redis.hset(`job:${id}:status`, { state: 'rendering', updatedAt: new Date(Date.now() + 1000).toISOString() });
    expect((await post('/render')).body.message).toBe('이미 렌더 중입니다.');
    await ctx.redis.hset(`job:${id}:status`, { state: 'rendered', updatedAt: new Date(Date.now() + 2000).toISOString() });
    expect((await post('/render')).status).toBe(202);
    await ctx.redis.hset(`job:${id}:status`, { state: 'ready', error: '렌더 실패', updatedAt: new Date(Date.now() + 3000).toISOString() });
    expect((await post('/render')).status).toBe(202);
    expect(await ctx.redis.llen('queue:render')).toBe(3);
  });

  it('rendering state with no request key (e.g. after API restart) is still 409', async () => {
    await putEdits({ version: 1, visible: [], groups: [], splits: [], manual: [], reviewed: ['r1', 'r2'] });
    await ctx.redis.hset(`job:${id}:status`, { state: 'rendering' });
    expect((await post('/render')).status).toBe(409);
  });

  it('409 when analysis is not finished', async () => {
    await ctx.redis.hset(`job:${id}:status`, { state: 'analyzing', progress: '10' });
    const r = await post('/render');
    expect(r.status).toBe(409);
    expect(await ctx.redis.llen('queue:render')).toBe(0);
  });

  it('output: 404 until output.mp4 exists, then an attachment named after the original', async () => {
    expect((await request(ctx.server).get(`/api/jobs/${id}/output`).set('Cookie', cookie)).status).toBe(404);
    seed(ctx, id, { 'output.mp4': Buffer.from('video-bytes') });
    const r = await request(ctx.server).get(`/api/jobs/${id}/output`).set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment/);
    expect(decodeURIComponent(r.headers['content-disposition'])).toContain('mosaic_결과 영상.final.mp4');
  });

  describe('manual', () => {
    const body = { manualId: 'm1', anchor: { frame: 45, box: [200, 200, 40, 40] }, otherAnchors: [10, 80] };

    it('POST pushes queue:propagate, returns 202, GET reports tracking then result', async () => {
      const r = await post('/manual', body);
      expect(r.status).toBe(202);
      const q = await ctx.redis.lrange('queue:propagate', 0, -1);
      expect(q.map((s: string) => JSON.parse(s))).toEqual([{ jobId: id, manualId: 'm1', anchor: body.anchor, otherAnchors: [10, 80] }]);
      const g1 = await request(ctx.server).get(`/api/jobs/${id}/manual/m1`).set('Cookie', cookie);
      expect(g1.body).toEqual({ state: 'tracking', result: null });
      await ctx.redis.hset(`job:${id}:manual:m1`, { state: 'done' });
      seed(ctx, id, { 'manual/m1.json': fixture('manual.sample.json')[0] });
      const g2 = await request(ctx.server).get(`/api/jobs/${id}/manual/m1`).set('Cookie', cookie);
      expect(g2.body.state).toBe('done');
      expect(g2.body.result.id).toBe('m1');
    });

    it('validates body and manualId', async () => {
      for (const bad of [
        {}, { ...body, manualId: 'x1' }, { ...body, manualId: '../m1' }, { ...body, manualId: 'm' + 'a'.repeat(41) },
        { ...body, anchor: { frame: -1, box: [1, 1, 1, 1] } },
        { ...body, anchor: { frame: 1, box: [1, 1, 1] } },
        { ...body, anchor: { frame: 1, box: [1, 1, 0, 5] } },
        { ...body, otherAnchors: 'x' }, { ...body, otherAnchors: [1.5] },
      ]) {
        const r = await post('/manual', bad);
        expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 400]);
      }
      expect(await ctx.redis.llen('queue:propagate')).toBe(0);
      const g = await request(ctx.server).get(`/api/jobs/${id}/manual/..%2Ftracks`).set('Cookie', cookie);
      expect(g.status).toBe(400);
    });
  });

  describe('retention', () => {
    it('sweep deletes jobs older than 7 days (dir + row) and keeps newer ones', async () => {
      const old = await newJob(ctx, 'alice', 'old.mp4');
      const recent = await newJob(ctx, 'alice', 'recent.mp4');
      const repo = ctx.app.get(JobRepo);
      const now = new Date();
      const db = (repo as any).db;
      db.prepare('UPDATE jobs SET createdAt = ? WHERE id = ?').run(new Date(now.getTime() - 8 * 86400e3).toISOString(), old);
      db.prepare('UPDATE jobs SET createdAt = ? WHERE id = ?').run(new Date(now.getTime() - 6 * 86400e3).toISOString(), recent);
      await ctx.redis.hset(`job:${old}:status`, { state: 'rendered' });
      const svc = ctx.app.get(RetentionService);
      expect(svc.sweep(now)).toBe(1);
      expect(fs.existsSync(path.join(ctx.dataDir, 'jobs', old))).toBe(false);
      expect(repo.get(old)).toBeUndefined();
      expect(await ctx.redis.exists(`job:${old}:status`)).toBe(0);
      expect(fs.existsSync(path.join(ctx.dataDir, 'jobs', recent))).toBe(true);
      expect(repo.get(recent)).toBeDefined();
      expect(svc.sweep(now)).toBe(0);
    });
  });
});
