import * as fs from 'fs';
import * as path from 'path';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const THUMB_RE = /^[\w-]+\.jpg$/;
export const MANUAL_ID_RE = /^m[\w-]{1,40}$/;
export const ALLOWED_EXT = ['.mp4', '.mov', '.mkv', '.webm'];

export class Storage {
  constructor(private readonly dataDir: string) {}

  jobsRoot() {
    return path.join(this.dataDir, 'jobs');
  }

  /** Callers must have validated `id` as a UUID. */
  jobDir(id: string) {
    if (!UUID_RE.test(id)) throw new Error('invalid job id');
    return path.join(this.jobsRoot(), id);
  }

  file(id: string, ...parts: string[]) {
    return path.join(this.jobDir(id), ...parts);
  }

  exists(p: string) {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }

  readJson<T = unknown>(p: string): T | undefined {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  writeJsonAtomic(p: string, data: unknown) {
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, p);
  }

  removeDir(id: string) {
    fs.rmSync(this.jobDir(id), { recursive: true, force: true });
  }
}
