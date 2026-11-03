import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tracksDoc, reviewDoc } from '../lib/fixtures';
import type { Edits, Job } from '../lib/types';
import { installFetch, type Call, type Handler } from '../test/mockFetch';
import { Studio } from './Studio';

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1', filename: 'clip.mp4', createdAt: new Date().toISOString(), state: 'ready', progress: 100, error: null, hasOutput: false, outputStale: false, ...over,
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

const twoItems = {
  items: [
    { id: 'r1', type: 'gap', trackIds: ['t3'], startFrame: 30, endFrame: 45, box: [500, 50, 48, 64] },
    { id: 'r2', type: 'low_confidence', trackIds: ['t2'], startFrame: 60, endFrame: 70, box: [100, 100, 60, 60] },
  ],
};
const crossingReview = {
  items: [{ id: 'r9', type: 'crossing', trackIds: ['t1', 't2'], startFrame: 10, endFrame: 20, box: [1, 1, 2, 2] }],
};

const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/edits'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const card = (key: string) => screen.findByTestId(`card-${key}`);
const toggle = async (key: string, label: string) =>
  userEvent.click(within(await card(key)).getByRole('switch', { name: `${label} 보임 전환` }));

describe('Studio people list', () => {
  it('toggling the switch sends exactly one debounced PUT with visible updated', async () => {
    const calls = setup();
    await toggle('t1', '인물 1');
    await toggle('t3', '인물 3');
    await toggle('t3', '인물 3');
    expect(puts(calls).length).toBe(0); // debounced
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    await sleep(700);
    expect(puts(calls).length).toBe(1);
    expect((puts(calls)[0].body as Edits).visible).toEqual(['t1']);
    const row = await card('t1');
    expect(within(row).getByRole('switch', { name: '인물 1 보임 전환' })).toHaveAttribute('aria-checked', 'true');
    expect(within(row).getByText('원본')).toBeInTheDocument();
  });

  it('groups two selected rows into one group', async () => {
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

  it('해제 clears the selection without grouping', async () => {
    const calls = setup();
    await card('t1');
    await userEvent.click(screen.getByRole('checkbox', { name: '인물 1 묶기 선택' }));
    await userEvent.click(screen.getByRole('checkbox', { name: '인물 2 묶기 선택' }));
    await userEvent.click(screen.getByRole('button', { name: '해제' }));
    expect(screen.queryByText('2개 선택됨')).toBeNull();
    await sleep(700);
    expect(puts(calls).length).toBe(0);
  });

  it('renaming via the edit button sets group.label', async () => {
    const calls = setup();
    const row = await card('t2');
    await userEvent.click(within(row).getByRole('button', { name: '인물 2 이름 편집' }));
    const input = within(row).getByRole('textbox', { name: '인물 2 이름 편집' });
    await userEvent.clear(input);
    await userEvent.type(input, '진행자{Enter}');
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).groups).toEqual([{ id: 'g1', trackIds: ['t2'], label: '진행자' }]);
    expect(await card('g1')).toBeInTheDocument();
  });

  it('double-clicking the name edits it; Escape cancels and blank reverts', async () => {
    const calls = setup();
    const row = await card('t2');
    await userEvent.dblClick(within(row).getByText('인물 2'));
    let input = within(row).getByRole('textbox', { name: '인물 2 이름 편집' });
    await userEvent.type(input, '아무개{Escape}');
    expect(within(row).queryByRole('textbox')).toBeNull();
    expect(within(row).getByText('인물 2')).toBeInTheDocument();
    await userEvent.dblClick(within(row).getByText('인물 2'));
    input = within(row).getByRole('textbox', { name: '인물 2 이름 편집' });
    await userEvent.clear(input);
    await userEvent.keyboard('{Enter}');
    expect(within(row).getByText('인물 2')).toBeInTheDocument();
    await sleep(700);
    expect(puts(calls).length).toBe(0);
  });

  it('clicking a row focuses the person (timeline title)', async () => {
    setup();
    await userEvent.click(await card('t2'));
    expect(screen.getByRole('heading', { name: '인물 2 등장 구간' })).toBeInTheDocument();
  });

  it('search filters rows by label, case-insensitively', async () => {
    setup();
    await card('t1');
    await userEvent.type(screen.getByRole('searchbox', { name: '인물 검색' }), '인물 3');
    expect(screen.getByTestId('card-t3')).toBeInTheDocument();
    expect(screen.queryByTestId('card-t1')).toBeNull();
    expect(screen.queryByTestId('card-t2')).toBeNull();
  });

  it('shows 조건에 맞는 인물이 없습니다. when filters exclude everyone', async () => {
    setup();
    await card('t1');
    await userEvent.type(screen.getByRole('searchbox', { name: '인물 검색' }), 'zzz');
    expect(screen.getByText('조건에 맞는 인물이 없습니다.')).toBeInTheDocument();
  });

  it('filter chips show counts and filter by 가림/보임', async () => {
    setup();
    await card('t1');
    expect(screen.getByRole('button', { name: '전체 3' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '가림 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '보임 0' })).toBeInTheDocument();
    await toggle('t1', '인물 1');
    expect(screen.getByRole('button', { name: '가림 2' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '보임 1' }));
    expect(screen.getByRole('button', { name: '보임 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('card-t1')).toBeInTheDocument();
    expect(screen.queryByTestId('card-t2')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '가림 2' }));
    expect(screen.queryByTestId('card-t1')).toBeNull();
    expect(screen.getByTestId('card-t2')).toBeInTheDocument();
  });

  it('shows 검출된 얼굴이 없습니다 when there are no tracks', async () => {
    setup({ tracks: { ...tracksDoc, tracks: [] }, review: { items: [] } });
    expect(await screen.findByText('검출된 얼굴이 없습니다')).toBeInTheDocument();
    expect(screen.getByTestId('note')).toHaveTextContent('모든 항목 확인됨');
    expect(screen.getByText('모든 항목 확인됨', { selector: '.empty' })).toBeInTheDocument();
  });
});

describe('Studio review and render', () => {
  it('disables render until review items are resolved; 괜찮음 adds reviewed', async () => {
    const calls = setup();
    await card('t1');
    const renderBtn = screen.getByRole('button', { name: '렌더 후 다운로드' });
    expect(renderBtn).toBeDisabled();
    expect(screen.getByTestId('note')).toHaveTextContent('확인 필요 1건 · 1구간 남음');
    await userEvent.click(screen.getByRole('button', { name: /괜찮음/ }));
    expect(screen.getByTestId('note')).toHaveTextContent('모든 항목 확인됨');
    expect(renderBtn).toBeEnabled();
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).reviewed).toEqual(['r1']);
  });

  it('clicking an upcoming item seeks the video to startFrame/fps', async () => {
    // r2 sits in a later 5s window so it shows as an upcoming group row
    setup({ tracks: { ...tracksDoc, frameCount: 600 }, review: { items: [twoItems.items[0], { ...twoItems.items[1], startFrame: 300 }] } });
    await card('t1');
    await userEvent.click(screen.getByTestId('review-group-2'));
    const video = screen.getByLabelText('미리보기 영상') as HTMLVideoElement;
    expect(video.currentTime).toBeCloseTo(300 / 30);
    expect(screen.getByTestId('time')).toHaveTextContent('00:10');
    // r2 is now the active card; r1's window moved to the upcoming list
    expect(screen.getByTestId('review-r2').tagName).toBe('SECTION');
    expect(screen.getByTestId('review-group-0').tagName).toBe('BUTTON');
  });

  it('the card time range button seeks to the item start', async () => {
    setup();
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: /로 이동/ }));
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
    expect(await screen.findByText('얼굴 찾는 중 37%')).toBeInTheDocument();
    expect(screen.getByTestId('shell-left')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByTestId('dropzone')).toBeNull();
  });
});

