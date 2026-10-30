import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import * as fs from 'fs';
import RedisMock from 'ioredis-mock';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { REDIS } from '../src/core.module';

export const FIXTURES = path.resolve(__dirname, '../../../contracts/fixtures');
export const PASSWORD = 'pw-test';

export interface TestCtx {
  app: INestApplication;
  redis: any;
  dataDir: string;
  server: any;
  cookies: Record<string, string>;
  close: () => Promise<void>;
}

export async function createApp(env: Record<string, string> = {}): Promise<TestCtx> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-api-'));
  const hash = bcrypt.hashSync(PASSWORD, 4);
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    DB_PATH: path.join(dataDir, 'studio.db'),
    JWT_SECRET: 'test-secret',
    STUDIO_USERS: `alice:${hash},bob:${hash}`,
    COOKIE_SECURE: 'false',
  });
  delete process.env.MAX_UPLOAD_BYTES;
  delete process.env.AUTH_DISABLED;
  delete process.env.AUTH_ANON_USER;
  Object.assign(process.env, env);
  const redis = new RedisMock();
  await redis.flushall();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS)
    .useValue(redis)
    .compile();
  const app = mod.createNestApplication();
  configureApp(app);
  await app.listen(0);
  return {
    app,
    redis,
    dataDir,
    server: app.getHttpServer(),
    cookies: {},
    close: async () => {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Logs in and returns the Cookie header value. */
export async function login(ctx: TestCtx, username = 'alice'): Promise<string> {
  if (ctx.cookies[username]) return ctx.cookies[username];
  const res = await request(ctx.server).post('/api/auth/login').send({ username, password: PASSWORD });
  const raw = (res.headers['set-cookie'] as unknown as string[])[0];
  ctx.cookies[username] = raw.split(';')[0];
  return ctx.cookies[username];
}

export function fixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}
