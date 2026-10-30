import * as path from 'path';

export const CONFIG = Symbol('CONFIG');

export interface AppConfig {
  port: number;
  dataDir: string;
  dbPath: string;
  redisUrl: string;
  jwtSecret: string;
  users: Map<string, string>;
  cookieSecure: boolean;
  maxUploadBytes: number;
  /** Prototype switch: when set, every request runs as this user and no login is needed. */
  anonUser: string | null;
}

export function parseUsers(raw: string | undefined): Map<string, string> {
  const users = new Map<string, string>();
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const idx = entry.indexOf(':'); // bcrypt hashes contain no ':'
    if (idx <= 0) continue;
    users.set(entry.slice(0, idx), entry.slice(idx + 1));
  }
  return users;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET 환경변수가 필요합니다. 설정하지 않으면 API를 시작하지 않습니다.');
  }
  const dataDir = env.DATA_DIR || '/data';
  return {
    port: Number(env.PORT) || 3000,
    dataDir,
    dbPath: env.DB_PATH || path.join(dataDir, 'studio.db'),
    redisUrl: env.REDIS_URL || 'redis://localhost:6379',
    jwtSecret: env.JWT_SECRET,
    users: parseUsers(env.STUDIO_USERS),
    cookieSecure: env.COOKIE_SECURE === 'true',
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES) || 2 * 1024 * 1024 * 1024,
    anonUser: env.AUTH_DISABLED === 'true' ? env.AUTH_ANON_USER || 'guest' : null,
  };
}
