# 효과 종류·배경 효과·타원/다각형 영역 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 가리는 범위는 그대로 두고, 가리는 방식(모자이크·블러·단색, 배경 효과, 타원·다각형 수동 영역)을 worker 렌더와 웹 미리보기에 같은 규칙으로 추가한다.

**Architecture:** worker `compose.mask_regions`가 프레임별 Region(모양+효과+블록) 목록을 만들고, `render`는 배경 효과를 프레임 전체에 칠한 뒤 Region을 원본 기준으로 덮어쓴다. 웹은 같은 규칙의 `maskRegions`와 `effects.ts`로 미리보기를 그린다. 기하 일치는 `contracts/fixtures`의 공유 fixture로 양쪽에서 검증한다.

**Tech Stack:** Python 3.11 + OpenCV + numpy (pytest), NestJS (jest), React 18 + Vite + canvas (vitest).

**Spec:** `docs/superpowers/specs/2026-11-02-effects-and-regions-design.md`

## Global Constraints

- edits.json은 `version: 1` 유지. 누락 필드 기본값: `effects = { default: {type:"mosaic", strength:1}, background: null, overrides: {} }`, `manual[].shape = "rect"`.
- `Effect.type ∈ {"mosaic","blur","color"}`. `"none"` 등 그 밖의 값은 거부. 노출은 `visible`로만.
- `strength`: 정수 1–5, 기본 1. 배율 `k(s) = 1 + 0.5·(s − 1)`.
- `color`: `#rrggbb`, 기본 `#000000`.
- 대상 mosaic 블록 = `round(base·k)`, base = 트랙 `blockSize` 또는 수동 `max(8, min(w,h)//8)`. 대상 blur σ = `max(min(w,h)/4, 2)·k`.
- 배경 mosaic 블록 = `round(max(8, min(W,H)//40)·k)`. 배경 blur σ = `(min(W,H)/60)·k`, ¼ 축소 → 블러 → 원크기 확대.
- 자동 트랙 Region은 항상 `shape: "rect"`.
- 모양 마스크는 OpenCV를 쓰지 않고 worker(`shapes.py`)·web(`shapes.ts`)의 같은 순수 래스터 규칙으로 만든다: 픽셀 중심 (x+0.5, y+0.5)가 모양 안이면 포함. 타원 `((px−cx)/rx)² + ((py−cy)/ry)² ≤ 1`(cx = x+w/2, rx = w/2), 다각형 even-odd. 박스 w 또는 h < 4면 rect. 공유 fixture `shape-masks.json`으로 두 구현의 비트맵을 비교한다. 미리보기 경계 확장은 하지 않는다.
- 다각형 좌표 변환은 스펙 §4.1: `P = center(B) + (D.xy + (u·D.w, v·D.h) − center(D)) ⊙ (B.w/A.w, B.h/A.h)` (D = 그린 앵커 박스, A = 가장 가까운 앵커 프레임의 전파 박스, B = 이 프레임의 박스), 정수 반올림 `floor(x + 0.5)`.
- 그룹 소속 판정: 그룹의 `trackIds`에 트랙 id **또는** 분할 조각 id가 있으면 소속.
- Region 처리 예외 → 로그 후 실패 목록에 넣고, 모든 영역 처리 뒤 실패 박스(프레임 안, 모양 무시)를 검정으로 칠한다. 배경 처리 예외 → 렌더 실패(`MSG_RENDER_FAILED`). 프레임 디코딩 실패 → 회색 `#6b6f7a`.
- 웹 미리보기는 영역마다 같은 `block`의 mosaic를 먼저 불투명하게 깔고 그 위에 효과를 그린다. blur는 박스보다 `ceil(3σ)` 넓은 소스(프레임 안 클램프)를 흐려 박스만 쓴다. `ctx.filter`가 지원되지 않으면 blur 단계를 건너뛴다(밑에 깐 mosaic가 보임). 원본이 보이는 경로는 없다.
- 공유 fixture(`contracts/fixtures/*.sample.json`)는 항상 API 검증을 통과하는 유효한 edits여야 한다. 우선순위·오래된 키 같은 경계 케이스는 각 테스트 파일 안의 로컬 데이터로 만든다.
- 저장 실패 시 렌더 요청을 보내지 않는다.
- 공개 저장소: 커밋 메시지·파일·브랜치에 타사 서비스 이름을 쓰지 않는다.
- 테스트 명령: worker `cd worker && pytest`, api `cd apps/api && npx jest` / `npm run test:e2e`, web `cd apps/web && npx vitest run && npm run typecheck`.

## Review Focus

1. **아주 작은 수동 영역(w 또는 h < 4px)의 타원·다각형**: 다각형이 한 점으로 뭉개져도 영역은 가려져야 한다 → 박스가 4px 미만이면 모양을 rect로 처리 (Task 2 `test_tiny_shape_falls_back_to_rect`, `shape-masks.json` 3×3 케이스로 web도 동일).
2. **프레임 밖으로 걸친 타원·다각형 박스**: 마스크는 잘리지 않은 박스 좌표로 그린 뒤 프레임과 교집합만 칠해야 한다 (Task 2 `test_shape_mask_clipped_at_frame_edge`).
3. **사라진 대상을 가리키는 override**(그룹 해제·분할 취소 뒤 남은 키): 저장 시 API가 거부하지만, 이미 저장된 파일에서는 worker·웹 모두 무시하고 default를 쓴다 (Task 1 `test_unknown_override_key_ignored`, Task 4 동일).
4. **배경 효과 켜짐 + 프레임 디코딩 전(미리보기)**: 원본이 보이면 안 된다 → 콘텐츠 영역 전체를 회색으로 채움 (Task 5 `background grey when not ready`).
5. **strength·color 누락 또는 효과 객체 일부만 있는 edits**: 기본값으로 채워 렌더·미리보기가 같은 결과 (Task 1 `test_effect_defaults_filled`, Task 4 `normalizeEdits fills effect defaults`).

---

### Task 1: 공유 fixture + worker `mask_regions` + 효과 파라미터

**Files:**
- Create: `worker/mosaic_worker/effects.py` (파라미터 계산만; 픽셀 연산은 Task 2)
- Modify: `worker/mosaic_worker/compose.py` (`mask_boxes` 제거 → `mask_regions`)
- Modify: `contracts/fixtures/edits.sample.json`, `contracts/fixtures/manual.sample.json`, `contracts/README.md`
- Create: `contracts/fixtures/expected-regions.json`, `contracts/fixtures/effect-params.json` (기존 `expected-mask-frames.json`은 웹 `fixtures.ts`가 아직 쓰므로 Task 4에서 삭제)
- Test: `worker/tests/test_compose.py`, `worker/tests/test_effects_params.py`

**Interfaces:**
- Produces (Python):
  - `effects.normalize_effects(edits: dict) -> dict` — `{default, background, overrides}`를 기본값으로 채워 반환. 각 Effect는 `{type, strength, color}` 모두 채움.
  - `effects.strength_factor(s: int) -> float`
  - `effects.region_block(base: int, s: int) -> int`, `effects.region_sigma(w: int, h: int, s: int) -> float`
  - `effects.background_block(W: int, H: int, s: int) -> int`, `effects.background_sigma(W: int, H: int, s: int) -> float`
  - `compose.Region = TypedDict{id: str, shape: str, box: list[int], points: list[list[int]] | None, effect: dict, block: int}`
  - `compose.mask_regions(tracks_doc: dict, edits: dict, manual: list[dict]) -> dict[int, list[Region]]` — (x, y) 정렬, 빈 프레임 없음.
  - `compose.effect_for(piece_id: str, track_id: str, edits: dict) -> dict` — 스펙 §3.2 순서.
