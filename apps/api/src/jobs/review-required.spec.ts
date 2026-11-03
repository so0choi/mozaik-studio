import { isRequired, requiredItems } from './review-required';

const item = (type: string, trackIds: string[], severity?: string) => ({ id: 'r1', type, trackIds, severity });

describe('isRequired severity', () => {
  it('advisory gap/low_confidence is never required', () => {
    expect(isRequired(item('gap', ['t1'], 'advisory'), {})).toBe(false);
    expect(isRequired(item('low_confidence', ['t1'], 'advisory'), {})).toBe(false);
  });
  it('required or missing severity keeps today behaviour', () => {
    expect(isRequired(item('gap', ['t1'], 'required'), {})).toBe(true);
    expect(isRequired(item('gap', ['t1']), {})).toBe(true);
    expect(isRequired(item('gap', ['t1']), { visible: ['t1'] })).toBe(false);
  });
  it('crossing ignores a severity field', () => {
    expect(isRequired(item('crossing', ['t1', 't2'], 'advisory'), { visible: ['t1'] })).toBe(true);
  });
  it('requiredItems drops advisory items', () => {
    expect(requiredItems([item('gap', ['t1'], 'advisory'), item('gap', ['t2'])], {})).toHaveLength(1);
  });
});
