# Face Mosaic Studio R1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 업로드 영상의 얼굴을 자동 검출·추적해 기본 전부 모자이크하고, 사람별 보임·검수·수동 박스 후 오디오 포함 결과를 내려받는 사내 웹 스튜디오 프로토타입.

**Architecture:** NestJS API가 업로드·인증·작업 메타(SQLite)·파일 서빙을 맡고, Redis 리스트로 Python 워커에 분석/전파/렌더를 넘긴다. 워커는 `/data/jobs/{id}/`에 계약된 JSON과 영상을 쓰고 Redis 상태 해시를 갱신한다. React SPA는 정규화 영상 위에 canvas 오버레이로 미리보기한다.

**Tech Stack:** Python ≥3.11 (opencv-contrib-python-headless, numpy, redis, imageio-ffmpeg, pytest), NestJS 10 + TypeScript (better-sqlite3, ioredis, bcryptjs, jsonwebtoken, multer, Jest, supertest), React 18 + Vite + TypeScript (Vitest), Redis 7, Docker Compose.

**Spec:** [docs/superpowers/specs/2026-10-30-face-mosaic-studio-design.md](../specs/2026-10-30-face-mosaic-studio-design.md) — §3 데이터 계약이 모든 트랙 사이의 단일 출처다.

## Global Constraints

- 좌표는 원본 해상도 픽셀, 박스 `[x, y, w, h]` 정수.
- 박스 확장 25%는 저장 시 1회만 적용. 소비자는 재적용 금지.
- 블록 크기 = 트랙 박스 짧은 변 중앙값 // 8, 최소 8. 격자 원점 = 박스 좌상단.
- gap-hold = round(0.5 × fps) 프레임.
- YuNet `score_threshold=0.5`, `nms_threshold=0.3`. 추적 IoU 0.3, 고신뢰 0.6, 강제 분리 = 중심 이동 > 박스 대각선 × 0.5.
- 기본 전부 가림. `edits.visible`에 있는 트랙/그룹만 보임.
- 업로드: ≤2GB, mp4/mov/mkv/webm. 워커 검사: ≤30분, ≤3840×2160.
- 출력: H.264 CRF 20 veryfast yuv420p, 오디오는 normalized.mp4에서 `-c:a copy`.
- 외형 임베딩/ReID 사용 금지.
- 사용자에게 보이는 메시지는 한국어, 느낌표 없음.
- 작업 보관 7일.

## Review Focus

1. 오디오 없는 영상 업로드 → 실패 없이 무음 결과가 나와야 한다 (Task W1, W4 테스트).
2. 가변 프레임레이트/시작 PTS가 0이 아닌 입력 → 미리보기 박스가 얼굴과 어긋나지 않아야 한다 (Task W1 테스트: 정규화 후 첫 프레임 PTS 0, 프레임 수 = round(duration×fps)).
3. 검출 0개 영상 → 분석이 `ready`로 끝나고 갤러리에 "검출된 얼굴이 없습니다" 표시 (W2, F2 테스트).
4. 다른 사용자의 작업 ID나 `../` 썸네일 이름 → 404/400 (A2 테스트).
5. 렌더 중 같은 작업에 렌더 재요청 → 중복 작업이 생기지 않고 409 (A3 테스트).

---

## Track 0 — 골격

### Task 0: 모노레포 골격과 계약 픽스처

**Files:**
- Create: `contracts/fixtures/tracks.sample.json`, `contracts/fixtures/edits.sample.json`, `contracts/fixtures/review.sample.json`, `contracts/fixtures/expected-mask-frames.json`
- Create: `docker-compose.yml`, `README.md`

**Interfaces:**
- Produces: 픽스처 3종(스펙 §3.3–3.5 형태, 640×360 30fps 90프레임, 트랙 t1·t2·t3, t2는 frame 45에서 split 대상) + `expected-mask-frames.json` = `{ "<frame>": [[x,y,w,h,blockSize], ...] }` (프레임 0, 44, 45, 89에 대해 edits 적용 후 가릴 박스). 워커 W3와 웹 F1이 **같은 기대값**으로 테스트한다.
- compose 서비스: `redis` (7-alpine), `api` (3000), `worker`, `web` (5173, dev). 공유 볼륨 `jobs-data:/data`.

- [ ] Step 1: 픽스처와 기대값 작성 (기대값은 스펙 규칙으로 손계산: t1 visible, t2b visible, t3 가림, t2a 가림)
- [ ] Step 2: compose 작성, `docker compose config` 통과 확인
- [ ] Step 3: Commit `chore: monorepo skeleton and contract fixtures`

---

## Track W — 워커 (`worker/`)