- Produces (fixture): `expected-regions.json` = `{ "<frame>": [Region, ...] }`, `effect-params.json` = `{ "cases": [{fn, args, expected}] }`.

- [ ] **Step 1: fixture 갱신**
  - `edits.sample.json`: `effects = { default: {type:"mosaic",strength:1}, background: {type:"blur",strength:2}, overrides: { "t3": {type:"blur",strength:3}, "m1": {type:"color",color:"#ff0000"} } }` 추가. `m1`에 `"shape":"ellipse"`, 새 수동 `m3` = `{shape:"polygon", points:[[0,0],[1,0],[0.5,1]], anchors:[{frame:60, box:[100,100,60,40]}], trim:null, deleted:false}` 추가. 그룹·존재하지 않는 키는 공유 sample에 넣지 않는다(`people.test.ts:4-14`가 같은 sample로 인물 목록을, `jobs.e2e-spec.ts:187-190`이 같은 sample의 PUT 200을 검증한다).
  - `manual.sample.json`: 변경 없음(m3는 전파 문서 없음 → 앵커 대체 경로).
  - `expected-regions.json`: 프레임 0/44/45/47/60/89. 손으로 계산해 쓰고, 각 Region의 `block`은 Global Constraints 공식대로.
  - `effect-params.json`: `region_block(10,1)=10`, `region_block(10,3)=20`, `region_block(8,5)=24`, `region_sigma(80,80,1)=20.0`, `region_sigma(4,4,1)=2.0`, `region_sigma(40,64,2)=15.0`, `background_block(640,360,1)=9`, `background_block(1920,1080,5)=81`, `background_sigma(640,360,1)=6.0`, `background_sigma(1920,1080,3)=36.0`.

- [ ] **Step 2: 실패하는 테스트 작성**

```python
# test_effects_params.py
def test_matches_shared_effect_params(): ...  # effect-params.json의 모든 case를 fn 이름으로 호출해 == expected (float는 abs 1e-9)

# test_compose.py (기존 테스트는 mask_regions + box/block 비교로 옮김)
def test_matches_expected_regions_exactly():
    assert mask_regions(tracks, edits, manual) == {int(k): v for k, v in expected.items() if k != "_comment"}
def test_auto_tracks_always_rect():  # overrides가 있어도 트랙 Region.shape == "rect", points is None
def test_group_override_beats_track_override(): # 로컬 edits: sample + groups=[{id:"g1",trackIds:["t3"],label:""}] + overrides g1=color, t3=blur → t3 Region effect.type == "color"
def test_split_piece_override_beats_group():    # 로컬 edits: g1=[t2] color + overrides["t2a"]=blur → t2a Region은 blur
def test_unknown_override_key_ignored():        # 로컬 edits: overrides["t9"] 추가 → 예외 없음, 결과는 추가 전과 동일
def test_polygon_points_absolute():             # m3 프레임 60(앵커 대체, 전파 문서 없음): points == [[100,100],[160,100],[130,140]]
def test_polygon_exact_at_anchor_with_expanded_doc(): # 로컬 manual doc: 앵커 프레임 박스가 25% 확장된 [93,95,75,50] → 그 프레임 points는 그린 다각형과 동일
def test_polygon_follows_box_translate_and_scale():   # 로컬 doc: 다음 프레임 박스가 (+10,+0) 이동·폭 2배 → 꼭짓점이 center 기준 이동·x 2배 (Global Constraints 공식)
def test_group_membership_after_split():        # edits = web splitTrack이 만드는 형태(g1.trackIds=["t2a","t2b"]) + overrides g1=color → t2a, t2b Region 모두 color
def test_effect_defaults_filled():              # effects 누락 edits → 모든 Region effect == {"type":"mosaic","strength":1,"color":"#000000"}
def test_mask_set_unchanged_by_effects():       # 같은 edits에서 effects/shape만 바꿔도 [(f, r["box"]) ...] 집합 동일 (스펙 불변식 1)
```

- [ ] **Step 3: 실패 확인** — Run: `cd worker && pytest tests/test_compose.py tests/test_effects_params.py -v` → ImportError `mask_regions`.

- [ ] **Step 4: 구현** — `effects.py`의 함수들(정수 결과는 Python `round`가 아니라 `int(x + 0.5)`로 반올림; 웹 `Math.round`와 같게). `compose.mask_regions`는 기존 `mask_boxes`의 선정 로직을 그대로 두고 Region dict를 만든다. 다각형 절대좌표는 Global Constraints의 변환 공식(앵커 대체 경로에서는 D에 그대로). "가장 가까운 앵커" = 프레임 거리 최소, 동률이면 앞 앵커. 수동 Region의 shape·points는 edits 항목에서(항목이 없는 수동 문서는 rect, default 효과). `mask_boxes`와 `MaskBox`는 삭제.

- [ ] **Step 5: 통과 확인** — `render.py`는 이 Task에서 `mask_regions` 결과를 `(*r["box"], r["block"])`로 바꿔 기존 `pixelate`에 넘기도록만 고친다(효과·모양은 Task 2). Run: `cd worker && pytest` → 전체 PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(worker): mask regions with shape and effect, shared fixtures"`

### Task 2: worker 효과 픽셀 연산 + render 합성 순서

**Files:**
- Modify: `worker/mosaic_worker/effects.py` (픽셀 연산 추가), `worker/mosaic_worker/render.py`
- Create: `worker/mosaic_worker/shapes.py` (순수 래스터), `contracts/fixtures/shape-masks.json` (케이스별 박스·모양·기대 비트맵 행 문자열 `"0110…"`: 타원 [0,0,7,5], [0,0,41,31]의 일부 행, 오목 다각형, 자기 교차 다각형, 3×3 tiny)
- Test: `worker/tests/test_render.py`, `worker/tests/test_shapes.py`

**Interfaces:**
- Consumes: Task 1의 `mask_regions`, `normalize_effects`, 파라미터 함수들.
- Produces:
  - `shapes.shape_bitmap(shape: str, w: int, h: int, points: list[list[int]] | None) -> np.ndarray[bool]` — 박스 원점 기준 (h, w) 비트맵, Global Constraints의 픽셀 중심 규칙. points는 박스 원점 기준 정수 좌표.
  - `effects.shape_mask(region: dict, frame_w: int, frame_h: int) -> tuple[slice, slice, np.ndarray[bool]]` — `shape_bitmap`을 프레임과 교집합으로 자른 것.
  - `effects.apply_region(src: np.ndarray, out: np.ndarray, region: dict) -> None` — src 기준으로 효과를 계산해 out에 마스크만큼 덮어씀.
  - `effects.apply_background(src: np.ndarray, effect: dict) -> np.ndarray`
  - `render.compose_frame(src: np.ndarray, regions: list[dict], background: dict | None, log) -> np.ndarray` — 스펙 §4.2 순서. 영역 예외는 `log(str)` 후 실패 목록에 넣고, 모든 영역 뒤에 실패 박스를 검정으로 칠함.
  - `pixelate`는 `effects.py`로 옮기고 `render.pixelate`는 재노출(기존 테스트 import 유지).

- [ ] **Step 1: 실패하는 테스트 작성**

