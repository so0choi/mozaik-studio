import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Region } from '../lib/types';
import { MaskPicker } from './MaskPicker';

const rect = { x: 0, y: 0, w: 640, h: 360 };
const region: Region = {
  id: 't1', shape: 'rect', box: [100, 100, 60, 60], points: null,
  effect: { type: 'mosaic', strength: 3, color: '#000000' }, block: 8,
};

function setup(over: Partial<React.ComponentProps<typeof MaskPicker>> = {}) {
  const onSelect = vi.fn();
  const onUnmask = vi.fn();
  render(
    <MaskPicker rect={rect} srcW={640} srcH={360} regions={[region]} selectedId={null} onSelect={onSelect} onUnmask={onUnmask} {...over} />,
  );
  return { onSelect, onUnmask, layer: screen.getByTestId('maskpicker') };
}

describe('MaskPicker', () => {
  it('clicking inside a region selects it', () => {
    const { onSelect, layer } = setup();
    fireEvent.click(layer, { clientX: 120, clientY: 120 });
    expect(onSelect).toHaveBeenCalledWith('t1');
  });
  it('clicking empty space clears the selection', () => {
    const { onSelect, layer } = setup({ selectedId: 't1' });
    fireEvent.click(layer, { clientX: 400, clientY: 300 });
    expect(onSelect).toHaveBeenCalledWith(null);
  });
  it('shows outline and X for the selected region only', () => {
    setup({ selectedId: 't1' });
    expect(screen.getByTestId('mask-outline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '가림 해제' })).toBeInTheDocument();
  });
  it('renders nothing for a selected id missing from this frame', () => {
    setup({ selectedId: 'zz' });
    expect(screen.queryByTestId('unmask-x')).toBeNull();
    expect(screen.queryByTestId('mask-outline')).toBeNull();
  });
  it('X calls onUnmask with the id and does not re-select', () => {
    const { onUnmask, onSelect } = setup({ selectedId: 't1' });
    fireEvent.click(screen.getByTestId('unmask-x'));
    expect(onUnmask).toHaveBeenCalledWith('t1');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