describe('Studio required review items', () => {
  it('a crossing appears in the queue only after one of its two people is set to 보임', async () => {
    setup({ review: crossingReview });
    await card('t1');
    expect(screen.queryByTestId('review-r9')).toBeNull();
    expect(screen.getByTestId('note')).toHaveTextContent('모든 항목 확인됨');
    expect(screen.getByRole('button', { name: '렌더 후 다운로드' })).toBeEnabled();
    expect(screen.getByTestId('hidden-note')).toHaveTextContent('지금 가림 상태로는 노출 위험이 없는 항목 1개는 숨겼습니다');

    await toggle('t1', '인물 1');
    expect(await screen.findByTestId('review-r9')).toBeInTheDocument();
    expect(screen.getByTestId('note')).toHaveTextContent('확인 필요 1건 · 1구간 남음');
    expect(screen.getByRole('button', { name: '렌더 후 다운로드' })).toBeDisabled();
    expect(screen.queryByTestId('hidden-note')).toBeNull();

    await toggle('t2', '인물 2');
    await waitFor(() => expect(screen.queryByTestId('review-r9')).toBeNull());
    expect(screen.getByTestId('hidden-note')).toBeInTheDocument();
  });
});

describe('Studio group confirm', () => {
  const mixed = {
    items: [
      { id: 'g1', type: 'gap', trackIds: ['t3'], startFrame: 30, endFrame: 45, box: [500, 50, 48, 64] },
      { id: 'g2', type: 'low_confidence', trackIds: ['t2'], startFrame: 60, endFrame: 70, box: [100, 100, 60, 60] },
      { id: 'gx', type: 'crossing', trackIds: ['t1', 't2'], startFrame: 80, endFrame: 90, box: [1, 1, 2, 2] },
      { id: 'g4', type: 'gap', trackIds: ['t3'], startFrame: 400, endFrame: 410, box: [500, 50, 48, 64] },
    ],
  };
  it('Shift+Enter confirms only non-crossing items of the active window and never changes visible', async () => {
    const calls = setup({ review: mixed, edits: { ...emptyEdits, visible: ['t1'] } });
    await card('t1');
    expect(screen.getByTestId('note')).toHaveTextContent('확인 필요 4건 · 2구간 남음');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    const body = puts(calls)[0].body as Edits;
    expect(body.reviewed.sort()).toEqual(['g1', 'g2']);
    expect(body.visible).toEqual(['t1']);
    expect(screen.getByTestId('review-gx').tagName).toBe('SECTION');
    expect(screen.getByTestId('note')).toHaveTextContent('확인 필요 2건 · 2구간 남음');
  });
});

