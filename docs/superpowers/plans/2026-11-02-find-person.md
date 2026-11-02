# 이 사람 찾기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 검수자가 고른 동의자 한 명과 비슷한 얼굴 조각을 버튼 실행으로 찾아 후보로 보여 주고, 확인한 조각만 그 사람에 묶는다.

**Architecture:** API가 `queue:find`에 요청을 넣고, 이 큐만 소비하는 별도 워커 처리기(`worker-find`)가 조각을 골라 YuNet 재검출 + SFace로 메모리에서만 비교해 `find_person.json`(조각 ID와 유사도)을 쓴다. 웹은 결과를 폴링해 상세 패널에 후보 카드를 띄우고, 추가는 기존 `groupPersons`/`setPersonVisible`로 처리한다. 기능 스위치 `FIND_PERSON_ENABLED`(기본 꺼짐)가 API에서 전체를 막는다.

**Tech Stack:** Python 3.12 (opencv `FaceDetectorYN`, `FaceRecognizerSF`, numpy, redis, pytest), NestJS + Jest/supertest(ioredis-mock), React 18 + Vitest.

**Spec:** [docs/superpowers/specs/2026-11-02-find-person-design.md](../specs/2026-11-02-find-person-design.md)

> **리뷰 반영:** 각 Task를 시작하기 전에 문서 끝의 "Amendments (approved)" 절에서 그 Task 번호 항목을 먼저 읽고 함께 구현한다. 그 절이 이 위의 Task 본문보다 우선한다.

## Global Constraints

