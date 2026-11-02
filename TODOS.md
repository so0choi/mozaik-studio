# TODOS

## 키보드만으로 다각형 그리기
- **What:** 다각형 수동 영역의 꼭짓점을 키보드(이동 커서 또는 좌표 입력)로 찍을 수 있게 한다.
- **Why:** 지금 사각형·타원·다각형 그리기는 포인터 전용이라 키보드 사용자는 수동 영역을 만들 수 없다.
- **Pros:** 접근성 완성, 정밀한 좌표 입력 가능.
- **Cons:** 커서 이동·확대 UI가 필요해 BoxTool이 커진다.
- **Context:** 2026-11-02 디자인 리뷰(효과·모양 계획)에서 범위 밖으로 미룸. 시작점: `apps/web/src/studio/BoxTool.tsx`, spec `docs/superpowers/specs/2026-11-02-effects-and-regions-design.md` §5.2 접근성.
- **Depends on:** 효과·모양 계획 Task 7.

## 추적 실패 수동 영역을 렌더 전 확인 항목으로
- **What:** 수동 영역 추적이 실패하면(기준 프레임만 가려짐) 렌더 전에 필수 확인 항목으로 띄운다.
- **Why:** 사용자가 구간(trim)을 지정하면 그 구간 전체가 가려진다고 오해할 수 있다. 얼굴 노출이 가장 나쁜 실패다.
- **Pros:** 조용한 노출 경로 하나를 막는다.
- **Cons:** 렌더 게이트(API `review-required.ts`와 웹 `reviewRequired.ts`)에 새 항목 종류가 생긴다.
- **Context:** 기존 동작(`apps/web/src/lib/masks.ts` 앵커 대체, `ManualBoxCard.tsx` 실패 문구). 효과·모양 계획은 문구만 "추적 실패 · 기준 프레임만 가려짐"으로 바꾼다.
- **Depends on:** 없음(독립 작업).
