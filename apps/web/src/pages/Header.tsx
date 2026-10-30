import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function SkipLink() {
  return (
    <a className="skip" href="#main">
      본문으로 건너뛰기
    </a>
  );
}

export function Logo() {
  return (
    <Link to="/" className="logo">
      <i aria-hidden="true">
        {Array.from({ length: 9 }, (_, i) => (
          <b key={i} />
        ))}
      </i>
      모자이크 스튜디오
    </Link>
  );
}

export function Header({ children }: { children?: ReactNode }) {
  return (
    <>
      <SkipLink />
      <header className="top">
        <Logo />
        {children}
      </header>
    </>
  );
}