패키지 구조: `worker/mosaic_worker/{normalize.py, detect.py, tracker.py, thumbs.py, review.py, compose.py, render.py, propagate.py, jobs.py, status.py, main.py}`, 테스트 `worker/tests/`. 의존성 `worker/pyproject.toml`. ffmpeg 경로는 `FFMPEG_BIN` 환경변수 → 없으면 `imageio_ffmpeg.get_ffmpeg_exe()`.

### Task W1: 정규화

**Interfaces:**
- Produces: `normalize(src: Path, job_dir: Path) -> Meta` (dataclass `Meta(fps:int, width:int, height:int, frame_count:int, duration_sec:float, has_audio:bool)`), `meta.json` 기록. 제한 초과 시 `UserFacingError("30분 이하, 4K 이하 영상만 지원합니다.")`, ffmpeg 실패 시 `UserFacingError("영상을 변환하지 못했습니다. 다른 파일로 다시 시도해 주세요.")`.

- [ ] Step 1: 테스트 `tests/test_normalize.py` — 합성 영상(29.97fps, 오디오 사인파, 시작 오프셋 0.5초) → `meta.fps == 30`, `has_audio is True`, 정규화 영상 첫 패킷 pts == 0; 오디오 없는 입력 → `has_audio is False`, 파일 생성; 31분 길이 메타를 가진 입력(ffprobe 결과 모킹) → `UserFacingError`.
- [ ] Step 2: 실패 확인 → 구현(스펙 §4.1 명령) → 통과 → Commit `feat(worker): normalize uploads to CFR H.264`

### Task W2: 검출 + 추적 + 썸네일 + review

**Interfaces:**
- Produces:
  - `detect.py`: `class FaceDetector: __init__(model_path: Path); detect(frame: np.ndarray) -> list[Detection]` (`Detection(box: tuple[int,int,int,int], score: float)`), 짧은 변 >1080이면 축소 후 환산.
  - `tracker.py`: `class Tracker: __init__(fps: int); update(frame_idx: int, dets: list[Detection]) -> None; finish() -> list[Track]` (`Track(id: str, frames: dict[int, box], scores: dict[int, float], held: set[int])`). 확장 25%는 `finish()`에서 적용, gap-hold 프레임은 `held`에 기록.
  - `review.py`: `build_review(tracks: list[Track], fps: int) -> dict` (스펙 §3.4).
  - `thumbs.py`: `write_thumbs(video: Path, tracks, job_dir) -> dict[str, {thumb, samples}]`.
  - `jobs.py`: `analyze(job_dir: Path, progress: Callable[[str,int],None]) -> None` → `tracks.json`, `review.json`, `thumbs/`.
- 모델: `worker/scripts/fetch_model.sh`가 opencv_zoo의 `face_detection_yunet_2023mar.onnx`를 `worker/models/`에 받는다.

- [ ] Step 1: `tests/test_tracker.py` — (a) 두 박스가 교차 후 지나가는 합성 검출열 → 어떤 트랙도 양쪽 경로를 모두 포함하지 않음; (b) 30fps에서 5프레임 끊김 → 같은 트랙 유지, `held`에 5프레임; 30프레임 끊김 → 15프레임 hold 후 새 트랙; 60fps에서 hold 30프레임; (c) 중심이 한 프레임에 대각선 0.6배 이동 → 새 트랙; (d) 출력 박스 = 원 박스 25% 확장(중심 기준, 프레임 경계로 clamp) 1회.
- [ ] Step 2: `tests/test_review.py` — 평균 점수 0.5인 20프레임 구간 → `low_confidence` 1건; IoU 0.2 교차 → `crossing` 1건(trackIds 2개); 0.8초 떨어진 같은 유형 2건 → 병합 1건.
- [ ] Step 3: `tests/test_analyze_integration.py` — `tests/assets/face.jpg`(OpenCV samples `lena.jpg`, 테스트 setup에서 내려받아 캐시; 네트워크 불가 시 skip)를 640×360 배경 위에서 좌→우 이동시킨 3초 영상 → 트랙 ≥1, 프레임 커버리지 ≥ 90%, `thumbs/{id}.jpg` 존재; 빈 배경 영상 → `tracks == []`, review items == [].
- [ ] Step 4: 실패 확인 → 구현(스펙 §4.2–4.4) → 통과 → Commit `feat(worker): detection, tracking, thumbnails and review items`

### Task W3: 편집 합성 (가릴 박스 계산)

