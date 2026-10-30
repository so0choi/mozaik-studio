import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, CONFIG } from '../config';
import { REDIS } from '../core.module';
import { DEFAULT_EDITS, isValidBox, validateEdits } from './edits.validator';
import { manualKey, Queue, QUEUE_ANALYZE, QUEUE_PROPAGATE, QUEUE_RENDER, renderRequestedKey, statusKey } from './queue';
import { JobRepo, JobRow } from './repo';
import { MANUAL_ID_RE, Storage, THUMB_RE, UUID_RE } from './storage';

export interface Job {
  id: string;
  filename: string;
  createdAt: string;
  state: string;
  progress: number;
  error: string | null;
  hasOutput: boolean;
}

interface Status {
  state: string;
  progress: number;
  error: string | null;
  updatedAt: string | null;
}

const RENDER_REQUEST_TTL_S = 6 * 60 * 60;

@Injectable()
export class JobsService {
  readonly storage: Storage;
  private readonly queue: Queue;
  /** Serialises check-and-set of the render request key within this process. */
  private readonly renderLocks = new Set<string>();

  constructor(
    @Inject(CONFIG) readonly cfg: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly repo: JobRepo,
  ) {
    this.storage = new Storage(cfg.dataDir);
    this.queue = new Queue(redis);
    fs.mkdirSync(this.storage.jobsRoot(), { recursive: true });
  }

  /** Owner check: unknown id, bad UUID and other users' jobs are all 404. */
  getOwned(id: string, username: string): JobRow {
    if (!UUID_RE.test(id)) throw new NotFoundException('작업을 찾을 수 없습니다.');
    const row = this.repo.get(id);
    if (!row || row.owner !== username) throw new NotFoundException('작업을 찾을 수 없습니다.');
    return row;
  }

  async status(id: string): Promise<Status> {
    const h = await this.redis.hgetall(statusKey(id));
    if (h && h.state) return this.toStatus(h);
    const f = this.storage.readJson<any>(this.storage.file(id, 'status.json'));
    if (f && typeof f.state === 'string') return this.toStatus(f);
    return { state: 'queued', progress: 0, error: null, updatedAt: null };
  }

  private toStatus(h: any): Status {
    const p = Number.parseInt(String(h.progress ?? 0), 10);
    return {
      state: String(h.state),
      progress: Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0,
      error: h.error ? String(h.error) : null,
      updatedAt: h.updatedAt ? String(h.updatedAt) : null,
    };
  }

  async toJob(row: JobRow): Promise<Job> {
    const s = await this.status(row.id);
    return {
      id: row.id,
      filename: row.filename,
      createdAt: row.createdAt,
      state: s.state,
      progress: s.progress,
      error: s.error,
      hasOutput: this.storage.exists(this.storage.file(row.id, 'output.mp4')),
    };
  }

  async list(owner: string): Promise<Job[]> {
    return Promise.all(this.repo.listByOwner(owner).map((r) => this.toJob(r)));
  }

  async create(owner: string, jobId: string, filename: string): Promise<Job> {
    const row: JobRow = { id: jobId, owner, filename, createdAt: new Date().toISOString() };
    try {
      this.repo.insert(row);
      await this.queue.push(QUEUE_ANALYZE, { jobId });
    } catch (e) {
      this.repo.delete(jobId);
      this.storage.removeDir(jobId);
      throw e;
    }
    return this.toJob(row);
  }

  /** Removes dir, row and redis keys. Synchronous for fs/db; redis cleanup is best effort. */
  removeJob(id: string) {
    this.storage.removeDir(id);
    this.repo.delete(id);
    this.redis.del(statusKey(id), renderRequestedKey(id)).catch(() => undefined);
  }

  jsonFile(id: string, name: 'tracks' | 'review' | 'meta'): unknown {
    const data = this.storage.readJson(this.storage.file(id, `${name}.json`));
    if (data === undefined) throw new NotFoundException('아직 준비되지 않았습니다.');
    return data;
  }

  thumbPath(id: string, name: string): string {
    if (!THUMB_RE.test(name)) throw new BadRequestException('썸네일 이름이 올바르지 않습니다.');
    const p = this.storage.file(id, 'thumbs', name);
    if (!this.storage.exists(p)) throw new NotFoundException('썸네일을 찾을 수 없습니다.');
    return p;
  }

