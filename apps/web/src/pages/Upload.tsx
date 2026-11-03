import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, uploadJob } from '../lib/api';
import { EmptyShell } from '../studio/EmptyShell';
import { MyJobs } from '../studio/MyJobs';

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const EXT = /\.(mp4|mov|mkv|webm)$/i;

/** Returns an error message, or '' when the file may be uploaded. */
export function validateVideo(file: File): string {
  if (!EXT.test(file.name)) return 'MP4, MOV, MKV, WEBM 파일만 올릴 수 있습니다.';
  if (file.size > MAX_BYTES) return '파일이 너무 큽니다. 2GB 이하 영상만 올릴 수 있습니다.';
  return '';
}

export function Upload() {
  const navigate = useNavigate();
  const [authDisabled, setAuthDisabled] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .me()
      .then((me) => setAuthDisabled(Boolean(me.authDisabled)))
      .catch(() => undefined);
  }, []);

  const start = async (file: File | undefined) => {
    if (!file || progress !== null) return;
    const bad = validateVideo(file);
    if (bad) {
      setError(bad);
      return;
    }
    setError('');
    setProgress(0);
    try {
      const job = await uploadJob(file, setProgress);
      navigate(`/jobs/${job.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '업로드에 실패했습니다.');
      setProgress(null);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void start(e.dataTransfer.files?.[0]);
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      navigate('/login');
    }
  };

  const center = (
    <div className="up-wrap">
      <h1 className="up-title">
        <span>영상을 올리면</span>
        <strong>AI가 얼굴을 바로 찾아 가립니다</strong>
      </h1>
      <div className="up-preview" aria-hidden="true">
        <div className="up-face" />
        <span className="up-badge">처리 결과 예시</span>
      </div>
      {progress !== null ? (
        <div className="up-zone busy" data-testid="dropzone">
          <div style={{ width: '100%' }}>
            <p className="up-prog-t">업로드 중 {progress}%</p>
            <div className="bar-prog" role="progressbar" aria-label="업로드 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
              <i style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>
      ) : (
        <div
          className={`up-zone${over ? ' over' : ''}`}
          data-testid="dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <svg className="up-cloud" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5H7z" />
            <path d="M12 16v-5M9.8 12.8L12 10.6l2.2 2.2" />
          </svg>
          <div className="up-txt">
            <p className="up-main">파일을 여기에 끌어다 놓으세요</p>
            <p className="up-sub">MP4, MOV, MKV, WEBM · 최대 2GB, 30분, 4K</p>
          </div>
          <button type="button" className="btn-primary" onClick={() => fileRef.current?.click()}>
            내 파일로 해 보기
          </button>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        hidden
        aria-label="영상 파일 선택"
        accept=".mp4,.mov,.mkv,.webm,video/*"
        onChange={(e) => void start(e.target.files?.[0])}
      />
      <div className="err" role="alert" hidden={!error}>
        {error}
      </div>
      <p className="up-note">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
        업로드한 파일은 7일 후 자동으로 삭제됩니다
      </p>
    </div>
  );

  return (
    <EmptyShell
      center={center}
      headerRight={
        <>
          <div className="sp" />
          <MyJobs />
          {!authDisabled && (
            <button type="button" className="link-btn" onClick={() => void logout()}>
              로그아웃
            </button>
          )}
        </>
      }
    />
  );
}
