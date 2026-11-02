import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Effect } from '../lib/types';
import { EffectControls } from './EffectControls';

const mosaic: Effect = { type: 'mosaic', strength: 1, color: '#000000' };
const blur: Effect = { type: 'blur', strength: 3, color: '#000000' };
const color: Effect = { type: 'color', strength: 1, color: '#123456' };

function setup(over: Partial<Parameters<typeof EffectControls>[0]> = {}) {
  const onChange = vi.fn();
  const onInherit = vi.fn();
  render(<EffectControls value={null} inherited={mosaic} onChange={onChange} onInherit={onInherit} filterSupported label="효과 종류" {...over} />);
  return { onChange, onInherit };
}

describe('EffectControls', () => {
  it('shows the inherited effect with (기본값) and no 기본값 따르기', () => {
    setup();
    expect(screen.getByText('모자이크 (기본값)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '기본값 따르기' })).toBeNull();
    expect(screen.getByRole('button', { name: '모자이크' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('an own value shows 기본값 따르기, which calls onInherit', () => {
    const { onInherit } = setup({ value: blur });
    fireEvent.click(screen.getByRole('button', { name: '기본값 따르기' }));
    expect(onInherit).toHaveBeenCalledTimes(1);
  });

  it('clicking another type commits it keeping strength; clicking the selected type does nothing', () => {
    const { onChange } = setup({ value: blur });
    fireEvent.click(screen.getByRole('button', { name: '블러' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '모자이크' }));
    expect(onChange).toHaveBeenCalledWith({ type: 'mosaic', strength: 3, color: '#000000' });
  });

  it('slider: many input events + one change -> one onChange; aria-valuetext', () => {
    const { onChange } = setup({ value: blur });
    const s = screen.getByRole('slider', { name: '강도' });
    expect(s).toHaveAttribute('aria-valuetext', '3 / 5');
    fireEvent.input(s, { target: { value: '4' } });
    fireEvent.input(s, { target: { value: '5' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(s).toHaveAttribute('aria-valuetext', '5 / 5');
    fireEvent.change(s, { target: { value: '5' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...blur, strength: 5 });
  });

  it('color type: color input and no strength slider', () => {
    const { onChange } = setup({ value: color });
    expect(screen.queryByRole('slider')).toBeNull();
    const c = screen.getByLabelText('색상') as HTMLInputElement;
    expect(c.type).toBe('color');
    expect(screen.getByText('#123456')).toBeInTheDocument();
    fireEvent.change(c, { target: { value: '#ff0000' } });
    expect(onChange).toHaveBeenCalledWith({ ...color, color: '#ff0000' });
  });

  it('explains blur-as-mosaic only when the browser cannot filter', () => {
    const note = '이 브라우저 미리보기에서는 블러가 모자이크로 보입니다. 결과 영상은 블러로 만들어집니다.';
    setup({ value: blur, filterSupported: false });
    expect(screen.getByText(note)).toBeInTheDocument();
  });

  it('no note when filter is supported or the effect is not blur', () => {
    setup({ value: blur, filterSupported: true });
    expect(screen.queryByText(/블러로 만들어집니다/)).toBeNull();
  });

  it('no selection and no detail when value and inherited are null (원본)', () => {
    setup({ value: null, inherited: null });
    for (const n of ['블러', '모자이크', '색상']) expect(screen.getByRole('button', { name: n })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('slider')).toBeNull();
  });
});
