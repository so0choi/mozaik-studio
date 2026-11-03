import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Effect, Person } from '../lib/types';
import { TargetDetail } from './TargetDetail';

const mosaic: Effect = { type: 'mosaic', strength: 1, color: '#000000' };
const blur: Effect = { type: 'blur', strength: 3, color: '#000000' };

const person = (visible: boolean): Person => ({
  key: 't1', label: '인물 1', trackIds: ['t1'], visible, thumb: '', samples: [], fragmentCount: 1,
  appearSec: 3, segments: [[0, 10]], isGroup: false, suspect: false, nonface: false, faceSide: 50,
});

function setup(visible: boolean, own: Effect | null = null) {
  const h = { onEffect: vi.fn(), onInherit: vi.fn(), onUncover: vi.fn(), onClose: vi.fn() };
  render(<TargetDetail person={person(visible)} own={own} inherited={mosaic} filterSupported {...h} />);
  return h;
}

describe('TargetDetail', () => {
  it('clicking 블러 on an unmasked person sends one effect edit (mask + override together)', () => {
    const h = setup(true);
    fireEvent.click(screen.getByRole('button', { name: '블러' }));
    expect(h.onEffect).toHaveBeenCalledTimes(1);
    expect(h.onEffect).toHaveBeenCalledWith(expect.objectContaining({ key: 't1' }), { type: 'blur', strength: 1, color: '#000000' });
    expect(h.onUncover).not.toHaveBeenCalled();
  });

  it('unmasked: no segment selected, no strength, status text, uncover button pressed', () => {
    setup(true);
    for (const n of ['블러', '모자이크', '색상']) expect(screen.getByRole('button', { name: n })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByText('원본 · 가림 해제됨')).toBeInTheDocument();
    expect(screen.getByText('이 대상은 원본으로 보입니다. 얼굴이 드러나지 않는지 확인하세요.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '원본 · 가림 해제' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('masked + inherited shows 모자이크 (기본값); own value shows 기본값 따르기', () => {
    const a = setup(false);
    expect(screen.getByText('모자이크 (기본값)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '원본 · 가림 해제' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('이 대상은 모자이크로 가려집니다.')).toBeInTheDocument();
    expect(a.onEffect).not.toHaveBeenCalled();
  });

  it('own override -> 기본값 따르기 calls onInherit', () => {
    const h = setup(false, blur);
    fireEvent.click(screen.getByRole('button', { name: '기본값 따르기' }));
    expect(h.onInherit).toHaveBeenCalledWith(expect.objectContaining({ key: 't1' }));
  });

  it('uncover is idempotent: clicking twice changes state once', () => {
    const changes = vi.fn();
    function Wrapper() {
      const [visible, setVisible] = useState(false);
      return (
        <TargetDetail
          person={person(visible)} own={null} inherited={mosaic} filterSupported
          onEffect={vi.fn()} onInherit={vi.fn()} onClose={vi.fn()}
          onUncover={() => { changes(); setVisible(true); }}
        />
      );
    }
    render(<Wrapper />);
    const b = screen.getByRole('button', { name: '원본 · 가림 해제' });
    fireEvent.click(b);
    fireEvent.click(screen.getByRole('button', { name: '원본 · 가림 해제' }));
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('× closes', () => {
    const h = setup(false);
    fireEvent.click(screen.getByRole('button', { name: '선택 해제' }));
    expect(h.onClose).toHaveBeenCalled();
  });
});
