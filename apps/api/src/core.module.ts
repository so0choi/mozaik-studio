import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfig, CONFIG, loadConfig } from './config';
import { JobRepo } from './jobs/repo';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    {
      provide: REDIS,
      inject: [CONFIG],
      useFactory: (cfg: AppConfig) => {
        const client = new Redis(cfg.redisUrl);
        client.on('error', (e) => console.error('[redis]', e.message));
        return client;
      },
    },
    {
      provide: JobRepo,
      inject: [CONFIG],
      useFactory: (cfg: AppConfig) => new JobRepo(cfg.dbPath),
    },
  ],
  exports: [CONFIG, REDIS, JobRepo],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis, private readonly repo: JobRepo) {}
  async onApplicationShutdown() {
    this.repo.close();
    try {
      await this.redis.quit();
    } catch {
      /* ignore */
    }
  }
}
