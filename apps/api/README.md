# Face Mosaic Studio API (NestJS)

All routes live under `/api`. Spec: `docs/superpowers/specs/2026-10-30-face-mosaic-studio-design.md` (section 5).

## Environment variables

| Name | Default | Notes |
|---|---|---|
| `JWT_SECRET` | none, required | The API refuses to start when unset. |
| `STUDIO_USERS` | empty | `user:bcrypthash,user2:bcrypthash` |
| `DATA_DIR` | `/data` | Jobs live in `$DATA_DIR/jobs/{id}/`. |
| `DB_PATH` | `$DATA_DIR/studio.db` | SQLite file. |
| `REDIS_URL` | `redis://localhost:6379` | |
| `PORT` | `3000` | |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS so the `studio_token` cookie gets `Secure`. |
| `MAX_UPLOAD_BYTES` | `2147483648` | Upload limit (413 above it). Mostly for tests. |

## Add a user

```
pnpm install
pnpm hash-password 'the-password'     # prints a bcrypt hash
```

Append `name:<hash>` to `STUDIO_USERS` (comma separated) and restart the API. bcrypt hashes contain `$`, so single-quote the value in a shell and write `$$` in docker-compose files.

## Scripts

`pnpm build`, `pnpm start`, `pnpm start:dev`, `pnpm test` (unit + e2e, ioredis-mock, temp `DATA_DIR`), `pnpm test:e2e`.

## Render duplicate detection

`POST /jobs/:id/render` sets `job:{id}:render_requested` (epoch ms, 6 h TTL) and pushes `queue:render`. A request is treated as a duplicate (409) while the worker state is `rendering`, or while that timestamp is newer than the status hash `updatedAt` (the message is still waiting in the queue). The worker needs no extra duty, but it must refresh `updatedAt` whenever it writes the status hash.