```python
def test_rect_mask_covers_whole_box_and_outside_untouched(): ...
# test_shapes.py
def test_matches_shared_shape_masks():                # shape-masks.json 모든 케이스의 비트맵이 정확히 같음
def test_ellipse_corners_excluded_center_included():  # [0,0,41,31]: (0,0) False, (20,15) True
def test_tiny_shape_falls_back_to_rect():             # box [5,5,3,3] polygon → 9픽셀 모두 True
def test_shape_mask_clipped_at_frame_edge():          # 박스 [-10,-10,40,40] ellipse: 반환 slice가 프레임 안, 마스크 모양은 잘리지 않은 타원의 해당 부분
def test_color_effect_fills_exact_color_inside_mask_only(): ...
def test_blur_floor_removes_detail():                  # helpers의 얼굴 합성 이미지 crop, s=1: cv2.Laplacian 분산 비 (blurred/orig) < 0.02
def test_mosaic_strength_scales_block():               # s=3 → _cells_uniform(block=round(base*2))
def test_background_then_regions_from_src():           # bg=color 파랑, region=color 빨강: region 안 빨강, 밖 파랑; region이 blur면 입력은 src(파랑 아님)
def test_visible_face_gets_background():               # visible 트랙 위치 픽셀이 bg 효과를 받음
def test_region_error_paints_black(monkeypatch):       # apply_region 또는 shape_mask가 예외 → 프레임 안 박스 전체 == 0(모양 무시), log 호출됨, 다른 영역 정상
def test_failed_region_black_survives_overlap(monkeypatch): # 영역 A 실패, 이후 처리되는 영역 B(color 빨강)가 A와 겹침 → 겹친 픽셀도 0
def test_background_error_fails_render(monkeypatch):   # apply_background 예외 → render()가 UserFacingError(MSG_RENDER_FAILED), output.mp4 생성 안 됨
def test_render_end_to_end_with_effects(tmp_path): ... # 기존 render 통합 테스트에 effects/ellipse 추가, 출력 프레임에서 ellipse 밖 박스 모서리가 원본과 같음(허용 오차는 기존 테스트와 동일)
```

- [ ] **Step 2: 실패 확인** — `cd worker && pytest tests/test_render.py -v` → ImportError.

- [ ] **Step 3: 구현**
  - `shape_bitmap`: numpy 그리드로 픽셀 중심 좌표를 만들어 타원 부등식 / even-odd 교차 수 판정(변마다 벡터 연산). `shape_mask`는 잘리지 않은 박스 비트맵을 프레임 교집합으로 자른다.
  - blur: `cv2.GaussianBlur(crop, (0,0), sigmaX=σ, borderType=cv2.BORDER_REPLICATE)`. 배경 blur는 `INTER_AREA`로 ¼ 축소 → σ/4로 블러 → `INTER_LINEAR` 확대.
  - mosaic: 기존 `pixelate`를 Region 박스·`region["block"]`으로 호출한 결과를 임시 버퍼에 만들고 마스크만 복사. 배경 mosaic는 박스 = 프레임 전체.
  - color: `#rrggbb` → BGR.
  - `render()`: `mask_regions` + `normalize_effects(edits)["background"]`로 `compose_frame` 호출. 배경 예외는 기존 `MSG_RENDER_FAILED` 경로.
- [ ] **Step 4: 통과 확인** — `cd worker && pytest` 전체 PASS. Laplacian 비가 0.02를 넘으면 기준을 느슨하게 하지 말고 측정값과 함께 멈추고 보고.
- [ ] **Step 5: Commit** — `git commit -m "feat(worker): blur, color and shaped regions with background effect in render"`

### Task 3: API 검증기

**Files:**
- Modify: `apps/api/src/jobs/edits.validator.ts`
- Create: `apps/api/src/jobs/edits.validator.spec.ts`
- Modify: `apps/api/test/jobs.e2e-spec.ts` (edits describe에 1케이스)

**Interfaces:**
- Produces: `validateEdits(e, trackIds: Set<string>, reviewIds: Set<string>): string | null` (시그니처 동일), `DEFAULT_EDITS()`에 `effects` 기본값 포함.

- [ ] **Step 1: 실패하는 테스트** (`edits.validator.spec.ts`, 기본 edits = `DEFAULT_EDITS()` + 트랙 `t1,t2`)
  - 허용: effects 누락, `effects.background: null`, overrides 키가 트랙/분할 조각(`t2a`)/그룹 id/수동 id, polygon 3점, shape 누락.
  - 거부(문자열 반환): `type:"none"`, `type:"pixel"`, `strength:0`, `strength:6`, `strength:2.5`, `color:"red"`, `color:"#fff"`, override 키 `"t9"`, `shape:"star"`, polygon인데 points 없음, points 2개, 좌표 `[1.2, 0]`, rect인데 points 있음.
  - 알 수 없는 override 메시지: `알 수 없는 대상입니다: t9`.
- [ ] **Step 2: 실패 확인** — `cd apps/api && npx jest src/jobs/edits.validator.spec.ts`
- [ ] **Step 3: 구현** — `effects`가 있으면 객체여야 하고, `default`는 Effect, `background`는 Effect|null, `overrides`는 키별 Effect. override 키 허용 집합 = `known`(트랙+분할 조각) ∪ 그룹 id ∪ 수동 id. 형식 오류는 기존 `bad` 메시지.
- [ ] **Step 4: e2e 1케이스** — `PUT /edits`에 `type:"none"` → 400. `npm run test:e2e` PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): validate effects and manual region shapes in edits"`

### Task 4: 웹 타입·기본값·`maskRegions`·편집 함수

**Files:**
- Modify: `apps/web/src/lib/types.ts`, `apps/web/src/lib/edits.ts`, `apps/web/src/lib/masks.ts`, `apps/web/src/lib/fixtures.ts` (`expected-mask-frames.json` → `expected-regions.json`, `effect-params.json` 추가), `apps/web/src/pages/Studio.tsx:20,222`
- Delete: `contracts/fixtures/expected-mask-frames.json` (worker `test_compose.py`도 이 시점엔 이미 `expected-regions.json`만 씀)
- Create: `apps/web/src/lib/effectParams.ts`
- Test: `apps/web/src/lib/masks.test.ts`, `apps/web/src/lib/edits.test.ts`, `apps/web/src/lib/effectParams.test.ts`

**Interfaces:**
- Produces (TS):
  - `type EffectType = 'mosaic' | 'blur' | 'color'`; `interface Effect { type: EffectType; strength: number; color: string }`; `interface Effects { default: Effect; background: Effect | null; overrides: Record<string, Effect> }`; `type Shape = 'rect' | 'ellipse' | 'polygon'`.
  - `ManualEdit`에 `shape?: Shape; points?: [number, number][]`. `Edits`에 `effects?: Effects`.
  - `interface Region { id: string; shape: Shape; box: Box; points: [number, number][] | null; effect: Effect; block: number }`.
  - `effectParams.ts`: `strengthFactor`, `regionBlock`, `regionSigma`, `backgroundBlock`, `backgroundSigma` — Task 1과 같은 이름(camelCase), `Math.round`.
  - `maskRegions(doc, edits, manual): Map<number, Region[]>`; `maskBoxes`·`MaskBox` 삭제.
  - `edits.ts`: `normalizeEdits`가 effects 기본값을 채움. 새 함수 `setTargetEffect(edits, targetId: string, effect: Effect | null): Edits`(null = override 제거), `setDefaultEffect(edits, effect: Effect): Edits`, `setBackgroundEffect(edits, effect: Effect | null): Edits`. `addManualEdit`은 `shape`/`points`를 그대로 보존. `groupPersons`는 없어지는 그룹 키의 override를 지우고 첫 선택 인물의 override(인물 key 기준)가 있으면 새 그룹 id로 옮긴다. `deleteManual`은 그 id의 override를 지운다.
