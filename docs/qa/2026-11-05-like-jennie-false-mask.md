# like Jennie 무대 영상 01:25 배경 모자이크 진단 (2026-11-05)

## 결론

- 잘못된 큰 박스는 **D 단계(추적 유지)** 에서 처음 생긴다. 모델(A)·NanoDet(B)·결합(C)·렌더/UI 좌표(E)는 원인이 아니다.
- 근본 원인은 **장면 전환 미검출**이다. 프레임 2036(클로즈업) → 2037(와이드 무대) 하드 컷에서 히스토그램 거리 0.636(주변의 7.2배)은 통과했지만 회색 차이 24.51이 기준 25.0에 0.49 못 미쳐 컷으로 판정되지 않았다. 그래서 `trim_holds_at_cuts`가 동작하지 않았고, 클로즈업 얼굴 박스(t522)가 와이드 화면 위에서 12프레임(0.5 s) 동안 유지되며 프레임마다 1.05배씩 커졌다(2048에서 660×767).
- 같은 원인으로 `cover_leading`(최근 커밋 40fd950)이 와이드 화면 댄서들의 박스를 클로즈업 화면(2025–2036) 위로 거꾸로 복사했다.

## 라벨과 점수의 의미 (`apps/web/src/lib/debugBoxes.ts`)

| 표시 | 의미 |
|---|---|
| `t522` | 연결(link) 이후의 트랙 ID |
| 숫자(0.61 등) | 그 프레임의 **실제 YuNet 검출 점수**. 검출이 없는 프레임에는 점수를 표시하지 않음 |
| `유지` | 그 프레임에 실제 검출이 없음(추적 유지, 내부 보강, 브리지, 선행 보강 중 하나로 생긴 박스) |
| `의심` | `suspect` 또는 `nonface` (crop 재검사 실패 / NanoDet 머리 위치 불일치) |
| `가림` / `보임` | edits.visible 기준 모자이크 적용 / 해제 |

t563(`유지 의심 · 보임`)은 클로즈업 가슴 부근에서 나온 약한 검출 3건(0.68/0.62/0.50)이다. `nonface`로 분류되어 기본값이 해제(보임)라서 모자이크되지는 않았다.

## 처리 흐름 (파일·함수)

`jobs.detect_and_track`: 프레임마다 `FaceDetector.detect`(YuNet `face_detection_yunet_2023mar.onnx`, 짧은 변 1080 이하는 원본 크기, score 0.5, NMS 0.3) → `Tracker.update`(HIGH 0.6, IoU 0.3, 미검출 시 0.5 s 유지, ×1.05/프레임, 속도 외삽) → `TrackVerifier`(crop 재검사) → `PersonGate`(NanoDet-Plus `object_detection_nanodet_2022nov.onnx`, COCO 사람 클래스 0번만 사용, 416 letterbox, fps/2 프레임마다 실행. **박스를 만들지 않고 트랙 단위 support/no_support 플래그만 정함**) → `SceneCuts`.
이후 `tracker.finish`(25% 확장) → `link_fragments` → `trim_holds_at_cuts` → `cover_inner_holds` → `bridge_gaps` → `cover_leading` → tracks.json. 렌더는 `compose.mask_regions`(타원 박스), UI는 `geometry.containRect`/`toDisplay` 순서로 처리한다.

## 가설 판정

| 가설 | 판정 | 근거 |
|---|---|---|
| xywh/xyxy 혼동 | 해당 없음 | YuNet 행 `x,y,w,h`를 그대로 사용(detect.py). NanoDet은 x1..x2를 w로 변환(person.py). 재생 결과가 운영 결과와 1348/1348 일치 |
| 정규화/픽셀 혼동 | 해당 없음 | 두 모델 모두 픽셀 좌표 출력. 1080p 영상에서 YuNet 배율은 1.0(model_box = frame_box) |
| letterbox 복원 | 해당 없음(박스 영향 없음) | `(a-px)/r` 식 확인. NanoDet 박스는 마스크에 쓰이지 않음 |
| crop offset | 해당 없음 | crop은 점수 재검사(verify)에만 쓰고 박스는 만들지 않음 |
| 원본→UI 좌표 | 해당 없음 | contain 배율과 offset을 적용. E 단계 로그에 표시 좌표 기록 |
| NanoDet 박스가 마스크로 사용 | 해당 없음 | 코드상 플래그 용도만. 2041의 박스는 모두 YuNet 트랙에서 나온 것 |
| 실제 검출 없이 과도한 유지 | **확인됨(컷 경계에서)** | t522: 2037–2048 유지, 같은 샷에서는 0.5 s 유지가 설계 의도 |
| 크기·위치 비정상 변화에도 유지 | 확인됨 | 유지 중 ×1.05^12 = 1.8배. 외삽만 하고 화면 내용은 검사하지 않음 |
| 장면 전환 후 이전 박스 잔존 | **확인됨, 원인** | 컷 미검출(gray 24.51 < 25). 영상 전체에서 컷을 건너간 마스크 박스 417개 |
| 잘못된 검출이 트랙에 연결 | 추가 확인 필요 | 이 구간에서는 관찰되지 않음 |
| fallback이 큰 영역 생성 | 해당 없음 | 별도 fallback 없음. 큰 영역은 유지 박스가 커진 것 |
| YuNet 단독 배경 오탐 | 이 구간에서는 해당 없음 | 2037–2048 검출은 14–32 px 댄서 머리뿐(crops_2041.jpg). 영상 전체는 미확인 |
| 작은·어두운·측면 얼굴 누락 | 추가 확인 필요 | 정답 라벨이 없어 수치를 내지 않음 |

