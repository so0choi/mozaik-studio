import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { installFetch } from '../test/mockFetch';
import type { Job } from '../lib/types';

const renderApp = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

describe('Login', () => {
  it('shows the server message on 401', async () => {
    installFetch((c) =>
      c.path === '/api/auth/login' ? { status: 401, body: { message: '아이디 또는 비밀번호가 맞지 않습니다.' } } : undefined,
    );
    renderApp('/login');
    await userEvent.type(screen.getByLabelText('아이디'), 'alice');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'x');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('아이디 또는 비밀번호가 맞지 않습니다.');
  });

  it('skips the login page when the server has login turned off', async () => {
    installFetch((c) => {
      if (c.path === '/api/auth/me') return { body: { username: 'demo', authDisabled: true } };
      if (c.path === '/api/jobs') return { body: [] };
      return undefined;
    });
    renderApp('/login');
    await waitFor(() => expect(screen.queryByRole('button', { name: '로그인' })).not.toBeInTheDocument());
    expect(await screen.findByText('영상 올리기')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '로그아웃' })).not.toBeInTheDocument();
  });

  it('route guard redirects to /login when /api/auth/me is 401', async () => {
    const calls = installFetch((c) => (c.path === '/api/auth/me' ? { status: 401, body: { message: 'x' } } : undefined));
    renderApp('/');
    expect(await screen.findByRole('button', { name: '로그인' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/auth/me')).toBe(true);
  });
});

const job = (over: Partial<Job>): Job => ({
  id: 'j1', filename: 'a.mp4', createdAt: new Date().toISOString(), state: 'ready', progress: 0, error: null, hasOutput: false, ...over,
});

describe('Jobs', () => {
  const setup = (jobs: Job[]) =>
    installFetch((c) => {
      if (c.path === '/api/auth/me') return { body: { username: 'alice' } };
      if (c.path === '/api/jobs' && c.method === 'GET') return { body: jobs };
      return undefined;
    });

  it('shows Korean states, failed error text, and the 5 minute queued warning', async () => {
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    setup([
      job({ id: '1', filename: 'queued-old.mp4', state: 'queued', createdAt: old }),
      job({ id: '2', filename: 'queued-new.mp4', state: 'queued' }),
      job({ id: '3', filename: 'norm.mp4', state: 'normalizing' }),
      job({ id: '4', filename: 'ana.mp4', state: 'analyzing', progress: 42 }),
      job({ id: '5', filename: 'ready.mp4', state: 'ready' }),
      job({ id: '6', filename: 'rend.mp4', state: 'rendering' }),
      job({ id: '7', filename: 'done.mp4', state: 'rendered', hasOutput: true }),
      job({ id: '8', filename: 'bad.mp4', state: 'failed', error: '30분 이하, 4K 이하 영상만 지원합니다.' }),
    ]);
    renderApp('/');
    expect(await screen.findByText('처리 서버 응답이 없습니다')).toBeInTheDocument();
    for (const t of ['대기 중', '변환 중', '분석 중 42%', '편집 가능', '렌더 중', '완료', '실패']) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    expect(screen.getByText('30분 이하, 4K 이하 영상만 지원합니다.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ready.mp4' })).toHaveAttribute('href', '/jobs/5');
    expect(screen.queryByRole('link', { name: 'bad.mp4' })).toBeNull();
  });

  it('shows upload progress from XMLHttpRequest and refreshes the list when done', async () => {
    const calls = setup([]);
    let xhrInstance!: FakeXHR;
    class FakeXHR {
      upload: { onprogress: ((e: unknown) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      status = 0;
      responseText = '';
      withCredentials = false;
      open = vi.fn();
      constructor() {
        xhrInstance = this;
      }
      send = vi.fn();
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    renderApp('/');
    const input = await screen.findByLabelText('영상 파일 선택');
    await userEvent.upload(input, new File(['x'], 'clip.mp4', { type: 'video/mp4' }));
    await waitFor(() => expect(xhrInstance.send).toHaveBeenCalled());
    xhrInstance.upload.onprogress!({ lengthComputable: true, loaded: 50, total: 100 });
    expect(await screen.findByText('업로드 중 50%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    xhrInstance.status = 201;
    xhrInstance.responseText = JSON.stringify(job({ id: 'n' }));
    xhrInstance.onload!();
    await waitFor(() => expect(screen.queryByText(/업로드 중/)).toBeNull());
    expect(calls.filter((c) => c.path === '/api/jobs' && c.method === 'GET').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the server error (413) and keeps the page usable', async () => {
    setup([]);
    class FakeXHR {
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      status = 413;
      responseText = JSON.stringify({ message: '파일이 너무 큽니다.' });
      withCredentials = false;
      open = vi.fn();
      send = vi.fn(() => setTimeout(() => this.onload?.(), 0));
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    renderApp('/');
    await userEvent.upload(await screen.findByLabelText('영상 파일 선택'), new File(['x'], 'big.mp4'));
    expect(await screen.findByText('파일이 너무 큽니다.')).toBeInTheDocument();
  });
});
