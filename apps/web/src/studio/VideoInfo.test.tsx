import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { VideoInfo } from './VideoInfo';

afterEach(cleanup);

const base = { filename: 'a.mp4', width: 1920, height: 1080, frameCount: 300, fps: 30 };

describe('VideoInfo 처리 시간', () => {
  it('총 시간과 변환/검출 상세를 보여준다', () => {
    render(<VideoInfo {...base} timing={{ normalizeSec: 104, analyzeSec: 382 }} />);
    expect(screen.getByText('처리 시간')).toBeTruthy();
    expect(screen.getByText('8분 6초 (변환 1분 44초 · 검출 6분 22초)')).toBeTruthy();
  });

  it('normalizeSec 이 null 이면 검출만 보여준다', () => {
    render(<VideoInfo {...base} timing={{ normalizeSec: null, analyzeSec: 382 }} />);
    expect(screen.getByText('검출 6분 22초')).toBeTruthy();
  });

  it('timing 이 없으면 행이 없다', () => {
    render(<VideoInfo {...base} />);
    expect(screen.queryByText('처리 시간')).toBeNull();
  });
});