- 얼굴 특징 벡터·정렬된 얼굴 이미지는 디스크·로그·Redis에 쓰지 않는다. 예외 메시지에 배열이 섞이지 않게 로그는 사람이 읽는 문장만 남긴다.
- 이 기능의 어떤 경로도 확인 없이 `edits.visible`을 늘리지 않는다. 렌더(`compose.py`, `render.py`)와 미리보기는 `find_person.json`을 읽지 않는다.
- `FIND_PERSON_ENABLED`가 `'true'`가 아니면 find-person API 세 개는 404.
- 상수: `SHOW_SCORE = 0.45`, `CHECK_SCORE = 0.6`, `MIN_FACE_PX = 60`(25% 확장 전 크기), `MIN_DETS = 15`, `FRAMES_PER_PIECE = 5`, `QUERY_FRAMES = 10`, `BEST_POOL = 40`, `MAX_DETECT_MISS = 2`(5장 중), `MAX_CANDIDATES = 300`, `TIME_CAP_SEC = 120`, 재검출 매칭 IoU ≥ 0.5, Redis 키 만료 6시간(21600초).
- SFace 파일 `face_recognition_sface_2021dec.onnx`, SHA-256 `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79`. YuNet `face_detection_yunet_2023mar.onnx`, SHA-256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`.
- 사용자에게 보이는 문구는 한국어, 느낌표 없음. 커밋·PR·파일에 타사 제품명을 쓰지 않는다.
- 각 논리 단위가 끝나면 `docs/progress-log.md`에 항목을 추가한다.

## Review Focus

1. 대상 사람의 조각이 모두 작은 얼굴(60px 미만)이면 → 버튼이 꺼져 있고 이유 문구가 보여야 한다 (Task 7 테스트 `disables find when no large piece`).
2. 후보 조각이 이미 다른 사람의 그룹에 들어 있으면 → 후보에 나오지 않아야 한다. 그 조각을 추가하면 그 그룹 전체가 딸려 오기 때문 (Task 6 테스트 `hides pieces owned by another group`).
3. 찾기 도중 작업이 삭제되면 → 작업 폴더가 되살아나지 않아야 한다 (Task 2 테스트 `does not write into a deleted job dir`).
4. 찾기 도중 검수자가 트랙을 분할하면 → 결과가 `stale`로 표시되고 후보가 쓰이지 않아야 한다 (Task 5 테스트 `stale when splits changed`).
5. 묶은 뒤 같은 사람으로 다시 찾으면 → 이전에 [아님]으로 뺀 조각이 다시 나오지 않아야 한다 (Task 2 테스트 `inherits dismissed when previous pieces are a subset`).

---

### Task 1: 이름 없는 그룹 저장 허용 (선행 수정)

**Files:**
- Modify: `apps/api/src/jobs/edits.validator.ts:35`
- Test: `apps/api/test/jobs.e2e-spec.ts` (`describe('edits')` 안)

**Interfaces:**
- Produces: 그룹 `label`은 선택 항목. 있으면 문자열, 200자 이하.

- [ ] **Step 1: 실패 테스트** — `it('accepts a group without label')`: 픽스처 tracks로 작업을 만든 뒤 `groups: [{ id: 'g1', trackIds: ['t1', 't2'] }]`(label 없음)인 edits를 PUT → 200, 다시 GET하면 같은 그룹. `it('rejects a non-string label')`: `label: 3` → 400.
- [ ] **Step 2:** `cd apps/api && npx jest --testRegex 'test/.*\.e2e-spec\.ts$' -t 'group without label'` → FAIL (400).
- [ ] **Step 3:** 검증 조건을 `(g.label !== undefined && (typeof g.label !== 'string' || g.label.length > 200))`이면 거부로 바꾼다.
- [ ] **Step 4:** 같은 명령 → PASS. `npx jest` 전체와 e2e 전체 PASS.
- [ ] **Step 5:** `git commit -m "fix(api): allow unnamed groups in edits"`

### Task 2: 워커 찾기 핵심 모듈

**Files:**
- Create: `worker/mosaic_worker/findperson.py`
- Test: `worker/tests/test_findperson.py`

**Interfaces:**
- Consumes: `compose.split_fragments(tracks_doc, edits) -> [(piece_id, block, {frame: box}, ...)]`, `status.atomic_write_json`, `tracker.EXPAND_RATIO`.
- Produces:
  - `@dataclass Piece(piece_id: str, frames: dict[int, list], scores: dict[int, float], suspect: bool)`
  - `pieces_of(tracks_doc: dict, edits: dict) -> list[Piece]` — 분할 반영, 점수는 원래 트랙의 `scores`에서 그 조각 구간만.
  - `select_candidates(pieces: list[Piece], query_ids: list[str]) -> list[Piece]` — spec §4.2 조건, 등장 프레임 수 내림차순 상위 `MAX_CANDIDATES`.
  - `pick_frames(piece: Piece, k: int) -> list[int]` — 점수 상위 `BEST_POOL`개에서 `np.linspace`로 고르게 k개, 오름차순.
  - `Embed = Callable[[np.ndarray, list], np.ndarray | None]` (프레임, 25% 확장된 박스 → L2 정규화 벡터 또는 None)
  - `ReadFrame = Callable[[Path, int], np.ndarray | None]` (영상 경로, 프레임 번호 → 그 프레임. 이동 후 읽기)
  - `find_person(job_dir: Path, person_key: str, piece_ids: list[str], embed: Embed, read_frame: ReadFrame, *, clock=time.monotonic, progress: Callable[[int], None] | None = None) -> dict | None` — 결과 문서를 반환하고 `job_dir/"find_person.json"`에 쓴다(작업 폴더가 없으면 쓰지 않고 `None` 반환). 처리 순서: 대상 조각 → 후보를 등장 프레임 수 내림차순으로 하나씩(R3). 후보마다 처음 얼굴이 잡힌 프레임에서 `thumbs.crop_thumb`로 표시용 썸네일을 만들어 `thumbs/find_{pieceId}.jpg`에 쓰고 결과 `candidates[i].thumb`에 그 경로를 넣는다. 시작할 때 이전 `thumbs/find_*.jpg`를 지운다(R2). 대상 조각에서 얼굴 벡터를 하나도 못 얻으면 `state: failed`, `error: "이 사람의 얼굴을 비교할 만큼 선명하게 찾지 못했습니다"`, 후보 계산 안 함(R6).
  - `tracks_version(job_dir: Path) -> str` — `tracks.json` 바이트 SHA-256 앞 16자.

- [ ] **Step 1: 실패 테스트** (합성 tracks/edits, 가짜 `embed`·`read_frames`; 영상 없음):
  - `test_overlapping_pieces_are_never_candidates`: 대상 조각과 프레임이 하나라도 겹치는 조각은 `select_candidates` 결과에 없음.
  - `test_filters_small_short_and_suspect`: 얼굴 짧은 변(확장 전) 59px, 검출 14개, `suspect=True` 조각은 제외. 60px·15개는 포함.
  - `test_split_pieces_are_separate`: `edits.splits=[{trackId:'t2', frame:100}]` → 후보 ID가 `t2a`/`t2b`.
  - `test_scores_and_threshold`: 가짜 embed가 조각별 고정 벡터를 돌려줄 때 `candidates`는 유사도 ≥ 0.45만, 내림차순, 소수 둘째 자리.
  - `test_drops_piece_when_two_detections_fail`: 5장 중 2장에서 embed가 None → 후보에서 빠짐. 1장 실패는 남음.
  - `test_time_cap_truncates`: `clock`이 호출마다 61초씩 증가 → `truncated is True`, 계산된 후보만 포함.
  - `test_no_candidates`: 조건을 만족하는 조각이 없으면 `state == 'done'`, `candidates == []`.
  - `test_result_has_no_vectors`: 결과 JSON을 재귀 탐색해 길이 ≥ 2인 float 리스트가 없고, 키 `embedding`/`feature`/`vector`가 없음.
  - `test_does_not_write_into_a_deleted_job_dir`: `read_frames` 도중 작업 폴더를 지우면 반환값 `None`, 폴더가 다시 생기지 않음.
  - `test_inherits_dismissed_when_previous_pieces_are_a_subset`: 이전 파일 `pieceIds=['t3'], dismissed=['t9']`, 새 요청 `['t3','t5']` → 새 결과 `dismissed == ['t9']`, `t9`는 `candidates`에 없음. 이전 `pieceIds=['t4']`면 이어받지 않음.
  - `test_truncation_keeps_longest_candidates`: 시간 제한에 걸리면 처리된 후보가 등장 프레임 수 상위 순서와 일치(R3).
  - `test_query_without_face_fails_with_message`: 대상 프레임 전부 embed None → `state == 'failed'`, 위 문구, `candidates == []`(R6).
  - `test_writes_candidate_thumbs_and_clears_old`: 후보마다 `thumbs/find_{pieceId}.jpg`가 생기고 결과 `candidates[i].thumb`가 그 경로, 다시 실행하면 이전 `find_*` 파일이 지워짐. 정렬된 얼굴 이미지 파일은 없음(R2).
- [ ] **Step 2:** `docker run --rm -v "$PWD/worker:/app/worker" -v "$PWD/contracts:/app/contracts:ro" face-mosaic-studio-worker pytest -q tests/test_findperson.py` → FAIL (모듈 없음).
- [ ] **Step 3:** 위 시그니처대로 구현. 대상 벡터 = 대상 조각들의 프레임(총 최대 `QUERY_FRAMES`) 벡터 평균의 정규화. 결과 문서 필드는 spec §4.4(`version, state, personKey, pieceIds, tracksVersion, splits, params, truncated, candidates, dismissed`). `personKey`는 `person_key` 인자 값.
- [ ] **Step 4:** 같은 명령 → PASS.
- [ ] **Step 5:** `git commit -m "feat(worker): find-person candidate scoring (in-memory embeddings)"`

### Task 3: SFace 임베더와 모델 체크섬

**Files:**
- Create: `worker/mosaic_worker/faceid.py`
- Modify: `worker/scripts/fetch_model.sh`, `worker/mosaic_worker/detect.py`(모델 경로 함수 재사용만, 동작 변경 없음)
- Test: `worker/tests/test_faceid.py` (`tests/assets/face.jpg` 사용)

**Interfaces:**
- Produces:
  - `SFACE_FILE = "face_recognition_sface_2021dec.onnx"`, `sface_model_path() -> Path` (`SFACE_MODEL_PATH` 환경변수 우선, 없으면 `worker/models/`).
  - `class FaceEmbedder: __call__(frame: np.ndarray, box: list) -> np.ndarray | None` — 확장 박스를 25% 되돌린 박스와 IoU ≥ 0.5인 YuNet 검출의 랜드마크로 `alignCrop` → `feature` → L2 정규화. 매칭 실패 시 None. `Embed` 타입을 만족.
  - `class FrameReader: __call__(video: Path, frame: int) -> np.ndarray | None` — 영상을 한 번 열어 두고 `CAP_PROP_POS_FRAMES`로 이동 후 읽음. 직전 프레임 다음이면 이동 없이 읽음. `ReadFrame` 타입을 만족(R3).

- [ ] **Step 1: 실패 테스트**
  - `test_same_face_is_similar`: `face.jpg`의 얼굴 박스로 두 번 임베딩 → 코사인 ≥ 0.99, 벡터 노름 1 ± 1e-5.
  - `test_blank_frame_returns_none`: 회색 단색 프레임 → None.
  - `test_frame_reader_returns_requested_frame`: 프레임마다 다른 색을 칠한 합성 영상(`tests/helpers.make_video`, 30프레임)에서 29 → 3 → 10 순서로 요청해도 각 프레임의 색이 맞음.
  - `test_fetch_script_checks_sha256`: `fetch_model.sh` 본문에 두 모델의 SHA-256 값이 모두 있음(문자열 검사).
- [ ] **Step 2:** `pytest -q tests/test_faceid.py` → FAIL.
- [ ] **Step 3:** `fetch_model.sh`를 모델별(파일명, URL, SHA-256) 루프로 바꾸고, 내려받은 뒤 `sha256sum`(없으면 `shasum -a 256`) 결과가 다르면 파일을 지우고 종료 코드 1. 이미 있는 파일도 해시를 검사.
- [ ] **Step 4:** `docker compose build worker` 성공(이미지 빌드 시 두 모델 내려받기와 해시 검사 통과), `pytest -q tests/test_faceid.py` → PASS.
- [ ] **Step 5:** `git commit -m "feat(worker): SFace embedder and checksum-verified model fetch"`

### Task 4: 찾기 큐와 전용 처리기

**Files:**
- Modify: `worker/mosaic_worker/main.py`, `worker/mosaic_worker/status.py`, `docker-compose.yml`
- Test: `worker/tests/test_main.py`

**Interfaces:**
- Consumes: Task 2 `find_person`, Task 3 `FaceEmbedder`, `FrameReader`.
- Produces:
  - `Q_FIND = "queue:find"`. 메시지 `{"jobId": str, "personKey": str, "pieceIds": [str]}`.
  - `Worker(r, data_dir, queues: list[str] | None = None)` — `queues`가 주어지면 `PRIORITY` 중 그 큐만 꺼낸다. 기본값은 지금과 같은 `[Q_PROPAGATE, Q_RENDER, Q_ANALYZE]`(find 제외).
  - 처리 중 목록을 처리기별로 나눈다(R1): 기본 처리기는 지금 키 `processing:worker`/`processing:worker:src` 그대로, find 처리기는 `processing:worker:find`/`processing:worker:find:src`. `requeue_processing()`은 자기 목록만 되돌린다. `_infer_queue`는 메시지에 `personKey`가 있으면 `Q_FIND`.
  - `main()`이 `--queues propagate,render,analyze|find` 인자를 받음.
  - `StatusWriter.set_find(job_id, state, progress=0, error="")` — 해시 `job:{id}:find`(`state, progress, error, updatedAt`), `expire` 21600초.
  - `do_find`: 메시지 검증(`personKey`, `pieceIds`는 `SAFE_ID` 형식), `running` → `find_person(...)` → `done`, 예외 시 `failed`와 사용자 문구 `"사람 찾기에 실패했습니다. 다시 시도해 주세요."`, 모델 파일 없음은 `"사람 찾기 모델이 없습니다. 관리자에게 문의해 주세요."`.
- [ ] **Step 1: 실패 테스트** (fakeredis 또는 기존 test_main의 가짜 Redis 패턴):
  - `test_default_worker_does_not_consume_find`: `queue:find`에 메시지가 있어도 기본 Worker의 `pop_next()`는 None.
  - `test_find_worker_consumes_only_find`: `queues=['queue:find']` Worker는 `queue:analyze`를 꺼내지 않음.
  - `test_do_find_sets_status_and_ttl`: 가짜 `find_person`으로 실행 → 해시 `state == 'done'`, `ttl > 0`.
  - `test_do_find_rejects_bad_piece_ids`: `pieceIds=['../x']` → `find_person` 호출 안 됨, 로그만.
  - `test_find_worker_restart_leaves_other_processing_alone`: `processing:worker`에 analyze 메시지가 있을 때 find 처리기의 `requeue_processing()`은 아무것도 되돌리지 않음. 반대도 같음(R1).
  - `test_infer_queue_find`: src 기록이 없는 `{jobId, personKey, pieceIds}` 메시지는 `queue:find`로 되돌아감(R1).
- [ ] **Step 2:** `pytest -q tests/test_main.py` → FAIL.
- [ ] **Step 3:** 구현. `docker-compose.yml`에 `worker-find` 서비스 추가(빌드 `./worker`, 같은 환경변수·볼륨, `command: ["python", "-m", "mosaic_worker.main", "--queues", "find"]`). 기존 `worker`는 명령을 바꾸지 않는다.
- [ ] **Step 4:** `pytest -q` 전체 PASS. `docker compose up -d --build --no-deps worker worker-find` 후 두 컨테이너 로그에 시작 줄.
- [ ] **Step 5:** `git commit -m "feat(worker): dedicated find-person queue consumer"`

### Task 5: API 엔드포인트와 기능 스위치

**Files:**
- Modify: `apps/api/src/config.ts`, `apps/api/src/jobs/queue.ts`, `apps/api/src/jobs/jobs.service.ts`, `apps/api/src/jobs/jobs.controller.ts`, `.env.example`(있다면), `README.md`
- Test: `apps/api/test/find-person.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `AppConfig.findPersonEnabled: boolean` (`env.FIND_PERSON_ENABLED === 'true'`).
  - `QUEUE_FIND = 'queue:find'`, `findKey = (id) => \`job:${id}:find\``.
  - `POST /jobs/:id/find-person` body `{personKey: string, pieceIds: string[]}` → 202 `{ok: true}`. `pieceIds`는 1~200개, 각각 현재 조각 ID(트랙 ID 또는 분할된 `tNa/tNb`)여야 함. 상태가 `queued|running`이면 409 `"이미 찾는 중입니다."`. 큐에 넣기 전 해시를 `queued`로, 만료 21600초.
  - `GET /jobs/:id/find-person` → `{state: 'none'|'queued'|'running'|'done'|'failed', progress: number, error: string, result: FindResult | null, stale: boolean}`. `stale` 계산은 spec §5.4.
  - `PUT /jobs/:id/find-person/dismissed` body `{pieceIds: string[]}` → 결과 파일의 `dismissed`에 합집합으로 저장. 상태가 `done`이 아니면 409.
  - 스위치가 꺼져 있으면 세 경로 모두 404.
  - `POST`마다 `Logger.log(\`find-person requested job=${id} user=${username}\`)`.
  - `removeJob`이 `findKey(id)`와 `job:${id}:manual:*` 키(SCAN)를 지운다.
