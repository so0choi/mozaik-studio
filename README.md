# 얼굴 모자이크 스튜디오 (R1 프로토타입)

업로드한 녹화 영상에서 얼굴을 자동 검출·추적해 기본 전부 모자이크하고, 사람별로 보이게 하거나 위험 구간을 검수한 뒤 오디오가 보존된 결과를 내려받는 사내 웹 스튜디오.

- 설계: [docs/design/office-hours-design.md](docs/design/office-hours-design.md)
- 스펙: [docs/superpowers/specs/2026-10-30-face-mosaic-studio-design.md](docs/superpowers/specs/2026-10-30-face-mosaic-studio-design.md)
- 계획 + 엔지니어링 리뷰: [docs/superpowers/plans/2026-10-30-face-mosaic-studio.md](docs/superpowers/plans/2026-10-30-face-mosaic-studio.md)
- 확정 화면 시안: [docs/design/finalized.html](docs/design/finalized.html)

## 구성

```
web (React, nginx :8080) ──/api──▶ api (NestJS :3000) ──Redis 리스트──▶ worker (Python, OpenCV/ffmpeg)
                                      └──────── 공유 볼륨 /data/jobs/{id}/ ────────┘
```

| 폴더 | 내용 | 테스트 |
|---|---|---|
| `apps/api` | 인증, 업로드, 작업 상태, 파일 서빙, 렌더 게이트, 7일 자동 삭제 | `cd apps/api && pnpm install && pnpm test` |
| `apps/web` | 로그인, 작업 목록/업로드, 스튜디오 화면 | `cd apps/web && pnpm install && pnpm test -- --run` |
| `worker` | 정규화, YuNet 검출, 추적, 검수 항목, 썸네일, 렌더, 수동 박스 전파 | `docker build -t face-mosaic-worker ./worker && docker run --rm -v "$PWD/contracts:/app/contracts:ro" face-mosaic-worker pytest -q` |
| `contracts` | 세 컴포넌트가 공유하는 JSON 픽스처와 기대값 | 위 워커·웹 테스트가 같은 기대값을 검사 |

## 실행

1. `.env` 작성 (git에 올리지 않음):
   ```
   JWT_SECRET=<임의의 긴 문자열>
   STUDIO_USERS=demo:<bcrypt 해시>
   COOKIE_SECURE=false
   ```
   bcrypt 해시는 `cd apps/api && pnpm hash-password <비밀번호>`로 만든다. compose가 `$`를 변수로 해석하므로 `.env` 안의 해시는 `$`를 `$$`로 바꿔 적는다.
2. `docker compose up --build -d`
3. 브라우저에서 http://localhost:8080 접속 후 로그인

로컬에서 만든 테스트 계정 `demo`의 비밀번호는 `.env`의 `DEMO_PASSWORD`에 있다.

## 알려진 한계

- 사내 인증은 환경변수 계정 목록이다. SSO가 정해지면 `apps/api/src/auth/jwt-cookie.guard.ts`만 교체한다.
- CPU 검출만 지원한다. 1080p 5분 영상 처리 시간과 긴 영상의 `tracks.json` 크기는 아직 측정하지 않았다.
- 수동 박스의 재기준·구간 자르기·삭제 UI는 없다(서버와 워커는 지원).
- 업로드 중 연결이 끊기는 경우와 2GB에 가까운 대용량 업로드는 자동 테스트하지 않았다.
