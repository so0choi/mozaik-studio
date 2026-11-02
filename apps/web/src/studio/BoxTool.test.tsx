import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Shape } from '../lib/types';
import { BoxTool } from './BoxTool';

const rect = { x: 0, y: 0, w: 640, h: 360 };

function setup(over: Partial<React.ComponentProps<typeof BoxTool>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <>
      <button type="button" data-draw-tool="rect">r</button>
      <button type="button" data-draw-tool="ellipse">e</button>
      <button type="button" data-draw-tool="polygon">p</button>
      <BoxTool rect={rect} srcW={640} srcH={360} shape={'rect' as Shape} initial={null} onConfirm={onConfirm} onCancel={onCancel} {...over} />
    </>,
  );
  return { onConfirm, onCancel, tool: screen.getByTestId('boxtool'), ...view };
}
const drag = (el: HTMLElement, a: [number, number], b: [number, number]) => {
  fireEvent.pointerDown(el, { clientX: a[0], clientY: a[1], pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: b[0], clientY: b[1], pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: b[0], clientY: b[1], pointerId: 1 });
};
const click = (el: HTMLElement, x: number, y: number) => fireEvent.click(el, { clientX: x, clientY: y, detail: 1 });
const realDouble = (el: HTMLElement, x: number, y: number) => {
  fireEvent.click(el, { clientX: x, clientY: y, detail: 1 });
  fireEvent.click(el, { clientX: x, clientY: y, detail: 2 });
  fireEvent.doubleClick(el, { clientX: x, clientY: y, detail: 2 });
};
const confirmBtn = () => screen.getByRole('button', { name: '이 영역으로 추적' });
const status = () => screen.getByRole('status');

describe('BoxTool ellipse', () => {
  it('drag shows an ellipse fill preview and confirms with the box and null points', () => {
    const { tool, onConfirm } = setup({ shape: 'ellipse' });
    drag(tool, [100, 50], [300, 150]);
    expect(screen.getByTestId('boxtool-shape').tagName.toLowerCase()).toBe('ellipse');
    fireEvent.click(confirmBtn());
    expect(onConfirm).toHaveBeenCalledWith([100, 50, 200, 100], null);
  });
});

