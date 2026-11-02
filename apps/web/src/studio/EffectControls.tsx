import { memo, useEffect, useRef, useState } from 'react';
import { DEFAULT_COLOR } from '../lib/effectParams';
import type { Effect, EffectType } from '../lib/types';

const TYPES: { type: EffectType; name: string }[] = [
  { type: 'blur', name: '블러' },
  { type: 'mosaic', name: '모자이크' },
  { type: 'color', name: '색상' },
];
export const effectName = (t: EffectType) => TYPES.find((x) => x.type === t)!.name;
export const BLUR_FALLBACK_NOTE = '이 브라우저 미리보기에서는 블러가 모자이크로 보입니다. 결과 영상은 블러로 만들어집니다.';

interface Props {
  /** this target's own effect; null = follows `inherited` (or, with `inherited` null too, nothing selected) */
  value: Effect | null;
  inherited: Effect | null;
  /** group label of the segment */
  label: string;
  filterSupported: boolean;
  onChange: (e: Effect) => void;
  /** shown only while `value` is an own value */
  onInherit?: () => void;
  /** adds a leading 끄기 segment (background effect); pressed while there is no effect */
  onOff?: () => void;
  /** strength/color used when the first effect is chosen from "nothing" */
  seed?: Effect | null;
}

/** Listens to the native `change` event: one commit per drag release (React's onChange fires on every input). */
function useNativeChange<T extends HTMLInputElement>(onCommit: (value: string) => void) {
  const ref = useRef<T>(null);
  const cb = useRef(onCommit);
  cb.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = () => cb.current(el.value);
    el.addEventListener('change', h);
    return () => el.removeEventListener('change', h);
  }, []);
  return ref;
}

function Strength({ effect, onCommit }: { effect: Effect; onCommit: (s: number) => void }) {
  const [local, setLocal] = useState(effect.strength);
  useEffect(() => setLocal(effect.strength), [effect.strength]);
  const ref = useNativeChange<HTMLInputElement>((v) => onCommit(Number(v)));
  return (
    <div className="fxrow">
      <div className="fxlab">
        <span>강도 {local}/5</span>
      </div>
      <div className="fxslide">
        <small>약하게</small>
        <input
          ref={ref}
          type="range"
          min={1}
          max={5}
          step={1}
          value={local}
          aria-label="강도"
          aria-valuetext={`${local} / 5`}
          data-effect-control
          onInput={(e) => setLocal(Number((e.target as HTMLInputElement).value))}
          onChange={(e) => setLocal(Number(e.target.value))}
        />
        <small>강하게</small>
      </div>
    </div>
  );
}

function ColorPick({ effect, onCommit }: { effect: Effect; onCommit: (c: string) => void }) {
  const [local, setLocal] = useState(effect.color);
  useEffect(() => setLocal(effect.color), [effect.color]);
  const ref = useNativeChange<HTMLInputElement>((v) => onCommit(v));
  return (
    <div className="fxrow fxcolor">
      <input
        ref={ref}
        type="color"
        value={local}
        aria-label="색상"
        data-effect-control
        onInput={(e) => setLocal((e.target as HTMLInputElement).value)}
        onChange={(e) => setLocal(e.target.value)}
      />
      <span className="mono">{local}</span>
    </div>
  );
}

/** Effect type segment + strength/color + "follow default", reused for the default, background, person and manual-region effects. */
function EffectControlsInner(p: Props) {
  const shown = p.value ?? p.inherited;
  const own = p.value !== null;
  const base = shown ?? p.seed ?? null;
  const choose = (type: EffectType) => {
    if (shown && shown.type === type) return;
    p.onChange({ type, strength: base?.strength ?? 1, color: base?.color ?? DEFAULT_COLOR });
  };
  return (
    <div className="fxctl" data-effect-control>
      <div className="seg" role="group" aria-label={p.label}>
        {p.onOff && (
          <button type="button" className={!shown ? 'on' : undefined} aria-pressed={!shown} data-effect-control onClick={() => shown && p.onOff!()}>
            끄기
          </button>
        )}
        {TYPES.map((t) => {
          const on = shown?.type === t.type;
          return (
            <button key={t.type} type="button" className={on ? 'on' : undefined} aria-pressed={on} data-effect-control onClick={() => choose(t.type)}>
              {t.name}
            </button>
          );
        })}
      </div>
      {shown && !own && <p className="fxstate">{effectName(shown.type)} (기본값)</p>}
      {shown && (
        <>
          {shown.type === 'color' ? (
            <ColorPick effect={shown} onCommit={(color) => p.onChange({ ...shown, color })} />
          ) : (
            <Strength effect={shown} onCommit={(strength) => p.onChange({ ...shown, strength })} />
          )}
          {shown.type === 'blur' && !p.filterSupported && <p className="fxnote">{BLUR_FALLBACK_NOTE}</p>}
        </>
      )}
      {own && p.onInherit && (
        <button type="button" className="resetbtn" data-effect-control onClick={p.onInherit}>
          기본값 따르기
        </button>
      )}
    </div>
  );
}

export const EffectControls = memo(EffectControlsInner);