- [ ] **Step 1: 실패 테스트** (`createApp({FIND_PERSON_ENABLED: 'true'})`, 기존 helpers 사용):
  - `404 on all three routes when the flag is off`
  - `202 queues {jobId, personKey, pieceIds} and sets queued with ttl`
  - `409 while queued or running`
  - `400 on unknown piece id or empty list`
  - `other user gets 404`
  - `GET returns result and stale=false; stale when splits changed` (결과 파일의 `splits`와 다른 edits를 PUT한 뒤)
  - `stale when tracks.json changed`
  - `PUT dismissed merges and is 409 before done`
  - `delete removes find and manual keys`
- [ ] **Step 2:** `cd apps/api && npx jest --testRegex 'test/.*\.e2e-spec\.ts$' find-person` → FAIL.
- [ ] **Step 3:** 구현. 해시는 Node `crypto.createHash('sha256')`, 앞 16자. 분할 비교는 `trackId` 순 정렬 후 `[trackId, frame]` 배열 비교. README에 스위치 설명과 "법무 승인 전에는 켜지 않는다" 한 줄.
- [ ] **Step 4:** 같은 명령 PASS, `npx jest`와 e2e 전체 PASS.
- [ ] **Step 5:** `git commit -m "feat(api): find-person endpoints behind FIND_PERSON_ENABLED"`

