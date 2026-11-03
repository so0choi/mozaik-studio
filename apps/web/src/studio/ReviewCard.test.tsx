import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { groupItems } from '../lib/reviewGroups';
import type { ReviewItem } from '../lib/types';
import { ReviewCard, ReviewUpcoming, type GroupInfo } from './ReviewCard';

const item = (id: string, startFrame: number, type: ReviewItem['type'] = 'gap'): ReviewItem => ({
  id,
  type,
  trackIds: ['t1'],
  startFrame,
  endFrame: startFrame + 5,
  box: [0, 0, 1, 1],
});
const noop = () => {};
const baseProps = {
  item: item('r1', 30),
  position: 1,
  total: 3,
  stage: 'ask' as const,
  fps: 30,
  who: '인물 1',
  splitPeople: [],
  onOk: noop,
  onProblem: noop,
  onBack: noop,
  onOption: noop,
  onSeek: noop,
  onPrev: noop,
  onNext: noop,
  onTogglePerson: noop,
  onSplitDone: noop,
};
const grp = (over: Partial<GroupInfo> = {}): GroupInfo => ({ index: 2, total: 7, size: 4, confirmable: 4, startFrame: 150, endFrame: 299, ...over });

describe('ReviewCard group header', () => {
  it('shows the group line and calls onConfirmGroup', () => {
    const onConfirmGroup = vi.fn();
    render(<ReviewCard {...baseProps} group={grp()} onConfirmGroup={onConfirmGroup} />);
    expect(screen.getByTestId('group-header')).toHaveTextContent('구간 2/7 · 00:05–00:09 · 4건');
    fireEvent.click(screen.getByTestId('confirm-group'));
    expect(onConfirmGroup).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('confirm-group')).toHaveTextContent('이 구간 모두 확인 (4건)');
    expect(screen.getByTestId('confirm-group')).toHaveTextContent('Shift+Enter');
    expect(screen.queryByText(/따로 선택/)).toBeNull();
  });

  it('disables the button when nothing is confirmable and notes the crossings', () => {
    render(<ReviewCard {...baseProps} group={grp({ size: 2, confirmable: 0 })} onConfirmGroup={noop} />);
    expect(screen.getByTestId('confirm-group')).toBeDisabled();
    expect(screen.getByText('교차 2건은 따로 선택해야 합니다')).toBeInTheDocument();
  });

  it('renders no group header without the prop', () => {
    render(<ReviewCard {...baseProps} />);
    expect(screen.queryByTestId('group-header')).toBeNull();
  });
});

describe('ReviewUpcoming groups', () => {
  const items = [item('a', 0), item('b', 10, 'crossing'), item('c', 160, 'low_confidence'), item('d', 900)];
  const groups = groupItems(items, 30, (i) => i.id === 'c');
  const render_ = (gs = groups.slice(1), onSelect = vi.fn()) => {
    render(
      <ReviewUpcoming groups={gs} totalGroups={groups.length} total={items.length} done={[]} hiddenCount={0} fps={30} whoOf={() => '인물 1'} isSuspect={(i) => i.id === 'c'} onSelect={onSelect} />,
    );
    return onSelect;
  };

  it('lists group rows with counts, the suspect tag, and selects the first item', () => {
    const onSelect = render_();
    expect(screen.getByText('다음 구간 · 남은 3구간 4건')).toBeInTheDocument();
    const row = screen.getByTestId('review-group-1');
    expect(row).toHaveTextContent('1건 · 낮은 신뢰도 1');
    expect(row).toHaveTextContent('얼굴 아닐 수 있음');
    expect(screen.getByTestId('review-group-6')).not.toHaveTextContent('얼굴 아닐 수 있음');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('shows counts by type for mixed groups', () => {
    render(
      <ReviewUpcoming groups={groups.slice(0, 1)} totalGroups={3} total={4} done={[]} hiddenCount={0} fps={30} whoOf={() => ''} isSuspect={() => false} onSelect={noop} />,
    );
    expect(screen.getByTestId('review-group-0')).toHaveTextContent('2건 · 끊김 1 · 교차 1');
  });

  it('caps rows at 9 with an 외 N구간 line', () => {
    const many = Array.from({ length: 12 }, (_, i) => item(`m${i}`, i * 150));
    const gs = groupItems(many, 30, () => false);
    render(<ReviewUpcoming groups={gs} totalGroups={12} total={12} done={[]} hiddenCount={0} fps={30} whoOf={() => ''} isSuspect={() => false} onSelect={noop} />);
    expect(screen.getAllByTestId(/^review-group-/)).toHaveLength(9);
    expect(screen.getByText('외 3구간')).toBeInTheDocument();
  });
});

describe('ReviewUpcoming advisory fold', () => {
  const adv = [{ ...item('a1', 30), severity: 'advisory' as const }, { ...item('a2', 90, 'low_confidence'), severity: 'advisory' as const }];
  const base = { groups: [], totalGroups: 0, total: 0, done: [], hiddenCount: 0, fps: 30, whoOf: () => '인물 1', isSuspect: () => false, onSelect: noop };

  it('is hidden when there are no advisory items', () => {
    render(<ReviewUpcoming {...base} advisory={[]} onSeekItem={noop} />);
    expect(screen.queryByText(/렌더를 막지 않음/)).toBeNull();
  });

  it('lists advisory items collapsed by default and seeks on click', () => {
    const onSeekItem = vi.fn();
    render(<ReviewUpcoming {...base} advisory={adv} onSeekItem={onSeekItem} />);
    const fold = screen.getByRole('button', { name: /참고 2곳 · 렌더를 막지 않음/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('advisory-list')).not.toBeVisible();
    fireEvent.click(fold);
    expect(screen.getByTestId('advisory-list')).toBeVisible();
    const row = screen.getByRole('button', { name: /낮은 신뢰도 · 인물 1/ });
    fireEvent.click(row);
    expect(onSeekItem).toHaveBeenCalledWith('a2');
  });
});
