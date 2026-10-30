import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tracksDoc, reviewDoc } from '../lib/fixtures';
import type { Edits, Job } from '../lib/types';
import { installFetch, type Call, type Handler } from '../test/mockFetch';
import { Studio } from './Studio';

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1', filename: 'clip.mp4', createdAt: new Date().toISOString(), state: 'ready', progress: 100, error: null, hasOutput: false, ...over,
});
const emptyEdits: Edits = { version: 1, visible: [], groups: [], splits: [], manual: [], reviewed: [] };

function setup(opts: { tracks?: unknown; review?: unknown; edits?: Edits; extra?: Handler; job?: Job } = {}) {
  const calls = installFetch((c) => {
    const x = opts.extra?.(c);
    if (x) return x;
    if (c.path === '/api/jobs/j1' && c.method === 'GET') return { body: opts.job ?? job() };
    if (c.path === '/api/jobs/j1/tracks') return { body: opts.tracks ?? tracksDoc };
    if (c.path === '/api/jobs/j1/review') return { body: opts.review ?? reviewDoc };
    if (c.path === '/api/jobs/j1/edits' && c.method === 'GET') return { body: opts.edits ?? emptyEdits };
    if (c.path === '/api/jobs/j1/edits' && c.method === 'PUT') return { body: {} };
    return undefined;
  });
  render(
    <MemoryRouter initialEntries={['/jobs/j1']}>
      <Routes>
        <Route path="/jobs/:id" element={<Studio />} />
      </Routes>
    </MemoryRouter>,
  );
  return calls;
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/edits'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const card = (key: string) => screen.findByTestId(`card-${key}`);

describe('Studio gallery', () => {
  it('toggling 보임 sends exactly one debounced PUT with visible updated', async () => {
    const calls = setup();
    const c1 = await card('t1');
    const show = within(c1).getByRole('button', { name: '보임' });
    await userEvent.click(show);
    await userEvent.click(within(await card('t3')).getByRole('button', { name: '보임' }));
    await userEvent.click(within(await card('t3')).getByRole('button', { name: '가림' }));
    expect(puts(calls).length).toBe(0); // debounced
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    await sleep(700);
    expect(puts(calls).length).toBe(1);
    expect((puts(calls)[0].body as Edits).visible).toEqual(['t1']);
    expect(within(await card('t1')).getByText('보임', { selector: '.badge' })).toBeInTheDocument();
  });

  it('groups two selected cards into one group', async () => {
    const calls = setup();
    await card('t1');
    expect(screen.queryByRole('button', { name: '같은 사람으로 묶기' })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: '인물 1 묶기 선택' }));
    await userEvent.click(screen.getByRole('checkbox', { name: '인물 3 묶기 선택' }));
    expect(screen.getByText('2개 선택됨')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '같은 사람으로 묶기' }));
    expect(await screen.findByTestId('card-g1')).toBeInTheDocument();
    expect(screen.queryByTestId('card-t1')).toBeNull();
    expect(screen.queryByTestId('card-t3')).toBeNull();
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).groups).toEqual([{ id: 'g1', trackIds: ['t1', 't3'] }]);
  });

  it('renaming a person sets group.label', async () => {
    const calls = setup();
    const input = within(await card('t2')).getByLabelText('인물 2 이름 편집');
    await userEvent.clear(input);
    await userEvent.type(input, '진행자{Enter}');
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).groups).toEqual([{ id: 'g1', trackIds: ['t2'], label: '진행자' }]);
    expect(await card('g1')).toBeInTheDocument();
  });

  it('shows 검출된 얼굴이 없습니다 when there are no tracks', async () => {
    setup({ tracks: { ...tracksDoc, tracks: [] }, review: { items: [] } });
    expect(await screen.findByText('검출된 얼굴이 없습니다')).toBeInTheDocument();
    expect(screen.getByTestId('note')).toHaveTextContent('모든 항목 확인됨');
  });
});

