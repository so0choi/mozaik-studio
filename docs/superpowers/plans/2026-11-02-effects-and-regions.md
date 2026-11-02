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
- 모양 마스크는 이진(OpenCV `LINE_8`, 안티앨리어싱 없음). 웹 미리보기는 모양 경계를 바깥으로 넓혀 렌더보다 덜 가리지 않는다.
- Region 처리 예외 → 그 영역을 검정으로 채우고 계속. 배경 처리 예외 → 렌더 실패(`MSG_RENDER_FAILED`). 프레임 디코딩 실패 → 회색 `#6b6f7a`.
- 공개 저장소: 커밋 메시지·파일·브랜치에 타사 서비스 이름을 쓰지 않는다.
- 테스트 명령: worker `cd worker && pytest`, api `cd apps/api && npx jest` / `npm run test:e2e`, web `cd apps/web && npx vitest run && npm run typecheck`.

## Review Focus

1. **아주 작은 수동 영역(w 또는 h < 4px)의 타원·다각형**: 다각형이 한 점으로 뭉개져도 영역은 가려져야 한다 → 박스가 4px 미만이면 모양을 rect로 처리 (Task 2 `test_tiny_shape_falls_back_to_rect`, Task 5 동일 케이스).
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
- Create: `contracts/fixtures/expected-regions.json` (기존 `expected-mask-frames.json` 대체, 삭제), `contracts/fixtures/effect-params.json`
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
  - `edits.sample.json`: `effects = { default: {type:"mosaic",strength:1}, background: {type:"blur",strength:2}, overrides: { "t3": {type:"blur",strength:3}, "m1": {type:"color",color:"#ff0000"} } }` 추가. `m1`에 `"shape":"ellipse"`, 새 수동 `m3` = `{shape:"polygon", points:[[0,0],[1,0],[0.5,1]], anchors:[{frame:60, box:[100,100,60,40]}], trim:null, deleted:false}` 추가. 그룹 `g1 = {id:"g1", trackIds:["t3"], label:"그룹"}` 와 override `"g1": {type:"color"}`를 넣어 그룹이 트랙보다 우선함을 고정(→ t3의 효과는 color). 존재하지 않는 키 `"t9": {type:"blur"}`도 넣는다(무시 확인용; API 검증 fixture로는 쓰지 않음).
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
def test_group_override_beats_track_override(): # t3 effect.type == "color"
def test_split_piece_override_beats_group():    # overrides["t2a"] 지정 시 t2a Region에 적용
def test_unknown_override_key_ignored():        # "t9" 있어도 예외 없음, 결과 동일
def test_polygon_points_absolute():             # m3 프레임 60: points == [[100,100],[160,100],[130,140]]
def test_effect_defaults_filled():              # effects 누락 edits → 모든 Region effect == {"type":"mosaic","strength":1,"color":"#000000"}
def test_mask_set_unchanged_by_effects():       # 같은 edits에서 effects/shape만 바꿔도 [(f, r["box"]) ...] 집합 동일 (스펙 불변식 1)
```

- [ ] **Step 3: 실패 확인** — Run: `cd worker && pytest tests/test_compose.py tests/test_effects_params.py -v` → ImportError `mask_regions`.

- [ ] **Step 4: 구현** — `effects.py`의 함수들(정수 결과는 Python `round`가 아니라 `int(x + 0.5)`로 반올림; 웹 `Math.round`와 같게). `compose.mask_regions`는 기존 `mask_boxes`의 선정 로직을 그대로 두고 Region dict를 만든다. 다각형 절대좌표 `box.x + int(u*box.w + 0.5)`. 수동 Region의 shape·points는 edits 항목에서(항목이 없는 수동 문서는 rect, default 효과). `mask_boxes`와 `MaskBox`는 삭제.

- [ ] **Step 5: 통과 확인** — `render.py`는 이 Task에서 `mask_regions` 결과를 `(*r["box"], r["block"])`로 바꿔 기존 `pixelate`에 넘기도록만 고친다(효과·모양은 Task 2). Run: `cd worker && pytest` → 전체 PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(worker): mask regions with shape and effect, shared fixtures"`

### Task 2: worker 효과 픽셀 연산 + render 합성 순서

**Files:**
- Modify: `worker/mosaic_worker/effects.py` (픽셀 연산 추가), `worker/mosaic_worker/render.py`
- Test: `worker/tests/test_render.py`