describe('Studio ReviewCard', () => {
  it('stage 1 shows type, who, range, explanation and the counter', async () => {
    setup({ review: twoItems });
    await card('t1');
    const c = screen.getByTestId('review-r1');
    expect(within(c).getByText('추적 끊김')).toBeInTheDocument();
    expect(within(c).getByText('인물 3')).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: /00:01 - 00:01/ })).toBeInTheDocument();
    expect(within(c).getByRole('heading', { level: 2 })).toHaveTextContent(/1\s*\/\s*2/);
    expect(within(c).getByRole('button', { name: /괜찮음/ })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: /문제 있음/ })).toBeInTheDocument();
  });

  it('괜찮음 marks reviewed and advances to the next item', async () => {
    const calls = setup({ review: twoItems });
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: /괜찮음/ }));
    expect(screen.getByTestId('review-r2').tagName).toBe('SECTION');
    expect(screen.queryByTestId('review-r1')).toBeNull();
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).reviewed).toEqual(['r1']);
  });

  it('뒤로 returns from stage 2 to stage 1', async () => {
    setup();
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: /문제 있음/ }));
    expect(screen.queryByRole('button', { name: /괜찮음/ })).toBeNull();
    expect(screen.getByRole('button', { name: /얼굴이 아니에요/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^← 뒤로/ }));
    expect(screen.getByRole('button', { name: /괜찮음/ })).toBeInTheDocument();
  });

  it('gap option 2 (얼굴이 아니에요) unmasks the owning person and the item leaves the queue', async () => {
    const calls = setup({ review: twoItems });
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: /문제 있음/ }));
    await userEvent.click(screen.getByRole('button', { name: /얼굴이 아니에요/ }));
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).visible).toEqual(['t3']);
    expect(screen.queryByTestId('review-r1')).toBeNull();
    expect(screen.getByTestId('review-r2').tagName).toBe('SECTION');
    expect(within(await card('t3')).getByRole('switch', { name: '인물 3 보임 전환' })).toHaveAttribute('aria-checked', 'true');
  });

  it('nothing is unmasked until the user picks 얼굴이 아니에요', async () => {
    const calls = setup();
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: /문제 있음/ }));
    await sleep(700);
    expect(puts(calls).length).toBe(0);
  });

  it('gap option 1 (얼굴이 보여요) opens the box tool', async () => {
    setup();
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: /문제 있음/ }));
    await userEvent.click(screen.getByRole('button', { name: /얼굴이 보여요/ }));
    expect(screen.getByTestId('boxtool')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '이 영역으로 추적' })).toBeEnabled(); // initial = item.box
  });

  it('gap option 3 (가림이 얼굴보다 작아요) starts from the box enlarged by 30%', async () => {
    const calls = setup({
      extra: (c) => (c.path === '/api/jobs/j1/manual' && c.method === 'POST' ? { status: 202, body: {} } : undefined),
    });
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: /문제 있음/ }));
    await userEvent.click(screen.getByRole('button', { name: /가림이 얼굴보다 작아요/ }));
    await userEvent.click(screen.getByRole('button', { name: '이 영역으로 추적' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/manual'))).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/manual'))!;
    // [500,50,48,64] grown 1.3x around its center (524,82)
    expect((post.body as { anchor: { box: number[] } }).anchor.box).toEqual([493, 40, 62, 84]);
  });

  describe('crossing', () => {
    const withT1Visible = { ...emptyEdits, visible: ['t1'] };

    it('option 1 splits both tracks, lists the pieces, and 완료 marks reviewed', async () => {
      const calls = setup({ review: crossingReview, edits: withT1Visible });
      await card('t1a').catch(() => undefined);
      const c = await screen.findByTestId('review-r9');
      expect(within(c).getByText('교차 구간')).toBeInTheDocument();
      await userEvent.click(within(c).getByRole('button', { name: /문제 있음/ }));
      expect(within(c).queryByRole('button', { name: /가림이 얼굴보다 작아요/ })).toBeNull();
      await userEvent.click(within(c).getByRole('button', { name: /두 사람이 바뀌었어요/ }));
      for (const l of ['인물 1a', '인물 1b', '인물 2a', '인물 2b']) {
        expect(within(c).getByRole('switch', { name: `${l} 보임 설정` })).toBeInTheDocument();
      }
      expect(within(c).getByRole('switch', { name: '인물 1a 보임 설정' })).toHaveAttribute('aria-checked', 'true');
      expect(within(c).getByRole('switch', { name: '인물 2a 보임 설정' })).toHaveAttribute('aria-checked', 'false');
      await userEvent.click(within(c).getByRole('button', { name: /완료/ }));
      await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
      const body = puts(calls)[0].body as Edits;
      expect(body.splits).toEqual([
        { trackId: 't1', frame: 1 },
        { trackId: 't2', frame: 1 },
      ]);
      expect(body.reviewed).toEqual(['r9']);
      expect(screen.queryByTestId('review-r9')).toBeNull();
    });

    it('the split panel stays open when toggling pieces makes the item non-required', async () => {
      const calls = setup({ review: crossingReview, edits: withT1Visible });
      const c = await screen.findByTestId('review-r9');
      await userEvent.click(within(c).getByRole('button', { name: /문제 있음/ }));
      await userEvent.click(within(c).getByRole('button', { name: /두 사람이 바뀌었어요/ }));
      await userEvent.click(within(c).getByRole('switch', { name: '인물 2a 보임 설정' }));
      await userEvent.click(within(c).getByRole('switch', { name: '인물 2b 보임 설정' }));
      const still = screen.getByTestId('review-r9');
      expect(within(still).getByRole('button', { name: /완료/ })).toBeInTheDocument();
      await userEvent.click(within(still).getByRole('button', { name: /완료/ }));
      await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
      expect((puts(calls)[0].body as Edits).reviewed).toEqual(['r9']);
    });

    it('option 3 (둘 중 하나가 얼굴이 아니에요) lists people unchanged; toggling one 보임 then 완료 PUTs visible + reviewed', async () => {
      const calls = setup({ review: crossingReview, edits: withT1Visible });
      const c = await screen.findByTestId('review-r9');
      await userEvent.click(within(c).getByRole('button', { name: /문제 있음/ }));
      await userEvent.click(within(c).getByRole('button', { name: /둘 중 하나가 얼굴이 아니에요/ }));
      expect(within(c).getByText(/보임으로 바꾼 뒤 교차 구간을 재생해/)).toBeInTheDocument();
      expect(within(c).getByRole('switch', { name: '인물 1 보임 설정' })).toHaveAttribute('aria-checked', 'true');
      expect(within(c).getByRole('switch', { name: '인물 2 보임 설정' })).toHaveAttribute('aria-checked', 'false');
      await sleep(700);
      expect(puts(calls).length).toBe(0); // nothing auto-unmasked
      await userEvent.click(within(c).getByRole('switch', { name: '인물 2 보임 설정' }));
      // item is no longer required but stays active in the notface panel
      const still = screen.getByTestId('review-r9');
      await userEvent.click(within(still).getByRole('button', { name: /완료/ }));
      await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
      const body = puts(calls)[0].body as Edits;
      expect([...body.visible].sort()).toEqual(['t1', 't2']);
      expect(body.splits).toEqual([]);
      expect(body.reviewed).toEqual(['r9']);
      expect(screen.queryByTestId('review-r9')).toBeNull();
    });

    it('keyboard 3 enters notface, Enter completes, Escape goes back to ask', async () => {
      const calls = setup({ review: crossingReview, edits: withT1Visible });
      const c = await screen.findByTestId('review-r9');
      await userEvent.keyboard('x3');
      expect(within(c).getByRole('switch', { name: '인물 2 보임 설정' })).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
      expect(within(c).getByRole('button', { name: /괜찮음/ })).toBeInTheDocument();
      await userEvent.keyboard('x3{Enter}');
      await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
      expect((puts(calls)[0].body as Edits).reviewed).toEqual(['r9']);
    });

    it('option 2 (얼굴이 보여요) opens the box tool', async () => {
      setup({ review: crossingReview, edits: withT1Visible });
      const c = await screen.findByTestId('review-r9');
      await userEvent.click(within(c).getByRole('button', { name: /문제 있음/ }));
      await userEvent.click(within(c).getByRole('button', { name: /얼굴이 보여요/ }));
      expect(screen.getByTestId('boxtool')).toBeInTheDocument();
    });
  });
});

describe('Studio seeking and playback keys', () => {
  const video = () => screen.getByLabelText('미리보기 영상') as HTMLVideoElement;
  const mockPlay = HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>;
  const mockPause = HTMLMediaElement.prototype.pause as unknown as ReturnType<typeof vi.fn>;

  it('frame-step buttons move one frame and pause', async () => {
    setup();
    await card('t1');
    mockPause.mockClear();
    await userEvent.click(screen.getByRole('button', { name: '1프레임 앞으로' }));
    expect(video().currentTime).toBeCloseTo(1 / 30);
    await userEvent.click(screen.getByRole('button', { name: '1프레임 앞으로' }));
    expect(video().currentTime).toBeCloseTo(2 / 30);
    await userEvent.click(screen.getByRole('button', { name: '1프레임 뒤로' }));
    expect(video().currentTime).toBeCloseTo(1 / 30);
    expect(mockPause).toHaveBeenCalled();
  });

  it('. and , step one frame (and never below 0)', async () => {
    setup();
    await card('t1');
    await userEvent.keyboard('..');
    expect(video().currentTime).toBeCloseTo(2 / 30);
    await userEvent.keyboard(',,,');
    expect(video().currentTime).toBeCloseTo(0);
  });

  it('Space plays a paused video and pauses a playing one', async () => {
    setup();
    await card('t1');
    mockPlay.mockClear();
    mockPause.mockClear();
    await userEvent.keyboard(' ');
    expect(mockPlay).toHaveBeenCalledTimes(1);
    Object.defineProperty(video(), 'paused', { configurable: true, value: false });
    await userEvent.keyboard(' ');
    expect(mockPause).toHaveBeenCalledTimes(1);
  });

  it('Space does nothing in the search input or in box mode, and on a focused button plays instead of clicking', async () => {
    setup();
    await card('t1');
    mockPlay.mockClear();
    const input = screen.getByRole('searchbox', { name: '인물 검색' });
    await userEvent.click(input);
    await userEvent.keyboard(' ');
    expect(mockPlay).not.toHaveBeenCalled();
    input.blur();
    screen.getByRole('button', { name: /문제 있음/ }).focus();
    await userEvent.keyboard(' ');
    expect(mockPlay).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /얼굴이 아니에요/ })).toBeNull(); // the button was not clicked
    mockPlay.mockClear();
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard('b');
    expect(screen.getByTestId('boxtool')).toBeInTheDocument();
    await userEvent.keyboard(' ');
    expect(mockPlay).not.toHaveBeenCalled();
  });
});