- [ ] **Step 1: 실패하는 테스트**
  - `masks.test.ts`: `maskRegions(tracksDoc, edits, manualDocs)`를 `expected-regions.json`과 `toEqual`(Map → 객체 변환). 기존 개별 케이스는 Region 형식으로 옮김. 추가(로컬 데이터): 그룹 > 트랙, 분할 조각 > 그룹 우선순위, 알 수 없는 override 키 무시, edits 항목 없는 수동 문서도 가림(Python과 일치하도록 동작 변경).
  - `effectParams.test.ts`: `effect-params.json` 전 케이스.
  - `edits.test.ts`: `normalizeEdits fills effect defaults`(effects 누락·strength 누락·color 누락), `setTargetEffect(…, null)`이 키 제거, `setBackgroundEffect(null)`, `groupPersons moves first override and drops stale group keys`(g1 override 보유 인물과 t3 병합 → overrides에 g1 없음, 새 그룹 id에 g1의 효과), `deleteManual drops its override`.
  - `masks.test.ts` 추가: `group membership after real splitTrack`(실제 `splitTrack` 결과 edits + 그룹 override → 두 조각 모두 적용).
- [ ] **Step 2: 실패 확인** — `cd apps/web && npx vitest run src/lib`
- [ ] **Step 3: 구현** — `maskRegions`는 Python과 한 줄씩 대응(수동 문서 순회 기준을 Python처럼 manual 문서 + 앵커 대체로 바꿈). `Studio.tsx`의 `masks` memo는 `maskRegions`로. 이 시점에 `PlayerOverlay`/`Filmstrip`이 Region을 받도록 타입만 맞추고, 그리기는 Task 5에서 바꾼다(임시로 `effect` 무시하고 rect mosaic로 그려 녹색 유지).
- [ ] **Step 4: 통과 확인** — `npx vitest run && npm run typecheck` PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): mask regions, effect params and effect edits"`

### Task 5: 웹 미리보기 `effects.ts`

**Files:**
- Create: `apps/web/src/lib/effects.ts` (기존 `pixelate.ts` 내용 이동 후 삭제), `apps/web/src/lib/effects.test.ts`, `apps/web/src/lib/shapes.ts`, `apps/web/src/lib/shapes.test.ts`
- Modify: `apps/web/src/studio/PlayerOverlay.tsx:66`, `apps/web/src/studio/Filmstrip.tsx:124-126`, `apps/web/src/lib/filmstrip.ts` (`scaleBoxes`/`boxesForThumb` → Region 버전 `scaleRegions`/`regionsForThumb`)

**Interfaces:**
- Consumes: `Region`, `Effects`, `effectParams.ts`.
- Produces:
  - `PixelSource` (기존 그대로).
  - `drawFrameEffects(ctx, src: PixelSource, off: HTMLCanvasElement, regions: Region[], background: Effect | null, rect: Rect, srcW: number, srcH: number): void` — 배경 → 영역 순서.
  - `shapes.ts`: `shapeBitmap(shape: Shape, w: number, h: number, points: [number, number][] | null): Uint8Array` — Python `shape_bitmap`과 같은 규칙(행 우선, 1 = 포함).
  - `effects.ts` 영역 그리기 순서: (1) 소스 픽셀 크기 오프스크린에 같은 `block`의 mosaic를 불투명하게 그림 (2) 효과(blur: 박스보다 `ceil(3σ)` 넓은 소스를 흐려 박스만 복사, `ctx.filter` 미지원이면 생략 / color: 채움) (3) `shapeBitmap`으로 만든 알파 마스크를 `destination-in`으로 적용(마스크 픽셀 알파는 0 또는 255) (4) 표시 크기로 `imageSmoothingEnabled=false` 확대해 오버레이에 그림.
- [ ] **Step 1: 실패하는 테스트**
  - `shapes.test.ts`: `matches shared shape masks`(`shape-masks.json` 전 케이스 일치 — worker와 같은 fixture).
  - `effects.test.ts`(호출 기록용 가짜 ctx — 기존 `PlayerOverlay.test.tsx` 방식):
  - `not ready → grey fill over every region box`
  - `background grey when not ready`: background != null이고 ready=false → `fillRect(rect.x, rect.y, rect.w, rect.h)` 회색.
  - `background drawn before regions` (호출 순서).
  - `opaque mosaic underlay drawn before blur`: blur Region에서 mosaic 그리기 호출이 blur 호출보다 먼저.
  - `blur samples a margin of ceil(3σ) around the box`: blur용 `drawImage` 소스 사각형이 박스보다 `ceil(3σ)`(프레임 안 클램프) 넓음.
  - `mask uses shapeBitmap alpha with destination-in`: ellipse Region에서 `putImageData`로 넣은 마스크 알파가 `shapeBitmap` 결과와 같고(0/255), 합성 모드가 `destination-in`.
  - `color effect uses region color`, `blur uses filter blur(σ px)` (σ = `regionSigma`, 소스 픽셀 단위 오프스크린).
  - `blur skipped when ctx.filter unsupported`: 가짜 ctx에서 `filter` 대입이 반영되지 않으면(읽으면 `'none'`) blur 단계 호출 없음, mosaic 밑칠은 있음. 배경 blur는 같은 조건에서 배경 mosaic로 그림.
- Produces 추가: `supportsCanvasFilter(ctx: CanvasRenderingContext2D): boolean` — `ctx.filter = 'blur(1px)'` 후 값을 읽어 확인하고 `'none'`으로 되돌린다. 결과는 모듈 변수에 캐시.
- [ ] **Step 2: 실패 확인** — `npx vitest run src/lib/effects.test.ts`
- [ ] **Step 3: 구현** — 영역은 위 4단계. 오프스크린은 소스 픽셀 크기라 비트맵과 1:1로 맞는다. 배경 blur는 ¼ 크기 캔버스(지원 안 되면 배경 mosaic). 배경 mosaic는 프레임 전체 `pixelate`. `PlayerOverlay`와 `Filmstrip`은 `drawFrameEffects`만 호출(Filmstrip 썸네일의 최소 블록 `MIN_THUMB_BLOCK`은 유지).
- [ ] **Step 4: 통과 확인** — `npx vitest run && npm run typecheck`
- [ ] **Step 5: Commit** — `git commit -m "feat(web): preview blur, color, shaped regions and background"`

### Task 6: 효과 컨트롤 (왼쪽 기본·배경, 오른쪽 인물·수동 영역) + 렌더 저장 게이트

**Files:**
- Modify: `apps/web/src/studio/LeftPanel.tsx:69-176` (카드 이름·순서·기본/배경 효과), `apps/web/src/studio/TargetDetail.tsx` (원본 버튼 분리, 효과 세그먼트), `apps/web/src/studio/ManualBoxCard.tsx` (효과 세그먼트, 모양 제목, 실패 문구), `apps/web/src/studio/TargetList.tsx:143` (실제 효과 태그), `apps/web/src/pages/Studio.tsx` (props 연결, `flush`/`startRender` `:87-100, :622-631`, 키보드 `:671-680`), `apps/web/src/styles.css` (오버레이 토큰, `.uncover` 버튼)
- Create: `apps/web/src/studio/EffectControls.tsx` (세그먼트 + 강도/색상 + 기본값 따르기, 세 곳에서 재사용), `apps/web/src/studio/EffectControls.test.tsx`, `apps/web/src/studio/LeftPanel.test.tsx`
- Test: `apps/web/src/studio/TargetDetail.test.tsx`, `apps/web/src/pages/Studio.test.tsx`