**Interfaces:**
- Consumes: Task 1의 `mask_regions`, `normalize_effects`, 파라미터 함수들.
- Produces:
  - `effects.shape_mask(region: dict, frame_w: int, frame_h: int) -> tuple[slice, slice, np.ndarray[bool]]` — 프레임과 교집합인 박스 범위와 그 범위의 이진 마스크. 박스 w 또는 h < 4면 rect.
  - `effects.apply_region(src: np.ndarray, out: np.ndarray, region: dict) -> None` — src 기준으로 효과를 계산해 out에 마스크만큼 덮어씀.
  - `effects.apply_background(src: np.ndarray, effect: dict) -> np.ndarray`
  - `render.compose_frame(src: np.ndarray, regions: list[dict], background: dict | None, log) -> np.ndarray` — 스펙 §4.2 순서. 영역 예외 시 검정 + `log(str)`.
  - `pixelate`는 `effects.py`로 옮기고 `render.pixelate`는 재노출(기존 테스트 import 유지).

- [ ] **Step 1: 실패하는 테스트 작성**

```python
def test_rect_mask_covers_whole_box_and_outside_untouched(): ...
def test_ellipse_mask_matches_cv2_ellipse_pixels():   # 박스 [10,10,41,31]: 마스크 == cv2.ellipse(LINE_8, thickness=-1)로 그린 것; 네 모서리 픽셀 False
def test_polygon_mask_matches_fillPoly_pixels(): ...
def test_tiny_shape_falls_back_to_rect():             # box [5,5,3,3] polygon → 9픽셀 모두 True
def test_shape_mask_clipped_at_frame_edge():          # 박스 [-10,-10,40,40] ellipse: 반환 slice가 프레임 안, 마스크 모양은 잘리지 않은 타원의 해당 부분
def test_color_effect_fills_exact_color_inside_mask_only(): ...
def test_blur_floor_removes_detail():                  # helpers의 얼굴 합성 이미지 crop, s=1: cv2.Laplacian 분산 비 (blurred/orig) < 0.02
def test_mosaic_strength_scales_block():               # s=3 → _cells_uniform(block=round(base*2))
def test_background_then_regions_from_src():           # bg=color 파랑, region=color 빨강: region 안 빨강, 밖 파랑; region이 blur면 입력은 src(파랑 아님)
def test_visible_face_gets_background():               # visible 트랙 위치 픽셀이 bg 효과를 받음
def test_region_error_paints_black(monkeypatch):       # apply_region이 예외 → 해당 박스∩마스크 == 0, log 호출됨, 다른 영역 정상
def test_render_end_to_end_with_effects(tmp_path): ... # 기존 render 통합 테스트에 effects/ellipse 추가, 출력 프레임에서 ellipse 밖 박스 모서리가 원본과 같음(허용 오차는 기존 테스트와 동일)
```

- [ ] **Step 2: 실패 확인** — `cd worker && pytest tests/test_render.py -v` → ImportError.

- [ ] **Step 3: 구현**
  - `shape_mask`: 잘리지 않은 박스 크기의 마스크를 그린 뒤(ellipse: center `(w//2, h//2)`, axes `(w//2, h//2)`; polygon: points − box 원점) 프레임 교집합으로 자른다.
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
- Modify: `apps/web/src/lib/types.ts`, `apps/web/src/lib/edits.ts`, `apps/web/src/lib/masks.ts`, `apps/web/src/lib/fixtures.ts`, `apps/web/src/pages/Studio.tsx:20,222`
- Create: `apps/web/src/lib/effectParams.ts`
- Test: `apps/web/src/lib/masks.test.ts`, `apps/web/src/lib/edits.test.ts`, `apps/web/src/lib/effectParams.test.ts`

**Interfaces:**
- Produces (TS):
  - `type EffectType = 'mosaic' | 'blur' | 'color'`; `interface Effect { type: EffectType; strength: number; color: string }`; `interface Effects { default: Effect; background: Effect | null; overrides: Record<string, Effect> }`; `type Shape = 'rect' | 'ellipse' | 'polygon'`.
  - `ManualEdit`에 `shape?: Shape; points?: [number, number][]`. `Edits`에 `effects?: Effects`.
  - `interface Region { id: string; shape: Shape; box: Box; points: [number, number][] | null; effect: Effect; block: number }`.
  - `effectParams.ts`: `strengthFactor`, `regionBlock`, `regionSigma`, `backgroundBlock`, `backgroundSigma` — Task 1과 같은 이름(camelCase), `Math.round`.
  - `maskRegions(doc, edits, manual): Map<number, Region[]>`; `maskBoxes`·`MaskBox` 삭제.
  - `edits.ts`: `normalizeEdits`가 effects 기본값을 채움. 새 함수 `setTargetEffect(edits, targetId: string, effect: Effect | null): Edits`(null = override 제거), `setDefaultEffect(edits, effect: Effect): Edits`, `setBackgroundEffect(edits, effect: Effect | null): Edits`. `addManualEdit`은 `shape`/`points`를 그대로 보존.
