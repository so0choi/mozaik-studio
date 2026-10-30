import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api, uploadJob } from '../lib/api';
import type { Job } from '../lib/types';
import { Header } from './Header';

const STALE_QUEUE_MS = 5 * 60 * 1000;
const ACTIVE = ['queued', 'normalizing', 'analyzing', 'rendering'];

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

export function Jobs() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [authDisabled, setAuthDisabled] = useState(false);

  useEffect(() => {
    api
      .me()
      .then((me) => setAuthDisabled(Boolean(me.authDisabled)))
      .catch(() => undefined);
  }, []);
  const [error, setError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    void refresh();
  }, [refresh]);

  const anyActive = !!jobs?.some((j) => ACTIVE.includes(j.state));
  useEffect(() => {
    if (!anyActive) return;
    const iv = setInterval(() => void refresh(), 2000);
    return () => clearInterval(iv);
  }, [anyActive, refresh]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploadError('');
    setProgress(0);
    try {
      await uploadJob(file, setProgress);
      if (fileRef.current) fileRef.current.value = '';
      await refresh();
    } catch (e) {
      setUploadError(e instanceof ApiError ? e.message : '업로드에 실패했습니다.');
    } finally {
      setProgress(null);
    }
  };

  const remove = async (j: Job) => {
    if (!window.confirm(`${j.filename} 작업을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    try {
      await api.deleteJob(j.id);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '삭제하지 못했습니다.');
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      navigate('/login');
    }
  };

  return (
    <>
      <Header>
        <div className="sp" />
        {!authDisabled && (
          <button type="button" className="link-btn" onClick={() => void logout()}>
            로그아웃
          </button>
        )}
      </Header>
      <main id="main" className="page">
        <div className="page-in">
          <section className="drop" aria-labelledby="up">
            <h1 id="up">영상 올리기</h1>
            <p className="hint">mp4, mov, mkv, webm · 2GB 이하 · 30분 이하</p>
            <input
              ref={fileRef}
              type="file"
              aria-label="영상 파일 선택"
              accept=".mp4,.mov,.mkv,.webm,video/*"
              disabled={progress !== null}
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            {progress !== null && (
              <div style={{ width: '100%' }}>
                <div
                  className="bar-prog"
                  role="progressbar"
                  aria-label="업로드 진행률"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                >
                  <i style={{ width: `${progress}%` }} />
                </div>
                <p className="hint">업로드 중 {progress}%</p>
              </div>
            )}
            <div className="err" role="alert">
              {uploadError}
            </div>
          </section>
          <section aria-labelledby="jl">
            <h2 id="jl" style={{ fontSize: 18, marginBottom: 12 }}>
              내 작업
            </h2>
            <div className="err" role="alert">
              {error}
            </div>
            {jobs && jobs.length === 0 && <p className="hint">아직 올린 영상이 없습니다.</p>}
            <ul className="jobs">
              {(jobs ?? []).map((j) => {
                const st = jobStatus(j);
                const open = j.state === 'ready' || j.state === 'rendering' || j.state === 'rendered';
                return (
                  <li key={j.id} className="job">
                    <span className="fn">{open ? <Link to={`/jobs/${j.id}`}>{j.filename}</Link> : j.filename}</span>
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
          </section>
        </div>
      </main>
    </>
  );
}
