import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, CONFIG } from '../config';
import { REDIS } from '../core.module';
import type { ReviewItemLike } from './review-required';
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
  /** output.mp4 exists AND was rendered from the current saved edits. */
  hasOutput: boolean;
  /** output.mp4 exists but does not match the current saved edits (or its binding is missing). */
  outputStale: boolean;
}

interface Status {
  state: string;
  progress: number;
  error: string | null;
  updatedAt: string | null;
}

/** Key-order independent serialisation, so edits compare by value, not by byte layout. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const RENDER_REQUEST_TTL_S = 6 * 60 * 60;

@Injectable()
export class JobsService {
  readonly storage: Storage;
  private readonly log = new Logger('Jobs');
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

  /** A render request newer than the worker's last status update is still waiting in queue:render. */
  async renderPending(id: string, s?: Status): Promise<boolean> {
    const status = s ?? (await this.status(id));
    const requestedAt = Number(await this.redis.get(renderRequestedKey(id))) || 0;
    const updatedAt = status.updatedAt ? Date.parse(status.updatedAt) || 0 : 0;
    return requestedAt > updatedAt;
  }

  async toJob(row: JobRow): Promise<Job> {
    const s = await this.status(row.id);
    // While a re-render is queued, the previous output is stale: report it as rendering with no output.
    const pending = await this.renderPending(row.id, s);
    return {
      id: row.id,
      filename: row.filename,
      createdAt: row.createdAt,
      state: pending ? 'rendering' : s.state,
      progress: pending ? 0 : s.progress,
      error: pending ? null : s.error,
      ...(pending ? { hasOutput: false, outputStale: false } : this.outputState(row.id)),
    };
  }

  /**
   * output.mp4 is only valid for the edits the worker rendered it from (output.edits.json, written
   * next to it). A missing or differing binding means stale: it is never offered for download.
   */
  outputState(id: string): { hasOutput: boolean; outputStale: boolean } {
    if (!this.storage.exists(this.storage.file(id, 'output.mp4'))) return { hasOutput: false, outputStale: false };
    const bound = this.storage.readJson(this.storage.file(id, 'output.edits.json'));
    const fresh = bound !== undefined && canonical(bound) === canonical(this.getEdits(id));
    return { hasOutput: fresh, outputStale: !fresh };
  }

  /** Path of a downloadable output: 404 while none exists, 409 when it predates the saved edits. */
  outputPath(id: string): string {
    const st = this.outputState(id);
    if (st.outputStale) throw new ConflictException('렌더 후 편집이 바뀌었습니다. 다시 렌더하세요.');
    return this.videoPath(id, 'output.mp4');
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

  private reviewItems(id: string): ReviewItemLike[] {
    const r = this.storage.readJson<any>(this.storage.file(id, 'review.json'));
    return Array.isArray(r?.items)
      ? r.items.map((i: any) => ({
          id: String(i.id),
          type: String(i.type),
          trackIds: Array.isArray(i.trackIds) ? i.trackIds.map(String) : [],
          severity: typeof i.severity === 'string' ? i.severity : undefined,
        }))
      : [];
  }

  private reviewIds(id: string): string[] {
    return this.reviewItems(id).map((i) => i.id);
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
      const status = await this.status(id);
      if (status.state === 'rendering' || (await this.renderPending(id, status))) {
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

  /** Re-runs detection from the original upload; resets derived data and per-person edits. */
  async requestReanalyze(id: string, username: string) {
    if (this.renderLocks.has(id)) throw new ConflictException('분석이나 렌더가 진행 중입니다.');
    this.renderLocks.add(id);
    try {
      const status = await this.status(id);
      if (['queued', 'normalizing', 'analyzing', 'rendering'].includes(status.state) || (await this.renderPending(id, status))) {
        throw new ConflictException('분석이나 렌더가 진행 중입니다.');
      }
      const editsPath = this.storage.file(id, 'edits.json');
      const edits = this.storage.readJson<any>(editsPath);
      if (edits && typeof edits === 'object') {
        const eff = edits.effects && typeof edits.effects === 'object' ? edits.effects : undefined;
        const next: any = { ...edits, visible: [], groups: [], splits: [], reviewed: [] };
        if (eff) {
          // drawn regions survive re-analysis, so their effect overrides do too; track/person ids change
          const manualIds = new Set((Array.isArray(edits.manual) ? edits.manual : []).map((m: any) => m?.id));
          const kept = Object.entries(eff.overrides ?? {}).filter(([k]) => manualIds.has(k));
          next.effects = { ...eff, overrides: Object.fromEntries(kept) };
        }
        this.storage.writeJsonAtomic(editsPath, next);
      }
      for (const f of ['tracks.json', 'review.json', 'output.mp4', 'output.edits.json', 'find_person.json', 'find_dismissed.json']) {
        fs.rmSync(this.storage.file(id, f), { force: true });
      }
      fs.rmSync(this.storage.file(id, 'thumbs'), { recursive: true, force: true });
      const now = new Date().toISOString();
      const statusJson = this.storage.file(id, 'status.json');
      if (fs.existsSync(statusJson)) {
        this.storage.writeJsonAtomic(statusJson, { state: 'queued', progress: 0, error: '', updatedAt: now });
      }
      await this.redis.hset(statusKey(id), { state: 'queued', progress: '0', error: '', updatedAt: now });
      await this.redis.del(renderRequestedKey(id));
      await this.queue.push(QUEUE_ANALYZE, { jobId: id });
      this.log.log(`reanalyze requested job=${id} user=${username}`);
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