describe('Studio review and render', () => {
  it('disables render until review items are resolved; 괜찮음 adds reviewed', async () => {
    const calls = setup();
    await card('t1');
    const renderBtn = screen.getByRole('button', { name: '렌더 후 다운로드' });
    expect(renderBtn).toBeDisabled();
    expect(screen.getByTestId('note')).toHaveTextContent('확인 필요 1건 남음');
    await userEvent.click(screen.getByRole('button', { name: /괜찮음/ }));
    expect(screen.getByTestId('note')).toHaveTextContent('모든 항목 확인됨');
    expect(renderBtn).toBeEnabled();
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).reviewed).toEqual(['r1']);
  });

  it('clicking a review item seeks the video to startFrame/fps', async () => {
    setup();
    await card('t1');
    await userEvent.click(screen.getByTestId('review-r1'));
    const video = screen.getByLabelText('미리보기 영상') as HTMLVideoElement;
    expect(video.currentTime).toBeCloseTo(30 / 30);
    expect(screen.getByTestId('time')).toHaveTextContent('00:01');
  });

  it('shows the 409 message verbatim', async () => {
    setup({
      edits: { ...emptyEdits, reviewed: ['r1'] },
      extra: (c) =>
        c.path === '/api/jobs/j1/render' ? { status: 409, body: { message: '확인 필요 항목 1건이 남았습니다.' } } : undefined,
    });
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: '렌더 후 다운로드' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('확인 필요 항목 1건이 남았습니다.');
  });

  it('renders: POST /render, polls the job, then shows 다운로드', async () => {
    let polls = 0;
    let requested = false;
    setup({
      edits: { ...emptyEdits, reviewed: ['r1'] },
      extra: (c) => {
        if (c.path === '/api/jobs/j1/render') {
          requested = true;
          return { status: 202, body: {} };
        }
        if (c.path === '/api/jobs/j1' && c.method === 'GET' && requested) {
          polls++;
          return { body: job(polls < 2 ? { state: 'rendering' } : { state: 'rendered', hasOutput: true }) };
        }
        return undefined;
      },
    });
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: '렌더 후 다운로드' }));
    expect(await screen.findByText('렌더 중')).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: '다운로드' }, { timeout: 6000 });
    expect(link).toHaveAttribute('href', '/api/jobs/j1/output');
  }, 10000);

  it('shows a progress message while the job is not ready yet', async () => {
    setup({ job: job({ state: 'analyzing', progress: 37 }) });
    expect(await screen.findByText('분석 중 37%')).toBeInTheDocument();
  });
});

describe('Studio required review items', () => {
  const crossingReview = { items: [{ id: 'r9', type: 'crossing', trackIds: ['t1', 't2'], startFrame: 10, endFrame: 20, box: [1, 1, 2, 2] }] };

  it('a crossing appears in the queue only after one of its two people is set to 보임', async () => {
    setup({ review: crossingReview });
    await card('t1');
    expect(screen.queryByTestId('review-r9')).toBeNull();
    expect(screen.getByTestId('note')).toHaveTextContent('모든 항목 확인됨');
    expect(screen.getByRole('button', { name: '렌더 후 다운로드' })).toBeEnabled();
    expect(screen.getByTestId('hidden-note')).toHaveTextContent('지금 가림 상태로는 노출 위험이 없는 항목 1개는 숨겼습니다');

    await userEvent.click(within(await card('t1')).getByRole('button', { name: '보임' }));
    expect(await screen.findByTestId('review-r9')).toBeInTheDocument();
    expect(screen.getByTestId('note')).toHaveTextContent('확인 필요 1건 남음');
    expect(screen.getByRole('button', { name: '렌더 후 다운로드' })).toBeDisabled();
    expect(screen.queryByTestId('hidden-note')).toBeNull();

    await userEvent.click(within(await card('t2')).getByRole('button', { name: '보임' }));
    await waitFor(() => expect(screen.queryByTestId('review-r9')).toBeNull());
    expect(screen.getByTestId('hidden-note')).toBeInTheDocument();
  });
});

