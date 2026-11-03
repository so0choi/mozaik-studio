import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { installFetch } from '../test/mockFetch';

const renderApp = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

describe('Login', () => {
  it('shows the server message on 401', async () => {
    installFetch((c) =>
      c.path === '/api/auth/login' ? { status: 401, body: { message: '아이디 또는 비밀번호가 맞지 않습니다.' } } : undefined,
    );
    renderApp('/login');
    await userEvent.type(screen.getByLabelText('아이디'), 'alice');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'x');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('아이디 또는 비밀번호가 맞지 않습니다.');
  });

  it('skips the login page when the server has login turned off', async () => {
    installFetch((c) => {
      if (c.path === '/api/auth/me') return { body: { username: 'demo', authDisabled: true } };
      if (c.path === '/api/jobs') return { body: [] };
      return undefined;
    });
    renderApp('/login');
    await waitFor(() => expect(screen.queryByRole('button', { name: '로그인' })).not.toBeInTheDocument());
    expect(await screen.findByText('내 파일로 해 보기')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '로그아웃' })).not.toBeInTheDocument();
  });

  it('route guard redirects to /login when /api/auth/me is 401', async () => {
    const calls = installFetch((c) => (c.path === '/api/auth/me' ? { status: 401, body: { message: 'x' } } : undefined));
    renderApp('/');
    expect(await screen.findByRole('button', { name: '로그인' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/auth/me')).toBe(true);
  });
});