### Task 6: 웹 로직 (후보 정리와 추가)

**Files:**
- Create: `apps/web/src/lib/findPerson.ts`
- Modify: `apps/web/src/lib/api.ts`, `apps/web/src/lib/types.ts`
- Test: `apps/web/src/lib/findPerson.test.ts`

**Interfaces:**
- Consumes: `people(doc, edits) -> Person[]`, `groupPersons(doc, edits, keys)`, `setPersonVisible(edits, person, visible)`.
- Produces:
  - 타입 `FindResult { personKey; pieceIds: string[]; truncated: boolean; candidates: {pieceId: string; score: number}[]; dismissed: string[] }`, `FindStatus { state; progress; error; result: FindResult | null; stale: boolean }`.
  - `api.postFindPerson(id, {personKey, pieceIds})`, `api.getFindPerson(id): Promise<FindStatus>`, `api.putFindDismissed(id, pieceIds)`.
  - `MIN_FACE_PX = 60`, `hasLargePiece(doc: TracksDoc, person: Person): boolean` — 조각 박스 짧은 변 중앙값 /1.25 ≥ 60이고 검출 ≥ 15인 조각이 있는지.
  - `CandidateView { pieceId; score; checked: boolean; person: Person }`
  - `candidateViews(result: FindResult, doc: TracksDoc, edits: Edits, target: Person): CandidateView[]` — `dismissed` 제외, 대상에 이미 있는 조각 제외, **다른 그룹(isGroup이고 key ≠ target.key)에 속한 조각 제외**, 현재 존재하지 않는 조각 제외, `checked = score ≥ 0.6`, 점수 내림차순.
  - `addPiecesToPerson(doc, edits, target: Person, pieceIds: string[]): Edits` (`apps/web/src/lib/edits.ts`, R4) — 대상이 그룹이면 **그 그룹 ID와 이름을 유지**한 채 `trackIds`에 조각을 더하고, 아니면 대상 조각과 후보로 새 그룹을 만든다. 보임 규칙은 `groupPersons`와 같다(하나라도 가림이면 결과는 가림). 기존 `groupPersons`는 바꾸지 않는다.
  - `planAdd(doc, edits, target: Person, pieceIds: string[]): { edits: Edits; needsConfirm: boolean; added: string[] }` — `addPiecesToPerson` 사용. `needsConfirm = target.visible`. `needsConfirm`이면 반환하는 `edits`는 **아직 적용하지 않은 원래 edits**이고 `added`만 채운다.
  - `commitAdd(doc, edits, target: Person, pieceIds: string[]): Edits` — 확인 후 호출. `addPiecesToPerson` 후 같은 그룹 Person을 찾아 `setPersonVisible(…, true)`.
- [ ] **Step 1: 실패 테스트**
  - `hides pieces owned by another group`
  - `hides dismissed, missing and already-member pieces`
  - `checks only scores >= 0.6 and sorts by score`
  - `adding to a masked person never grows visible` — 무작위 edits 50개(fast-check 없이 시드 고정 루프)로 `planAdd` 전후 `edits.visible`의 집합이 같거나 부분집합.
  - `adding to a visible person needs confirm and changes nothing before it`
  - `commitAdd keeps the merged person visible and includes the added pieces`
  - `hasLargePiece false when all pieces are under 60px or under 15 detections`
  - `addPiecesToPerson keeps group id and label regardless of piece order` — 후보 조각이 대상 그룹의 첫 조각보다 앞 트랙이어도 그룹 ID·이름이 그대로(R4).
  - `addPiecesToPerson on an ungrouped target creates one group with both`
- [ ] **Step 2:** `cd apps/web && npx vitest run src/lib/findPerson.test.ts` → FAIL.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** 같은 명령 PASS, `npx vitest run && npx tsc --noEmit -p .` PASS.
- [ ] **Step 5:** `git commit -m "feat(web): find-person candidate logic"`

### Task 7: 웹 화면 (버튼, 후보 카드, 확인 대화상자)

**Files:**
- Create: `apps/web/src/studio/FindPersonCard.tsx`
- Modify: `apps/web/src/studio/TargetDetail.tsx`, `apps/web/src/pages/Studio.tsx`, `apps/web/src/styles.css`
- Test: `apps/web/src/studio/FindPersonCard.test.tsx`

