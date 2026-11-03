import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../lib/types';
import { installFetch } from '../test/mockFetch';
import { MyJobs } from './MyJobs';

const job = (over: Partial<Job>): Job => ({
  id: 'j1', filename: 'clip.mp4', createdAt: new Date().toISOString(), state: 'failed', progress: 0, error: '실패', hasOutput: false, outputStale: false, ...over,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(jobs: Job[]) {
  const calls = installFetch((c) => {
    if (c.path === '/api/jobs' && c.method === 'GET') return { body: jobs };
    if (c.path === '/api/jobs/j1/reanalyze') return { status: 202, body: { ok: true } };
    return undefined;
  });
  render(
    <MemoryRouter>
      <MyJobs />
    </MemoryRouter>,
  );
  return calls;
}

describe('MyJobs re-analyze', () => {
  it('failed job shows 다시 분석 and calls the API after confirm, then refreshes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const calls = setup([job({})]);
    await userEvent.click(screen.getByRole('button', { name: '내 작업' }));
    await userEvent.click(await screen.findByRole('button', { name: 'clip.mp4 다시 분석' }));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/jobs/j1/reanalyze')).toBe(true);
    expect(calls.filter((c) => c.path === '/api/jobs' && c.method === 'GET').length).toBe(2);
  });

  it('does nothing when the confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const calls = setup([job({})]);
    await userEvent.click(screen.getByRole('button', { name: '내 작업' }));
    await userEvent.click(await screen.findByRole('button', { name: 'clip.mp4 다시 분석' }));
    expect(calls.some((c) => c.path.endsWith('/reanalyze'))).toBe(false);
  });

  it('non-failed jobs have no 다시 분석 button', async () => {
    setup([job({ state: 'ready', error: null })]);
    await userEvent.click(screen.getByRole('button', { name: '내 작업' }));
    await screen.findByText('clip.mp4');
    expect(screen.queryByRole('button', { name: /다시 분석/ })).toBeNull();
  });
});
