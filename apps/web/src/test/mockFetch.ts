import { vi } from 'vitest';

export interface Call {
  method: string;
  path: string;
  body: unknown;
}
export type Reply = { status?: number; body?: unknown } | undefined;
export type Handler = (c: Call) => Reply;

/** Replace global fetch; unhandled requests answer 404 so missing mocks fail loudly in assertions. */
export function installFetch(handler: Handler): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const r = handler(call) ?? { status: 404, body: { message: `unmocked ${call.method} ${call.path}` } };
      const text = r.body === undefined ? '' : JSON.stringify(r.body);
      return new Response(text, { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}
