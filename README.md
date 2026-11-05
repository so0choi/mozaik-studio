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

## 폴더 구조

```
face-mosaic-studio/
├── docker-compose.yml        redis, api, worker, web 네 서비스 (jobs-data 볼륨을 api와 worker가 공유)
├── apps/
│   ├── api/src/              NestJS
│   │   ├── auth/             로그인, JWT 쿠키 가드 (SSO로 바꿀 때 jwt-cookie.guard.ts만 교체)
│   │   ├── jobs/             업로드, 작업 상태, 파일 서빙, edits 검증, Redis 큐 넣기, 렌더 게이트
│   │   └── retention/        7일 지난 작업 자동 삭제
│   └── web/src/              React + Vite, nginx로 서빙
│       ├── pages/            Login, Upload(작업 목록), Studio
│       ├── studio/           스튜디오 화면 부품 (플레이어 오버레이, 타임라인, 대상 목록, 검수 카드, 수동 박스 도구, 효과 조절)
│       └── lib/              API 호출, 미리보기 마스크·효과·모양 계산 (워커와 같은 규칙)
├── worker/
│   ├── mosaic_worker/        Python 워커 (모듈별 역할은 아래 "분석 파이프라인" 참고)
│   ├── models/               ONNX 모델 (git 미포함, scripts/fetch_model.sh로 받음)
│   ├── scripts/fetch_model.sh
│   └── tests/
├── contracts/fixtures/       tracks/edits/manual/review 샘플, 효과 파라미터, 모양 마스크 기대값
└── docs/
    ├── design/               office-hours 설계, 화면 시안
    ├── superpowers/specs/    스펙 (본 스펙, 효과·영역, 사람 찾기)
    ├── superpowers/plans/    구현 계획
    ├── qa/                   QA 기록
    └── progress-log.md       진행 로그
```

### 작업 디렉터리 `/data/jobs/{jobId}/`

api와 worker는 서로 직접 호출하지 않고 이 디렉터리의 파일과 Redis 큐로만 주고받는다. 형식은 [스펙 §3](docs/superpowers/specs/2026-10-30-face-mosaic-studio-design.md)이 기준이다.

| 파일 | 만드는 쪽 | 내용 |
|---|---|---|
| `original.{ext}` | api | 업로드 원본 |
| `normalized.mp4`, `meta.json` | worker | 고정 프레임레이트 H.264/AAC로 바꾼 영상과 그 정보 |
| `tracks.json`, `review.json`, `thumbs/` | worker | 얼굴 트랙, 검수 항목, 썸네일 |
| `edits.json` | api (웹이 PUT) | 보이게 할 사람, 효과 등 사용자 편집 |
| `manual/{manualId}.json` | worker | 수동 박스 전파 결과 |
| `output.mp4`, `output.edits.json` | worker | 렌더 결과와 렌더에 쓴 edits |

워커는 큐를 `queue:propagate` > `queue:render` > `queue:analyze` 순서로 꺼낸다. 짧은 수동 전파가 긴 분석 뒤에 밀리지 않게 하기 위해서다.

## 분석 파이프라인과 사용 모델

얼굴 검출 모델은 **YuNet** 하나다. 오검출을 거르는 보조 신호로 **NanoDet** 사람 검출 모델을 함께 쓴다. 둘 다 OpenCV 모델 모음(opencv_zoo)의 ONNX 파일이고, `opencv-contrib-python-headless`만으로 CPU에서 돌린다. PyTorch 같은 별도 딥러닝 프레임워크와 GPU는 쓰지 않는다. 추적과 이어 붙이기는 모델 없이 박스 위치·크기 계산만 한다(얼굴 생김새 비교·ReID는 생체정보를 피하려고 쓰지 않음).

| 모델 | 파일 | 쓰는 곳 | 역할 |
|---|---|---|---|
| YuNet | `face_detection_yunet_2023mar.onnx` | `detect.py`, `verify.py` | 얼굴 검출 (`cv2.FaceDetectorYN`), 의심 트랙 재확인 |
| NanoDet | `object_detection_nanodet_2022nov.onnx` (Apache 2.0) | `person.py` | 사람 박스 검출 (`cv2.dnn`), 얼굴이 머리 자리에 있는지 확인 |

