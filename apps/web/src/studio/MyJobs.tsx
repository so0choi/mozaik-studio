import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../lib/api';
import type { Job } from '../lib/types';

const STALE_QUEUE_MS = 5 * 60 * 1000;

export function jobStatus(j: Job, now = Date.now()): { text: string; tone: 'ok' | 'bad' | '' } {
  switch (j.state) {
    case 'queued':
      if (now - Date.parse(j.createdAt) > STALE_QUEUE_MS) return { text: '처리 서버 응답이 없습니다', tone: 'bad' };
      return { text: '대기 중', tone: '' };
    case 'normalizing':
      return { text: '변환 중', tone: '' };
    case 'analyzing':
      return { text: `분석 중 ${j.progress}%`, tone: '' };
    case 'ready':
      return { text: '편집 가능', tone: 'ok' };
    case 'rendering':
      return { text: '렌더 중', tone: '' };
    case 'rendered':
      return { text: '완료', tone: 'ok' };
    case 'failed':
      return { text: '실패', tone: 'bad' };
  }
}

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
};

/** Header button + dropdown listing the user's existing jobs. */
export function MyJobs() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setJobs(await api.listJobs());
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) navigate('/login');
      else setError(e instanceof ApiError ? e.message : '목록을 불러오지 못했습니다.');
    }
  }, [navigate]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const remove = async (j: Job) => {
    if (!window.confirm(`${j.filename} 작업을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    try {
      await api.deleteJob(j.id);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '삭제하지 못했습니다.');
    }
  };

  return (
    <div className="myjobs" ref={box} data-testid="my-jobs">
      <button type="button" className="link-btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>
        내 작업
      </button>
      {open && (
        <div className="myjobs-pop" role="region" aria-label="내 작업 목록">
          {error && (
            <div className="err" role="alert">
              {error}
            </div>
          )}
          {jobs && jobs.length === 0 && <p className="hint">아직 올린 영상이 없습니다.</p>}
          <ul className="jobs">
            {(jobs ?? []).map((j) => {
              const st = jobStatus(j);
              return (
                <li key={j.id} className="job">
                  <span className="fn">
                    <Link to={`/jobs/${j.id}`} onClick={() => setOpen(false)}>
                      {j.filename}
                    </Link>
                  </span>
                  <span className={`st ${st.tone}`}>{st.text}</span>
                  <span className="when">{fmtDate(j.createdAt)}</span>
                  <button type="button" className="del" onClick={() => void remove(j)} aria-label={`${j.filename} 삭제`}>
                    삭제
                  </button>
                  {j.state === 'failed' && j.error && <span className="why">{j.error}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