**Interfaces:**
- Consumes: Task 6 전부.
- **순서(R7):** 이 Task는 효과·영역 브랜치(`spec/effects-and-regions`)가 `main`에 들어온 뒤 그 위에서 진행한다. 찾기 카드는 별도 컴포넌트로, 상세 패널의 효과 컨트롤 아래에 붙여 그 브랜치의 변경과 겹치는 줄을 최소화한다.
- Produces: `FindPersonCard({ jobId, doc, edits, target, thumbSrc, flushEdits: () => Promise<void>, onApply(edits: Edits) })`. [이 사람 더 찾기]는 `await flushEdits()`(대기 중인 편집 저장)가 성공한 뒤에만 `postFindPerson`을 부른다. 저장이 실패하면 요청하지 않고 `편집을 저장하지 못해 찾기를 시작하지 않았습니다`를 보여 준다(R5). `TargetDetail`은 `findEnabled: boolean`과 위 카드용 props를 받아 카드를 렌더한다. `Studio.tsx`는 첫 `getFindPerson` 404로 `findEnabled=false`를 정하고, `onApply`는 기존 편집 반영 경로(되돌리기 이력 포함)를 쓴다.
- 문구(그대로 사용):
  - 버튼 `이 사람 더 찾기`, 꺼짐 사유 `얼굴이 크게 나온 조각(60px 이상, 15프레임 이상)이 없어서 찾을 수 없습니다`
  - 진행 `찾는 중 {progress}%`
  - 없음 `찾을 수 있는 후보가 없습니다 (얼굴 60px 이상, 15프레임 이상 조각 기준)`
  - 일부 `시간 제한으로 일부 후보만 확인했습니다`
  - 무효 `편집이 바뀌어 다시 찾아야 합니다`
  - 추가 버튼 `선택한 조각을 이 사람에 추가`, 빼기 `아님`
  - 확인 `추가하면 {n}개 조각이 보이게 됩니다. 아래 조각이 모두 이 사람인지 확인해 주세요` / `추가하고 보이기` / `취소`
- [ ] **Step 1: 실패 테스트** (`@testing-library/react`, `api` 모킹)
  - `disables find when no large piece` (사유 문구 표시)
  - `polls until done and renders candidates with default checks`
  - `dismiss calls putFindDismissed and removes the tile`
  - `visible target: confirm dialog lists added thumbnails; cancel leaves edits untouched`
  - `stale result shows the message and no add button`
  - `card hidden when findEnabled is false`
  - `find waits for pending edits to save; save failure blocks the request`(R5)
  - `uses worker-made candidate thumbnails`: 후보 썸네일은 결과의 `candidates[i].thumb`(`thumbs/find_*.jpg`)(R2).