분석 작업(`jobs.py`)은 영상을 한 번만 디코딩하면서 아래 순서로 진행한다.

```
original.*
  │ normalize.py   ffmpeg로 고정 프레임레이트 H.264/AAC, PTS 0 시작으로 변환 → normalized.mp4, meta.json
  ▼
프레임마다 ─┬─ detect.py    YuNet 얼굴 검출 (신뢰도 ≥ 0.5, NMS 0.3, 짧은 변 1080px 넘으면 축소 후 검출)
            ├─ tracker.py   ByteTrack식 2단계 IoU 매칭 + 등속 예측으로 박스를 트랙으로 묶음
            ├─ thumbs.py    트랙별 대표 썸네일과 2초 간격 샘플
            ├─ verify.py    점수 0.9 미만 검출은 주변을 크게 잘라 YuNet을 다시 돌림 → 낮으면 suspect
            ├─ person.py    약 0.5초마다 NanoDet 실행, 얼굴 중심이 사람 박스 위쪽 25% 안인지 판정
            └─ scenecut.py  HSV 히스토그램 차이로 장면 전환 감지
  ▼
link.py      끊긴 같은 얼굴 조각을 위치·크기·시간 간격으로 이어 붙임 (장면 전환을 넘어서는 잇지 않음)
             짧은 검출 공백은 마스크를 이어서 채움 (얼굴이 아닐 가능성이 큰 트랙은 제외)
  ▼
tracks.json, review.json(낮은 신뢰도·공백·교차 구간), thumbs/
suspect이면서 머리 자리에도 없는 트랙 = nonface → edits.json의 visible에 넣어 기본으로 모자이크를 풂
```

그 밖의 워커 모듈:

| 모듈 | 역할 |
|---|---|
| `main.py` | Redis 큐 루프, 우선순위 처리, 재시작 시 처리 중이던 메시지 복구 |
| `status.py` | 작업 상태를 Redis 해시와 `status.json`에 함께 기록 |
| `propagate.py` | 사람이 그린 박스를 OpenCV CSRT 추적기로 앞뒤 프레임에 전파 |
| `compose.py` | tracks + edits + 수동 박스를 합쳐 프레임별 가릴 영역 계산 (기본은 전부 가림) |
| `effects.py`, `shapes.py` | 모자이크·효과 계산과 모양 래스터화 (웹 미리보기와 같은 규칙, `contracts`로 검사) |
| `render.py` | 프레임을 처리해 ffmpeg로 인코딩하고 오디오를 복사해 `output.mp4` 생성 |

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

**로그인 끄기(프로토타입용):** `.env`에 `AUTH_DISABLED=true`를 넣으면 로그인 없이 모든 요청이 `AUTH_ANON_USER`(기본 `guest`) 사용자로 처리된다. 8080 포트에 접근할 수 있는 누구나 모든 작업을 보고 지울 수 있으므로 로컬이나 사내망에서만 쓴다. 다시 켜려면 줄을 지우거나 `false`로 바꾸고 `docker compose up -d api`.

## 알려진 한계

- 사내 인증은 환경변수 계정 목록이다. SSO가 정해지면 `apps/api/src/auth/jwt-cookie.guard.ts`만 교체한다.
- CPU 검출만 지원한다. 1080p 5분 영상 처리 시간과 긴 영상의 `tracks.json` 크기는 아직 측정하지 않았다.
- "얼굴이 아닐 수 있음"(nonface)으로 판정된 트랙은 기본으로 모자이크가 풀린다. 붐비는 거리 영상에서는 샘플 100개 중 8개가 실제 얼굴이었으므로 검수자가 해당 그룹을 확인해 다시 가려야 한다. 판정 기준은 영상 한 편으로만 측정했다.
- 수동 박스의 재기준·구간 자르기·삭제 UI는 없다(서버와 워커는 지원).
- 업로드 중 연결이 끊기는 경우와 2GB에 가까운 대용량 업로드는 자동 테스트하지 않았다.
