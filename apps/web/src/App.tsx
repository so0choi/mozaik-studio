import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ApiError, api } from './lib/api';
import { Jobs } from './pages/Jobs';
import { Login } from './pages/Login';
import { Studio } from './pages/Studio';

/** Route guard: GET /api/auth/me, redirect to /login on 401. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'ok' | 'denied' | 'error'>('checking');
  useEffect(() => {
    let live = true;
    api
      .me()
      .then(() => live && setState('ok'))
      .catch((e) => live && setState(e instanceof ApiError && e.status === 401 ? 'denied' : 'error'));
    return () => {
      live = false;
    };
  }, []);
  if (state === 'checking') return <div className="status-box" role="status">확인 중</div>;
  if (state === 'denied') return <Navigate to="/login" replace />;
  if (state === 'error') return <div className="status-box" role="alert">서버에 연결하지 못했습니다.</div>;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Jobs /></RequireAuth>} />
      <Route path="/jobs/:id" element={<RequireAuth><Studio /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