- [ ] **Step 2:** `npx vitest run src/studio/FindPersonCard.test.tsx` → FAIL.
- [ ] **Step 3:** 구현. 폴링 간격 1초, 카드가 닫히거나 대상이 바뀌면 중지. 썸네일은 `thumbSrc(candidate.thumb)`.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit -p .` PASS. 브라우저에서 `FIND_PERSON_ENABLED=true`로 Pexels 테스트 영상 작업에 대해 한 사람 찾기 → 후보 표시 → 가림 상태 추가 → 보임 상태 추가 확인 대화상자까지 확인하고 스크린샷.
- [ ] **Step 5:** `git commit -m "feat(web): find-person card in target detail"`

### Task 8: 스펙 개정과 기록

**Files:**
- Modify: `docs/superpowers/specs/2026-10-30-face-mosaic-studio-design.md` (§2 ReID 조항과 §1 범위 밖 목록의 R-Recog), `docs/progress-log.md`

- [ ] **Step 1:** R1 스펙의 "ReID/임베딩 금지(생체정보 회피 전제)"를 find-person spec §7 문구로 바꾸고, 범위 밖 목록의 "얼굴 인식/ReID(R-Recog)"에 "단, 이 사람 찾기(opt-in)는 2026-11-02 스펙 참조"를 덧붙인다.
- [ ] **Step 2:** 진행 로그에 구현 항목(커밋 SHA, 테스트 수, 남은 측정)을 추가.
- [ ] **Step 3:** `docs/` 전체에서 타사 제품명(영문·한글 표기 모두) 검색 결과 0건 확인.
- [ ] **Step 4:** `git commit -m "docs: amend R1 ReID clause for opt-in find-person; progress log"`

### Task 9: 출시 전 측정 (기능 스위치를 켜기 위한 조건, 코드 변경 없음)

- [ ] **Step 1:** 영상 3종(`test-media/pexels-students-10clips-1080p.mp4`, 파리 브이로그, 한국인 얼굴이 나오는 짧은 자체 촬영본 — 사용자가 제공)을 분석.
- [ ] **Step 2:** 영상마다 주요 인물 2~3명에 대해 찾기를 실행하고, 표시된 후보마다 "같은 사람/다른 사람/비얼굴"을 썸네일로 라벨링.
- [ ] **Step 3:** 기준값별(0.45~0.7, 0.05 간격) 기본 체크 후보 중 다른 사람 수, 표시 후보 오류 비율, 재현율, 실행 시간, `truncated` 여부 표.
- [ ] **Step 4:** 기본 체크에 다른 사람 0건이 되는 가장 낮은 값으로 `CHECK_SCORE`를 정하는 안을 사용자에게 제시. 변경 시 워커·웹 상수와 테스트를 함께 고친다.
- [ ] **Step 5:** 결과를 진행 로그에 남긴다. 스위치를 켜는 결정은 사용자와 법무 승인 후.

---

## Eng review (plan-eng-review, 2026-11-02)

Target: `docs/superpowers/plans/2026-11-02-find-person.md` (spec `docs/superpowers/specs/2026-11-02-find-person-design.md`), base commit `0302472`.

### Scope Challenge

- Reuse: `compose.split_fragments` (worker/mosaic_worker/compose.py:17) for pieces, `StatusWriter` pattern (status.py:59 `set_manual`) for status, manual-propagation API pattern (jobs.service.ts `requestManual`/`manualStatus`), `groupPersons`/`setPersonVisible` (edits.ts:22,37), `people()` (people.ts:30), existing thumbs. Nothing in the repo already embeds faces.
- Size: about 22 changed files, new modules `findperson.py`, `faceid.py`, `findPerson.ts`, `FindPersonCard.tsx`, one new compose service → complexity gate trips (8+ files).
- Search: no new framework pattern beyond OpenCV `FaceRecognizerSF` (already in the installed cv2 4.14, used by the 2026-11-02 probe) [Layer 1].
- TODOS.md: none in repo.
- Reality rows:
  - REALITY: premise-table finding unverified=1 (60px/0.45/0.6 thresholds are probe-derived on 2 videos, docs/progress-log.md "SFace 탐침") docs/superpowers/plans/2026-11-02-find-person.md:15
  - REALITY: already-done pass (no commits touching find-person paths since spec) worker/mosaic_worker/main.py:1
  - REALITY: surface-check finding (`--queues` flag does not exist yet; planned in Task 4; `processing:worker` key shared) worker/mosaic_worker/main.py:32
  - REALITY: binding-decisions pass (user: B approach, button-only, no stored vectors, confirm per group) docs/superpowers/specs/2026-11-02-find-person-design.md:13
  - REALITY: numbers finding (TIME_CAP_SEC 120 and MAX_CANDIDATES 300 are [estimated]; probe took several minutes for ~2,100 seeks [measured: 2026-11-02 probe]) docs/superpowers/plans/2026-11-02-find-person.md:15
  - REALITY: deferred-asks pass (no linked issue) docs/superpowers/plans/2026-11-02-find-person.md:1
  - REALITY: pr-count pass (one PR) docs/superpowers/plans/2026-11-02-find-person.md:1

### Findings

1. [CRITICAL] (confidence: 9/10) worker/mosaic_worker/main.py:32 — `PROCESSING = "processing:worker"` is one list shared by every consumer, and `requeue_processing()` (main.py:47) puts back *every* message in it at startup. With a second `worker-find` process, restarting either one re-queues messages the other is still processing (duplicate analyze/render). `_infer_queue` (main.py:59) would also route a find message without a src entry to analyze.
2. [CRITICAL] (confidence: 8/10) apps/web/src/lib/edits.ts:38-46 — `groupPersons` takes members in `people()` order (people.ts:72, piece order), and keeps the label only if `selected[0]` is a group. When a candidate piece sorts before the target group, the target's name is dropped and a new group id is minted. Task 6 `planAdd/commitAdd` builds on this.
3. [CRITICAL] (confidence: 8/10) apps/web/src/pages/Studio.tsx:82 — edits are saved with a 500 ms debounce. Task 5 validates `pieceIds` against on-disk edits, so a find started right after a split (t2a) can 400, or run against old splits.
4. [CRITICAL] (confidence: 9/10) worker/mosaic_worker/thumbs.py:56 — samples are stored as bytes with no frame index, and tracks.json `samples` lists paths only. Task 7's "그 조각 구간의 샘플" cannot be built; a split piece would show the whole track's thumbnail, which may be the other person — the reviewer's only check.
5. [INFORMATIONAL] (confidence: 7/10) docs/superpowers/plans/2026-11-02-find-person.md (Task 3 `read_frames_sequential`) — sequential decode of a 23-min 1080p video is ~42k frames; with TIME_CAP 120 s the cap likely hits first and truncation then drops *late-video* candidates, not low-priority ones. Seek-per-frame costs ≤1 GOP (1 s, keyframes every second since `f5a92ea`) per frame. [estimated]
6. [CRITICAL] (confidence: 8/10) spec §4.3 / Task 2 — no defined behavior when the query person has no frame where YuNet re-detects a face (all query frames fail): no query vector, every score undefined.
7. [INFORMATIONAL] (confidence: 7/10) apps/web/src/studio/TargetDetail.tsx — the effects/regions plan on branch `spec/effects-and-regions` puts per-target effect controls in TargetDetail (learning `effect-target-by-location`). Both plans edit the same component; parallel branches will conflict.
8. [INFORMATIONAL] (confidence: 7/10) Task 6 `hasLargePiece` vs Task 2 `select_candidates` — the 60 px / 15 detections rule lives in Python and TypeScript (hand-synced list). Mitigation folded into Task 6 tests (same fixture values); no separate decision.

### Decision ledger

(Records R1–R7 below are pending until answered.)

| ID | Choice | Answer (2026-11-02, AskUserQuestion) | State | Accepted scope |
|---|---|---|---|---|
| D1 | File arrangement (complexity gate) | 원래 구성 (권장) | approved | findperson.py / faceid.py split kept |
| R1 | Per-consumer processing lists (finding 1) | 처리기별 목록 (권장) | approved | Task 4 keys, `_infer_queue` find, 2 tests |
| R2 | Candidate display thumbnails (finding 4) | 후보 썸네일 저장 (권장) | approved | Task 2 `thumbs/find_{pieceId}.jpg`, Task 7 uses them, tests |
| R3 | Candidate-priority seek reading (finding 5) | 후보 우선 이동 (권장) | approved | Task 2 order, Task 3 `FrameReader`, tests; cap re-measured in Task 9 |
| R4 | `addPiecesToPerson` keeps id/label (finding 2) | 추가 전용 함수 (권장) | approved | Task 6 function + 2 tests; `groupPersons` unchanged |
| R5 | Flush edits before POST (finding 3) | 먼저 저장 (권장) | approved | Task 7 `flushEdits` + test |
| R6 | Query without face → failed + message (finding 6) | 안내하고 종료 (권장) | approved | Task 2 behavior + test |
| R7 | UI task after effects branch (finding 7) | 화면은 뒤에 (권장) | approved | Task 7 ordering note |

Scope Challenge result: scope accepted as-is (D1 kept the original arrangement). Approval readiness: PASS (D1, R1–R7, answers above).

### 1. Architecture

```
Studio ──flushEdits──▶ PUT /edits
   │ [이 사람 더 찾기]
   ▼
POST /jobs/:id/find-person ──(flag, owner, pieceIds vs disk edits, 409)──▶ Redis job:{id}:find=queued (ttl 6h)
   │                                                                      queue:find
   ▼                                                                         │
GET /jobs/:id/find-person ◀── find_person.json + stale(tracks hash, splits) ◀┤
   │                                                                         ▼
FindPersonCard ──addPiecesToPerson / setPersonVisible──▶ edits      worker-find (processing:worker:find)
                                                                     find_person(): pieces → query vec (fail if none)
                                                                     → candidates by length → seek, YuNet+SFace in memory
                                                                     → thumbs/find_*.jpg, find_person.json (no vectors)
```

- Design-twice: shape A (plan) = separate queue consumer writing a result file the API reads. Shape B = API calls a worker HTTP endpoint synchronously. B adds a server to the worker and blocks a request for minutes; A reuses the queue/status pattern the codebase already has (`requestManual`). Pick A.
- Red flags: hand-synced list (finding 8) — mitigated by shared fixture values in tests; split ownership — `find_person.json` written by worker (results) and API (`dismissed`): accepted because API writes only after `state == done` and the worker only rewrites on a new run that the API blocks with 409 while running.
- Production failure: worker-find crashes mid-run → hash stays `running` until TTL (6 h) and POST returns 409 for that long. Not covered → added to Implementation Tasks (T1).

Findings 1, 4, 5, 7 above. Dispositions: all accepted (R1, R2, R3, R7).

### 2. Code quality

Findings 2, 3, 6, 8 above. Dispositions: R4, R5, R6 accepted; 8 mitigated in tests (no decision needed).

### 3. Tests

```
CODE PATHS                                              USER FLOWS
[+] findperson.find_person                              [+] Find for a masked person
  ├── [PLANNED ★★★] candidates filter/overlap/split       ├── [PLANNED ★★] poll → candidates → add (Task 7)
  ├── [PLANNED ★★★] query has no face → failed (R6)       └── [PLANNED ★★★] masked stays masked (Task 6 property)
  ├── [PLANNED ★★★] time cap keeps longest (R3)         [+] Find for a visible person
  ├── [PLANNED ★★] thumbs written/cleared (R2)            └── [PLANNED ★★★] confirm dialog; cancel no-op (Task 7)
  └── [PLANNED ★★★] deleted job dir not recreated       [+] Split then find immediately
