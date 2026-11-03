import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Person } from '../lib/types';
import { TargetList, type RevealKey } from './TargetList';

const person = (key: string, over: Partial<Person> = {}): Person => ({
  key, label: `인물 ${key}`, trackIds: [key], visible: false, thumb: `${key}.jpg`, samples: [], fragmentCount: 1,
  appearSec: 3, segments: [[0, 3]], isGroup: false, suspect: false, ...over,
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
