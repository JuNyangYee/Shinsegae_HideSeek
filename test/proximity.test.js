import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProximityJudge } from '../public/display/core/proximity.js';

const CFG = {
  nearBelowM: 0.6,
  farAboveM: 1.2,
  retreatMarginM: 0.05,
  approachHoldMs: 350,
  retreatHoldMs: 600,
  staleMs: 1200,
  maxSampleGapMs: 300,
};

const ok = (t, distanceM) => ({ source: 'mock', timestampMs: t, status: 'ok', distanceM });
const status = (t, s) => ({ source: 'mock', timestampMs: t, status: s });

// from~to(포함)까지 100ms 간격으로 같은 샘플을 넣고 마지막 결과를 돌려준다.
function feed(judge, from, to, make) {
  let last;
  for (let t = from; t <= to; t += 100) last = judge.update(make(t), t);
  return last;
}
const at = (d) => (t) => ok(t, d);

test('unknown에서 원거리는 600ms 유지 후 far, 경계값 1.2 m는 mid이고 approach 350ms로 바뀐다', () => {
  const judge = createProximityJudge(CFG);
  assert.equal(feed(judge, 0, 500, at(1.6)).decision, 'unknown');
  const far = judge.update(ok(600, 1.6), 600);
  assert.deepEqual([far.decision, far.changed], ['far', true]);
  assert.equal(feed(judge, 700, 900, at(1.6)).changed, false); // 같은 판정 반복은 변화 아님

  assert.equal(feed(judge, 1000, 1300, at(1.2)).decision, 'far'); // 1.2 m = mid 후보, 300ms로는 부족
  const mid = judge.update(ok(1350, 1.2), 1350);
  assert.deepEqual([mid.decision, mid.changed], ['mid', true]);

  // 0.6 m는 mid(경계), 0.59 m부터 near
  assert.equal(feed(judge, 1400, 2000, at(0.6)).decision, 'mid');
  feed(judge, 2100, 2400, at(0.59));
  assert.equal(judge.update(ok(2450, 0.59), 2450).decision, 'near');
});

test('멀어질 때만 여유가 붙는다: near는 0.65 m 이상, mid는 1.25 m 초과여야 바깥 후보가 된다', () => {
  const judge = createProximityJudge(CFG);
  feed(judge, 0, 600, at(0.4));
  assert.equal(judge.snapshot(600).decision, 'near');
  assert.equal(feed(judge, 700, 1600, at(0.64)).decision, 'near'); // 여유 안: 후보 없음
  assert.equal(judge.snapshot(1600).candidate, null);
  feed(judge, 1700, 2200, at(0.65));
  const mid = judge.update(ok(2300, 0.65), 2300); // 600ms(retreat)
  assert.deepEqual([mid.decision, mid.changed], ['mid', true]);

  assert.equal(feed(judge, 2400, 3200, at(1.25)).decision, 'mid'); // 1.25 m는 아직 mid
  feed(judge, 3300, 3800, at(1.26));
  assert.equal(judge.update(ok(3900, 1.26), 3900).decision, 'far');
  // far에서 다가올 때는 기획값 그대로: 1.2 m면 mid 후보
  feed(judge, 4000, 4300, at(1.2));
  assert.equal(judge.update(ok(4350, 1.2), 4350).decision, 'mid');
});

test('no-target은 정상 샘플이며 원거리로 본다(시작 unknown·근거리에서 600ms 뒤 far)', () => {
  const fresh = createProximityJudge(CFG);
  assert.equal(feed(fresh, 0, 500, (t) => status(t, 'no-target')).decision, 'unknown');
  assert.equal(fresh.update(status(600, 'no-target'), 600).decision, 'far');

  const judge = createProximityJudge(CFG);
  feed(judge, 0, 600, at(0.4));
  feed(judge, 700, 1200, (t) => status(t, 'no-target'));
  const r = judge.update(status(1300, 'no-target'), 1300);
  assert.deepEqual([r.decision, r.changed], ['far', true]);
  // 1.6 m 정상 샘플과 섞여도 같은 원거리 구역이라 판정이 흔들리지 않는다.
  assert.equal(judge.update(ok(1400, 1.6), 1400).changed, false);
});

test('다른 구역 샘플이 끼면 후보가 끊기고 유지 시간을 새로 센다', () => {
  const judge = createProximityJudge(CFG);
  feed(judge, 0, 600, at(1.6));
  feed(judge, 700, 900, at(0.9)); // mid 후보 200ms
  judge.update(ok(1000, 1.6), 1000); // far 샘플이 끼어 후보 취소
  assert.equal(feed(judge, 1100, 1400, at(0.9)).decision, 'far'); // 1100부터 300ms: 부족
  assert.equal(judge.update(ok(1450, 0.9), 1450).decision, 'mid');
});

test('error는 즉시 unknown, stale·신호 공백·잘못된 샘플은 유지 시간을 채우지 못한다', () => {
  const judge = createProximityJudge(CFG);
  feed(judge, 0, 600, at(1.6));
  const r = judge.update(status(700, 'error'), 700);
  assert.deepEqual([r.decision, r.changed], ['unknown', true]);
  assert.equal(feed(judge, 800, 1300, at(1.6)).decision, 'unknown'); // 회복 후 600ms를 다시 채워야 한다
  assert.equal(judge.update(ok(1400, 1.6), 1400).decision, 'far');

  assert.equal(judge.tick(2600).changed, false); // 마지막 샘플 후 1200ms: 아직 아님
  const stale = judge.tick(2601);
  assert.deepEqual([stale.decision, stale.changed], ['unknown', true]);

  // 공백(400ms > maxSampleGapMs)을 사이에 둔 샘플로는 600ms를 채우지 못한다.
  judge.update(ok(2700, 1.6), 2700);
  assert.equal(judge.update(ok(3100, 1.6), 3100).decision, 'unknown');
  assert.equal(judge.update(ok(3400, 1.6), 3400).decision, 'unknown');

  // 음수 거리·숫자 아님·시각 역행·미래 시각은 거절되고 진행 중 후보도 끊긴다.
  for (const [bad, reason] of [
    [ok(3500, -1), 'negative-distance'],
    [ok(3500, Number.NaN), 'bad-distance'],
    [ok(3200, 1.6), 'out-of-order'],
    [ok(9000, 1.6), 'future-timestamp'],
  ]) {
    const rejected = judge.update(bad, 3500);
    assert.deepEqual([rejected.accepted, rejected.reason], [false, reason]);
  }
  assert.equal(judge.update(ok(3700, 1.6), 3700).decision, 'unknown'); // 3100부터의 유지가 끊겨 부족
});
