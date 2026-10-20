import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProximityJudge } from '../public/display/core/proximity.js';

const CFG = {
  nearMaxM: 1.2,
  farMinM: 2.0,
  nearHoldMs: 350,
  farHoldMs: 600,
  staleMs: 1200,
  maxSampleGapMs: 300,
};

const ok = (t, distanceM) => ({ source: 'mock', timestampMs: t, status: 'ok', distanceM });
const status = (t, s) => ({ source: 'mock', timestampMs: t, status: s });

// from~to(포함)까지 100ms 간격으로 같은 거리 샘플을 넣고 마지막 결과를 돌려준다.
function feed(judge, from, to, distanceM) {
  let last;
  for (let t = from; t <= to; t += 100) last = judge.update(ok(t, distanceM), t);
  return last;
}

test('unknown에서 시작해 원거리를 유지 시간만큼 이어야 far가 되고, 반복 far는 변화로 알리지 않는다', () => {
  const judge = createProximityJudge(CFG);
  assert.equal(judge.snapshot(0).decision, 'unknown');
  assert.equal(feed(judge, 0, 500, 3).decision, 'unknown');
  const confirmed = judge.update(ok(600, 3), 600);
  assert.deepEqual([confirmed.decision, confirmed.changed], ['far', true]);
  assert.equal(feed(judge, 700, 1500, 3).changed, false);
});

test('사이 구간은 이전 판정을 유지하고, 근거리 후보를 끊어 유지 시간을 새로 세게 한다', () => {
  const judge = createProximityJudge(CFG);
  feed(judge, 0, 600, 3);
  assert.equal(feed(judge, 700, 1000, 1.6).decision, 'far'); // 사이 구간: far 유지
  feed(judge, 1100, 1300, 1.0); // 근거리 200ms 유지 후
  judge.update(ok(1400, 1.5), 1400); // 사이 구간 샘플이 끼어들면 후보 취소
  assert.equal(feed(judge, 1500, 1700, 1.0).decision, 'far'); // 1500부터 다시 세서 아직 부족
  const near = judge.update(ok(1850, 1.2), 1850); // 경계값 1.2m는 근거리, 350ms 충족
  assert.deepEqual([near.decision, near.changed], ['near', true]);
});

test('no-target은 이전 판정을 유지하되 후보를 끊고, 시작 unknown은 그대로 둔다', () => {
  const fresh = createProximityJudge(CFG);
  assert.equal(fresh.update(status(0, 'no-target'), 0).decision, 'unknown');

  const judge = createProximityJudge(CFG);
  feed(judge, 0, 600, 3);
  feed(judge, 700, 900, 0.5); // 근거리 200ms
  const r = judge.update(status(1000, 'no-target'), 1000);
  assert.deepEqual([r.decision, r.changed], ['far', false]);
  assert.equal(feed(judge, 1100, 1400, 0.5).decision, 'far'); // 1100부터 다시 셈
  assert.equal(judge.update(ok(1450, 0.5), 1450).decision, 'near');
});

test('error는 즉시 unknown이고, 회복 후 유지 시간을 처음부터 다시 채워야 한다', () => {
  const judge = createProximityJudge(CFG);
  feed(judge, 0, 600, 3);
  const r = judge.update(status(700, 'error'), 700);
  assert.deepEqual([r.decision, r.changed], ['unknown', true]);
  assert.equal(feed(judge, 800, 1300, 3).decision, 'unknown');
  assert.equal(judge.update(ok(1400, 3), 1400).decision, 'far');
});

test('샘플이 끊기면 tick에서 stale → unknown, 신호 공백·잘못된 샘플은 유지 시간을 채우지 못한다', () => {
  const judge = createProximityJudge(CFG);
  feed(judge, 0, 600, 3);
  assert.equal(judge.tick(1800).changed, false); // 마지막 샘플 후 1200ms: 아직 아님
  const stale = judge.tick(1801);
  assert.deepEqual([stale.decision, stale.changed], ['unknown', true]);
  assert.equal(judge.snapshot(1801).stale, true);

  // 공백(400ms > maxSampleGapMs)을 사이에 둔 두 샘플로는 원거리 600ms를 채우지 못한다.
  judge.update(ok(2000, 3), 2000);
  assert.equal(judge.update(ok(2400, 3), 2400).decision, 'unknown');
  assert.equal(judge.update(ok(2700, 3), 2700).decision, 'unknown');

  // 음수 거리·숫자 아님·시각 역행은 거절되고 진행 중 후보도 끊긴다.
  for (const [bad, reason] of [
    [ok(2800, -1), 'negative-distance'],
    [ok(2800, Number.NaN), 'bad-distance'],
    [ok(2500, 3), 'out-of-order'],
    [ok(9000, 3), 'future-timestamp'],
  ]) {
    const r = judge.update(bad, 2800);
    assert.deepEqual([r.accepted, r.reason], [false, reason]);
  }
  assert.equal(judge.update(ok(3000, 3), 3000).decision, 'unknown'); // 2400부터의 유지가 끊겨 부족
});
