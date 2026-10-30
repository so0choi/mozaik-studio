import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JobsService } from '../jobs/jobs.service';
import { JobRepo } from '../jobs/repo';

export const RETENTION_DAYS = 7;
const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Retention');
  private timer?: NodeJS.Timeout;

  constructor(private readonly repo: JobRepo, private readonly jobs: JobsService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      try {
        const n = this.sweep(new Date());
        if (n > 0) this.log.log(`deleted ${n} expired job(s)`);
      } catch (e) {
        this.log.error(`sweep failed: ${(e as Error).message}`);
      }
    }, HOUR_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Deletes jobs created more than 7 days before `now` (dir + row + redis keys). Returns the count. */
  sweep(now: Date): number {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * HOUR_MS).toISOString();
    const expired = this.repo.listOlderThan(cutoff);
    for (const row of expired) this.jobs.removeJob(row.id);
    return expired.length;
  }
}
