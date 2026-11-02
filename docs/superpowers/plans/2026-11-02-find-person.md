# 이 사람 찾기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 검수자가 고른 동의자 한 명과 비슷한 얼굴 조각을 버튼 실행으로 찾아 후보로 보여 주고, 확인한 조각만 그 사람에 묶는다.

**Architecture:** API가 `queue:find`에 요청을 넣고, 이 큐만 소비하는 별도 워커 처리기(`worker-find`)가 조각을 골라 YuNet 재검출 + SFace로 메모리에서만 비교해 `find_person.json`(조각 ID와 유사도)을 쓴다. 웹은 결과를 폴링해 상세 패널에 후보 카드를 띄우고, 추가는 기존 `groupPersons`/`setPersonVisible`로 처리한다. 기능 스위치 `FIND_PERSON_ENABLED`(기본 꺼짐)가 API에서 전체를 막는다.

**Tech Stack:** Python 3.12 (opencv `FaceDetectorYN`, `FaceRecognizerSF`, numpy, redis, pytest), NestJS + Jest/supertest(ioredis-mock), React 18 + Vitest.

**Spec:** [docs/superpowers/specs/2026-11-02-find-person-design.md](../specs/2026-11-02-find-person-design.md)

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
  - `ReadFrames = Callable[[Path, list[int]], Iterator[tuple[int, np.ndarray]]]`
  - `find_person(job_dir: Path, person_key: str, piece_ids: list[str], embed: Embed, read_frames: ReadFrames, *, clock=time.monotonic, progress: Callable[[int], None] | None = None) -> dict` — 결과 문서를 반환하고 `job_dir/"find_person.json"`에 쓴다(작업 폴더가 없으면 쓰지 않고 `None` 반환).
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
  - `test_reads_frames_once_in_order`: `read_frames`에 넘긴 프레임 목록이 오름차순이고 중복 없음.
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
  - `read_frames_sequential(video: Path, frames: list[int]) -> Iterator[tuple[int, np.ndarray]]` — 한 번 열어 순방향으로 읽고 요청 프레임만 내보냄. `ReadFrames` 타입을 만족.

- [ ] **Step 1: 실패 테스트**
  - `test_same_face_is_similar`: `face.jpg`의 얼굴 박스로 두 번 임베딩 → 코사인 ≥ 0.99, 벡터 노름 1 ± 1e-5.
  - `test_blank_frame_returns_none`: 회색 단색 프레임 → None.
  - `test_read_frames_sequential_yields_requested`: 합성 영상(`tests/helpers.make_video`, 30프레임)에서 `[3, 10, 29]` → 정확히 그 인덱스 3개.
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
- Consumes: Task 2 `find_person`, Task 3 `FaceEmbedder`, `read_frames_sequential`.
- Produces:
  - `Q_FIND = "queue:find"`. 메시지 `{"jobId": str, "personKey": str, "pieceIds": [str]}`.
  - `Worker(r, data_dir, queues: list[str] | None = None)` — `queues`가 주어지면 `PRIORITY` 중 그 큐만 꺼낸다. 기본값은 지금과 같은 `[Q_PROPAGATE, Q_RENDER, Q_ANALYZE]`(find 제외).
  - `main()`이 `--queues propagate,render,analyze|find` 인자를 받음.
  - `StatusWriter.set_find(job_id, state, progress=0, error="")` — 해시 `job:{id}:find`(`state, progress, error, updatedAt`), `expire` 21600초.
  - `do_find`: 메시지 검증(`personKey`, `pieceIds`는 `SAFE_ID` 형식), `running` → `find_person(...)` → `done`, 예외 시 `failed`와 사용자 문구 `"사람 찾기에 실패했습니다. 다시 시도해 주세요."`, 모델 파일 없음은 `"사람 찾기 모델이 없습니다. 관리자에게 문의해 주세요."`.
- [ ] **Step 1: 실패 테스트** (fakeredis 또는 기존 test_main의 가짜 Redis 패턴):
  - `test_default_worker_does_not_consume_find`: `queue:find`에 메시지가 있어도 기본 Worker의 `pop_next()`는 None.
  - `test_find_worker_consumes_only_find`: `queues=['queue:find']` Worker는 `queue:analyze`를 꺼내지 않음.
  - `test_do_find_sets_status_and_ttl`: 가짜 `find_person`으로 실행 → 해시 `state == 'done'`, `ttl > 0`.
  - `test_do_find_rejects_bad_piece_ids`: `pieceIds=['../x']` → `find_person` 호출 안 됨, 로그만.
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
  - `planAdd(doc, edits, target: Person, pieceIds: string[]): { edits: Edits; needsConfirm: boolean; added: string[] }` — 대상과 조각들의 person key로 `groupPersons`. `needsConfirm = target.visible`. `needsConfirm`이면 반환하는 `edits`는 **아직 적용하지 않은 원래 edits**이고 `added`만 채운다.
  - `commitAdd(doc, edits, target: Person, pieceIds: string[]): Edits` — 확인 후 호출. `groupPersons` 후 새 그룹 Person을 찾아 `setPersonVisible(…, true)`.
- [ ] **Step 1: 실패 테스트**
  - `hides pieces owned by another group`
  - `hides dismissed, missing and already-member pieces`
  - `checks only scores >= 0.6 and sorts by score`
  - `adding to a masked person never grows visible` — 무작위 edits 50개(fast-check 없이 시드 고정 루프)로 `planAdd` 전후 `edits.visible`의 집합이 같거나 부분집합.
  - `adding to a visible person needs confirm and changes nothing before it`
  - `commitAdd keeps the merged person visible and includes the added pieces`
  - `hasLargePiece false when all pieces are under 60px or under 15 detections`
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
- Produces: `FindPersonCard({ jobId, doc, edits, target, thumbSrc, onApply(edits: Edits) })`. `TargetDetail`은 `findEnabled: boolean`과 위 카드용 props를 받아 카드를 렌더한다. `Studio.tsx`는 첫 `getFindPerson` 404로 `findEnabled=false`를 정하고, `onApply`는 기존 편집 반영 경로(되돌리기 이력 포함)를 쓴다.
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
- [ ] **Step 2:** `npx vitest run src/studio/FindPersonCard.test.tsx` → FAIL.
- [ ] **Step 3:** 구현. 폴링 간격 1초, 카드가 닫히거나 대상이 바뀌면 중지. 썸네일은 `thumbSrc(person.thumb)`, 분할 조각이면 썸네일 위에 `분할된 조각` 배지.
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