YuNet threshold와 입력 해상도 실험은 **실행하지 않았다**. 모델 오탐이 원인이 아니었기 때문이다.

## 수정 (최소)

`worker/mosaic_worker/scenecut.py`: 히스토그램 두 조건은 통과했지만 회색 바닥값에서 떨어진 프레임에 한해, 128×72 회색 영상의 구조 상관(zero-mean NCC)이 0.6 미만이면 컷으로 인정한다. 평탄한 프레임(std < 4, 페이드 아웃)은 구조를 비교할 수 없으므로 구제하지 않는다. 기존 컷 판정은 그대로 유지된다.

### 수정 전후 비교 (like Jennie 전체 3287프레임 재생)

| 변형 | 컷 수 | 놓친 실제 컷 8개 중 검출 | 조명 변화 21개 중 오판 | 컷 반대편 샷에 남은 마스크 박스 | 제거된 실제 검출 박스 |
|---|---|---|---|---|---|
| 기존 | 25 | 0 | 0 | 417 | – |
| **NCC 구제 (적용)** | 32 (+74,154,1728,2037,2918,3048, 크레딧 3243) | 6 | 0 | 151 | 0 |
| 대안: gray ≥ 18 | 31 | 6 (1728 대신 357) | 0 | 183 | 0 |

- "놓친 실제 컷"과 "조명 변화" 분류는 320 px 썸네일을 보고 내가 판단한 것이다(정답 라벨 아님). 판정 근거 이미지: `scene_survey/nm_*.jpg`
- 여유 폭이 작다. 조명 변화 NCC의 최솟값은 0.645로 기준 0.6과의 차이가 0.045다. gray 대안도 최댓값 17.6으로 기준과 0.4 차이다. 둘 다 영상 하나로 측정한 값이다.
- 아직 놓치는 컷: 357(NCC 0.672), 2996(NCC 0.678). 남은 박스 151개 대부분이 이 두 컷 주변이다.
- 얼굴 노출 위험 점검: 제거된 박스 중 같은 샷에 그 트랙의 실제 검출이 있는 박스는 12개다. t903(7개)은 컷을 넘어 다음 샷 얼굴로 이어지던 브리지였고, 머리 위치는 다른 마스크 박스가 덮는다(`t903_check.jpg`, 76–95% 덮임). t922/t923(5개)은 edits에서 이미 보임 상태였고 새 트랙 t924/t925가 100% 덮는다.
- 2041 구간: 수정 후 2037/2041/2048에 150 px보다 큰 박스가 없다. 2030/2036에서 와이드 화면 댄서 박스가 거꾸로 복사되던 것도 사라졌다.
- 다른 영상: pexels-students-10clips(컷 9개)와 paris-3min(컷 25개)은 컷 집합이 동일하다. 결정적 파이프라인이므로 tracks 결과도 같다.
- 처리 시간: SceneCuts 프레임당 약 +1.1 ms(INTER_AREA 축소), 분석 1프레임 약 33 ms 대비 약 +3%. 3개 변형 동시 실행에서 잰 YuNet/NanoDet ms는 경합 때문에 부풀었으므로 비교에 쓰지 않는다.

## 재현 방법

```bash
docker run --rm -v "$PWD/worker:/app/worker" -v "$PWD/test-media:/m" face-mosaic-studio-worker \
  python scripts/debug_stages.py /m/<normalized.mp4> --start 1920 --end 2160 --full \
  --keyframes 2036,2037,2041 --out /m/debug-out [--tracks-json tracks.json --edits edits.json] \
  [--set scenecut.CUT_RESCUE_NCC=-1]   # 기존 동작
```

```bash
docker run --rm -v "$PWD/worker:/app/worker" -v "$PWD/test-media:/m" face-mosaic-studio-worker \
  python scripts/scene_survey.py /m/<video> --out /m/survey-out
```

