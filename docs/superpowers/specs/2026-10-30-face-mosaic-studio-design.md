# 얼굴 모자이크 스튜디오 — 구현 스펙 (R1 프로토타입)

- 작성일: 2026-10-30
- 입력: [office-hours 설계 문서](../../design/office-hours-design.md) (APPROVED), 확정 화면 [finalized.html](../../design/finalized.html)
- 상태: 사용자가 "결정사항 모두 권장안으로 진행" 위임 (2026-10-30). 이 문서의 결정 중 사용자가 직접 고르지 않은 것은 **[권장 채택]**으로 표시한다.

## 1. 목표와 범위

연내(2026-12-31) 사내 데모용 독립 웹 스튜디오. 업로드한 녹화 영상에서 얼굴을 자동 검출·추적해 기본 전부 모자이크하고, 사용자가 사람별로 보이게 하거나(특정인 제외), 위험 구간을 검수하고, 수동 박스를 추가한 뒤, 오디오가 보존된 결과를 다운로드한다.

**범위 밖:** 실시간 라이브(R-Live), 얼굴 인식/ReID(R-Recog), 번호판·배경 블러, 미디버스/커머스 연동, 일괄 처리.

**성공 기준**
1. 1080p 5분 영상 업로드 → 분석 → 갤러리에서 특정인 보임 → 확인 필요 항목 처리 → 수동 박스 1개 → 렌더 → 오디오 포함 다운로드가 한 번에 된다.
2. 데모 샘플에서 결과 영상의 얼굴 노출 프레임 0 (검수 절차 §9.3).
3. 켜기/끄기가 재처리 없이 미리보기에 즉시 반영된다.
4. **최소 데모(대체안, M2까지):** 1·3만 적용, 수동 박스·트랙 분할·확인 필요 목록 제외. 이 경우 성공 기준 2는 "자동 검출 범위 안에서"로 완화된다.

## 2. 아키텍처

```
[web: React+Vite SPA] ──HTTP/JSON, 영상 Range──▶ [api: NestJS]
                                                  │  SQLite(jobs 메타) · /data/jobs/{id}/ 파일
                                                  │  LPUSH queue:analyze / queue:render / queue:propagate
                                                  ▼
                                               [Redis]
                                                  ▲  BRPOP · HSET job:{id}:status
                                                  │
                                         [worker: Python 3]
                                          ffmpeg 정규화 · YuNet 검출 · 자체 ByteTrack식 추적
                                          CSRT 전파 · 모자이크 렌더
```

- **모노레포 [권장 채택]:** `apps/api` (NestJS 10+, TS), `apps/web` (React 18 + Vite + TS), `worker/` (Python ≥3.11), `contracts/` (JSON 스키마·샘플), `docker-compose.yml`.
- **기술 선택:** API는 팀 표준 NestJS(사용자 선택). 영상 처리만 Python으로 격리.
- **큐 [권장 채택]:** BullMQ 대신 Redis 리스트(LPUSH/BRPOP) + 상태 해시. 두 언어에서 의존성 없이 같은 계약을 쓰기 위함.
- **저장소:** 공유 볼륨 `/data/jobs/{jobId}/`. API만 SQLite에 쓴다. 워커는 파일과 Redis 상태 해시만 쓴다.
- **검출:** YuNet (OpenCV `cv2.FaceDetectorYN`, `face_detection_yunet_2023mar.onnx`), CPU. GPU는 없다고 가정(사용자 답변 "모름 → CPU 기준").
- **추적:** 외형 특징을 쓰지 않는 ByteTrack식 2단계 IoU 매칭 + 등속 예측을 워커에 직접 구현(외부 의존성 없음). ReID/임베딩 금지(생체정보 회피 전제).

## 3. 데이터 계약 (모든 컴포넌트가 따르는 단일 출처)

### 3.1 작업 디렉터리 `/data/jobs/{jobId}/`
| 파일 | 작성자 | 내용 |
|---|---|---|
| `original.{ext}` | api | 업로드 원본 |
| `normalized.mp4` | worker | CFR H.264/AAC, PTS 0 시작 |
| `meta.json` | worker | `{fps, width, height, frameCount, durationSec, hasAudio}` |
| `tracks.json` | worker | §3.3 |
| `review.json` | worker | §3.4 |
| `thumbs/{trackId}.jpg`, `thumbs/{trackId}_s{n}.jpg` | worker | 대표 썸네일, 구간 샘플 썸네일 |
| `edits.json` | api (web이 PUT) | §3.5 |
| `manual/{manualId}.json` | worker | 수동 박스 전파 결과 §3.6 |
| `output.mp4` | worker | 렌더 결과 |