describe('Studio keyboard', () => {
  it('Enter resolves the active item', async () => {
    const calls = setup();
    await card('t1');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).reviewed).toEqual(['r1']);
  });

  it('X then 2 on a gap item unmasks its person', async () => {
    const calls = setup({ review: twoItems });
    await card('t1');
    await userEvent.keyboard('x');
    expect(screen.getByRole('button', { name: /얼굴이 아니에요/ })).toBeInTheDocument();
    await userEvent.keyboard('2');
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).visible).toEqual(['t3']);
    expect(screen.queryByTestId('review-r1')).toBeNull();
  });

  it('1/2/3 do nothing before X is pressed', async () => {
    const calls = setup();
    await card('t1');
    await userEvent.keyboard('2');
    await sleep(700);
    expect(puts(calls).length).toBe(0);
  });

  it('Escape goes back from stage 2', async () => {
    setup();
    await card('t1');
    await userEvent.keyboard('x');
    expect(screen.queryByRole('button', { name: /괜찮음/ })).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: /괜찮음/ })).toBeInTheDocument();
  });

  it('ArrowRight / ArrowLeft move between unresolved items', async () => {
    setup({ review: twoItems });
    await card('t1');
    expect(screen.getByTestId('review-r1').tagName).toBe('SECTION');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByTestId('review-r2').tagName).toBe('SECTION');
    expect(screen.getByTestId('time')).toHaveTextContent('00:02');
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByTestId('review-r1').tagName).toBe('SECTION');
  });

  it('B toggles the box tool and Escape cancels it', async () => {
    setup();
    await card('t1');
    await userEvent.keyboard('b');
    expect(screen.getByTestId('boxtool')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('boxtool')).toBeNull();
    await userEvent.keyboard('B');
    expect(screen.getByTestId('boxtool')).toBeInTheDocument();
  });

  it('shortcuts are ignored while the box tool is open', async () => {
    const calls = setup();
    await card('t1');
    await userEvent.keyboard('b');
    await userEvent.keyboard('{Enter}x');
    await sleep(700);
    expect(puts(calls).length).toBe(0);
    expect(screen.getByTestId('boxtool')).toBeInTheDocument();
  });

  it('keys typed into the search input do nothing', async () => {
    const calls = setup();
    await card('t1');
    const input = screen.getByRole('searchbox', { name: '인물 검색' });
    await userEvent.click(input);
    await userEvent.keyboard('xb12{Enter}{Escape}');
    expect(input).toHaveValue('xb12');
    expect(screen.getByRole('button', { name: /괜찮음/ })).toBeInTheDocument();
    expect(screen.queryByTestId('boxtool')).toBeNull();
    await sleep(700);
    expect(puts(calls).length).toBe(0);
  });

  it('keys typed into the rename input do nothing', async () => {
    const calls = setup();
    const row = await card('t2');
    await userEvent.click(within(row).getByRole('button', { name: '인물 2 이름 편집' }));
    await userEvent.keyboard('x{Enter}');
    expect(screen.getByRole('button', { name: /괜찮음/ })).toBeInTheDocument();
    await sleep(700);
    expect(puts(calls).every((c) => (c.body as Edits).reviewed.length === 0)).toBe(true);
  });

  it('modifier combos are ignored', async () => {
    const calls = setup();
    await card('t1');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await sleep(700);
    expect(puts(calls).length).toBe(0);
  });
});

describe('Studio split and manual box', () => {
  it('여기서 분할 adds a split and the person becomes two rows', async () => {
    const calls = setup();
    await card('t1');
    await userEvent.click(within(await card('t1')).getByRole('button', { name: '인물 1 등장 구간 보기' }));
    expect(screen.getByRole('button', { name: '여기서 분할' })).toBeDisabled(); // frame 0 = track start
    await userEvent.click(screen.getByRole('button', { name: /로 이동/ })); // seek to frame 30
    await userEvent.click(screen.getByRole('button', { name: '여기서 분할' }));
    expect(await screen.findByTestId('card-t1a')).toBeInTheDocument();
    expect(screen.getByTestId('card-t1b')).toBeInTheDocument();
    expect(screen.queryByTestId('card-t1')).toBeNull();
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).splits).toEqual([{ trackId: 't1', frame: 30 }]);
  });

  it('얼굴이 보여요 -> POST /manual -> 추적 중 -> polls to done and marks the item reviewed', async () => {
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
    await userEvent.click(screen.getByRole('button', { name: /문제 있음/ }));
    await userEvent.click(screen.getByRole('button', { name: /얼굴이 보여요/ }));
    expect(screen.getByTestId('boxtool')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '이 영역으로 추적' }));

    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/manual'))!;
    await waitFor(() => expect(post).toBeDefined());
    expect(post.body).toEqual({ manualId: 'm1', anchor: { frame: 30, box: [500, 50, 48, 64] }, otherAnchors: [] });
    expect(within(screen.getByTestId('review-r1')).getByText(/추적 중/)).toBeInTheDocument();
    expect(within(screen.getByTestId('review-r1')).queryByRole('button', { name: /괜찮음/ })).toBeNull();
    expect(screen.getByTestId('manual-chip')).toHaveTextContent('추적 중');
    expect(screen.getByRole('button', { name: '렌더 후 다운로드' })).toBeDisabled();

    await waitFor(() => expect(screen.getByTestId('note')).toHaveTextContent('모든 항목 확인됨'), { timeout: 5000 });
    expect(screen.getByTestId('manual-chip')).toHaveTextContent('수동 영역 m1');
    expect(screen.getByTestId('manual-chip')).not.toHaveTextContent('추적 중');
    await waitFor(() => {
      const last = puts(calls).at(-1)!.body as Edits;
      expect(last.reviewed).toEqual(['r1']);
      expect(last.manual).toEqual([{ id: 'm1', anchors: [{ frame: 30, box: [500, 50, 48, 64] }], trim: null, deleted: false }]);
    });
  }, 12000);

  it('shows 추적 실패 on the card when tracking failed', async () => {
    setup({
      extra: (c) => {
        if (c.path === '/api/jobs/j1/manual' && c.method === 'POST') return { status: 500, body: { message: '추적 서버 오류' } };
        return undefined;
      },
    });
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: /문제 있음/ }));
    await userEvent.click(screen.getByRole('button', { name: /얼굴이 보여요/ }));
    await userEvent.click(screen.getByRole('button', { name: '이 영역으로 추적' }));
    expect(await screen.findByText('추적 실패 · 기준 프레임만 가려짐')).toBeInTheDocument();
  });

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