**Interfaces:**
- Consumes: `setTargetEffect`, `setDefaultEffect`, `setBackgroundEffect`, `setPersonVisible`(edits.ts), `Effect`, `Effects`.
- Produces:
  - `EffectControls({ value: Effect | null, inherited: Effect | null, allowNone?: false, onChange(e: Effect): void, onInherit?(): void, filterSupported: boolean })` — `value = null`이면 `inherited`를 "(기본값)"과 함께 표시. 강도 슬라이더는 로컬 상태로 미리보기하고 `change`에서 한 번 `onChange`. type이 color면 강도 대신 색상.
  - `edits.ts`: `setPersonEffect(doc, edits, person: Person, effect: Effect): Edits` — 한 번에 `visible`에서 인물 trackIds 제거 + `overrides[person.key] = effect` + 그룹이면 멤버 조각 키의 override 삭제. `uncoverPerson(doc, edits, person): Edits` — 멱등 `setPersonVisible(…, true)`.
  - `Studio`: `saveRevision`/`savedRevision` 카운터, `flush(): Promise<boolean>`은 진행 중 저장을 기다리고 직렬화하며 `savedRevision === saveRevision`일 때 true. `startRender`는 false면 `api.render` 미호출 + `renderError = '저장하지 못해 렌더를 시작하지 않았습니다.'`, 대기 중 버튼 문구 "저장 중…".
- [ ] **Step 1: 실패하는 테스트**
  - `EffectControls.test.tsx`: 상속 표시 "모자이크 (기본값)"; 개별값이면 "기본값 따르기" → `onInherit`; 슬라이더 `input` 이벤트 여러 번 + `change` 한 번 → `onChange` 1회; color면 강도 슬라이더 없음·색상 입력 있음; `filterSupported=false`이고 blur면 안내 문구 표시; 슬라이더 `aria-valuetext="3 / 5"`.
  - `TargetDetail.test.tsx`: 원본 상태 인물에서 "블러" 클릭 → `onEffect(person, {type:"blur",…})` 1회(가림 + override는 `setPersonEffect` 하나로); "원본 · 가림 해제" 두 번 클릭해도 상태 변화 1회(멱등); 원본 상태에서는 세그먼트 선택 표시 없음·강도 숨김.
  - `edits.test.ts`(Task 4 파일): `setPersonEffect masks and sets override in one edit`, `setPersonEffect on group clears member piece overrides`, `uncoverPerson is idempotent`.
  - `LeftPanel.test.tsx`: 카드 이름 "기본 효과"·"원본" 버튼 없음·클릭 → `onDefault(effect)`; 배경 "끄기" → `onBackground(null)`, 배경 켜짐이면 안내 문구와 강도/색상; 효과 섹션이 매직 블러 카드보다 DOM에서 앞; "자동 가림"/"직접 가림" 제목; 계속 disabled 목록(클래스 칩, "대상 선택", "기본값으로 초기화", "고급 설정").
  - `Studio.test.tsx`: `render waits for in-flight save` (putEdits 지연 resolve → 렌더 버튼 → resolve 전 `api.render` 미호출, resolve 후 1회); `render not requested when save fails` (reject → 미호출, 오류 문구); `edit during save is saved before render`; `Space on a focused effect button does not toggle playback`.
- [ ] **Step 2–4: 실패 확인 → 구현 → 통과** (`cd apps/web && npx vitest run && npm run typecheck`). TargetList 태그는 `maskRegions`가 아닌 effects 해석 함수(`effectFor(personKey)` — `masks.ts`의 우선순위 함수를 export해 재사용)로 표시.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): default, background and per-target effect controls with save-gated render"`

### Task 7: 타원·다각형 그리기 도구

**Files:**
- Modify: `apps/web/src/studio/BoxTool.tsx` (→ `shape` prop), `apps/web/src/studio/LeftPanel.tsx:117-128`, `apps/web/src/pages/Studio.tsx` (`BoxMode`에 shape·points, 확정 시 `addManualEdit`, `redrawManual :537`에 기존 shape·points 전달)
- Create: `apps/web/src/studio/BoxTool.test.tsx`, `apps/web/src/lib/polygon.ts` (`polygonArea`, `dedupeVertices`, `clampVertex`), `apps/web/src/lib/polygon.test.ts`

**Interfaces:**
- Produces: `BoxTool` props 추가 `shape: Shape`, `initialPoints?: [number, number][] | null`, `onConfirm(box: Box, points: [number, number][] | null)` (points는 박스 기준 0..1, 소수 4자리 반올림). 다시 그리기는 points를 유지하고 박스만 바꿈. 전파 요청(`POST :id/manual`)은 바운딩 박스 그대로.
- [ ] **Step 1: 실패하는 테스트**
  - `polygon.test.ts`: `polygonArea` 일직선 3점 = 0; `dedupeVertices`가 연속 중복 제거; `clampVertex`가 프레임 밖 좌표를 경계로.
  - ellipse: 드래그 → 채움 미리보기(`data-testid="boxtool-shape"`가 ellipse), 확정 → `onConfirm(box, null)`.
  - polygon: 클릭 3번 + Enter → `onConfirm(bbox, points)`; 첫 점 근처 클릭으로도 닫힘; 더블클릭은 점을 추가하지 않고 닫음; Backspace는 마지막 점 제거; Esc → `onCancel`.
  - polygon: 일직선 3점·중복 점·bbox 4px 미만이면 확정 비활성 + 이유 문구; 안내문 `role="status"`에 꼭짓점 수.
  - polygon: `initial` 박스는 점선 가이드로만 표시, 점은 비어 있음.
  - redraw: 기존 polygon을 다시 그리면 points 유지, 새 박스로만 확정.
  - 확정·취소 뒤 포커스가 도구 버튼으로 돌아감.
- [ ] **Step 2–4: 실패 확인 → 구현 → 통과.** 채움 미리보기는 SVG `<polygon fill-rule="evenodd">`, 색은 `--overlay-*` 토큰. 왼쪽 패널 타원·다각형 버튼 활성화(`aria-pressed`). ManualBoxCard 다시 그리기 안내 "모양을 바꾸려면 이 영역을 지우고 새로 그리세요".
- [ ] **Step 5: Commit** — `git commit -m "feat(web): draw ellipse and polygon manual regions"`

### Task 8: 상위 스펙 개정 + 수동 QA·성능 측정

**Files:**
- Modify: `docs/superpowers/specs/2026-10-30-face-mosaic-studio-design.md` (§1 범위 밖, §3.5, §4 렌더 5번 — 새 스펙 §10대로)
- Create: `docs/qa/2026-11-02-effects-and-regions-qa.md`

- [ ] **Step 1:** 상위 스펙 개정(새 스펙 §10의 세 항목).
- [ ] **Step 2:** 로컬 docker compose로 1080p 샘플을 업로드 → 대상별 blur/color, 배경 blur, 타원·다각형 각 1개 → 렌더. 미리보기 스크린샷과 결과 프레임을 같은 프레임 번호로 나란히 저장.
- [ ] **Step 3:** `render.log`의 처리 시간으로 배경 끔/블러/모자이크 각각 fps 기록. 배경 블러가 끔 대비 2배 이상 느리면 측정값과 함께 보고(최적화는 이 계획 밖).
- [ ] **Step 3b:** 미리보기 재생 fps를 Chrome DevTools Performance로 측정(배경 끔 / 배경 블러 + 대상 블러 3개). 24fps 미만이면 측정값과 함께 보고. Safari에서 블러 대상이 mosaic로 대체되어 보이는지 확인(`ctx.filter` 미지원 경로). 블러 영역 가장자리를 확대 스크린샷으로 확인해 원본 영상이 비치지 않는지 기록.
- [ ] **Step 3c:** 다각형 수동 영역을 그리고 전파 완료 전후의 앵커 프레임 미리보기·렌더 프레임이 같은 모양인지 확인.
- [ ] **Step 4:** QA 문서에 확인 항목(스펙 §6 불변식 1–5별 관찰 결과)과 측정값 기록.
- [ ] **Step 5: Commit** — `git commit -m "docs: amend base spec and record effects QA"`

---