[+] main.Worker (find consumer)                           └── [PLANNED ★★] flush before POST (R5)
  ├── [PLANNED ★★★] queue isolation + restart (R1)      [+] Error states
  └── [GAP] stuck `running` after crash → 409 for 6 h      ├── [PLANNED ★★] stale result message
[+] API find-person                                       ├── [PLANNED ★★] no candidates / truncated copy
  ├── [PLANNED ★★★] flag off 404, owner 404, 409, 400      └── [GAP] worker-find not running → stays queued forever
  └── [PLANNED ★★★] stale on tracks/splits change
[+] render/compose
  └── [PLANNED ★★★] find_person.json does not change masks (spec §8.1)

COVERAGE (planned): 15/17 paths | GAPS: 2 (both "worker-find down/crashed")
```

- Test value cards for the two gaps go to Implementation Tasks T1.
- Test Plan artifact: written to the gstack project directory (see below).

### 4. Performance

- [INFORMATIONAL] (confidence: 6/10) Task 2 — up to 300 candidates × 5 frames + 10 query frames = 1,510 seeks; with 1 s GOP each seek decodes ≤ 30 frames (avg ~15) → ~22k decoded frames on a 23-min video, likely over 120 s on CPU. [estimated] Truncation now drops the lowest-priority candidates (R3); Task 9 measures the real cap. No new decision.
- Memory: one decoded 1080p frame at a time plus ≤ 1,510 × 128-float vectors in memory (< 1 MB). Fine.

### NOT in scope
- Cross-video identity, auto-grouping of strangers, auto-unmask (spec §1).
- Background effects/blur (separate effects plan).

### What already exists
- Queue/status/result-file pattern: manual propagation (`jobs.service.ts` `requestManual`/`manualStatus`, `main.py` `do_propagate`, `status.py` `set_manual`) — reused.
- Pieces: `compose.split_fragments` — reused so piece boundaries match render.
- Thumbnail crop: `thumbs.crop_thumb` — reused for candidate thumbnails.
- Grouping/visibility: `groupPersons`, `setPersonVisible` — `setPersonVisible` reused; `addPiecesToPerson` added beside `groupPersons` (R4).

### Failure modes
| Path | Failure | Covered | User sees |
|---|---|---|---|
| worker-find | process crash mid-run | GAP (T1) | 409 "이미 찾는 중입니다" for up to 6 h — silent-ish |
| worker-find | service not running | GAP (T1) | stays "찾는 중 0%" forever |
| query | no face re-detected | R6 test | clear message |
| job deleted mid-run | — | test | nothing (no dir recreated) |
| model missing | — | Task 4 message | clear message |
Critical gaps: 1 (crash/down → no clear error, no test) → T1.

### Worktree parallelization
| Step | Modules touched | Depends on |
|---|---|---|
| Task 1 | apps/api | — |
| Tasks 2–4 | worker/ | — |
| Task 5 | apps/api | Task 1 |
| Task 6 | apps/web/src/lib | — |
| Task 7 | apps/web | Task 6, effects branch merged (R7) |
| Task 8–9 | docs, manual measurement | Tasks 2–7 |

Lane A: Tasks 2 → 3 → 4 (worker/). Lane B: Task 1 → 5 (apps/api). Lane C: Task 6 (apps/web lib). Launch A + B + C; merge; Task 7 after the effects branch lands; then 8–9.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above.

- [ ] **T1 (P1, human: ~2h / CC: ~15min)** — worker/api — stale `running`/`queued` state
  - Surfaced by: Architecture / Failure modes — worker-find crash or not running leaves the job at 409 / 0% with no message.
  - Files: `worker/mosaic_worker/status.py`, `apps/api/src/jobs/jobs.service.ts`, `apps/api/test/find-person.e2e-spec.ts`
  - Change: worker refreshes `updatedAt` with progress at least every 10 s; API treats `queued|running` with `updatedAt` older than 60 s as `failed` with "사람 찾기가 중단됐습니다. 다시 시도해 주세요" and allows a new POST.
  - Verify: e2e `stale running state becomes failed and POST is accepted again`.
- [ ] **T2 (P1)** — R1–R7 amendments are already folded into Tasks 2–7 above; verify each listed test exists when the task lands.

### Outside voice (Codex, gpt-6-astra, plan-review) — 9 findings, all accepted

| ID | Finding (severity) | Answer | Accepted change |
|---|---|---|---|
| O1 | Result not bound to the selected person (High) | A) 적용 | see Amendments Task 6/7 |
| O2 | No stale check after polling ends (High) | A) 적용 | Task 6 |
| O3 | `flush()` is not a save barrier — Studio.tsx:87 clears `dirty` before awaiting and swallows errors (High, verified) | A) 적용 | Task 7 |
| O4 | Non-atomic admission; no request id (High) | A) 적용 | Task 2/4/5/6 |
| O5 | Held frames make same-person fragments "overlap" (High, verified: tracker.py hold) | "전부 권장안대로 진행" | Task 2 |
| O6 | Reused thumbnail names + 1 h cache — jobs.controller.ts:62 (High, verified) | A) 적용 | Task 2/5 |
| O7 | Dismissals lost after searching another person (Medium) | A) 적용 | Task 2/5 |
| O8 | Measurement cannot show recall or whole-piece safety (High) | A) 적용 | Task 9 |
| O9 | `FIND_PERSON_ENABLED` not forwarded in docker-compose.yml:10 (Medium, verified) | "전부 권장안대로 진행" | Task 5 |
| T1 | Crashed/absent worker-find leaves 409/0% (critical gap) | "전부 권장안대로 진행" | Task 4/5 |

## Amendments (approved)

- **Task 2**
  - (O5) "대상과 시간이 겹치는 조각" = 양쪽 **실제 검출 프레임(`scores` 키)** 이 하나라도 겹치는 경우만. 유지 구간(`frames`만 있는 프레임)만 겹치면 후보로 남긴다. 테스트 `held_tail_overlap_is_still_a_candidate`, `real_detection_overlap_is_excluded`.
  - (O4) `find_person(..., request_id: str, ...)`. 결과 문서에 `requestId`. 썸네일 이름은 (O6) `thumbs/find_{requestId}_{pieceId}.jpg`, 새 결과를 쓴 뒤 다른 `requestId`의 `find_*` 파일을 지운다.
  - (O7) 결과 파일에 `dismissed`를 두지 않는다. 별도 파일 `find_dismissed.json` = `{대상 조각 ID: [뺀 조각 ID]}`. 후보 계산 시 이번 대상 조각 중 하나라도 키로 있으면 그 목록을 모두 합쳐 제외. 테스트 `dismissed_survive_searching_another_person`. (앞서 계획한 "이전 pieceIds 부분집합이면 이어받기"는 이것으로 대체)
  - (T1) 후보 하나를 끝낼 때마다, 또 10초마다 진행 상태를 갱신(`progress` 콜백).
- **Task 4**
  - (O4) 메시지에 `requestId`. `do_find`는 Redis `job:{id}:find`의 `requestId`가 메시지와 다르면 건너뛴다(취소·대체된 요청).
  - (T1) `set_find`가 `updatedAt`을 갱신. 처리기 시작 시 자기 처리 목록에서 되돌린 find 메시지는 그대로 다시 실행.
- **Task 5**
  - (O4) `POST`: `requestId = randomUUID()`. Redis `WATCH job:{id}:find` → 상태가 `queued|running`이고 최신(아래 T1)이면 409 → `MULTI`로 해시 `{state: queued, requestId, updatedAt}` + 만료 + `LPUSH` → `EXEC` 실패 시 409. 응답 `{ok: true, requestId}`. `GET`/`PUT dismissed`에 `requestId` 포함, `PUT`은 body의 `requestId`가 현재 결과와 다르면 409.
  - (O7) `PUT /find-person/dismissed`는 `find_dismissed.json`에 `{결과의 대상 조각 ID 각각: 합집합}`으로 저장.
  - (O6) `GET /jobs/:id/thumbs/:name`은 이름이 `find_`로 시작하면 `Cache-Control: no-store`. (이름 자체도 요청마다 달라 이중 방어)
  - (T1) `queued|running`인데 `updatedAt`이 60초보다 오래되면 응답 `state: failed`, `error: "사람 찾기가 중단됐습니다. 다시 시도해 주세요"`, 새 `POST` 허용. e2e `stale running state becomes failed and POST is accepted again`.
  - (O9) `docker-compose.yml`의 `api.environment`에 `FIND_PERSON_ENABLED: ${FIND_PERSON_ENABLED:-false}` 추가, `worker-find`도 같은 이미지·볼륨. README와 `.env.example`(있으면)에 변수 설명. 검증: `docker compose config | grep FIND_PERSON_ENABLED`.
- **Task 6**
  - (O1) `candidateViews`, `planAdd`, `commitAdd`는 먼저 `resultMatchesTarget(result, target)`을 확인한다: 결과의 `pieceIds`가 모두 `target.trackIds`에 들어 있어야 한다. 아니면 빈 목록 / 예외 `FindResultMismatch`. 테스트 `result for another person shows nothing and cannot be added`.
  - (O2) `FindResult`에 `requestId`, `tracksVersion`, `splits`. `planAdd`/`commitAdd`는 `result.splits`가 현재 `edits.splits`와 다르면 예외 `FindResultStale`(확인 대화상자 단계 포함). 테스트 `split after result blocks add`.
- **Task 7**
  - (O3) `Studio.tsx`의 저장을 직렬화한다: 진행 중 저장 Promise를 보관하는 `saveChain`; `flushEdits()`는 진행 중 저장을 기다린 뒤 남은 변경을 저장하고, 실패하면 예외를 던진다(기존 화면 오류 표시는 유지). 자동 저장도 같은 경로를 쓴다. Studio 수준 테스트 `flushEdits waits for an in-flight save`, `flushEdits rejects when the save fails`.
  - (O1) 대상이 바뀌면 카드 상태를 초기화하고 진행 중 응답은 `requestId`로 무시.
- **Task 9**
  - (O8) 대상 인물마다 **모든 등장 조각**을 영상 재생으로 라벨링한다(같은 사람 / 다른 사람 / 비얼굴 / 두 사람 이상 섞인 조각). 기준값 조정용 영상과 평가용 영상을 나눈다(Pexels·파리 = 조정, 자체 촬영본 = 평가). 지표에 재현율, 섞인 조각이 기본 체크된 수(목표 0), 같은 작업을 기능 없이/있이 했을 때 검수 시간 비교를 넣는다.

Approval readiness: PASS (D1, R1–R7, O1–O9, T1; answers above, 2026-11-02).

### Unresolved decisions
None.

### Completion summary
- Step 0: Scope Challenge — scope accepted as-is
- Reality rows: 7/7 applicable rows emitted, 1 unverified premise (thresholds probe-derived)
- Architecture Review: 4 issues found (findings 1, 4, 5, 7)
- Code Quality Review: 4 issues found (findings 2, 3, 6, 8)
- Test Review: diagram produced, 2 gaps identified (worker-find crash/absent → T1)
- Performance Review: 1 issue found (seek cost, estimated)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed (no TODOS.md; all findings folded into tasks)
- Failure modes: 1 critical gap flagged (→ T1, accepted)
- Unresolved decisions: 0
- Outside voice: codex (gpt-6-astra), completed, 9 findings, all accepted
- Parallelization: 3 lanes, 3 parallel / Task 7–9 sequential
- Lake Score: 12/12

### Suppressed findings
- None.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex via `/plan-eng-review` | Independent 2nd opinion | 1 | completed | 9 findings, all accepted |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | issues_open | 11 issues, 1 critical gaps (all mapped to accepted tasks) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex (gpt-6-astra), phase plan-review, completed, 9 findings (7 High, 2 Medium), all accepted into Amendments.
- **CROSS-MODEL:** native review and codex overlapped on save ordering (native finding 3 vs O3, codex went deeper: `flush()` swallows errors) and staleness (spec §5.4 vs O2). Codex alone found O1, O4, O5, O6, O7, O8, O9.
- **VERDICT:** Eng review ran with all findings accepted into the plan (status issues_open = mapped work, not unresolved). Design review recommended next for Task 7 UI.

NO UNRESOLVED DECISIONS