describe('Studio ManualBoxCard', () => {
  const m1Edits: Edits = {
    ...emptyEdits,
    reviewed: ['r1'],
    manual: [{ id: 'm1', anchors: [{ frame: 10, box: [1, 2, 30, 40] }], trim: null, deleted: false }],
  };
  const withManual = (extra?: Handler) =>
    setup({
      edits: m1Edits,
      extra: (c) => {
        if (c.path === '/api/jobs/j1/manual/m1')
          return {
            body: {
              state: 'done',
              result: { id: 'm1', frames: { '10': [1, 2, 30, 40], '20': [1, 2, 30, 40], '30': [5, 6, 30, 40] }, segments: [[10, 30]] },
            },
          };
        if (c.path === '/api/jobs/j1/manual' && c.method === 'POST') return { status: 202, body: {} };
        return extra?.(c);
      },
    });
  const openChip = async () => {
    await userEvent.click(await screen.findByRole('button', { name: /수동 영역 m1/ }));
    return screen.getByTestId('manual-card-m1');
  };

  it('clicking the chip opens the card (replacing the review card), seeks to the first frame, and shows the range', async () => {
    withManual();
    const c = await openChip();
    expect(screen.queryByRole('button', { name: /괜찮음/ })).toBeNull();
    expect(within(c).getByTestId('manual-range')).toHaveTextContent('00:00 - 00:01 (10-30f)');
    expect((screen.getByLabelText('미리보기 영상') as HTMLVideoElement).currentTime).toBeCloseTo(10 / 30);
    await userEvent.click(within(c).getByRole('button', { name: /닫기/ }));
    expect(screen.queryByTestId('manual-card-m1')).toBeNull();
  });

  it('Escape closes the card', async () => {
    withManual();
    await openChip();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('manual-card-m1')).toBeNull();
  });

  it('여기부터 / 자르기 해제 update trim in the PUT', async () => {
    const calls = withManual();
    const c = await openChip();
    await userEvent.click(within(c).getByRole('button', { name: '여기부터' }));
    expect(within(c).getByTestId('manual-range')).toHaveTextContent('(10-30f)');
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).manual[0].trim).toEqual([10, 30]);
    await userEvent.click(within(c).getByRole('button', { name: '자르기 해제' }));
    await waitFor(() => expect(puts(calls).length).toBe(2), { timeout: 2000 });
    expect((puts(calls)[1].body as Edits).manual[0].trim).toBeNull();
  });

  it('여기까지 sets the trim end to the current frame', async () => {
    const calls = withManual();
    const c = await openChip();
    await userEvent.click(screen.getByRole('button', { name: '확인 완료 00:01' })); // seek to frame 30
    await userEvent.click(within(c).getByRole('button', { name: '여기까지' }));
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).manual[0].trim).toEqual([10, 30]);
  });

  it('삭제 with confirm=true sets deleted and closes the card', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const calls = withManual();
    const c = await openChip();
    await userEvent.click(within(c).getByRole('button', { name: /삭제/ }));
    expect(confirm).toHaveBeenCalledWith('수동 영역 m1을 삭제할까요?');
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).manual[0].deleted).toBe(true);
    expect(screen.queryByTestId('manual-card-m1')).toBeNull();
    expect(screen.queryByTestId('manual-chip')).toBeNull();
    vi.restoreAllMocks();
  });

  it('삭제 with confirm=false changes nothing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const calls = withManual();
    const c = await openChip();
    await userEvent.click(within(c).getByRole('button', { name: /삭제/ }));
    await sleep(700);
    expect(puts(calls).length).toBe(0);
    expect(screen.getByTestId('manual-card-m1')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('다시 그리기 + drawing posts /manual with manualId m1 and the other anchor frames', async () => {
    const calls = withManual();
    const c = await openChip();
    await userEvent.click(screen.getByRole('button', { name: '확인 완료 00:01' })); // seek to frame 30 (doc has a box there)
    await userEvent.click(within(c).getByRole('button', { name: /다시 그리기/ }));
    expect(screen.getByTestId('boxtool')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '이 영역으로 추적' }));
    await waitFor(() => expect(calls.some((x) => x.method === 'POST' && x.path.endsWith('/manual'))).toBe(true));
    const post = calls.find((x) => x.method === 'POST' && x.path.endsWith('/manual'))!;
    expect(post.body).toEqual({ manualId: 'm1', anchor: { frame: 30, box: [5, 6, 30, 40] }, otherAnchors: [10] });
    await waitFor(() => {
      const last = puts(calls).at(-1)!.body as Edits;
      expect(last.manual[0].anchors.map((a) => a.frame)).toEqual([10, 30]);
    });
    expect(screen.getByTestId('manual-chip')).toHaveTextContent('추적 중');
  });
});

describe('Studio suspect tracks', () => {
  const suspectDoc = {
    ...tracksDoc,
    tracks: tracksDoc.tracks.map((t) => (t.id === 't1' || t.id === 't3' ? { ...t, suspect: true } : t)),
  };
  afterEach(() => vi.restoreAllMocks());

  it('keeps suspects in a collapsed group that expands to rows with a badge', async () => {
    setup({ tracks: suspectDoc });
    await card('t2');
    expect(screen.queryByTestId('card-t1')).toBeNull();
    const toggleBtn = screen.getByRole('button', { name: /얼굴 아닐 수 있음 2/ });
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/음식, 무늬 등 얼굴이 아닌 것을/)).toBeNull();
    await userEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/음식, 무늬 등 얼굴이 아닌 것을 잘못 찾았을 수 있습니다. 가려진 채로 시작합니다./)).toBeInTheDocument();
    expect(within(await card('t1')).getByText('얼굴 아닐 수 있음')).toBeInTheDocument();
    expect(within(await card('t3')).getByText('얼굴 아닐 수 있음')).toBeInTheDocument();
    expect(within(await card('t2')).queryByText('얼굴 아닐 수 있음')).toBeNull();
  });

  it('confirm=true shows all suspects via one debounced PUT', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const calls = setup({ tracks: suspectDoc });
    await card('t2');
    await userEvent.click(screen.getByRole('button', { name: '확인 후 모두 보임' }));
    expect(confirm).toHaveBeenCalledWith(
      '얼굴 아닐 수 있음으로 표시된 2개를 모두 보이게 합니다. 썸네일을 확인하셨나요?',
    );
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    await sleep(700);
    expect(puts(calls).length).toBe(1);
    expect([...(puts(calls)[0].body as Edits).visible].sort()).toEqual(['t1', 't3']);
    expect(screen.queryByRole('button', { name: '확인 후 모두 보임' })).toBeNull();
  });

  it('confirm=false sends nothing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const calls = setup({ tracks: suspectDoc });
    await card('t2');
    await userEvent.click(screen.getByRole('button', { name: '확인 후 모두 보임' }));
    await sleep(800);
    expect(puts(calls).length).toBe(0);
    expect(screen.getByRole('button', { name: '확인 후 모두 보임' })).toBeInTheDocument();
  });
});