- [ ] **Step 1: 실패하는 테스트**
  - `masks.test.ts`: `maskRegions(tracksDoc, edits, manualDocs)`를 `expected-regions.json`과 `toEqual`(Map → 객체 변환). 기존 개별 케이스는 Region 형식으로 옮김. 추가: 알 수 없는 override 키 무시, edits 항목 없는 수동 문서도 가림(Python과 일치하도록 동작 변경).
  - `effectParams.test.ts`: `effect-params.json` 전 케이스.
  - `edits.test.ts`: `normalizeEdits fills effect defaults`(effects 누락·strength 누락·color 누락), `setTargetEffect(…, null)`이 키 제거, `setBackgroundEffect(null)`.
- [ ] **Step 2: 실패 확인** — `cd apps/web && npx vitest run src/lib`
- [ ] **Step 3: 구현** — `maskRegions`는 Python과 한 줄씩 대응(수동 문서 순회 기준을 Python처럼 manual 문서 + 앵커 대체로 바꿈). `Studio.tsx`의 `masks` memo는 `maskRegions`로. 이 시점에 `PlayerOverlay`/`Filmstrip`이 Region을 받도록 타입만 맞추고, 그리기는 Task 5에서 바꾼다(임시로 `effect` 무시하고 rect mosaic로 그려 녹색 유지).
- [ ] **Step 4: 통과 확인** — `npx vitest run && npm run typecheck` PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): mask regions, effect params and effect edits"`

### Task 5: 웹 미리보기 `effects.ts`

**Files:**
- Create: `apps/web/src/lib/effects.ts` (기존 `pixelate.ts` 내용 이동 후 삭제), `apps/web/src/lib/effects.test.ts`
- Modify: `apps/web/src/studio/PlayerOverlay.tsx:66`, `apps/web/src/studio/Filmstrip.tsx:124-126`, `apps/web/src/lib/filmstrip.ts` (`scaleBoxes`/`boxesForThumb` → Region 버전 `scaleRegions`/`regionsForThumb`)

**Interfaces:**
- Consumes: `Region`, `Effects`, `effectParams.ts`.
- Produces:
  - `PixelSource` (기존 그대로).
  - `drawFrameEffects(ctx, src: PixelSource, off: HTMLCanvasElement, regions: Region[], background: Effect | null, rect: Rect, srcW: number, srcH: number): void` — 배경 → 영역 순서.
  - `shapePath(ctx, r: Region, rect: Rect, srcW: number, srcH: number): Path2D`와 `CLIP_GROW_PX = 1` — 경계 확장은 `Path2D`를 채우고 같은 경로를 `lineWidth = 2·max(1, rect.w/srcW)`로 스트로크해 클립 영역 대신 마스크 캔버스로 합성(source-in).
- [ ] **Step 1: 실패하는 테스트** (`effects.test.ts`, jsdom canvas는 `vitest-canvas-mock` 대신 호출 기록용 가짜 ctx를 쓴다 — 기존 `PlayerOverlay.test.tsx` 방식 따름)
  - `not ready → grey fill over every region box`
  - `background grey when not ready`: background != null이고 ready=false → `fillRect(rect.x, rect.y, rect.w, rect.h)` 회색.
  - `background drawn before regions` (호출 순서).
  - `ellipse path grows outward`: 스트로크 lineWidth ≥ 2, 경로 반지름 = 박스 반축(표시 좌표).
  - `tiny shape uses rect`, `color effect uses region color`, `blur uses filter blur(σ·scale px)` (σ = `regionSigma`, scale = rect.w/srcW).
- [ ] **Step 2: 실패 확인** — `npx vitest run src/lib/effects.test.ts`
- [ ] **Step 3: 구현** — blur: 오프스크린 캔버스에 박스 영역을 `ctx.filter = \`blur(${σ·scale}px)\``로 그림. 배경 blur는 ¼ 크기 캔버스. 배경 mosaic는 프레임 전체 `pixelate`. `PlayerOverlay`와 `Filmstrip`은 `drawFrameEffects`만 호출(Filmstrip 썸네일의 최소 블록 `MIN_THUMB_BLOCK`은 유지).
- [ ] **Step 4: 통과 확인** — `npx vitest run && npm run typecheck`
- [ ] **Step 5: Commit** — `git commit -m "feat(web): preview blur, color, shaped regions and background"`

### Task 6: 왼쪽 패널 효과 컨트롤

**Files:**
- Modify: `apps/web/src/studio/LeftPanel.tsx:146-176`, `apps/web/src/pages/Studio.tsx` (props 연결)
- Create: `apps/web/src/studio/LeftPanel.test.tsx`