**Interfaces:**
- Produces: `compose.py`: `mask_boxes(tracks_doc: dict, edits: dict, manual: list[dict]) -> dict[int, list[tuple[x,y,w,h,block]]]` — 기본 가림, `visible`/groups/splits 적용, 수동 박스 추가(삭제·trim 반영, block = 짧은 변//8 최소 8).

- [ ] Step 1: `tests/test_compose.py` — Task 0 픽스처 입력 → `expected-mask-frames.json`과 정확히 일치; split 경계 프레임 45가 `t2b`에 속함; `manual.deleted=true`는 무시.
- [ ] Step 2: 구현 → 통과 → Commit `feat(worker): compose edits into per-frame mask boxes`

### Task W4: 렌더

**Interfaces:**
- Consumes: `mask_boxes`.
- Produces: `render.py`: `pixelate(frame, box, block) -> None` (in-place, 격자 원점 박스 좌상단), `render(job_dir: Path, progress) -> Path` → `output.mp4`.

- [ ] Step 1: `tests/test_render.py` — `pixelate` 후 각 block×block 셀 내부 픽셀이 동일값; 박스 밖 픽셀 불변; 통합: W2 합성 영상 + 전부 가림 렌더 → 출력 프레임 수 == 입력, 가림 박스 영역이 원본과 다름, 오디오 스트림 유무가 입력과 같음.
- [ ] Step 2: 구현(스펙 §4.5, rawvideo 파이프) → 통과 → Commit `feat(worker): render mosaic output with audio passthrough`

### Task W5: CSRT 전파

**Interfaces:**
- Produces: `propagate.py`: `propagate(job_dir, manual_id, anchor: {frame, box}, other_anchors: list[int]) -> dict` → `manual/{id}.json` (기존 파일이 있으면 새 기준과 가장 가까운 다른 기준 사이 프레임만 교체), 방향별 최대 10초.

- [ ] Step 1: `tests/test_propagate.py` — 이동하는 얼굴 영상에서 기준 프레임 30 → 프레임 0–89 중 결과 프레임 박스 중심이 실제 얼굴 중심과 박스 폭 50% 이내(≥80% 프레임); 기존 기준 [10, 70]이 있는 상태에서 새 기준 40 → 프레임 10 이하·70 이상은 그대로, 사이만 교체.
- [ ] Step 2: 구현 → 통과 → Commit `feat(worker): manual box propagation with CSRT`

### Task W6: 큐 루프와 Docker 이미지

**Interfaces:**
- Consumes: Redis `queue:analyze|propagate|render`, 상태 해시 (스펙 §3.2).
- Produces: `python -m mosaic_worker.main` 장기 실행 루프; `worker/Dockerfile` (python:3.12-slim + ffmpeg apt + 모델 다운로드).

- [ ] Step 1: `tests/test_main.py` (fakeredis) — analyze 메시지 → 상태가 `normalizing→analyzing→ready`; `UserFacingError` → `failed` + 메시지; 렌더 예외 → 상태 `ready` + error; 알 수 없는 jobId → 로그만 남기고 루프 지속.
- [ ] Step 2: 구현 → 통과 → `docker build worker` 성공 → Commit `feat(worker): redis queue loop and container`

---

## Track A — API (`apps/api/`)

모듈: `auth/`, `jobs/` (controller, service, storage.ts, queue.ts, repo.ts), `retention/`. 설정: `DATA_DIR` (기본 `/data`), `REDIS_URL`, `JWT_SECRET`, `STUDIO_USERS`, `DB_PATH` (`$DATA_DIR/studio.db`).

### Task A1: 인증

**Interfaces:**
- Produces: `POST /api/auth/login|logout`, `GET /api/auth/me`, 전역 `JwtCookieGuard` (쿠키 `studio_token`, 12h), `req.user = { username }`. `scripts/hash-password.ts`로 bcrypt 해시 생성.

- [ ] Step 1: e2e `test/auth.e2e-spec.ts` — 맞는 비번 → 200 + Set-Cookie httpOnly; 틀린 비번 → 401 `{"message":"아이디 또는 비밀번호가 맞지 않습니다."}`; 쿠키 없이 `/api/jobs` → 401.
- [ ] Step 2: 구현 → 통과 → Commit `feat(api): env-based login with jwt cookie`

### Task A2: 작업 생성·조회·파일 서빙

**Interfaces:**
- Produces: 스펙 §5 표의 업로드·목록·조회·video·tracks·review·meta·thumbs·edits·DELETE. 응답 `Job = { id, filename, createdAt, state, progress, error|null, hasOutput }`. `GET /api/jobs/:id`는 SQLite + Redis 상태 해시 병합(해시 없으면 `queued`).
- edits PUT 검증: 스펙 §3.5 형태, 알 수 없는 트랙 ID 거부 → 400.

- [ ] Step 1: e2e `test/jobs.e2e-spec.ts` (ioredis-mock, 임시 DATA_DIR) — 업로드 → 201 + `queue:analyze`에 `{"jobId"}`; `.txt` → 400 `{"message":"mp4, mov, mkv, webm 파일만 올릴 수 있습니다."}`; 다른 사용자로 조회 → 404; `thumbs/..%2Fstudio.db` → 400; video Range `bytes=0-99` → 206 + `Content-Length: 100`; edits에 없는 트랙 ID → 400; DELETE → 디렉터리 삭제.
- [ ] Step 2: 구현 → 통과 → Commit `feat(api): job upload, status and file serving`

### Task A3: 렌더 게이트·수동 전파·보관 스케줄러

**Interfaces:**
- Produces: `POST /api/jobs/:id/render` (미처리 review → 409 스펙 문구, 상태 `rendering|queued` 중 재요청 → 409 `{"message":"이미 렌더 중입니다."}`), `GET /output`, `POST /manual` (`{manualId, anchor, otherAnchors}` → `queue:propagate`), `GET /manual/:mid`, `RetentionService.sweep(now: Date): number` (7일 초과 삭제, 1시간 주기).

- [ ] Step 1: e2e/단위 — review 2건 중 1건 reviewed → 409 "확인 필요 항목 1건이 남았습니다."; 모두 reviewed → 202 + 큐 push; 렌더 중 재요청 → 409; `sweep`에 8일 전 작업 → 1 반환 + 디렉터리 삭제, 6일 전 → 유지.
- [ ] Step 2: 구현 → 통과 → Commit `feat(api): render gate, manual propagation and retention`

---

## Track F — 웹 (`apps/web/`)

구조: `src/lib/{api.ts, frames.ts, masks.ts, geometry.ts}`, `src/pages/{Login.tsx, Jobs.tsx, Studio.tsx}`, `src/studio/{PeopleGallery.tsx, PlayerOverlay.tsx, Timeline.tsx, ReviewQueue.tsx, BoxTool.tsx}`, 스타일은 `docs/design/finalized.html`의 토큰·레이아웃을 CSS 변수로 옮긴다. dev 서버는 `/api`를 `http://localhost:3000`으로 프록시.

### Task F1: 순수 로직

**Interfaces:**
- Produces: `frameAt(mediaTime: number, fps: number): number` (= Math.round), `toDisplay(box, srcW, srcH, dispW, dispH)`, `maskBoxes(tracksDoc, edits, manual): Map<number, [x,y,w,h,block][]>` (W3와 같은 규칙), `people(tracksDoc, edits): Person[]` (`Person = { key, label, trackIds, visible, thumb, fragmentCount, appearSec }`).

- [ ] Step 1: Vitest — Task 0 픽스처로 `maskBoxes`가 `expected-mask-frames.json`과 일치; `frameAt(1.5, 30) === 45`; `toDisplay` 1920→960 스케일 반으로; 트랙 0개 → `people() == []`.
- [ ] Step 2: 구현 → 통과 → Commit `feat(web): mask and geometry logic shared with worker rules`

### Task F2: 로그인·작업 목록·업로드

- [ ] Step 1: Vitest + Testing Library — 로그인 실패 메시지 표시; 업로드 중 진행률; `failed` 작업에 error 문구; `queued` 5분 초과 → "처리 서버 응답이 없습니다".
- [ ] Step 2: 구현 → 통과 → Commit `feat(web): login, job list and upload`

### Task F3: 스튜디오 화면

**Interfaces:**
- Consumes: F1 함수, API §5.

- [ ] Step 1: 컴포넌트 테스트 — 카드 보임 토글 → `PUT /edits` 1회(500ms 디바운스) 및 `visible` 반영; 카드 2개 선택 → "같은 사람으로 묶기" → groups 1개; 검출 0개 → "검출된 얼굴이 없습니다"; 미처리 review > 0 → 렌더 버튼 disabled + "확인 필요 N건 남음"; "괜찮음" → reviewed 추가.
- [ ] Step 2: 구현(오버레이는 `requestVideoFrameCallback`, 미지원 시 `timeupdate` 대체) → 통과 → Commit `feat(web): studio gallery, overlay preview and review queue`

### Task F4: 분할·수동 박스

- [ ] Step 1: 테스트 — "여기서 분할" → `splits` 추가 + 카드 2개로; 플레이어 드래그 → `POST /manual` + 카드 "추적 중", 폴링 `done` → 오버레이에 박스.
- [ ] Step 2: 구현 → 통과 → Commit `feat(web): track split and manual box propagation`

---

## Track I — 통합

### Task I1: compose 통합 실행

- [ ] Step 1: `docker compose up --build` → 브라우저로 로그인 → 합성 얼굴 영상 업로드 → `ready` → 보임 1명 → review 모두 처리 → 렌더 → 다운로드한 output.mp4를 ffprobe로 확인(프레임 수·오디오).
- [ ] Step 2: README에 실행법, 사용자 추가법(`hash-password`), 알려진 한계 기록 → Commit `docs: run instructions`

## 실행 순서

Task 0 → (W1–W6 ∥ A1–A3 ∥ F1–F4) → I1. 세 트랙은 §3 계약과 Task 0 픽스처로만 연결된다.
