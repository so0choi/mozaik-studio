import Redis from 'ioredis';

export const QUEUE_ANALYZE = 'queue:analyze';
export const QUEUE_RENDER = 'queue:render';
export const QUEUE_PROPAGATE = 'queue:propagate';

export const statusKey = (id: string) => `job:${id}:status`;
export const manualKey = (id: string, mid: string) => `job:${id}:manual:${mid}`;
/** Set by the API on POST /render (value = epoch ms). Used only for duplicate detection. */
export const renderRequestedKey = (id: string) => `job:${id}:render_requested`;

export class Queue {
  constructor(private readonly redis: Redis) {}

  push(queue: string, msg: unknown) {
    return this.redis.lpush(queue, JSON.stringify(msg));
  }
}