describe('Studio undo / redo', () => {
  const undoBtn = () => screen.getByRole('button', { name: '되돌리기' });
  const redoBtn = () => screen.getByRole('button', { name: '다시하기' });
  const switchOf = async (key: string, label: string) =>
    within(await card(key)).getByRole('switch', { name: `${label} 보임 전환` });

  it('starts disabled; 되돌리기 restores a toggled person and saves it; 다시하기 reapplies', async () => {
    const calls = setup();
    await card('t1');
    expect(undoBtn()).toBeDisabled();
    expect(redoBtn()).toBeDisabled();
    await toggle('t1', '인물 1');
    expect(await switchOf('t1', '인물 1')).toHaveAttribute('aria-checked', 'true');
    expect(undoBtn()).toBeEnabled();
    await userEvent.click(undoBtn());
    expect(await switchOf('t1', '인물 1')).toHaveAttribute('aria-checked', 'false');
    expect(undoBtn()).toBeDisabled();
    expect(redoBtn()).toBeEnabled();
    await userEvent.click(redoBtn());
    expect(await switchOf('t1', '인물 1')).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(undoBtn());
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).visible).toEqual([]);
  });

  it('Ctrl+Z undoes and Ctrl+Shift+Z redoes; ignored while typing', async () => {
    setup();
    await card('t1');
    await toggle('t1', '인물 1');
    const input = screen.getByRole('searchbox', { name: '인물 검색' });
    await userEvent.click(input);
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(await switchOf('t1', '인물 1')).toHaveAttribute('aria-checked', 'true'); // typing: not undone
    input.blur();
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(await switchOf('t1', '인물 1')).toHaveAttribute('aria-checked', 'false');
    await userEvent.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    expect(await switchOf('t1', '인물 1')).toHaveAttribute('aria-checked', 'true');
  });

  it('loading the saved edits is not an undo step', async () => {
    setup({ edits: { ...emptyEdits, visible: ['t1'] } });
    await card('t1');
    expect(undoBtn()).toBeDisabled();
  });

  it('undoing a manual box creation keeps the entry as deleted:true in the PUT', async () => {
    const calls = setup({
      extra: (c) => (c.path === '/api/jobs/j1/manual' && c.method === 'POST' ? { status: 202, body: {} } : undefined),
    });
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: /문제 있음/ }));
    await userEvent.click(screen.getByRole('button', { name: /얼굴이 보여요/ }));
    await userEvent.click(screen.getByRole('button', { name: '이 영역으로 추적' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/manual'))).toBe(true));
    await userEvent.click(undoBtn());
    await waitFor(() => {
      const last = puts(calls).at(-1)!.body as Edits;
      expect(last.manual).toEqual([expect.objectContaining({ id: 'm1', deleted: true })]);
    });
  });

  it('announces a person that undo turns back to 보임', async () => {
    setup({ edits: { ...emptyEdits, visible: ['t1'] } });
    await card('t1');
    await toggle('t1', '인물 1'); // 가림
    await userEvent.click(undoBtn());
    expect(document.querySelector('.sr[aria-live]')).toHaveTextContent('인물 1 보임으로 되돌림');
  });
});

describe('Studio right column', () => {
  it('focusing a person shows the detail panel; effect click masks with an override; 원본 · 가림 해제 uncovers; × clears focus', async () => {
    const calls = setup();
    await userEvent.click(await card('t2'));
    const detail = await screen.findByTestId('target-detail');
    await userEvent.click(within(detail).getByRole('button', { name: '원본 · 가림 해제' }));
    expect(within(detail).getByText(/이 대상은 원본으로 보입니다/)).toBeInTheDocument();
    expect(within(await card('t2')).getByRole('switch', { name: '인물 2 보임 전환' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(detail).getByRole('button', { name: '블러' }));
    expect(within(await card('t2')).getByRole('switch', { name: '인물 2 보임 전환' })).toHaveAttribute('aria-checked', 'false');
    expect(within(await card('t2')).getByTestId('rtag-t2')).toHaveTextContent('블러');
    await waitFor(() => expect(puts(calls).length).toBe(1), { timeout: 2000 });
    expect((puts(calls)[0].body as Edits).effects!.overrides.t2).toEqual({ type: 'blur', strength: 1, color: '#000000' });
    await userEvent.click(within(detail).getByRole('button', { name: '선택 해제' }));
    expect(screen.queryByTestId('target-detail')).toBeNull();
  });

  it('the toolbar chip shows the real effect: 원본 when visible, otherwise the effect name', async () => {
    setup();
    await userEvent.click(await card('t2'));
    const detail = await screen.findByTestId('target-detail');
    const chip = () => document.querySelector('.tchip.fx')!;
    expect(chip()).toHaveTextContent('블러');
    await userEvent.click(within(detail).getByRole('button', { name: '모자이크' }));
    expect(chip()).toHaveTextContent('모자이크');
    await userEvent.click(within(detail).getByRole('button', { name: '원본 · 가림 해제' }));
    expect(chip()).toHaveTextContent('원본');
    expect(chip().className).toContain('v');
  });

  it('left panel: auto blur switch is on and disabled; 사각형 is the box tool', async () => {
    setup();
    await card('t1');
    const sw = screen.getByRole('switch', { name: '자동 가림 켜짐' });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: '박스 그리기' })).toHaveTextContent('사각형');
  });
});