입력은 운영과 같은 `normalized.mp4`(24 fps CFR, 3287프레임)를 써야 한다. 원본은 23.976 fps이고 3284프레임이다. UI 시각은 frame/24로 계산하므로 2041은 01:25.04다.

## 산출물

`test-media/debug-2026-11-05-like-jennie/` (git 제외)
- `base/`, `fix/`: `panels/f{프레임}_{A..E}.jpg`, `stages_ADE.mp4`(1920–2160), `boxes.jsonl`(박스별 로그), `summary.json`, `scene.json`
- `scene_survey/`: 컷 후보별 이전|현재 썸네일, `structure_ncc.json`
- `grid_2032_2047.jpg`, `crops_2041.jpg`, `t903_check.jpg`

## 남은 일 / 판단이 필요한 부분

1. 컷 판정 방식 선택: 적용한 NCC 구제를 유지할지, gray 18로 바꿀지, 두 조건을 모두 요구할지(5/8, 오판 방어가 더 강함). 사람이 결정해야 한다.
2. Fable 검토 제안: 구제로 찾은 컷을 "약한 컷"으로 분리해 유지 박스 정리와 cover_leading에만 쓰고, 링크·브리지·리뷰 판정에는 쓰지 않으면 오판 비용이 줄어든다. 범위 밖이라 적용하지 않았다.
3. 유지 박스의 화면 내용 검사(패치 상관)와 성장률 상한은 컷 검출과 무관하게 같은 증상을 줄일 수 있다. 측정은 아직 하지 않았다.
4. 영상 두 개만 측정했다. 조명이 강한 공연 영상을 추가로 측정해야 한다.
5. 기존 작업(dfe5fb01…)의 tracks.json은 그대로다. 재분석해야 반영된다.

## 정답표(라벨링) 도구 — 2026-11-05 추가

사람이 눈으로 답한 정답표로 이후 변경을 채점한다. 영상과 답은 로컬(`test-media/labels/`, git 제외)에만 둔다.

1. 문제 만들기(180문항: 장면 40 · 박스 110 · 놓친 얼굴 30):
   `docker run --rm -v "$PWD/worker:/app/worker" -v <scratch>:/s -v "$PWD/test-media/labels:/out" face-mosaic-studio-worker python scripts/make_label_sheet.py --video /s/normalized.mp4 --tracks /s/fix.json --base-tracks /s/base.json --edits /s/edits.json --survey /s/survey.json --out /out/like-jennie`
2. 답하기: `python3 worker/scripts/label_server.py test-media/labels/like-jennie --port 8765` → http://127.0.0.1:8765 (launch.json `label-tool`). 답은 누를 때마다 `labels.json`에 저장된다.
3. 채점: `docker run ... python scripts/score_labels.py /out/like-jennie --tracks A.json --tracks B.json --edits /s/edits.json`
   → 변형마다 얼굴 노출 수(늘면 안 됨), 얼굴 아닌 곳 가림 수, 장면 전환 놓침·오판을 출력한다. 화면에는 모델 점수나 박스 출처를 보여주지 않는다(판단 편향 방지).

## 정답표 채점 결과와 적용한 변경 — 2026-11-05

사용자 라벨 180문항(장면 40 · 박스 110 · 전체 프레임 30, 전체 프레임에서 "얼굴 아님" 클릭 137 / 마스크 196)으로 채점.

| 변형 (장면전환 수정 포함) | 잘못 가린 곳(전체 프레임 137 중 남음) | 얼굴로 남긴 마스크 노출(59 중) | 박스 문항 얼굴 노출 |
|---|---|---|---|
| 장면전환 수정만 | 137 | 0 | 기준 |
| **미리 깔기 0.25 s + 유지 박스 성장 없음 (적용)** | **114** | **0** | 변화 없음 |
| 의심 트랙 미리 깔기·브리지·내부보강 제외 | 110 | 4 | 변화 없음 |
| 의심 트랙 유지 0프레임 | 99 | 8 | +1 |
| 의심 트랙 유지 3프레임 | 109 | 4 | +1 |
| 모두 합침 | 63 | 9 | +1 |

- 잘못 가린 곳 137개 중 98개가 의심 트랙의 유지/미리 깔기 박스였다. 그러나 의심 트랙에 진짜 얼굴도 섞여 있어(위 표의 노출) 그대로 잘라내지 않았다. 다음 단계는 의심 판정 자체의 정확도를 높이는 것이다.
- 적용: `tracker.HOLD_GROWTH` 1.05 → 1.0, `link.LEAD_SEC` 0.5 → 0.25. 테스트 236개 통과. 새 기본값으로 실제 영상을 재생한 결과가 실험 결과와 완전히 동일하다.
- 한계: 영상 1개, 라벨러 1명. 다른 영상에서도 같은 방식으로 정답표를 만들어 노출이 늘지 않는지 확인해야 한다.
