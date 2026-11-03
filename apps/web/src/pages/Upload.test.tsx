import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFetch } from '../test/mockFetch';
import type { Job } from '../lib/types';
import { Upload } from './Upload';

const job = (over: Partial<Job>): Job => ({
  id: 'j1', filename: 'a.mp4', createdAt: new Date().toISOString(), state: 'ready', progress: 0, error: null, hasOutput: false, outputStale: false, ...over,
});

const setup = (jobs: Job[] = []) => {
  const calls = installFetch((c) => {
    if (c.path === '/api/auth/me') return { body: { username: 'alice' } };
    if (c.path === '/api/jobs' && c.method === 'GET') return { body: jobs };
    if (c.path.startsWith('/api/jobs/') && c.method === 'DELETE') return { status: 204, body: null };
    return undefined;
  });
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Upload />} />
        <Route path="/jobs/:id" element={<div>studio {''}page</div>} />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return calls;
};

class FakeXHR {
  static last: FakeXHR;
  upload: { onprogress: ((e: unknown) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  responseText = '';
  withCredentials = false;
  open = vi.fn();
  send = vi.fn();
  constructor() {
    FakeXHR.last = this;
  }
}

afterEach(() => vi.unstubAllGlobals());

const drop = (file: File) => fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [file] } });

describe('Upload page', () => {
  it('drops a valid file, shows progress in the centre, and navigates to the new job', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    setup();
    drop(new File(['x'], 'clip.mp4', { type: 'video/mp4' }));
    await waitFor(() => expect(FakeXHR.last.send).toHaveBeenCalled());
    FakeXHR.last.upload.onprogress!({ lengthComputable: true, loaded: 42, total: 100 });
    expect(await screen.findByText('업로드 중 42%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    FakeXHR.last.status = 201;
    FakeXHR.last.responseText = JSON.stringify(job({ id: 'n1' }));
    FakeXHR.last.onload!();
    expect(await screen.findByText(/studio/)).toBeInTheDocument();
  });

  it('rejects an invalid extension without uploading', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    FakeXHR.last = undefined as never;
    setup();
    drop(new File(['x'], 'notes.txt'));
    expect(await screen.findByRole('alert')).toHaveTextContent('MP4, MOV, MKV, WEBM');
    expect(FakeXHR.last).toBeUndefined();
  });

  it('shows the server error in the drop zone and allows retry', async () => {
    class Fail extends FakeXHR {
      status = 413;
      responseText = JSON.stringify({ message: '파일이 너무 큽니다.' });
      send = vi.fn(() => setTimeout(() => this.onload?.(), 0));
    }
    vi.stubGlobal('XMLHttpRequest', Fail);
    setup();
    drop(new File(['x'], 'big.mp4'));
    expect(await screen.findByText('파일이 너무 큽니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '내 파일로 해 보기' })).toBeEnabled();
  });

  it('highlights the zone while dragging over', () => {
    setup();
    const zone = screen.getByTestId('dropzone');
    fireEvent.dragOver(zone);
    expect(zone).toHaveClass('over');
    fireEvent.dragLeave(zone);
    expect(zone).not.toHaveClass('over');
  });

  it('the primary button opens the hidden file input', async () => {
    setup();
    const input = screen.getByLabelText('영상 파일 선택') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    await userEvent.click(screen.getByRole('button', { name: '내 파일로 해 보기' }));
    expect(click).toHaveBeenCalled();
  });

  it('greys out the side columns', () => {
    setup();
    expect(screen.getByTestId('shell-left')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('블러 대상이 아직 없습니다')).toBeInTheDocument();
  });
});

describe('My jobs dropdown', () => {
  it('lists jobs with Korean states and navigates on click', async () => {
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    setup([
      job({ id: '1', filename: 'q.mp4', state: 'queued', createdAt: old }),
      job({ id: '4', filename: 'ana.mp4', state: 'analyzing', progress: 42 }),
      job({ id: '5', filename: 'ready.mp4' }),
      job({ id: '8', filename: 'bad.mp4', state: 'failed', error: '지원하지 않는 영상입니다.' }),
    ]);
    await userEvent.click(within(screen.getByTestId('my-jobs')).getByRole('button', { name: '내 작업' }));
    expect(await screen.findByText('처리 서버 응답이 없습니다')).toBeInTheDocument();
    expect(screen.getByText('분석 중 42%')).toBeInTheDocument();
    expect(screen.getByText('실패')).toBeInTheDocument();
    expect(screen.getByText('지원하지 않는 영상입니다.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ready.mp4' })).toHaveAttribute('href', '/jobs/5');
    await userEvent.click(screen.getByRole('link', { name: 'ready.mp4' }));
    expect(await screen.findByText(/studio/)).toBeInTheDocument();
  });

  it('asks for confirmation before deleting', async () => {
    const calls = setup([job({ id: '5', filename: 'ready.mp4' })]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(screen.getByRole('button', { name: '내 작업' }));
    await userEvent.click(await screen.findByRole('button', { name: 'ready.mp4 삭제' }));
    expect(confirm).toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'ready.mp4 삭제' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/jobs/5')).toBe(true));
    confirm.mockRestore();
  });
});
