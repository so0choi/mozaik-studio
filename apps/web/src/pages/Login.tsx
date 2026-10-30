import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../lib/api';
import { SkipLink } from './Header';

export function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Server has login turned off (AUTH_DISABLED): go straight to the job list.
  useEffect(() => {
    let live = true;
    api
      .me()
      .then((me) => live && me.authDisabled && navigate('/', { replace: true }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(username, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '로그인하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SkipLink />
      <main id="main" className="auth">
        <form onSubmit={submit}>
          <h1>모자이크 스튜디오</h1>
          <label className="field">
            아이디
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          </label>
          <label className="field">
            비밀번호
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <div className="err" role="alert">
            {error}
          </div>
          <button type="submit" className="btn-primary" disabled={busy}>
            로그인
          </button>
        </form>
      </main>
    </>
  );
}
