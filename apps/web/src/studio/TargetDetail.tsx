import { memo } from 'react';
import type { Effect, Person } from '../lib/types';
import { EffectControls, effectName } from './EffectControls';

interface Props {
  person: Person;
  /** this person's own effect override, or null when it follows `inherited` */
  own: Effect | null;
  /** the effect that applies when there is no own override (default, or an older track override) */
  inherited: Effect;
  filterSupported: boolean;
  /** choosing an effect masks the person and sets the override in one edit */
  onEffect: (person: Person, effect: Effect) => void;
  onInherit: (person: Person) => void;
  onUncover: (person: Person) => void;
  onClose: () => void;
}

/**
 * Per-person effect panel. 원본 · 가림 해제 is a separate, idempotent button: unmasking is never one
 * click on the effect segment. Choosing any effect masks the person.
 */
function TargetDetailInner(p: Props) {
  const { person } = p;
  const uncovered = person.visible;
  return (
    <section className="bcard tdetail" aria-label="대상 상세" data-testid="target-detail">
      <div className="bc-head">
        <h3>{person.label}</h3>
        <button type="button" className="xbtn" aria-label="선택 해제" onClick={p.onClose}>
          ×
        </button>
      </div>
      <button
        type="button"
        className="uncover"
        aria-pressed={uncovered}
        onClick={() => {
          if (!uncovered) p.onUncover(person);
        }}
      >
        원본 · 가림 해제
      </button>
      <div className="trow stack">
        <span id="td-kind">효과</span>
        <EffectControls
          label="대상 효과 종류"
          value={uncovered ? null : p.own}
          inherited={uncovered ? null : p.own ? null : p.inherited}
          seed={p.own ?? p.inherited}
          filterSupported={p.filterSupported}
          onChange={(e) => p.onEffect(person, e)}
          onInherit={uncovered ? undefined : () => p.onInherit(person)}
        />
      </div>
      <p className={`helper${uncovered ? ' warn' : ''}`}>
        {uncovered
          ? '이 대상은 원본으로 보입니다. 얼굴이 드러나지 않는지 확인하세요.'
          : `이 대상은 ${effectName((p.own ?? p.inherited).type)}${(p.own ?? p.inherited).type === 'color' ? '으로' : '로'} 가려집니다.`}
      </p>
      {uncovered && <p className="fxstate" role="status">원본 · 가림 해제됨</p>}
    </section>
  );
}

export const TargetDetail = memo(TargetDetailInner);