**Interfaces:**
- Consumes: `setTargetEffect`, `setDefaultEffect`, `setBackgroundEffect`, 기존 `toggleVisible`.
- Produces: `LeftPanel` props 추가 `effectTarget: { id: string; visible: boolean } | null` (현재 열린 인물 `currentKey` → 그 Person의 key, 아니면 열린 수동 카드 `manualOpen`의 id), `effects: Effects`, `onEffect(target: string | null, e: Effect | null)`, `onBackground(e: Effect | null)`, `onToggleVisible()`.
- [ ] **Step 1: 실패하는 테스트**
  - 대상 없음: "블러" 클릭 → `onEffect(null, {type:"blur", strength:1, color:"#000000"})`; "원본" 버튼 disabled.
  - 대상 있음(`t3`): "색상" 클릭 → `onEffect("t3", {...type:"color"})`; "원본" 클릭 → `onToggleVisible` 호출, `onEffect` 미호출.
  - 세부 조정: 슬라이더 `min=1 max=5 step=1`, 값 변경 → strength 반영; 색상 선택기는 type=color일 때만 렌더.
  - 배경: "끄기" → `onBackground(null)`, "모자이크" → `onBackground({type:"mosaic",...})`.
  - 계속 disabled: 자동 탐지 클래스 칩, "대상 선택", "기본값으로 초기화", "고급 설정".
- [ ] **Step 2–4: 실패 확인 → 구현 → 통과** (`npx vitest run src/studio/LeftPanel.test.tsx`, 전체 vitest + typecheck). 세부 조정은 `rowbtn`을 펼침 토글로 바꾸고 펼친 영역에 `<input type="range">`와 `<input type="color">`. 변경은 기존 `updateEdits`(undo/redo·저장 경로)로.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): target and background effect controls"`

### Task 7: 타원·다각형 그리기 도구

**Files:**
- Modify: `apps/web/src/studio/BoxTool.tsx` (→ `shape` prop 추가), `apps/web/src/studio/LeftPanel.tsx:117-128`, `apps/web/src/pages/Studio.tsx` (`BoxMode`에 shape, 확정 시 `addManualEdit`)
- Create: `apps/web/src/studio/BoxTool.test.tsx`

**Interfaces:**
- Produces: `BoxTool` props 추가 `shape: Shape`, `onConfirm(box: Box, points: [number, number][] | null)` (points는 박스 기준 0..1, 소수 4자리 반올림). `ManualEdit.shape`/`points` 저장. 전파 요청(`POST :id/manual`)은 바운딩 박스 그대로.
- [ ] **Step 1: 실패하는 테스트**
  - ellipse: 드래그 → 미리보기 요소 `border-radius: 50%`, 확정 → `onConfirm(box, null)`.
  - polygon: 클릭 3번 + Enter → `onConfirm(bbox, points)`; bbox = 꼭짓점 min/max; points ∈ [0,1].
  - polygon: 2점에서 Enter·더블클릭 → 확정 안 됨; Esc → `onCancel`.
  - polygon: bbox w 또는 h < 4 → 확정 버튼 disabled(사각형의 기존 4px 규칙과 같음).
- [ ] **Step 2–4: 실패 확인 → 구현 → 통과.** 다각형은 SVG `<polygon>`으로 표시. 왼쪽 패널 타원·다각형 버튼 활성화(`aria-pressed`), 단축키는 추가하지 않음.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): draw ellipse and polygon manual regions"`

### Task 8: 상위 스펙 개정 + 수동 QA·성능 측정

**Files:**
- Modify: `docs/superpowers/specs/2026-10-30-face-mosaic-studio-design.md` (§1 범위 밖, §3.5, §4 렌더 5번 — 새 스펙 §10대로)
- Create: `docs/qa/2026-11-02-effects-and-regions-qa.md`

- [ ] **Step 1:** 상위 스펙 개정(새 스펙 §10의 세 항목).
- [ ] **Step 2:** 로컬 docker compose로 1080p 샘플을 업로드 → 대상별 blur/color, 배경 blur, 타원·다각형 각 1개 → 렌더. 미리보기 스크린샷과 결과 프레임을 같은 프레임 번호로 나란히 저장.
- [ ] **Step 3:** `render.log`의 처리 시간으로 배경 끔/블러/모자이크 각각 fps 기록. 배경 블러가 끔 대비 2배 이상 느리면 측정값과 함께 보고(최적화는 이 계획 밖).
- [ ] **Step 4:** QA 문서에 확인 항목(스펙 §6 불변식 1–5별 관찰 결과)과 측정값 기록.
- [ ] **Step 5: Commit** — `git commit -m "docs: amend base spec and record effects QA"`