describe('BoxTool polygon', () => {
  it('three clicks + Enter confirms with bbox and box-relative points (4 decimals)', () => {
    const { tool, onConfirm } = setup({ shape: 'polygon' });
    click(tool, 100, 100);
    click(tool, 200, 100);
    click(tool, 100, 130);
    expect(status()).toHaveTextContent('꼭짓점 3개');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledWith([100, 100, 100, 30], [[0, 0], [1, 0], [0, 1]]);
  });

  it('rounds normalized points to 4 decimals', () => {
    const { tool, onConfirm } = setup({ shape: 'polygon' });
    click(tool, 0, 0);
    click(tool, 30, 0);
    click(tool, 10, 7);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledWith([0, 0, 30, 7], [[0, 0], [1, 0], [0.3333, 1]]);
  });

  it('clicking near the first vertex closes the shape', () => {
    const { tool } = setup({ shape: 'polygon' });
    click(tool, 100, 100);
    click(tool, 200, 100);
    click(tool, 100, 160);
    click(tool, 103, 102);
    expect(screen.getByTestId('boxtool-shape')).toHaveAttribute('data-closed', 'true');
    expect(status()).toHaveTextContent('꼭짓점 3개');
    click(tool, 300, 300);
    expect(status()).toHaveTextContent('꼭짓점 3개');
  });

  it('double click closes without adding a vertex', () => {
    const { tool } = setup({ shape: 'polygon' });
    click(tool, 100, 100);
    click(tool, 200, 100);
    click(tool, 100, 160);
    realDouble(tool, 400, 300);
    expect(screen.getByTestId('boxtool-shape')).toHaveAttribute('data-closed', 'true');
    expect(status()).toHaveTextContent('꼭짓점 3개');
  });

  it('double click with fewer than 3 vertices does not close and a later click still adds', () => {
    const { tool } = setup({ shape: 'polygon' });
    click(tool, 100, 100);
    click(tool, 200, 100);
    realDouble(tool, 300, 200);
    expect(status()).toHaveTextContent('꼭짓점 2개');
    click(tool, 100, 160);
    expect(status()).toHaveTextContent('꼭짓점 3개');
    expect(screen.getByTestId('boxtool-shape')).toHaveAttribute('data-closed', 'false');
  });

  it('close radius is 8 display px: 9px away adds a vertex, 7px closes', () => {
    const { tool } = setup({ shape: 'polygon' });
    click(tool, 100, 100);
    click(tool, 200, 100);
    click(tool, 100, 160);
    click(tool, 109, 100);
    expect(status()).toHaveTextContent('꼭짓점 4개');
    expect(screen.getByTestId('boxtool-shape')).toHaveAttribute('data-closed', 'false');
    click(tool, 107, 100);
    expect(screen.getByTestId('boxtool-shape')).toHaveAttribute('data-closed', 'true');
    expect(status()).toHaveTextContent('꼭짓점 4개');
  });

  it('hint texts follow the spec', () => {
    const { unmount, tool } = setup({ shape: 'polygon' });
    click(tool, 100, 100);
    click(tool, 200, 100);
    click(tool, 100, 160);
    expect(status()).toHaveTextContent('클릭해 꼭짓점 추가 · Enter 또는 첫 점 클릭으로 닫기 · Backspace 되돌리기 · Esc 취소');
    unmount();
    setup({ shape: 'ellipse' });
    expect(status()).toHaveTextContent('드래그해 가릴 영역을 그리세요');
  });

  it('Backspace removes the last vertex and reopens a closed shape', () => {
    const { tool } = setup({ shape: 'polygon' });
    click(tool, 100, 100);
    click(tool, 200, 100);
    click(tool, 100, 160);
    click(tool, 50, 130);
    realDouble(tool, 0, 0);
    fireEvent.keyDown(window, { key: 'Backspace' });
    expect(status()).toHaveTextContent('꼭짓점 3개');
    expect(screen.getByTestId('boxtool-shape')).toHaveAttribute('data-closed', 'false');
  });

  it('Escape cancels', () => {
    const { onCancel } = setup({ shape: 'polygon' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('collinear points disable confirm and say why', () => {
    const { tool, onConfirm } = setup({ shape: 'polygon' });
    click(tool, 100, 100);
    click(tool, 150, 100);
    click(tool, 200, 100);
    expect(confirmBtn()).toBeDisabled();
    expect(status()).toHaveTextContent('일직선');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('duplicate points disable confirm and say why', () => {
    const { tool } = setup({ shape: 'polygon' });
    click(tool, 100, 100);
    click(tool, 100, 100);
    click(tool, 100, 100);
    expect(confirmBtn()).toBeDisabled();
    expect(status()).toHaveTextContent('서로 다른 꼭짓점');
  });

  it('fewer than three vertices disable confirm', () => {
    const { tool } = setup({ shape: 'polygon' });
    click(tool, 100, 100);
    click(tool, 200, 100);
    expect(confirmBtn()).toBeDisabled();
    expect(status()).toHaveTextContent('3개 이상');
  });

  it('bbox under 4px disables confirm', () => {
    const { tool } = setup({ shape: 'polygon' });
    click(tool, 100, 100);
    click(tool, 102, 100);
    click(tool, 100, 102);
    expect(confirmBtn()).toBeDisabled();
    expect(status()).toHaveTextContent('4px');
  });

  it('initial box is only a dashed guide; the vertex list starts empty', () => {
    setup({ shape: 'polygon', initial: [50, 50, 100, 100] });
    expect(screen.getByTestId('boxtool-guide')).toBeInTheDocument();
    expect(status()).toHaveTextContent('꼭짓점 0개');
    expect(confirmBtn()).toBeDisabled();
  });

  it('vertices outside the frame are clamped to the frame edge', () => {
    const { tool, onConfirm } = setup({ shape: 'polygon' });
    click(tool, -20, 10);
    click(tool, 100, 10);
    click(tool, 100, 400);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledWith([0, 10, 100, 350], [[0, 0], [1, 0], [1, 1]]);
  });
});

describe('BoxTool redraw of an existing polygon', () => {
  it('keeps the points and only changes the box', () => {
    const pts: [number, number][] = [[0, 0], [1, 0.5], [0.25, 1]];
    const { tool, onConfirm } = setup({ shape: 'polygon', initialPoints: pts, initial: [10, 10, 50, 50] });
    drag(tool, [200, 100], [320, 220]);
    expect(screen.getByTestId('boxtool-shape').tagName.toLowerCase()).toBe('polygon');
    fireEvent.click(confirmBtn());
    expect(onConfirm).toHaveBeenCalledWith([200, 100, 120, 120], pts);
  });
});

describe('BoxTool focus return', () => {
  it('confirm and cancel return focus to the tool button of the shape', () => {
    const { tool } = setup({ shape: 'ellipse' });
    drag(tool, [100, 50], [300, 150]);
    fireEvent.click(confirmBtn());
    expect(document.activeElement).toBe(document.querySelector('[data-draw-tool="ellipse"]'));
    (document.activeElement as HTMLElement).blur();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(document.activeElement).toBe(document.querySelector('[data-draw-tool="ellipse"]'));
  });
});