## Eng Review (gstack /plan-eng-review, 2026-11-02)

Target: `docs/superpowers/plans/2026-11-02-effects-and-regions.md` (+ spec `docs/superpowers/specs/2026-11-02-effects-and-regions-design.md`). Report file = this plan.

### Scope Challenge
- 기존 재사용: `pixelate`(render.py:18), `mask_boxes` 선정 로직(compose.py:44), `pieces`/`visibleIds`(web), `updateEdits` undo/redo·저장 경로, 공유 fixture 패턴(`expected-mask-frames.json`, test_compose.py:13 / masks.test.ts:9).
- 복잡도: 변경 파일 약 30개, 새 모듈 5개(worker `effects.py`, `shapes.py`; web `effectParams.ts`, `effects.ts`, `shapes.ts`) → 게이트 발동. 기능 삭감 제안 없음. 구조 D2: 원래 배치(A) 승인 — 사용자 "전체 다 권장안으로 진행".
- Scope Challenge 결과: scope accepted as-is.
- REALITY: premise-table pass 핵심 전제 6건 코드 확인(propagate.py:84 확장, edits.ts:89 split 그룹 재작성, Studio.tsx:87 flush 실패 삼킴, PlayerOverlay.tsx:161 video 위 canvas, fixtures.ts:6 import, jobs.e2e-spec.ts:187 sample PUT 200), unverified=1(Safari `ctx.filter` 지원 버전)
- REALITY: already-done pass origin/main에 효과·모양 관련 커밋 없음(`git log origin/main -G mask_regions` 빈 결과)
- REALITY: surface-check pass 테스트 명령은 apps/api/package.json:9-10, apps/web/package.json scripts(typecheck, test)와 일치
- REALITY: binding-decisions pass 사용자 결정(범위 A, version 1 유지, 원본=visible, 블러 하한, 다각형 이동·스케일)을 계획이 유지
- REALITY: numbers pass effect-params.json 10개 값 공식으로 재계산 [estimated: 손계산], 성능 수치는 Task 8에서 [re-measure before gate]
- REALITY: deferred-asks pass 연결 이슈 없음, B·C는 spec §9에 명시
- REALITY: pr-count pass 1 PR(.gstack/ship-policy.json 없음 → 기본값)

### Section findings (native)
1. Architecture
   - [CRITICAL] (confidence: 7/10) spec §5.1 blur — `ctx.filter` 미지원 브라우저(일부 Safari, WebKit bug 198416)에서는 blur가 적용되지 않아 원본 영역이 그대로 그려질 수 있음. → R1
   - [INFORMATIONAL] (confidence: 8/10) spec §4.2 — "box ∩ mask를 검정"은 `shape_mask` 자체가 실패하면 정의되지 않음. → R4
2. Code quality
   - [INFORMATIONAL] (confidence: 9/10) Task 1 Step 1 — 공유 `edits.sample.json`에 그룹 g1·없는 키 t9를 넣으면 `people.test.ts:4-14`의 인물 목록과 `jobs.e2e-spec.ts:187-190`(sample PUT → 200)이 깨짐. → R2
   - [INFORMATIONAL] (confidence: 9/10) Task 1 — `expected-mask-frames.json` 삭제 시 `apps/web/src/lib/fixtures.ts:6` import가 Task 4까지 깨짐. → R3
3. Tests
   - [INFORMATIONAL] (confidence: 8/10) Task 2 — 배경 처리 실패 → 렌더 실패 경로(spec §4.2)에 테스트 없음. → R6 (승인된 동작의 필수 증명으로 추가)
4. Performance
   - [INFORMATIONAL] (confidence: 6/10) Medium confidence, verify this is actually an issue. Task 5 — 재생 중 프레임마다 영역별 canvas blur + 배경 ¼ blur. 미리보기 fps 측정이 계획에 없음. → R5

Dispositions: R1–R6 accepted (사용자 "전체 다 권장안으로 진행").

### Outside voice (Codex, provider=codex, model gpt-6-astra, completed)
O1 High 블러 가장자리 투명 → 아래 video 노출 / O2 High 전파 박스(25% 확장·클램프)에 다각형 상대좌표를 그대로 쓰면 모양이 바뀜 / O3 High 병합 후 남은 override 키 → 저장 거부, `flush()`가 실패를 삼키고 렌더 진행(기존 버그) / O4 High 실패 영역 검정을 이후 겹친 영역이 덮음 / O5 High 가짜 ctx 호출 테스트로는 기하 일치를 증명 못 함 / O6 Medium split 뒤 그룹 소속이 `t2a`/`t2b`로 바뀜 / O7 High 수동 카드를 열어도 `currentKey`가 남아 대상이 뒤바뀜, 수동 영역 "원본" 계약 없음.
모두 코드로 확인(propagate.py:84, edits.ts:89, Studio.tsx:87-100·520·622-631, PlayerOverlay.tsx:161). Dispositions: O1–O7 accepted, 수정안은 아래 ledger.

### Decision ledger
Answer reference for all rows: 사용자 메시지 "전체 다 권장안으로 진행" (2026-11-02, D2 이후). 각 행 State: approved, Accepted scope = 권장 수정안.
- D1: /office-hours 건너뜀 (사용자 선택 B).
- D2 (structure): Original arrangement. 이후 O5 수정으로 `shapes.py`/`shapes.ts`가 추가됨(같은 배치 원칙: 순수 로직과 그리기 분리).
- R1: 웹 blur는 `ctx.filter` 지원 감지, 미지원 시 blur 단계 생략(불투명 mosaic 밑칠이 보임). Task 5 테스트 `blur skipped when ctx.filter unsupported`.
- R2: 공유 sample은 항상 API-유효. 우선순위·오래된 키 케이스는 테스트 로컬 데이터. Task 1·4.
- R3: `expected-mask-frames.json` 삭제를 Task 4로 이동.
- R4 + O4: 영역 실패는 실패 목록에 모아 모든 영역 처리 뒤 박스 전체 검정. Task 2 `test_region_error_paints_black`, `test_failed_region_black_survives_overlap`.
- R5: Task 8 Step 3b 미리보기 fps 측정(24fps 미만 보고).
- R6: Task 2 `test_background_error_fails_render`.
- O1: 미리보기 영역은 mosaic 불투명 밑칠 → 효과 → 알파 마스크. blur는 `ceil(3σ)` 여백 소스. Task 5 테스트 3건, Task 8 Step 3b 가장자리 확인.
- O2: 다각형 변환 = 그린 앵커 박스 D 기준, 앵커 프레임 전파 박스 A 대비 B의 이동·스케일. Task 1 테스트 2건, Task 8 Step 3c.
- O3: `groupPersons`/`deleteManual`이 override 키를 옮기거나 지움 + 저장 실패 시 렌더 요청 안 함. Task 4·6 테스트.
- O5: 모양 마스크를 OpenCV 대신 양쪽 순수 래스터 함수 + 공유 `shape-masks.json`으로 비트맵 일치 검증, 1px 확장 제거.
- O6: 그룹 소속 판정은 트랙 id 또는 분할 조각 id. Task 1 `test_group_membership_after_split`, Task 4 실제 `splitTrack` 케이스.
- O7: 효과 대상 = `manualOpen` 우선, 수동 대상이면 "원본" 비활성. Task 6 테스트. → **디자인 리뷰 DD1로 대체**: 대상 규칙 없이 위치로 결정(인물 = TargetDetail, 수동 영역 = ManualBoxCard, 왼쪽 = 기본 효과).
Approval readiness: PASS (D1, D2, R1–R6, O1–O7; answer refs above)

