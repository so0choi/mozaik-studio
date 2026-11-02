import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Person } from '../lib/types';
import { TargetDetail } from './TargetDetail';

const person = (visible: boolean): Person => ({
  key: 't1', label: '인물 1', trackIds: ['t1'], visible, thumb: '', samples: [], fragmentCount: 1,
  appearSec: 3, segments: [[0, 10]], isGroup: false, suspect: false,
});

function setup(visible: boolean) {
  const onSetVisible = vi.fn();
  const onClose = vi.fn();
  render(<TargetDetail person={person(visible)} onSetVisible={onSetVisible} onClose={onClose} />);
  return { onSetVisible, onClose };
}

describe('TargetDetail', () => {
  it('원본 segment unmasks, 모자이크 segment masks', () => {
    const { onSetVisible } = setup(false);
    fireEvent.click(screen.getByRole('button', { name: '원본' }));
    expect(onSetVisible).toHaveBeenLastCalledWith('t1', true);
    fireEvent.click(screen.getByRole('button', { name: '모자이크' }));
    expect(onSetVisible).toHaveBeenLastCalledWith('t1', false);
  });

  it('reflects the state: masked -> 모자이크 selected + switch on + masked helper text', () => {
    setup(false);
    expect(screen.getByRole('button', { name: '모자이크' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('switch', { name: '대상 효과 적용' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('이 대상은 모자이크로 가려집니다.')).toBeInTheDocument();
  });

  it('visible -> 원본 selected, switch off, warning helper text', () => {
    setup(true);
    expect(screen.getByRole('button', { name: '원본' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('switch', { name: '대상 효과 적용' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('이 대상은 원본으로 보입니다. 얼굴이 드러나지 않는지 확인하세요.')).toBeInTheDocument();
  });

  it('the switch toggles masking (off -> mask, on -> unmask)', () => {
    const { onSetVisible } = setup(true);
    fireEvent.click(screen.getByRole('switch', { name: '대상 효과 적용' }));
    expect(onSetVisible).toHaveBeenLastCalledWith('t1', false);
  });

  it('기본값 masks; 블러/색상/세부 조정 are disabled; × closes', () => {
    const { onSetVisible, onClose } = setup(true);
    fireEvent.click(screen.getByRole('button', { name: '기본값' }));
    expect(onSetVisible).toHaveBeenLastCalledWith('t1', false);
    for (const n of ['블러', '색상', /세부 조정/]) expect(screen.getByRole('button', { name: n })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '선택 해제' }));
    expect(onClose).toHaveBeenCalled();
  });
});