### 3.2 큐 메시지 (Redis 리스트, JSON 문자열)
- `queue:analyze` ← `{"jobId": "..."}`
- `queue:propagate` ← `{"jobId": "...", "manualId": "...", "anchor": {"frame": 123, "box": [x,y,w,h]}, "otherAnchors": [frame...]}`
- `queue:render` ← `{"jobId": "..."}`
- 상태 해시 `job:{jobId}:status`: `state` ∈ `queued|normalizing|analyzing|ready|rendering|rendered|failed`, `progress` 0–100 정수, `error` 사용자에게 보일 한국어 문장, `updatedAt` ISO.
- 수동 전파 상태 해시 `job:{jobId}:manual:{manualId}`: `state` ∈ `tracking|done|failed`.
- 좌표는 전부 **원본 해상도 픽셀**, 박스는 `[x, y, w, h]` 정수.

### 3.3 `tracks.json`
```json
{
  "version": 1,
  "fps": 30, "width": 1920, "height": 1080, "frameCount": 9000,
  "render_config": { "expandRatio": 0.25, "blockDivisor": 8, "minBlock": 8, "gapHoldSec": 0.5 },
  "tracks": [
    {
      "id": "t3",
      "thumb": "thumbs/t3.jpg",
      "samples": ["thumbs/t3_s0.jpg", "thumbs/t3_s1.jpg"],
      "blockSize": 22,
      "segments": [[120, 840]],
      "frames": { "120": [812, 240, 180, 196], "121": [814, 241, 180, 196] },
      "scores": { "120": 0.91 }
    }
  ]
}
```
- `frames`의 박스는 **확장(25%)과 gap-hold가 이미 적용된 최종 박스**다. 소비자(web 오버레이, 렌더러)는 확장을 다시 적용하지 않는다. `expandRatio`는 기록용이다.
- `blockSize`: 트랙별 고정값 = 트랙 박스 짧은 변 중앙값 / 8, 최소 8px (프레임마다 재계산하지 않아 격자가 떨리지 않음).
- 모자이크 격자 원점은 **박스 좌상단**.

### 3.4 `review.json`
```json
{ "items": [ { "id": "r1", "type": "low_confidence|gap|crossing", "trackIds": ["t4"], "startFrame": 1260, "endFrame": 1300, "box": [x,y,w,h] } ] }
```
생성 규칙: 낮은 신뢰도(트랙 구간 평균 점수 < 0.6, 15프레임 이상), gap(gap-hold로 채운 구간), 교차(두 트랙 박스 IoU > 0.1인 구간). 인접 항목은 1초 이내면 병합.

### 3.5 `edits.json` (web 소유, api가 검증 후 저장)
```json
{
  "version": 1,
  "visible": ["t1"],
  "groups": [ { "id": "g1", "trackIds": ["t1","t5"], "label": "진행자" } ],
  "splits": [ { "trackId": "t2", "frame": 1500 } ],
  "manual": [ { "id": "m1", "anchors": [ { "frame": 2520, "box": [x,y,w,h] } ], "trim": [2400, 2700], "deleted": false } ],
  "reviewed": ["r1"]
}
```
- 기본은 전부 가림. `visible`에 있는 트랙(그룹이면 그룹 전체)만 보임.
- `splits`: 트랙을 frame에서 나눠 `t2` → `t2a`(<frame), `t2b`(≥frame). 보임/가림은 분할된 조각 ID로 지정.
- 그룹은 사람이 직접 묶는 것이며 외형 비교는 하지 않는다.

### 3.6 `manual/{id}.json`
`{ "id": "m1", "frames": { "2400": [x,y,w,h], ... }, "segments": [[2400, 2700]] }` — 저장 시 25% 확장 적용 완료. 재기준(re-anchor) 시 새 기준 프레임과 가장 가까운 다른 기준 프레임 사이의 프레임만 교체한다. CSRT는 실패 신호 없이 어긋날 수 있으므로 사용자가 재기준·trim·삭제로 고친다. 전파 범위: 방향별 최대 10초 또는 추적 실패 시 중단.

## 4. 워커 (Python)

