import { DEFAULT_EDITS, validateEdits } from './edits.validator';

const tracks = new Set(['t1', 't2']);
const none = new Set<string>();
const run = (patch: any) => validateEdits({ ...DEFAULT_EDITS(), ...patch }, tracks, none);
const manual = (extra: any = {}) => ({ id: 'm1', anchors: [{ frame: 0, box: [0, 0, 10, 10] }], trim: null, deleted: false, ...extra });
const eff = (e: any) => run({ effects: { default: { type: 'mosaic', strength: 1 }, background: null, overrides: {}, ...e } });

describe('validateEdits effects', () => {
  it('accepts defaults, an omitted effects field and valid effect settings', () => {
    expect(run({})).toBeNull();
    expect(run({ effects: undefined })).toBeNull();
    expect(eff({ background: null })).toBeNull();
    expect(eff({ default: { type: 'blur' } })).toBeNull();
    expect(eff({ default: { type: 'color', color: '#aabb00' } })).toBeNull();
  });
  it('rejects effects without a default', () => {
    expect(typeof run({ effects: { background: null, overrides: {} } })).toBe('string');
  });
  it('accepts override keys: track, split piece, group, manual', () => {
    const ok = run({
      splits: [{ trackId: 't2', frame: 5 }],
      groups: [{ id: 'g1', trackIds: ['t1'], label: '' }],
      manual: [manual()],
      effects: { default: { type: 'mosaic' }, background: { type: 'blur', strength: 5 },
        overrides: { t1: { type: 'blur' }, t2a: { type: 'color' }, g1: { type: 'mosaic' }, m1: { type: 'blur' } } },
    });
    expect(ok).toBeNull();
  });
  it.each([
    [{ type: 'none' }], [{ type: 'pixel' }], [{ type: 'blur', strength: 0 }], [{ type: 'blur', strength: 6 }],
    [{ type: 'blur', strength: 2.5 }], [{ type: 'color', color: 'red' }], [{ type: 'color', color: '#fff' }],
  ])('rejects bad effect %j', (d) => {
    expect(typeof eff({ default: d })).toBe('string');
    expect(typeof eff({ background: d })).toBe('string');
    expect(typeof eff({ overrides: { t1: d } })).toBe('string');
  });
  it('rejects unknown override key', () => {
    expect(eff({ overrides: { t9: { type: 'blur' } } })).toBe('알 수 없는 대상입니다: t9');
  });
  it('rejects non-object effects', () => {
    expect(typeof run({ effects: 3 })).toBe('string');
    expect(typeof run({ effects: { default: { type: 'blur' }, background: null, overrides: [] } })).toBe('string');
  });
});

describe('validateEdits manual shapes', () => {
  const tri = [[0, 0], [1, 0], [0.5, 1]];
  it('accepts shapes', () => {
    expect(run({ manual: [manual()] })).toBeNull();
    expect(run({ manual: [manual({ shape: 'rect' })] })).toBeNull();
    expect(run({ manual: [manual({ shape: 'ellipse' })] })).toBeNull();
    expect(run({ manual: [manual({ shape: 'polygon', points: tri })] })).toBeNull();
  });
  it.each([
    [{ shape: 'star' }], [{ shape: 'polygon' }], [{ shape: 'polygon', points: [[0, 0], [1, 1]] }],
    [{ shape: 'polygon', points: [[1.2, 0], [1, 1], [0, 1]] }], [{ shape: 'rect', points: [[0, 0], [1, 0], [0, 1]] }],
    [{ shape: 'polygon', points: [[0, 0], [1, 0], [0, 'x']] }],
  ])('rejects %j', (x) => {
    expect(typeof run({ manual: [manual(x)] })).toBe('string');
  });
});