### Test coverage diagram (planned)
```
CODE PATHS                                         USER FLOWS
[+] worker compose.mask_regions                    [+] 효과 바꾸기 → 미리보기 → 렌더
  ├── 선정 규칙(기존)        [★★★ fixture 공유]      ├── [★★ PLANNED] 대상 효과/배경 (LeftPanel.test)
  ├── 효과 우선순위·split 그룹 [★★★ PLANNED T1]       ├── [★★ PLANNED] 타원·다각형 그리기 (BoxTool.test)
  └── 다각형 변환           [★★★ PLANNED T1]         ├── [★★★ PLANNED] 저장 실패 → 렌더 안 함 (Studio.test)
[+] worker shapes/effects/render                    └── [GAP→QA] 미리보기·렌더 나란히 비교 (Task 8, 수동)
  ├── shape_bitmap          [★★★ shape-masks.json]  [+] 오류 상태
  ├── 효과 3종·하한         [★★★ PLANNED T2]          ├── [★★★ PLANNED] 영역 실패 → 검정(겹침 포함)
  └── 배경 실패             [★★ PLANNED T2]           └── [★★ PLANNED] 프레임 미디코딩 → 회색
[+] api validateEdits        [★★★ PLANNED T3]
[+] web maskRegions/shapes/effects [★★★/★★ PLANNED T4-5]
COVERAGE (planned): code paths 11/11, user flows 5/6 (1 manual QA)
```
Tests made obsolete: `masks.test.ts`의 `maskBoxes` 케이스·`test_compose.py`의 `mask_boxes` 케이스는 Region 형식으로 옮김(삭제 아님).

### Failure modes
| 경로 | 현실적 실패 | 대응 | 사용자에게 |
|---|---|---|---|
| 웹 blur | 브라우저가 `ctx.filter` 무시 | 감지 후 mosaic 밑칠만 | mosaic로 보임 |
| 웹 영역 합성 | 가장자리 투명 | 불투명 밑칠 + 알파 0/255 | 보이지 않음 |
| 다각형 전파 | CSRT 어긋남·클램프로 모양 왜곡 | 앵커 프레임 정확, 그 외는 기존 재기준·trim | 미리보기에 그대로 보임 |
| render 영역 | 예외 | 마지막에 박스 검정 + 로그 | 검정 박스(과잉 가림) |
| render 배경 | 예외 | 렌더 실패 메시지 | 명확한 오류 |
| 저장 | 검증 거부 | 렌더 요청 안 함 + 오류 | 명확한 오류 |
Critical gaps: 0.

### NOT in scope
- 하위 프로젝트 B(자동 탐지 확장)·C(클릭 선택): 모델·라이선스 결정 필요, spec §9.
- 다각형 회전·변형 추적: CSRT가 박스만 추적.
- 배경 블러 최적화: 측정 후 별도 판단.

### What already exists
- `pixelate`(worker/web) 재사용, `mask_boxes`/`maskBoxes` 선정 로직은 그대로 옮김, 공유 fixture 패턴 확장, 기존 `updateEdits` 저장·undo 경로 재사용. 새로 만드는 것은 효과 연산·모양 래스터·UI 컨트롤뿐.

### Worktree parallelization strategy
| Step | Modules touched | Depends on |
|---|---|---|
| T1 compose+fixtures | worker/, contracts/ | — |
| T2 render | worker/, contracts/ | T1 |
| T3 API | apps/api/ | T1 (fixture) |
| T4 web model | apps/web/src/lib, contracts/ | T1 |
| T5 web preview | apps/web/src/lib, studio/ | T2 (shape-masks.json), T4 |
| T6 panel+render gate | apps/web/src/studio, pages/ | T4 |
| T7 drawing tool | apps/web/src/studio, pages/ | T4 |
| T8 docs+QA | docs/ | T1–T7 |
Lanes: A: T1 → T2 (worker). B: T3 (api, T1 이후). C: T4 → T5/T6/T7 (web, 같은 파일 Studio.tsx를 건드리므로 순차). Execution: T1 → (T2 ∥ T3 ∥ T4) → T5 → T6 → T7 → T8. Conflict: contracts/ (T1·T2·T4), Studio.tsx (T4·T6·T7).

## Implementation Tasks
Synthesized from this review's findings (already folded into Tasks 1–8 above).
- [ ] **T1 (P1, human: ~3h / CC: ~20min)** — web preview — 불투명 밑칠·blur 여백·filter 감지 (R1, O1) — Files: apps/web/src/lib/effects.ts — Verify: `npx vitest run src/lib/effects.test.ts`
- [ ] **T2 (P1, human: ~4h / CC: ~30min)** — shapes — 양쪽 순수 래스터 + shape-masks.json (O5) — Files: worker/mosaic_worker/shapes.py, apps/web/src/lib/shapes.ts — Verify: `pytest tests/test_shapes.py`, `npx vitest run src/lib/shapes.test.ts`
- [ ] **T3 (P1, human: ~2h / CC: ~15min)** — compose — 다각형 변환·split 그룹 소속 (O2, O6) — Files: worker/mosaic_worker/compose.py, apps/web/src/lib/masks.ts — Verify: test_compose.py, masks.test.ts
- [ ] **T4 (P1, human: ~2h / CC: ~15min)** — web state — override 이전 + 저장 실패 시 렌더 안 함 (O3) — Files: apps/web/src/lib/edits.ts, pages/Studio.tsx — Verify: edits.test.ts, Studio.test.tsx
- [ ] **T5 (P1, human: ~1h / CC: ~10min)** — render — 실패 검정 마지막 패스 (R4, O4, R6) — Files: worker/mosaic_worker/render.py — Verify: test_render.py
- [ ] **T6 (P2, human: ~1h / CC: ~10min)** — panel — 효과 대상 우선순위 (O7) — Files: studio/LeftPanel.tsx, pages/Studio.tsx — Verify: LeftPanel.test.tsx
- [ ] **T7 (P2, human: ~30min / CC: ~5min)** — fixtures — sample 유효 유지·삭제 순서 (R2, R3) — Files: contracts/fixtures — Verify: `npm run test:e2e`, people.test.ts
- [ ] **T8 (P2, human: ~1h / CC: manual)** — QA — 미리보기 fps·가장자리·다각형 앵커 확인 (R5) — Files: docs/qa — Verify: Task 8

### Unresolved decisions
None.

### Completion summary
- Step 0: Scope Challenge — scope accepted as-is
- Reality rows: 7/7 applicable rows emitted, 1 unverified premise
- Architecture Review: 2 issues found
- Code Quality Review: 2 issues found
- Test Review: diagram produced, 1 gap identified (+1 manual-QA flow)
- Performance Review: 1 issue found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed (no TODOS.md; B·C tracked in spec §9)
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex, completed (7 findings, all accepted)
- Parallelization: 3 lanes, 3 parallel / 5 sequential
- Lake Score: 1/1 (D2 no completeness score; remedies all full-coverage options)

### Suppressed findings
- (confidence 4) 배경 효과를 켜면 visible로 푼 얼굴도 흐려지는 동작이 사용자 기대와 다를 수 있음 — 사용자가 1절에서 승인한 동작이라 제기하지 않음.

## Design Review (gstack /plan-design-review, 2026-11-02)

