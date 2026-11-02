import { memo } from 'react';
import type { Person } from '../lib/types';

interface Props {
  person: Person;
  onSetVisible: (key: string, visible: boolean) => void;
  onClose: () => void;
}

const SOON = '준비 중';

/** Per-person effect panel. 원본 = visible (unmasked), 모자이크 = masked. Nothing here changes visibility except explicit clicks. */
function TargetDetailInner({ person, onSetVisible, onClose }: Props) {
  const masked = !person.visible;
  return (
    <section className="bcard tdetail" aria-label="대상 상세" data-testid="target-detail">
      <div className="bc-head">
        <h3>{person.label}</h3>
        <button type="button" className="xbtn" aria-label="선택 해제" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="trow">
        <span id="td-apply">대상 효과 적용</span>
        <button
          type="button"
          className="tsw"
          role="switch"
          aria-checked={masked}
          aria-labelledby="td-apply"
          onClick={() => onSetVisible(person.key, masked)}
        />
      </div>
      <div className="trow stack">
        <span id="td-kind">대상 효과</span>
        <div className="seg" role="group" aria-labelledby="td-kind">
          <button type="button" className={person.visible ? 'on' : undefined} aria-pressed={person.visible} onClick={() => onSetVisible(person.key, true)}>
            원본
          </button>
          <button type="button" disabled title={SOON} aria-pressed="false">
            블러
          </button>
          <button type="button" className={masked ? 'on' : undefined} aria-pressed={masked} onClick={() => onSetVisible(person.key, false)}>
            모자이크
          </button>
          <button type="button" disabled title={SOON} aria-pressed="false">
            색상
          </button>
        </div>
      </div>
      <div className="trow">
        <button type="button" className="rowbtn" disabled title={SOON}>
          <span>세부 조정</span>
          <span aria-hidden="true">›</span>
        </button>
        <button type="button" className="resetbtn" onClick={() => onSetVisible(person.key, false)}>
          기본값
        </button>
      </div>
      <p className={`helper${person.visible ? ' warn' : ''}`}>
        {person.visible
          ? '이 대상은 원본으로 보입니다. 얼굴이 드러나지 않는지 확인하세요.'
          : '이 대상은 모자이크로 가려집니다.'}
      </p>
    </section>
  );
}

export const TargetDetail = memo(TargetDetailInner);
