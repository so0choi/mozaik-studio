import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Person } from '../lib/types';
import { TargetList, type RevealKey } from './TargetList';

const person = (key: string, over: Partial<Person> = {}): Person => ({
  key, label: `인물 ${key}`, trackIds: [key], visible: false, thumb: `${key}.jpg`, samples: [], fragmentCount: 1,
  appearSec: 3, segments: [[0, 3]], isGroup: false, suspect: false, nonface: false, faceSide: 50, ...over,
});

const base = (people: Person[], over: Partial<React.ComponentProps<typeof TargetList>> = {}) => (
  <TargetList
    people={people}
    selected={new Set()}
    currentKey={null}
    thumbSrc={(p) => p}
    effectOf={() => ({ effect: { type: 'blur' } as never, own: false })}
    onToggleVisible={() => undefined}
    onToggleSelect={() => undefined}
    onFocusPerson={() => undefined}
    onMerge={() => undefined}
    onCancelSelect={() => undefined}
    onRename={() => undefined}
    onShowSuspects={() => undefined}
    manualList={[]}
    manualState={{}}
    manualOpen={null}
    onOpenManual={() => undefined}
    {...over}
  />
);

describe('TargetList reveal', () => {
  const scroll = vi.fn();
  let orig: unknown;
  beforeEach(() => {
    scroll.mockReset();
    orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, arg?: unknown) {
      scroll(this, arg);
    } as never;
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = orig as never;
    cleanup();
  });

  const people = [person('a'), person('b', { visible: true }), person('s', { suspect: true })];
  const rk = (key: string, nonce = 1, kind: RevealKey['kind'] = 'person'): RevealKey => ({ key, kind, nonce });

  it('does not scroll without revealKey', () => {
    render(base(people, { currentKey: 'a' }));
    expect(scroll).not.toHaveBeenCalled();
  });

  it('resets the shown filter and scrolls a hidden-by-filter row', async () => {
    const { rerender } = render(base(people));
    await userEvent.click(screen.getByRole('button', { name: /^보임/ }));
    expect(screen.queryByTestId('card-a')).toBeNull();
    rerender(base(people, { currentKey: 'a', revealKey: rk('a') }));
    const row = screen.getByTestId('card-a');
    expect(screen.getByRole('button', { name: /^전체/ })).toHaveAttribute('aria-pressed', 'true');
    expect(scroll).toHaveBeenCalledWith(row, { block: 'nearest' });
    expect(row).toHaveClass('current');
    expect(within(row).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
  });

  it('clears the search text when it hides the row', async () => {
    const { rerender } = render(base(people));
    await userEvent.type(screen.getByRole('searchbox', { name: '인물 검색' }), 'zzz');
    expect(screen.queryByTestId('card-a')).toBeNull();
    rerender(base(people, { currentKey: 'a', revealKey: rk('a') }));
    expect(screen.getByRole('searchbox', { name: '인물 검색' })).toHaveValue('');
    expect(scroll).toHaveBeenCalledWith(screen.getByTestId('card-a'), { block: 'nearest' });
  });

  it('expands the collapsed suspect group', () => {
    const { rerender } = render(base(people));
    expect(screen.queryByTestId('card-s')).toBeNull();
    rerender(base(people, { currentKey: 's', revealKey: rk('s') }));
    const row = screen.getByTestId('card-s');
    expect(row).toHaveClass('current');
    expect(scroll).toHaveBeenCalledWith(row, { block: 'nearest' });
  });

  it('expands a collapsed 자동 가림 group', async () => {
    const { rerender } = render(base(people));
    await userEvent.click(screen.getByRole('button', { name: /자동 가림/ }));
    expect(screen.queryByTestId('card-a')).toBeNull();
    rerender(base(people, { currentKey: 'a', revealKey: rk('a') }));
    expect(scroll).toHaveBeenCalledWith(screen.getByTestId('card-a'), { block: 'nearest' });
  });

  it('scrolls a manual row into view and expands its group', async () => {
    const manualList = [{ id: 'm1', anchors: [{ frame: 0, box: [0, 0, 1, 1] as [number, number, number, number] }], trim: null, deleted: false }];
    const { rerender } = render(base(people, { manualList }));
    await userEvent.click(screen.getByRole('button', { name: /직접 가림/ }));
    expect(screen.queryByTestId('mrow-m1')).toBeNull();
    rerender(base(people, { manualList, manualOpen: 'm1', revealKey: rk('m1', 1, 'manual') }));
    expect(scroll).toHaveBeenCalledWith(screen.getByTestId('mrow-m1'), { block: 'nearest' });
  });

  it('clicking inside the list does not scroll', async () => {
    render(base(people));
    await userEvent.click(screen.getByTestId('card-a'));
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe('TargetList suspect tiles', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  // s1/s3 are nonface; s2 is a plain suspect (unchecked by default)
  const people = [
    person('a'),
    person('s1', { suspect: true, nonface: true, faceSide: 20 }),
    person('s2', { suspect: true, faceSide: 90 }),
    person('s3', { suspect: true, nonface: true, faceSide: 60 }),
    person('s4', { suspect: true, faceSide: 30 }),
    person('sv', { suspect: true, visible: true, nonface: true }),
  ];
  const open = async () => userEvent.click(screen.getByRole('button', { name: /얼굴 아닐 수 있음/ }));
  const ck = (key: string) => within(screen.getByTestId(`card-${key}`)).getByRole('checkbox');
  const tileKeys = () => screen.getAllByTestId(/^card-s/).map((e) => e.getAttribute('data-testid'));

  it('checks only nonface tiles by default; the auto group keeps rows', async () => {
    render(base(people));
    await open();
    expect(ck('s1')).toHaveAttribute('aria-checked', 'true');
    expect(ck('s3')).toHaveAttribute('aria-checked', 'true');
    expect(ck('s2')).toHaveAttribute('aria-checked', 'false');
    expect(ck('s4')).toHaveAttribute('aria-checked', 'false');
    expect(ck('s1')).toHaveAccessibleName('인물 s1 가림 해제 대상');
    expect(within(screen.getByTestId('card-s1')).getByText('가림')).toBeInTheDocument();
    expect(within(screen.getByTestId('card-a')).getByRole('switch')).toBeInTheDocument();
  });

  it('shows the 가능성 높음 chip on nonface tiles only', async () => {
    render(base(people));
    await open();
    expect(within(screen.getByTestId('card-s1')).getByText('가능성 높음')).toBeInTheDocument();
    expect(within(screen.getByTestId('card-s2')).queryByText('가능성 높음')).toBeNull();
  });

  it('sorts nonface first, then larger face first, otherwise keeps order', async () => {
    render(base(people));
    await open();
    expect(tileKeys()).toEqual(['card-s3', 'card-sv', 'card-s1', 'card-s2', 'card-s4']);
  });

  it('shows the group note', async () => {
    render(base(people));
    await open();
    expect(
      screen.getByText('음식, 손, 무늬 등 얼굴이 아닐 수 있는 영역입니다. 가능성이 높은 것은 미리 체크했습니다. 진짜 얼굴이 보이면 체크를 풀고 한 번에 가림 해제하세요.'),
    ).toBeInTheDocument();
  });

  it('already-visible tile has no checkbox, shows 원본, is not counted', async () => {
    render(base(people));
    await open();
    const tile = screen.getByTestId('card-sv');
    expect(within(tile).queryByRole('checkbox')).toBeNull();
    expect(within(tile).getByText('원본')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '선택한 2개 가림 해제' })).toBeInTheDocument();
  });

  it('ticking a plain suspect and confirming passes it with the nonface ones', async () => {
    const onShowSuspects = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(base(people, { onShowSuspects }));
    await open();
    await userEvent.click(ck('s2'));
    expect(ck('s2')).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('button', { name: '선택한 3개 가림 해제' }));
    expect(confirm).toHaveBeenCalledWith('얼굴 아닐 수 있음 3개의 가림을 해제합니다. 진짜 얼굴은 체크를 풀어 두세요.');
    expect(onShowSuspects).toHaveBeenCalledWith(['s3', 's1', 's2']);
  });

  it('unchecking a nonface tile removes it from the confirm list', async () => {
    const onShowSuspects = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(base(people, { onShowSuspects }));
    await open();
    await userEvent.click(ck('s1'));
    expect(ck('s1')).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(screen.getByRole('button', { name: '선택한 1개 가림 해제' }));
    expect(onShowSuspects).toHaveBeenCalledWith(['s3']);
  });

  it('cancel calls nothing', async () => {
    const onShowSuspects = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(base(people, { onShowSuspects }));
    await open();
    await userEvent.click(screen.getByRole('button', { name: '선택한 2개 가림 해제' }));
    expect(onShowSuspects).not.toHaveBeenCalled();
  });

  it('button is hidden when nothing is selected', async () => {
    render(base(people));
    await open();
    for (const k of ['s1', 's3']) await userEvent.click(ck(k));
    expect(screen.queryByRole('button', { name: /가림 해제$/ })).toBeNull();
  });

  it('button is hidden while the group is collapsed', () => {
    render(base(people));
    expect(screen.queryByRole('button', { name: /가림 해제$/ })).toBeNull();
  });

  it('clicking the tile focuses; clicking the checkbox does not', async () => {
    const onFocusPerson = vi.fn();
    render(base(people, { onFocusPerson }));
    await open();
    await userEvent.click(ck('s1'));
    expect(onFocusPerson).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByTestId('card-s1')).getByText('인물 s1'));
    expect(onFocusPerson).toHaveBeenCalledWith('s1');
  });

  it('counts only the searched (visible) tiles', async () => {
    render(base(people));
    await open();
    await userEvent.type(screen.getByRole('searchbox', { name: '인물 검색' }), 's1');
    expect(screen.getByRole('button', { name: '선택한 1개 가림 해제' })).toBeInTheDocument();
  });

  it('drops toggled keys that no longer exist (back to the default)', async () => {
    const { rerender } = render(base(people));
    await open();
    await userEvent.click(ck('s1'));
    expect(ck('s1')).toHaveAttribute('aria-checked', 'false');
    rerender(base(people.filter((x) => x.key !== 's1')));
    rerender(base(people));
    expect(ck('s1')).toHaveAttribute('aria-checked', 'true');
  });
});