describe('Studio save-gated render', () => {
  const deferred = () => {
    let resolve!: () => void;
    let reject!: () => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const renders = (calls: Call[]) => calls.filter((c) => c.path === '/api/jobs/j1/render');
  const resolved = { ...emptyEdits, reviewed: ['r1'] };

  it('render waits for in-flight save', async () => {
    const d = deferred();
    const calls = setup({
      edits: resolved,
      extra: (c) => {
        if (c.path === '/api/jobs/j1/edits' && c.method === 'PUT') return { body: {}, wait: d.promise };
        if (c.path === '/api/jobs/j1/render') return { status: 202, body: {} };
        return undefined;
      },
    });
    await toggle('t1', '인물 1');
    await userEvent.click(screen.getByRole('button', { name: '렌더 후 다운로드' }));
    expect(await screen.findByText('저장 중…')).toBeInTheDocument();
    await sleep(100);
    expect(renders(calls).length).toBe(0);
    d.resolve();
    await waitFor(() => expect(renders(calls).length).toBe(1));
  });

  it('render not requested when save fails', async () => {
    const calls = setup({
      edits: resolved,
      extra: (c) =>
        c.path === '/api/jobs/j1/edits' && c.method === 'PUT' ? { status: 500, body: { message: '서버 오류' } } : undefined,
    });
    await toggle('t1', '인물 1');
    await userEvent.click(screen.getByRole('button', { name: '렌더 후 다운로드' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('저장하지 못해 렌더를 시작하지 않았습니다.');
    expect(renders(calls).length).toBe(0);
  });

  it('edit during save is saved before render', async () => {
    const d = deferred();
    let n = 0;
    const calls = setup({
      edits: resolved,
      extra: (c) => {
        if (c.path === '/api/jobs/j1/edits' && c.method === 'PUT') return ++n === 1 ? { body: {}, wait: d.promise } : { body: {} };
        if (c.path === '/api/jobs/j1/render') return { status: 202, body: {} };
        return undefined;
      },
    });
    await toggle('t1', '인물 1');
    await userEvent.click(screen.getByRole('button', { name: '렌더 후 다운로드' }));
    await waitFor(() => expect(puts(calls).length).toBe(1));
    await toggle('t3', '인물 3'); // edit while the first save is in flight
    d.resolve();
    await waitFor(() => expect(renders(calls).length).toBe(1));
    expect(puts(calls).length).toBe(2);
    expect((puts(calls)[1].body as Edits).visible).toContain('t3');
    // the render request came after the second save
    expect(calls.indexOf(renders(calls)[0])).toBeGreaterThan(calls.indexOf(puts(calls)[1]));
  });

  it('Space on a focused effect button does not toggle playback', async () => {
    setup();
    await userEvent.click(await card('t2'));
    const detail = await screen.findByTestId('target-detail');
    const btn = within(detail).getByRole('button', { name: '블러' });
    btn.focus();
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('Escape with focus on an effect button still goes back from stage 2', async () => {
    setup();
    await userEvent.click(await card('t1'));
    await userEvent.keyboard('x');
    expect(screen.queryByRole('button', { name: /괜찮음/ })).toBeNull();
    const btn = within(await screen.findByTestId('target-detail')).getByRole('button', { name: '블러' });
    btn.focus();
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(await screen.findByRole('button', { name: /괜찮음/ })).toBeInTheDocument();
  });

  it('save fails once: the render click shows the error and sends no POST; the next click saves the latest edits and renders once', async () => {
    let n = 0;
    const calls = setup({
      edits: resolved,
      extra: (c) => {
        if (c.path === '/api/jobs/j1/edits' && c.method === 'PUT') return ++n === 1 ? { status: 500, body: { message: '서버 오류' } } : { body: {} };
        if (c.path === '/api/jobs/j1/render') return { status: 202, body: {} };
        return undefined;
      },
    });
    await toggle('t1', '인물 1');
    await userEvent.click(screen.getByRole('button', { name: '렌더 후 다운로드' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('저장하지 못해 렌더를 시작하지 않았습니다.');
    expect(renders(calls).length).toBe(0);
    await toggle('t3', '인물 3');
    await userEvent.click(screen.getByRole('button', { name: '렌더 후 다운로드' }));
    await waitFor(() => expect(renders(calls).length).toBe(1));
    const last = puts(calls)[puts(calls).length - 1].body as Edits;
    expect(last.visible).toEqual(expect.arrayContaining(['t1', 't3']));
    expect(calls.indexOf(renders(calls)[0])).toBeGreaterThan(calls.indexOf(puts(calls)[puts(calls).length - 1]));
    await sleep(100);
    expect(renders(calls).length).toBe(1);
  });

  it('unmounting with an unsaved edit sends the final save through the save chain', async () => {
    const calls = setup({ edits: resolved });
    await toggle('t1', '인물 1');
    cleanup();
    await waitFor(() => expect(puts(calls).length).toBe(1));
    expect((puts(calls)[0].body as Edits).visible).toEqual(['t1']);
    await sleep(700);
    expect(puts(calls).length).toBe(1); // the cleared debounce timer does not save again
  });

  it('two consecutive failing saves send no POST /render and the error stays', async () => {
    const calls = setup({
      edits: resolved,
      extra: (c) =>
        c.path === '/api/jobs/j1/edits' && c.method === 'PUT' ? { status: 500, body: { message: '서버 오류' } } : undefined,
    });
    await toggle('t1', '인물 1');
    await userEvent.click(screen.getByRole('button', { name: '렌더 후 다운로드' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('저장하지 못해');
    await userEvent.click(screen.getByRole('button', { name: '렌더 후 다운로드' }));
    await waitFor(() => expect(puts(calls).length).toBeGreaterThanOrEqual(2));
    await sleep(100);
    expect(renders(calls).length).toBe(0);
    expect(screen.getByRole('alert')).toHaveTextContent('저장하지 못해');
  });

  it('an edit made while rendering does not offer the stale output and tells the user to render again', async () => {
    let requested = false;
    setup({
      edits: resolved,
      extra: (c) => {
        if (c.path === '/api/jobs/j1/render') {
          requested = true;
          return { status: 202, body: {} };
        }
        if (c.path === '/api/jobs/j1' && c.method === 'GET' && requested) return { body: job({ state: 'rendered', hasOutput: true }) };
        return undefined;
      },
    });
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: '렌더 후 다운로드' }));
    expect(await screen.findByText('렌더 중')).toBeInTheDocument();
    await toggle('t3', '인물 3'); // edit during rendering
    await waitFor(() => expect(document.querySelector('.sr[aria-live]')).toHaveTextContent('렌더 후 편집이 바뀌었습니다. 다시 렌더하세요.'), { timeout: 6000 });
    expect(screen.queryByRole('link', { name: '다운로드' })).toBeNull();
  }, 10000);

  it('after a reload, a render that predates the saved edits is not offered and the notice shows', async () => {
    setup({ edits: resolved, job: job({ state: 'rendered', hasOutput: false, outputStale: true }) });
    await card('t1');
    await waitFor(() => expect(document.querySelector('.sr[aria-live]')).toHaveTextContent('렌더 후 편집이 바뀌었습니다. 다시 렌더하세요.'));
    expect(screen.queryByRole('link', { name: '다운로드' })).toBeNull();
    expect(screen.getByRole('button', { name: '렌더 후 다운로드' })).toBeInTheDocument();
  });

  it('after a reload, a render matching the saved edits is offered for download', async () => {
    setup({ edits: resolved, job: job({ state: 'rendered', hasOutput: true }) });
    await card('t1');
    expect(await screen.findByRole('link', { name: '다운로드' })).toBeInTheDocument();
  });

  it('a render that finishes stale on the server is not offered even if nothing changed locally', async () => {
    let requested = false;
    setup({
      edits: resolved,
      extra: (c) => {
        if (c.path === '/api/jobs/j1/render') { requested = true; return { status: 202, body: {} }; }
        if (c.path === '/api/jobs/j1' && c.method === 'GET' && requested) return { body: job({ state: 'rendered', hasOutput: false, outputStale: true }) };
        return undefined;
      },
    });
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: '렌더 후 다운로드' }));
    await waitFor(() => expect(document.querySelector('.sr[aria-live]')).toHaveTextContent('렌더 후 편집이 바뀌었습니다. 다시 렌더하세요.'), { timeout: 6000 });
    expect(screen.queryByRole('link', { name: '다운로드' })).toBeNull();
  }, 10000);
});

describe('Studio mask picker', () => {
  it('X on a picked ungrouped piece unmasks it in one undo step and undo restores it', async () => {
    setup();
    await card('t1');
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const orig = [Object.getOwnPropertyDescriptor(proto, 'clientWidth'), Object.getOwnPropertyDescriptor(proto, 'clientHeight')];
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 360 });
    try {
      fireEvent(window, new Event('resize'));
      const layer = await screen.findByTestId('maskpicker');
      layer.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, x: 0, y: 0, toJSON: () => ({}) });
      fireEvent.click(layer, { clientX: 120, clientY: 120 });
      expect(await screen.findByTestId('unmask-x')).toBeInTheDocument();
      const sw = () => within(screen.getByTestId('card-t1')).getByRole('switch', { name: '인물 1 보임 전환' });
      expect(sw()).toHaveAttribute('aria-checked', 'false');
      await userEvent.click(screen.getByTestId('unmask-x'));
      expect(sw()).toHaveAttribute('aria-checked', 'true');
      expect(screen.queryByTestId('unmask-x')).toBeNull();
      expect(screen.getByText('가림을 해제했습니다 · Ctrl+Z로 되돌리기')).toBeInTheDocument();
      await userEvent.keyboard('{Control>}z{/Control}');
      expect(sw()).toHaveAttribute('aria-checked', 'false');
    } finally {
      if (orig[0]) Object.defineProperty(proto, 'clientWidth', orig[0]);
      else delete proto.clientWidth;
      if (orig[1]) Object.defineProperty(proto, 'clientHeight', orig[1]);
      else delete proto.clientHeight;
    }
  });
});

describe('Studio canvas selection reveals the list row', () => {
  const stubSize = () => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const orig = [Object.getOwnPropertyDescriptor(proto, 'clientWidth'), Object.getOwnPropertyDescriptor(proto, 'clientHeight')];
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 640 });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 360 });
    return () => {
      if (orig[0]) Object.defineProperty(proto, 'clientWidth', orig[0]);
      else delete proto.clientWidth;
      if (orig[1]) Object.defineProperty(proto, 'clientHeight', orig[1]);
      else delete proto.clientHeight;
    };
  };
  const layerOf = async () => {
    fireEvent(window, new Event('resize'));
    const layer = await screen.findByTestId('maskpicker');
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, x: 0, y: 0, toJSON: () => ({}) });
    return layer;
  };
  const scroll = vi.fn();
  const origScroll = Element.prototype.scrollIntoView;
  afterEach(() => {
    Element.prototype.scrollIntoView = origScroll;
  });

  it('clicking a masked region marks its row current, scrolls it, and shows its detail card', async () => {
    scroll.mockReset();
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) {
      scroll(this, arg);
    } as never;
    setup();
    await card('t1');
    const restore = stubSize();
    try {
      const layer = await layerOf();
      fireEvent.click(layer, { clientX: 120, clientY: 120 });
      await waitFor(() => expect(screen.getByTestId('card-t1')).toHaveClass('current'));
      expect(scroll).toHaveBeenCalledWith(screen.getByTestId('card-t1'), { block: 'nearest' });
      expect(within(screen.getByTestId('card-t1')).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByRole('button', { name: /로 이동/ })).toBeInTheDocument(); // TargetDetail is open
    } finally {
      restore();
    }
  });

  it('clicking a drawn region opens its card and scrolls its row', async () => {
    scroll.mockReset();
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) {
      scroll(this, arg);
    } as never;
    setup({
      edits: { ...emptyEdits, manual: [{ id: 'm1', anchors: [{ frame: 0, box: [400, 250, 60, 60] }], trim: null, deleted: false }] },
    });
    await card('t1');
    const restore = stubSize();
    try {
      const layer = await layerOf();
      fireEvent.click(layer, { clientX: 420, clientY: 270 });
      expect(await screen.findByTestId('manual-card-m1')).toBeInTheDocument();
      expect(scroll).toHaveBeenCalledWith(screen.getByTestId('mrow-m1'), { block: 'nearest' });
    } finally {
      restore();
    }
  });
});