- System audit: UI 범위 = 왼쪽 패널 효과 카드·그리기 도구, 오른쪽 TargetDetail·TargetList·ManualBoxCard, 미리보기 overlay. DESIGN.md 없음 → `apps/web/src/styles.css` 토큰 기준(`/design-consultation`은 권장하지만 이번 범위 밖).
- Step 0: 5/10 — 동작은 정의됐지만 사용자가 무엇을 편집 중인지·노출 상태·그리기 중 상태가 화면에 정의되지 않음. 집중 영역: 전체 7개 패스(권장).
- Step 0.5 목업: 생성하지 않음. 레이아웃이 main(b9d87aa)에 이미 확정돼 있고, 목업 보드는 사용자가 직접 고르는 단계라 "전체 권장안으로 진행" 지시와 맞지 않음.
- Outside voices: Codex(gpt-6-astra, completed) 13건 + Claude 서브에이전트 10건. 핵심 지적이 일치(대상 불명확, 원본=노출 한 번 클릭, 상속/개별 구분 없음, 슬라이더 연속 커밋, 다각형 동작 미정, 상태 누락).

Litmus (Claude / Codex / 합의): 1 브랜드 — / YES / YES · 2 시각 앵커 — / YES / YES(중앙 미리보기) · 3 제목만으로 이해 NO / NO / CONFIRMED 실패 → DD1·DD13 · 4 섹션 하나의 일 NO / NO / CONFIRMED 실패 → DD1 · 5 카드 필요 — / NO / NOT SPEC'D(기존 승인 레이아웃) · 6 모션 — / NO / 해당 없음 · 7 그림자 없이 프리미엄 — / YES / YES. Hard rejection #7(카드 스택 인스펙터): Codex만 지적, 레이아웃은 직전 브랜치에서 사용자 승인 → 재개하지 않음(Pass 4 상한 7).

### Passes
| Pass | 전 | 후 | 근거 |
|---|---|---|---|
| 1 정보 구조 | 4 | 8 | DD1 편집 대상 = 위치, DD13 효과 섹션을 매직 블러 위로, 이름 변경 |
| 2 상태 | 3 | 8 | DD8 상태 표(효과 변경·블러 미리보기·추적·렌더), DD6 다각형 그리기 상태 |
| 3 여정 | 5 | 8 | DD2 노출 버튼 분리·멱등, DD5 배경 안내 문구, DD9 저장 후 렌더 |
| 4 AI slop | 7 | 7 | APP UI, 하드 리젝트 #7은 승인된 기존 레이아웃 |
| 5 디자인 시스템 | 6 | 8 | DD4 EffectControls 재사용 컴포넌트, DD14 오버레이 토큰 |
| 6 반응형·접근성 | 3 | 7 | DD10 라벨·aria·포커스·단축키 충돌; 키보드 다각형은 TODO |
| 7 미결정 | — | 14 resolved, 2 deferred | 아래 |

### Decisions (모두 사용자 지시 "전체 다 권장안으로 진행"에 따른 권장안 자동 채택)
- DD1 편집 대상은 화면 위치로 결정: 왼쪽 "기본 효과"(effects.default), 인물 = TargetDetail, 수동 영역 = ManualBoxCard. (원칙: 각 화면에 하나의 분명한 다음 행동)
- DD2 "원본 · 가림 해제"는 효과 세그먼트와 분리된 경고색 버튼, 멱등. 효과 선택 = 가림 + override 한 번의 편집. (원칙: 신뢰는 픽셀 단위로)
- DD3 상속 표시 "(기본값)" + "기본값 따르기", 목록 태그에 실제 효과.
- DD4 강도/색상: 드래그 중 미리보기, change에서 1회 커밋; color면 강도 숨김; "강도 3/5".
- DD5 배경 효과 자체 강도/색상 + "가림을 해제한 인물에도 적용됩니다".
- DD6 다각형 그리기 동작 전부 명세(가이드 선, Backspace, 첫 점 닫기, 더블클릭 중복 없음, 클램프, 넓이>0, 이유 문구, 도구 전환 시 폐기, initial은 가이드).
- DD7 다시 그리기는 모양 유지·박스만, 모양 변경은 삭제 후 새로.
- DD8 상태 표(저장 오류 즉시, Safari 블러 안내, 모든 모양 추적 표시, 추적 실패 문구 교체).
- DD9 렌더는 진행 중 저장 대기 + 리비전 확인(직렬화).
- DD10 접근성: 슬라이더·색상 라벨, aria-expanded, status 알림, 포커스 복귀, 포커스된 컨트롤 위 전역 단축키 차단.
- DD11 추적 실패 문구 "기준 프레임만 가려짐"(렌더 게이트화는 TODO).
- DD12 그룹 효과 지정은 멤버 조각 개별값을 지움(혼합 상태 없음).
- DD13 효과 섹션을 매직 블러 카드 위로, "자동/직접 블러" → "자동/직접 가림", "수동 박스" → "수동 영역".
- DD14 오버레이 색 토큰 `--overlay-fill/line/ink`.
- TODO A(TODOS.md 추가): 키보드 다각형 그리기, 추적 실패 렌더 게이트.

### NOT in scope (design)
- 인스펙터 카드 스타일 재설계: 직전 브랜치에서 승인된 레이아웃.
- DESIGN.md 작성(`/design-consultation`): 토큰은 styles.css로 충분, 별도 작업.
- 모바일 레이아웃: 스튜디오는 데스크톱 전용(기존 전제).

### What already exists (design)
- `Seg`(LeftPanel), `.rowbtn`, `.bcard`, `.trk` 추적 표시, `role="switch"` 패턴, `--warn`/`--primary`/`--s*`/`--r-*` 토큰, 저장 오류 배너(`saveError`), TargetDetail 원본/가림 스위치.

## Design Review Completion Summary
```
  +====================================================================+
  |         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
  +====================================================================+
  | System Audit         | no DESIGN.md (styles.css tokens), UI scope yes |
  | Step 0               | 5/10, all 7 passes                          |
  | Pass 1  (Info Arch)  | 4/10 → 8/10 after fixes                     |
  | Pass 2  (States)     | 3/10 → 8/10 after fixes                     |
  | Pass 3  (Journey)    | 5/10 → 8/10 after fixes                     |
  | Pass 4  (AI Slop)    | 7/10 → 7/10 after fixes                     |
  | Pass 5  (Design Sys) | 6/10 → 8/10 after fixes                     |
  | Pass 6  (Responsive) | 3/10 → 7/10 after fixes                     |
  | Pass 7  (Decisions)  | 14 resolved, 2 deferred                     |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (3 items)                           |
  | What already exists  | written                                     |
  | TODOS.md updates     | 2 items proposed (added)                    |
  | Approved Mockups     | 0 generated, 0 approved                     |
  | Decisions made       | 14 added to plan                            |
  | Decisions deferred   | 2 (listed below)                            |
  | Overall design score | 3/10 → 7/10                                 |
  +====================================================================+
```
Deferred (TODOS.md): 키보드 다각형 그리기, 추적 실패 렌더 게이트. Pass 4(승인된 카드 레이아웃)와 Pass 6(키보드 그리기)이 8 미만.

Unresolved decisions: none.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex via `/plan-eng-review`, `/plan-design-review` | Independent 2nd opinion | 2 | completed | eng 7 findings, design 13 findings; all accepted or deferred to TODOS |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 6 issues, 0 critical gaps (remedies accepted into plan) |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | issues_open | score: 3/10 → 7/10, 14 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex plan-review (eng phase) completed, 7 findings; codex design phase completed, 13 findings; Claude design subagent (in-host) completed, 10 findings.
- **CROSS-MODEL:** design — codex and in-host subagent agree on unclear edit target, one-click exposure via 원본, no inherit/override distinction, continuous slider commits, unspecified polygon drawing, missing states. Codex alone raised the card-stack inspector (not reopened) and the in-flight save race (adopted, DD9).
- **VERDICT:** NOT CLEARED — Eng Review issues_open (remedies mapped into Tasks 1–8, no open decisions); eng review required. Design review issues_open (2 deferred TODOs, passes 4 and 6 below 8).

NO UNRESOLVED DECISIONS
