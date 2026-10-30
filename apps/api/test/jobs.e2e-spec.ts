import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { createApp, fixture, login, TestCtx } from './helpers';

const MP4 = Buffer.alloc(1000, 7);

async function upload(ctx: TestCtx, user = 'alice', name = '회의 녹화.mp4', body: Buffer = MP4) {
  const cookie = await login(ctx, user);
  return request(ctx.server).post('/api/jobs').set('Cookie', cookie).attach('file', body, name);
}

function seed(ctx: TestCtx, id: string, files: Record<string, Buffer | object>) {
  const dir = path.join(ctx.dataDir, 'jobs', id);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.isBuffer(content) ? content : JSON.stringify(content));
  }
  return dir;
}

describe('jobs (A2)', () => {
  let ctx: TestCtx;
  beforeEach(async () => (ctx = await createApp()));
  afterEach(() => ctx.close());

  it('upload -> 201 Job, file saved, queue:analyze gets {"jobId"}', async () => {
    const res = await upload(ctx);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      filename: '회의 녹화.mp4',
      state: 'queued',
      progress: 0,
      error: null,
      hasOutput: false,
    });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.existsSync(path.join(ctx.dataDir, 'jobs', res.body.id, 'original.mp4'))).toBe(true);
    const q = await ctx.redis.lrange('queue:analyze', 0, -1);
    expect(q.map((s: string) => JSON.parse(s))).toEqual([{ jobId: res.body.id }]);
  });

  it('rejects .txt with 400 and leaves no orphan job dir', async () => {
    const res = await upload(ctx, 'alice', 'notes.txt');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('mp4, mov, mkv, webm 파일만 올릴 수 있습니다.');
    expect(fs.readdirSync(path.join(ctx.dataDir, 'jobs'))).toEqual([]);
    expect(await ctx.redis.llen('queue:analyze')).toBe(0);
  });

  it('missing file field -> 400', async () => {
    const cookie = await login(ctx);
    const res = await request(ctx.server).post('/api/jobs').set('Cookie', cookie).field('x', 'y');
    expect(res.status).toBe(400);
  });

  it('413 when over MAX_UPLOAD_BYTES, no orphan dir, nothing queued', async () => {
    await ctx.close();
    ctx = await createApp({ MAX_UPLOAD_BYTES: '500' });
    const res = await upload(ctx);
    expect(res.status).toBe(413);
    expect(fs.readdirSync(path.join(ctx.dataDir, 'jobs'))).toEqual([]);
    expect(await ctx.redis.llen('queue:analyze')).toBe(0);
    const list = await request(ctx.server).get('/api/jobs').set('Cookie', await login(ctx));
    expect(list.body).toEqual([]);
  });

  it('list shows only own jobs; other user gets 404 on every job route', async () => {
    const mine = (await upload(ctx, 'alice')).body.id;
    const bobCookie = await login(ctx, 'bob');
    const list = await request(ctx.server).get('/api/jobs').set('Cookie', bobCookie);
    expect(list.body).toEqual([]);
    const routes: [string, string][] = [
      ['get', ''], ['get', '/video'], ['get', '/tracks'], ['get', '/review'], ['get', '/meta'],
      ['get', '/thumbs/t1.jpg'], ['get', '/edits'], ['get', '/manual/m1'], ['get', '/output'],
      ['delete', ''],
    ];
    for (const [m, suffix] of routes) {
      const r = await (request(ctx.server) as any)[m](`/api/jobs/${mine}${suffix}`).set('Cookie', bobCookie);
      expect([m, suffix, r.status]).toEqual([m, suffix, 404]);
    }
    for (const [m, suffix, body] of [['put', '/edits', {}], ['post', '/render', {}], ['post', '/manual', {}]] as const) {
      const r = await (request(ctx.server) as any)[m](`/api/jobs/${mine}${suffix}`).set('Cookie', bobCookie).send(body);
      expect([m, suffix, r.status]).toEqual([m, suffix, 404]);
    }
    const stillMine = await request(ctx.server).get(`/api/jobs/${mine}`).set('Cookie', await login(ctx));
    expect(stillMine.status).toBe(200);
  });

  it('non-UUID and unknown ids -> 404', async () => {
    const cookie = await login(ctx);
    for (const id of ['abc', '..', '00000000-0000-0000-0000-000000000000']) {
      expect((await request(ctx.server).get(`/api/jobs/${id}`).set('Cookie', cookie)).status).toBe(404);
    }
  });

  it('status: Redis hash wins, then status.json, then queued', async () => {
    const id = (await upload(ctx)).body.id;
    const cookie = await login(ctx);
    const get = async () => (await request(ctx.server).get(`/api/jobs/${id}`).set('Cookie', cookie)).body;

    seed(ctx, id, { 'status.json': { state: 'analyzing', progress: 40, error: null, updatedAt: 'x' } });
    expect(await get()).toMatchObject({ state: 'analyzing', progress: 40, error: null });

    await ctx.redis.hset(`job:${id}:status`, { state: 'failed', progress: '55', error: '영상을 변환하지 못했습니다.', updatedAt: 'y' });
    expect(await get()).toMatchObject({ state: 'failed', progress: 55, error: '영상을 변환하지 못했습니다.' });

    await ctx.redis.del(`job:${id}:status`);
    fs.rmSync(path.join(ctx.dataDir, 'jobs', id, 'status.json'));
    expect(await get()).toMatchObject({ state: 'queued', progress: 0, error: null });

    seed(ctx, id, { 'output.mp4': Buffer.from('x') });
    expect((await get()).hasOutput).toBe(true);
  });

  it('video: Range bytes=0-99 -> 206 with Content-Length 100; 404 before it exists', async () => {
    const id = (await upload(ctx)).body.id;
    const cookie = await login(ctx);
    expect((await request(ctx.server).get(`/api/jobs/${id}/video`).set('Cookie', cookie)).status).toBe(404);
    seed(ctx, id, { 'normalized.mp4': Buffer.alloc(1000, 1) });
    const r = await request(ctx.server).get(`/api/jobs/${id}/video`).set('Cookie', cookie).set('Range', 'bytes=0-99').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(206);
    expect(r.headers['content-length']).toBe('100');
    expect(r.headers['content-range']).toBe('bytes 0-99/1000');
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.body.length).toBe(100);
    const open = await request(ctx.server).get(`/api/jobs/${id}/video`).set('Cookie', cookie).set('Range', 'bytes=900-');
    expect(open.status).toBe(206);
    expect(open.headers['content-range']).toBe('bytes 900-999/1000');
    const suffix = await request(ctx.server).get(`/api/jobs/${id}/video`).set('Cookie', cookie).set('Range', 'bytes=-10');
    expect(suffix.headers['content-range']).toBe('bytes 990-999/1000');
    const bad = await request(ctx.server).get(`/api/jobs/${id}/video`).set('Cookie', cookie).set('Range', 'bytes=5000-6000');
    expect(bad.status).toBe(416);
    const full = await request(ctx.server).get(`/api/jobs/${id}/video`).set('Cookie', cookie);
    expect(full.status).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
  });

  it('tracks/review/meta return JSON files, 404 when absent', async () => {
    const id = (await upload(ctx)).body.id;
    const cookie = await login(ctx);
    for (const n of ['tracks', 'review', 'meta']) {
      expect((await request(ctx.server).get(`/api/jobs/${id}/${n}`).set('Cookie', cookie)).status).toBe(404);
    }
    seed(ctx, id, { 'tracks.json': fixture('tracks.sample.json'), 'review.json': fixture('review.sample.json'), 'meta.json': { fps: 30 } });
    const t = await request(ctx.server).get(`/api/jobs/${id}/tracks`).set('Cookie', cookie);
    expect(t.status).toBe(200);
    expect(t.body.tracks).toHaveLength(3);
    expect((await request(ctx.server).get(`/api/jobs/${id}/review`).set('Cookie', cookie)).body.items).toHaveLength(1);
    expect((await request(ctx.server).get(`/api/jobs/${id}/meta`).set('Cookie', cookie)).body).toEqual({ fps: 30 });
  });

  it('thumbs: serves valid name, 400 on traversal or bad name, 404 when missing', async () => {
    const id = (await upload(ctx)).body.id;
    const cookie = await login(ctx);
    seed(ctx, id, { 'thumbs/t1.jpg': Buffer.from('jpg') });
    const ok = await request(ctx.server).get(`/api/jobs/${id}/thumbs/t1.jpg`).set('Cookie', cookie);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/image\/jpeg/);
    for (const bad of ['..%2Fstudio.db', '..%2F..%2Fstudio.db', 't1.png', '.jpg', 'a%00.jpg', '..%2Foriginal.mp4']) {
      const r = await request(ctx.server).get(`/api/jobs/${id}/thumbs/${bad}`).set('Cookie', cookie);
      expect([bad, r.status]).toEqual([bad, 400]);
    }
    expect((await request(ctx.server).get(`/api/jobs/${id}/thumbs/t9.jpg`).set('Cookie', cookie)).status).toBe(404);
  });

  describe('edits', () => {
    let id: string;
    let cookie: string;
    beforeEach(async () => {
      id = (await upload(ctx)).body.id;
      cookie = await login(ctx);
      seed(ctx, id, { 'tracks.json': fixture('tracks.sample.json'), 'review.json': fixture('review.sample.json') });
    });
    const put = (body: unknown) => request(ctx.server).put(`/api/jobs/${id}/edits`).set('Cookie', cookie).send(body as any);

    it('GET returns the default when nothing is stored', async () => {
      const r = await request(ctx.server).get(`/api/jobs/${id}/edits`).set('Cookie', cookie);
      expect(r.body).toEqual({ version: 1, visible: [], groups: [], splits: [], manual: [], reviewed: [] });
    });

    it('PUT accepts the contract fixture (split-derived ids) and GET round-trips it', async () => {
      const edits = fixture('edits.sample.json');
      edits.reviewed = ['r1'];
      expect((await put(edits)).status).toBe(200);
      expect((await request(ctx.server).get(`/api/jobs/${id}/edits`).set('Cookie', cookie)).body).toEqual(edits);
      expect(fs.existsSync(path.join(ctx.dataDir, 'jobs', id, 'edits.json'))).toBe(true);
    });

    it('PUT rejects unknown track ids (visible, groups, splits) and review ids with 400', async () => {
      const base = { version: 1, visible: [], groups: [], splits: [], manual: [], reviewed: [] };
      for (const bad of [
        { ...base, visible: ['t99'] },
        { ...base, visible: ['t1a'] }, // t1 is not split
        { ...base, groups: [{ id: 'g1', trackIds: ['t1', 'nope'], label: 'x' }] },
        { ...base, splits: [{ trackId: 't9', frame: 3 }] },
        { ...base, reviewed: ['r9'] },
      ]) {
        const r = await put(bad);
        expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 400]);
        expect(typeof r.body.message).toBe('string');
      }
    });

    it('PUT rejects malformed shapes with 400', async () => {
      const base = { version: 1, visible: [], groups: [], splits: [], manual: [], reviewed: [] };
      for (const bad of [
        null, [], 'x', { ...base, version: 2 }, { ...base, visible: 'a' }, { ...base, visible: [1] },
        { ...base, groups: [{ id: 'g', trackIds: 'x', label: 'l' }] },
        { ...base, splits: [{ trackId: 't1', frame: -1 }] },
        { ...base, splits: [{ trackId: 't1', frame: 1.5 }] },
        { ...base, manual: [{ id: 'bad id', anchors: [], trim: null, deleted: false }] },
        { ...base, manual: [{ id: 'm1', anchors: [{ frame: 1, box: [1, 2, 3] }], trim: null, deleted: false }] },
        { ...base, manual: [{ id: 'm1', anchors: [], trim: [1], deleted: false }] },
        { ...base, manual: [{ id: 'm1', anchors: [], trim: null, deleted: 'no' }] },
        { version: 1 },
      ]) {
        const r = await put(bad);
        expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 400]);
      }
    });
  });

  it('DELETE removes the directory, the row and redis keys', async () => {
    const id = (await upload(ctx)).body.id;
    const cookie = await login(ctx);
    await ctx.redis.hset(`job:${id}:status`, { state: 'ready' });
    const r = await request(ctx.server).delete(`/api/jobs/${id}`).set('Cookie', cookie);
    expect(r.status).toBe(204);
    expect(fs.existsSync(path.join(ctx.dataDir, 'jobs', id))).toBe(false);
    expect((await request(ctx.server).get(`/api/jobs/${id}`).set('Cookie', cookie)).status).toBe(404);
    expect(await ctx.redis.exists(`job:${id}:status`)).toBe(0);
  });
});