describe('Studio re-analyze', () => {
  it('opens a confirmation dialog; 취소 does nothing', async () => {
    const calls = setup();
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: '다시 분석' }));
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).getByText('다시 분석할까요')).toBeInTheDocument();
    expect(within(dlg).getByText(/최신 검출 기준으로 처음부터 다시 분석합니다/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/reanalyze'))).toBe(false);
    expect(screen.getByTestId('card-t1')).toBeInTheDocument();
  });

  it('confirm flushes pending edits, then reanalyzes and shows the waiting shell, then reloads', async () => {
    let requested = false;
    let polls = 0;
    const calls = setup({
      extra: (c) => {
        if (c.path === '/api/jobs/j1/reanalyze') {
          requested = true;
          return { status: 202, body: { ok: true } };
        }
        if (c.path === '/api/jobs/j1' && c.method === 'GET' && requested) {
          polls++;
          return { body: job(polls < 2 ? { state: 'analyzing', progress: 40 } : {}) };
        }
        return undefined;
      },
    });
    await toggle('t1', '인물 1');
    await userEvent.click(screen.getByRole('button', { name: '다시 분석' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '다시 분석' }));
    expect(await screen.findByText(/얼굴 찾는 중|대기 중/)).toBeInTheDocument();
    expect(screen.queryByTestId('card-t1')).toBeNull();
    const order = calls.filter((c) => (c.method === 'PUT' && c.path.endsWith('/edits')) || c.path.endsWith('/reanalyze'));
    expect(order.map((c) => c.method + ' ' + c.path)).toEqual(['PUT /api/jobs/j1/edits', 'POST /api/jobs/j1/reanalyze']);
    expect(await screen.findByTestId('card-t1', {}, { timeout: 6000 })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/api/jobs/j1/tracks').length).toBe(2);
  }, 10000);

  it('does not reanalyze when saving edits fails', async () => {
    const calls = setup({
      extra: (c) => (c.path === '/api/jobs/j1/edits' && c.method === 'PUT' ? { status: 400, body: { message: '저장 오류' } } : undefined),
    });
    await toggle('t1', '인물 1');
    await userEvent.click(screen.getByRole('button', { name: '다시 분석' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '다시 분석' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('저장하지 못해');
    expect(calls.some((c) => c.path.endsWith('/reanalyze'))).toBe(false);
    expect(screen.getByTestId('card-t1')).toBeInTheDocument();
  });

  it('shows the 409 message and keeps the studio', async () => {
    setup({
      extra: (c) =>
        c.path === '/api/jobs/j1/reanalyze' ? { status: 409, body: { message: '분석이나 렌더가 진행 중입니다.' } } : undefined,
    });
    await card('t1');
    await userEvent.click(screen.getByRole('button', { name: '다시 분석' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '다시 분석' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('분석이나 렌더가 진행 중입니다.');
    expect(screen.getByTestId('card-t1')).toBeInTheDocument();
  });
});