1. **정규화:** `ffmpeg -i original -vf "fps={round(src_fps)},setpts=PTS-STARTPTS" -af "asetpts=PTS-STARTPTS" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 128k -avoid_negative_ts make_zero -movflags +faststart normalized.mp4`. 오디오 없는 입력은 `-an`, `meta.hasAudio=false`. 실패 시 `state=failed`, `error="영상을 변환하지 못했습니다. 다른 파일로 다시 시도해 주세요."`.
2. **검출:** YuNet `score_threshold=0.5`, `nms_threshold=0.3`. 프레임 짧은 변 > 1080이면 1080으로 축소해 검출 후 좌표 환산. 진행률은 프레임 비율.
3. **추적:** 2단계 매칭(점수 ≥0.6 먼저, 나머지 후), IoU 임계 0.3, 중심 이동이 박스 대각선의 0.5배를 넘으면 강제 분리. 끊긴 트랙은 gap-hold(0.5초 = round(0.5×fps) 프레임) 동안 등속 예측 위치로 박스를 유지하고 박스를 프레임마다 5%씩 키운다. 3프레임 미만 트랙은 버리지 않고 유지(노출 방지 우선).
4. **썸네일:** 트랙에서 `score × 면적`이 최대인 프레임의 박스를 20% 여유를 두고 잘라 160px. 샘플 썸네일은 2초 간격, 최대 8장.
5. **렌더:** `tracks.json` + `edits.json` + `manual/*.json`을 합쳐 프레임별 가릴 박스 목록 생성 → 각 박스를 트랙 `blockSize` 격자(원점 박스 좌상단)로 픽셀화 → OpenCV로 프레임 쓰기를 ffmpeg 파이프(stdin rawvideo)로 넘겨 H.264 CRF 20 인코딩, `normalized.mp4`의 오디오를 `-c:a copy`로 mux(오디오 없으면 생략).
6. **CSRT 전파:** `cv2.TrackerCSRT_create` (opencv-contrib). 기준 프레임에서 앞뒤로 진행.

## 5. API (NestJS)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/auth/login` | `{username,password}` → httpOnly JWT 쿠키 |
| POST | `/api/auth/logout` | 쿠키 삭제 |
| GET | `/api/auth/me` | 현재 사용자 |
| POST | `/api/jobs` | multipart `file` 업로드 → 작업 생성, `queue:analyze` |
| GET | `/api/jobs` | 내 작업 목록 |
| GET | `/api/jobs/:id` | 메타 + Redis 상태 병합 |
| GET | `/api/jobs/:id/video` | `normalized.mp4`, HTTP Range 지원 |
| GET | `/api/jobs/:id/tracks` · `/review` · `/meta` | JSON 그대로 |
| GET | `/api/jobs/:id/thumbs/:name` | 썸네일 (이름은 `^[\w-]+\.jpg$`만 허용) |
| GET/PUT | `/api/jobs/:id/edits` | edits.json 읽기/검증 후 저장 |
| POST | `/api/jobs/:id/manual` | 수동 박스 전파 요청 → `queue:propagate` |
| GET | `/api/jobs/:id/manual/:mid` | 전파 상태 + 결과 |
| POST | `/api/jobs/:id/render` | 미처리 review 항목이 있으면 409 `{"message":"확인 필요 항목 N건이 남았습니다."}`, 아니면 `queue:render` |
| GET | `/api/jobs/:id/output` | 결과 다운로드 (`rendered`일 때만) |
| DELETE | `/api/jobs/:id` | 디렉터리와 메타 삭제 |

- **인증 [권장 채택]:** 사내 인증 방식 미정 → 환경변수 `STUDIO_USERS="alice:<bcrypt>,bob:<bcrypt>"` 기반 로그인 + JWT(쿠키, 12시간). 사내 SSO가 정해지면 `AuthGuard`만 교체.
- **접근:** 작업 소유자만 조회·수정. 다른 사용자의 작업 ID는 404.
- **업로드 제한 [권장 채택]:** 2GB 이하, 확장자 mp4/mov/mkv/webm, 길이 30분 이하·해상도 3840×2160 이하는 워커가 ffprobe 후 검사(초과 시 `failed` + `"30분 이하, 4K 이하 영상만 지원합니다."`). 초과 용량은 API가 413.
- **보관:** 생성 7일 후 자동 삭제(API 내부 1시간 주기 스케줄러). 수동 삭제 즉시.
- **경로 안전:** jobId는 서버 생성 UUID만 허용, 파일 이름은 화이트리스트.

## 6. 웹 (React)

화면은 [finalized.html](../../design/finalized.html)을 기준으로 한다.

- **라우트:** `/login`, `/` (작업 목록 + 업로드), `/jobs/:id` (스튜디오).
- **업로드/진행:** 업로드 진행률, 분석 중 상태(`normalizing/analyzing` + progress) 2초 폴링, 실패 메시지 표시.
- **스튜디오 좌측:** 사람 카드(트랙/그룹 단위), 대표 썸네일, 조각 수, 등장 시간, 가림|보임, 다중 선택 → 같은 사람으로 묶기, 이름 편집(그룹 label).
- **스튜디오 우측:** `<video src=/api/jobs/:id/video>` + canvas 오버레이. 현재 프레임 = `round(mediaTime × fps)` (`requestVideoFrameCallback`). 가림 박스는 원본 좌표 → 표시 크기로 스케일, 블록 격자는 원본 픽셀 기준 계산 후 스케일. 선택한 사람의 등장 구간 타임라인 + 샘플 썸네일 줄(교차 후 복귀를 눈으로 확인). 확인 필요 목록(괜찮음/박스 추가), 트랙 분할 버튼(현재 프레임에서), 박스 그리기(드래그) → 전파 요청 → "추적 중" → 완료.
- **렌더:** 확인 필요가 0일 때만 활성. 렌더 상태 폴링 → 다운로드 링크.
- **편집 저장:** 변경 후 500ms 디바운스로 `PUT /edits`.

