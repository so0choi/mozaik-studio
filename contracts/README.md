# Contracts

Spec §3 (`docs/superpowers/specs/2026-10-30-face-mosaic-studio-design.md`) is the source of truth.

`fixtures/` holds one 640×360, 30fps, 90-frame job:
- `tracks.sample.json` — t1 (always), t2 (always, split at 45 into t2a/t2b), t3 (frames 30–59)
- `edits.sample.json` — t1 and t2b visible; manual m1 (ellipse, trimmed to 44–46); m2 deleted; m3 (polygon, anchor frame 60, no propagation doc). `effects`: default mosaic/1, background blur/2, overrides t3 blur/3 and m1 color #ff0000
- `manual.sample.json` — manual propagation outputs (m1 frames 40–50, m2 frames 5–15)
- `expected-regions.json` — regions (`{id, shape, box, points, effect, block}`) at frames 0/44/45/47/60 (frame 89 has none), sorted by (x,y); frames 0–60 all have regions
- `effect-params.json` — `{cases:[{fn,args,expected}]}` 효과 파라미터 함수(블록 크기, 블러 σ)의 입력과 기대값
- `shape-masks.json` — 타원·다각형 모양 비트맵의 기대값(worker와 web이 같은 비트맵을 만드는지 고정). 다각형 채우기 규칙은 nonzero winding(겹침·이중 트레이스도 채움)이며, 점이 3개 미만이거나 부호 있는 넓이 |shoelace| < 1 인 다각형은 rect(전체)로 처리한다. 면적 합이 0인 나비넥타이도 여기에 걸려 rect가 된다.

Rules encoded by the expected values:
- Default is mosaic; only `visible` track ids (or groups) are skipped.
- Split at frame F: `<id>a` covers frames < F, `<id>b` covers frames ≥ F.
- Manual boxes: skip `deleted`; when `trim` is set keep only frames within [trim0, trim1]; block = max(8, min(w,h)//8). Region `block` = region_block(base, effect.strength).
- Track boxes use the track's fixed `blockSize`. Boxes are already expanded; never expand again.
- Effect order for a target piece: split-piece override, first group (in `groups` order) containing the track or piece decides (no override there: fall through to the track override, never to a later group), track override, `effects.default`. Manual regions: their own override, then default. Unknown override keys are ignored.
- Polygon points: P = B.xy + (P_drawn - A.xy) * (B.wh / A.wh), A = nearest anchor frame propagated box, B = frame box; equal to the drawn polygon at B == A and in the anchor fallback.