describe('Studio split and manual box', () => {
  it('여기서 분할 adds a split and the person becomes two cards', async () => {
    const calls = setup();
    await card('t1');
    await userEvent.click(within(await card('t1')).getByRole('button', { name: '인물 1 등장 구간 보기' }));
    expect(screen.getByRole('button', { name: '여기서 분할' })).toBeDisabled(); // frame 0 = track start
    await userEvent.click(screen.getByTestId('review-r1')); // seek to frame 30
    await userEvent.click(screen.getByRole('button', { name: '여기서 분할' }));
    expect(await screen.findByTestId('card-t1a')).toBeInTheDocument();
    expect(screen.getByTestId('card-t1b')).toBeInTheDocument();
    expect(screen.queryByTestId('card-t1')).toBeNull();
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).splits).toEqual([{ trackId: 't1', frame: 30 }]);
  });

  it('박스 추가 -> POST /manual -> 추적 중 -> polls to done and marks the item reviewed', async () => {
    let polls = 0;
    const calls = setup({
      extra: (c) => {
        if (c.path === '/api/jobs/j1/manual' && c.method === 'POST') return { status: 202, body: {} };
        if (c.path === '/api/jobs/j1/manual/m1') {
          polls++;
          return polls < 2
            ? { body: { state: 'tracking' } }
            : { body: { state: 'done', result: { id: 'm1', frames: { '30': [500, 50, 48, 64] }, segments: [[30, 30]] } } };
        }
        return undefined;
      },
    });
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: /박스 추가/ }));
    expect(screen.getByTestId('boxtool')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '이 영역으로 추적' }));

    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/manual'))!;
    await waitFor(() => expect(post).toBeDefined());
    expect(post.body).toEqual({ manualId: 'm1', anchor: { frame: 30, box: [500, 50, 48, 64] }, otherAnchors: [] });
    expect(within(screen.getByTestId('review-r1')).getByText('추적 중')).toBeInTheDocument();
    expect(screen.getByTestId('manual-chip')).toHaveTextContent('추적 중');
    expect(screen.getByRole('button', { name: '렌더 후 다운로드' })).toBeDisabled();

    await waitFor(() => expect(screen.getByTestId('note')).toHaveTextContent('모든 항목 확인됨'), { timeout: 5000 });
    expect(screen.getByTestId('manual-chip')).toHaveTextContent('수동 박스 1');
    expect(screen.getByTestId('manual-chip')).not.toHaveTextContent('추적 중');
    await waitFor(() => {
      const last = puts(calls).at(-1)!.body as Edits;
      expect(last.reviewed).toEqual(['r1']);
      expect(last.manual).toEqual([{ id: 'm1', anchors: [{ frame: 30, box: [500, 50, 48, 64] }], trim: null, deleted: false }]);
    });
  }, 12000);

  it('drawing with 박스 그리기 + drag posts the dragged box in source pixels', async () => {
    const calls = setup({
      extra: (c) => (c.path === '/api/jobs/j1/manual' && c.method === 'POST' ? { status: 202, body: {} } : undefined),
    });
    await card('t1');
    // jsdom has no layout: make the player 640x360 so display px == source px
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const orig = [Object.getOwnPropertyDescriptor(proto, 'clientWidth'), Object.getOwnPropertyDescriptor(proto, 'clientHeight')];
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 360 });
    fireEvent(window, new Event('resize'));
    await userEvent.click(screen.getByRole('button', { name: '박스 그리기' }));
    const tool = screen.getByTestId('boxtool');
    tool.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, x: 0, y: 0, toJSON: () => ({}) });
    expect(screen.getByRole('button', { name: '이 영역으로 추적' })).toBeDisabled();
    fireEvent.pointerDown(tool, { clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(tool, { clientX: 180, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(tool, { clientX: 180, clientY: 130, pointerId: 1 });
    await userEvent.click(screen.getByRole('button', { name: '이 영역으로 추적' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/manual'))).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/manual'))!;
    expect((post.body as { anchor: { box: number[] } }).anchor.box).toEqual([100, 50, 80, 80]);
    if (orig[0]) Object.defineProperty(proto, 'clientWidth', orig[0]);
    else delete proto.clientWidth;
    if (orig[1]) Object.defineProperty(proto, 'clientHeight', orig[1]);
    else delete proto.clientHeight;
  });
});

describe('Studio suspect tracks', () => {
  const suspectDoc = {
    ...tracksDoc,
    tracks: tracksDoc.tracks.map((t) => (t.id === 't1' || t.id === 't3' ? { ...t, suspect: true } : t)),
  };
  afterEach(() => vi.restoreAllMocks());

  it('shows badge on suspect cards and the summary count', async () => {
    setup({ tracks: suspectDoc });
    expect(within(await card('t1')).getByText('얼굴 아닐 수 있음')).toBeInTheDocument();
    expect(within(await card('t3')).getByText('얼굴 아닐 수 있음')).toBeInTheDocument();
    expect(within(await card('t2')).queryByText('얼굴 아닐 수 있음')).toBeNull();
    expect(screen.getByText('얼굴이 아닐 수 있는 항목 2개')).toBeInTheDocument();
  });

  it('confirm=true shows all suspects via one debounced PUT', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const calls = setup({ tracks: suspectDoc });
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: '확인 후 모두 보임' }));
    expect(confirm).toHaveBeenCalledWith(
      '얼굴 아닐 수 있음으로 표시된 2개를 모두 보이게 합니다. 썸네일을 확인하셨나요?',
    );
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    await sleep(700);
    expect(puts(calls).length).toBe(1);
    expect([...(puts(calls)[0].body as Edits).visible].sort()).toEqual(['t1', 't3']);
    expect(screen.queryByText(/얼굴이 아닐 수 있는 항목/)).toBeNull();
  });

  it('confirm=false sends nothing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const calls = setup({ tracks: suspectDoc });
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: '확인 후 모두 보임' }));
    await sleep(800);
    expect(puts(calls).length).toBe(0);
    expect(screen.getByText('얼굴이 아닐 수 있는 항목 2개')).toBeInTheDocument();
  });
});