## 7. 오류 처리

| 상황 | 동작 |
|---|---|
| 업로드 형식/용량 위반 | 400/413, 한국어 메시지, 입력 유지 |
| 정규화·검출 실패 | `failed` + error, 작업 목록에 표시, 삭제만 가능 |
| 워커 미동작 | `queued`가 5분 넘으면 UI에 "처리 서버 응답이 없습니다" 표시 |
| 전파 실패 | 수동 박스를 그린 프레임만 고정 박스로 남기고 "추적 실패 · 구간을 직접 지정하세요" |
| 렌더 중 실패 | `failed`가 아닌 `ready`로 되돌리고 error 표시, 재시도 가능 |
| 미처리 검수 항목으로 렌더 요청 | 409 |

## 8. 일정 (개발자 1명 + Claude Code)

| M | 내용 | 주 |
|---|---|---|
| M0 | 계약(§3)·모노레포·compose 골격 | 1 (방식 2로 추가된 1주) |
| M1 | 워커: 정규화·검출·추적·썸네일·렌더 CLI, CPU 속도 측정 | 1 |
| M2 | API 업로드/작업/인증 + 웹 업로드·갤러리·켜기/끄기·렌더 (최소 데모) | 2 |
| M3 | 오버레이 미리보기·확인 필요·분할·수동 박스 전파 | 3 |
| M4 | 자동 삭제·실패 표시·사내 배포 | 1 |

여유 0주. 지연 시 M2(최소 데모)로 시연하고 §1의 완화 기준을 보고 라인에 미리 공유한다.

## 9. 테스트

1. **워커 단위:** 추적기(교차·가림 시나리오에서 ID가 섞이지 않고 조각화됨), gap-hold 길이(fps별 0.5초), 확장 1회 적용, 블록 격자 원점·고정 크기, 편집 병합(가림 기본, visible/groups/splits), 수동 재기준 프레임 교체 범위.
2. **워커 통합:** 공개 샘플 얼굴 이미지로 합성한 움직이는 영상(오디오 포함/미포함)으로 정규화→분석→렌더 실행, 출력 길이·오디오 유무·PTS 0 확인, 렌더 결과에서 가림 박스 내부가 원본과 다르고(픽셀화) 보임 트랙은 원본과 같음.
3. **노출 검수 절차(데모 전 수동):** 결과 영상을 정속 1회 시청 + `review.json`의 모든 구간과 트랙 경계 ±15프레임을 프레임 단위로 확인.
4. **API e2e (Jest+supertest):** 로그인, 소유자 외 404, 업로드 제한, Range 응답 206, 409 렌더 게이트, edits 검증 실패 400, 파일명 경로 이탈 차단.
5. **웹 단위 (Vitest):** 프레임 인덱스 계산, 좌표 스케일, 블록 격자, 편집 상태 → 가릴 박스 목록 계산(워커와 같은 규칙 — 같은 픽스처로 양쪽 테스트).

## 10. 해결된 리뷰 지적 (office-hours minor 12건)

| ID | 결정 |
|---|---|
| R3-2 | gap-hold를 시간(0.5초)으로 정의, 등속 예측 + 5%/프레임 확대 |
| R3-3 | 격자 원점 = 박스 좌상단, 블록 크기 트랙별 고정 |
| R3-4 | §9.3 검수 절차 |
| R3-5 | §5 업로드 제한, §4 출력 CRF 20 |
| R3-6 | 썸네일 = score×면적 최대 프레임 |
| R3-7 | 2초 간격 샘플 썸네일 줄 |
| R3-8 | §3.6 재기준 교체 범위, 드리프트는 사용자 수정 |
| R3-9 | 오디오는 normalized.mp4에서 복사 (원본 아님) |
| R3-10 | setpts/asetpts + avoid_negative_ts, 오디오 없는 경로 |
| R3-11 | §3.5 edits.json 필드, 샘플 썸네일 줄은 M3 |
| R3-12 | §1 최소 데모 완화 기준 |
| R3-13 | 해당 없음(용어는 R-Live/R-Recog로 통일) |
