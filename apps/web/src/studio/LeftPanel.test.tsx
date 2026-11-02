import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Effects } from '../lib/types';
import { LeftPanel } from './LeftPanel';

const fx = (over: Partial<Effects> = {}): Effects => ({
  default: { type: 'mosaic', strength: 1, color: '#000000' },
  background: null,
  overrides: {},
  ...over,
});

function setup(effects = fx(), filterSupported = true) {
  const h = { onDefault: vi.fn(), onBackground: vi.fn(), onSelectTool: vi.fn() };
  render(<LeftPanel review={null} reviewCount={0} drawTool={null} effects={effects} filterSupported={filterSupported} {...h} />);
  return h;
}
const card = (n: string) => screen.getByRole('region', { name: n });

describe('LeftPanel effects', () => {
  it('기본 효과 card has no 원본 and reports the chosen effect', () => {
    const h = setup();
    const c = card('기본 효과');
    expect(within(c).queryByRole('button', { name: '원본' })).toBeNull();
    expect(within(c).getByText('개별 설정이 없는 대상에 적용')).toBeInTheDocument();
    fireEvent.click(within(c).getByRole('button', { name: '블러' }));
    expect(h.onDefault).toHaveBeenCalledWith({ type: 'blur', strength: 1, color: '#000000' });
  });

  it('배경 효과: 끄기 pressed when off; turning on seeds an effect; 끄기 -> null', () => {
    const h = setup();
    const c = card('배경 효과');
    expect(within(c).getByRole('button', { name: '끄기' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(c).queryByRole('slider')).toBeNull();
    fireEvent.click(within(c).getByRole('button', { name: '블러' }));
    expect(h.onBackground).toHaveBeenCalledWith({ type: 'blur', strength: 1, color: '#000000' });
  });

  it('배경 켜짐: note, strength slider, 끄기 -> onBackground(null)', () => {
    const h = setup(fx({ background: { type: 'blur', strength: 2, color: '#000000' } }));
    const c = card('배경 효과');
    expect(within(c).getByText('가림을 해제한 인물에도 적용됩니다')).toBeInTheDocument();
    expect(within(c).getByRole('slider', { name: '강도' })).toBeInTheDocument();
    fireEvent.click(within(c).getByRole('button', { name: '끄기' }));
    expect(h.onBackground).toHaveBeenCalledWith(null);
  });

  it('effects sections come before the 매직 블러 card; renamed cards', () => {
    setup();
    const order = (a: HTMLElement, b: HTMLElement) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(order(card('기본 효과'), card('매직 블러'))).toBeTruthy();
    expect(order(card('배경 효과'), card('매직 블러'))).toBeTruthy();
    expect(screen.getByRole('heading', { name: /자동 가림/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '직접 가림' })).toBeInTheDocument();
  });

  it('remaining placeholders stay disabled', () => {
    setup();
    for (const n of ['자동차 번호판', '대상 선택', '기본값으로 초기화', '고급 설정']) {
      expect(screen.getByRole('button', { name: n })).toBeDisabled();
    }
  });
});

describe('LeftPanel draw tools', () => {
  it('타원/다각형 are enabled, reflect the active tool with aria-pressed, and report the choice', () => {
    const onSelectTool = vi.fn();
    render(
      <LeftPanel review={null} reviewCount={0} drawTool="polygon" effects={fx()} filterSupported onDefault={vi.fn()} onBackground={vi.fn()} onSelectTool={onSelectTool} />,
    );
    expect(screen.getByRole('button', { name: '다각형' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '타원' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '박스 그리기' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: '타원' }));
    expect(onSelectTool).toHaveBeenCalledWith('ellipse');
  });
});