  videoPath(id: string, file: 'normalized.mp4' | 'output.mp4'): string {
    const p = this.storage.file(id, file);
    if (!this.storage.exists(p)) throw new NotFoundException('아직 준비되지 않았습니다.');
    return p;
  }

  getEdits(id: string) {
    return this.storage.readJson(this.storage.file(id, 'edits.json')) ?? DEFAULT_EDITS();
  }

  private reviewIds(id: string): string[] {
    const r = this.storage.readJson<any>(this.storage.file(id, 'review.json'));
    return Array.isArray(r?.items) ? r.items.map((i: any) => String(i.id)) : [];
  }

  putEdits(id: string, body: unknown) {
    const tracks = this.storage.readJson<any>(this.storage.file(id, 'tracks.json'));
    const trackIds = new Set<string>(Array.isArray(tracks?.tracks) ? tracks.tracks.map((t: any) => String(t.id)) : []);
    const err = validateEdits(body, trackIds, new Set(this.reviewIds(id)));
    if (err) throw new BadRequestException(err);
    this.storage.writeJsonAtomic(this.storage.file(id, 'edits.json'), body);
    return body;
  }

  async requestRender(id: string) {
    if (this.renderLocks.has(id)) throw new ConflictException('이미 렌더 중입니다.');
    this.renderLocks.add(id);
    try {
      const edits: any = this.getEdits(id);
      const reviewed = new Set<string>(Array.isArray(edits.reviewed) ? edits.reviewed : []);
      const pending = this.reviewIds(id).filter((r) => !reviewed.has(r)).length;
      if (pending > 0) throw new ConflictException(`확인 필요 항목 ${pending}건이 남았습니다.`);

      const status = await this.status(id);
      const requestedAt = Number(await this.redis.get(renderRequestedKey(id))) || 0;
      const updatedAt = status.updatedAt ? Date.parse(status.updatedAt) || 0 : 0;
      // A request newer than the worker's last status update is still waiting in queue:render.
      if (status.state === 'rendering' || requestedAt > updatedAt) {
        throw new ConflictException('이미 렌더 중입니다.');
      }
      if (status.state !== 'ready' && status.state !== 'rendered') {
        throw new ConflictException('분석이 끝난 뒤에 렌더할 수 있습니다.');
      }
      await this.redis.set(renderRequestedKey(id), String(Date.now()), 'EX', RENDER_REQUEST_TTL_S);
      try {
        await this.queue.push(QUEUE_RENDER, { jobId: id });
      } catch (e) {
        await this.redis.del(renderRequestedKey(id));
        throw e;
      }
    } finally {
      this.renderLocks.delete(id);
    }
  }

  async requestManual(id: string, body: any) {
    const bad = (m = '수동 박스 요청 형식이 올바르지 않습니다.') => new BadRequestException(m);
    if (!body || typeof body !== 'object') throw bad();
    const { manualId, anchor, otherAnchors } = body;
    if (typeof manualId !== 'string' || !MANUAL_ID_RE.test(manualId)) throw bad('수동 박스 ID가 올바르지 않습니다.');
    if (!anchor || !Number.isInteger(anchor.frame) || anchor.frame < 0 || !isValidBox(anchor.box)) throw bad();
    if (!Array.isArray(otherAnchors) || !otherAnchors.every((n) => Number.isInteger(n) && n >= 0)) throw bad();
    await this.redis.hset(manualKey(id, manualId), { state: 'tracking' });
    await this.queue.push(QUEUE_PROPAGATE, {
      jobId: id,
      manualId,
      anchor: { frame: anchor.frame, box: anchor.box },
      otherAnchors,
    });
  }

  async manualStatus(id: string, mid: string) {
    if (!MANUAL_ID_RE.test(mid)) throw new BadRequestException('수동 박스 ID가 올바르지 않습니다.');
    const result = this.storage.readJson(this.storage.file(id, 'manual', `${mid}.json`)) ?? null;
    const h = await this.redis.hgetall(manualKey(id, mid));
    const state = h?.state || (result ? 'done' : 'tracking');
    return { state, result };
  }

  outputName(row: JobRow) {
    return `mosaic_${path.parse(row.filename).name}.mp4`;
  }
}
