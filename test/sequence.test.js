import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSequenceDirector } from '../public/display/core/sequence.js';

const CFG = { hideMs: 700, revealMs: 900, playTimeoutMarginMs: 1000, playbackRetryDelayMs: 3000 };

const plays = (actions) => actions.filter((a) => a.type === 'play');

// hidden-idle에서 far로 첫 등장을 끝내 visible-idle로 만든다. 마지막 재생 ID를 돌려준다.
function revealOnce(director, t = 0) {
  const [play] = director.setDecision('far', t);
  director.playbackFinished(play.playId, t + 900);
  assert.equal(director.snapshot().phase, 'visible-idle');
  return play.playId;
}

test('hidden-idle·unknown에서 시작해 far에서 처음 등장하고, 반복 near는 숨기를 다시 시작하지 않는다', () => {
  const director = createSequenceDirector(CFG);
  assert.deepEqual([director.snapshot().phase, director.snapshot().decision], ['hidden-idle', 'unknown']);
  revealOnce(director);

  const first = plays(director.setDecision('near', 1000));
  assert.deepEqual(first.map((a) => a.clip), ['hide']);
  assert.deepEqual(director.setDecision('near', 1100), []); // 같은 판정 반복
  director.playbackFinished(first[0].playId, 1700);
  assert.equal(director.snapshot().phase, 'hidden-idle');
  assert.deepEqual(director.setDecision('near', 1800), []);
});

test('전환 중 판정이 여러 번 바뀌면 최신 하나만 남아 클립 완료 후 재평가된다', () => {
  const director = createSequenceDirector(CFG);
  revealOnce(director);
  const [hide] = director.setDecision('near', 1000);

  assert.deepEqual(director.setDecision('far', 1100), []); // 숨는 중: 저장만
  const next = plays(director.playbackFinished(hide.playId, 1700));
  assert.deepEqual(next.map((a) => a.clip), ['reveal']);
  assert.ok(next[0].playId > hide.playId);

  // 나오는 중 near → far로 되돌아오면 최신 far만 남아 추가 전환이 없다.
  director.setDecision('near', 1800);
  director.setDecision('far', 1900);
  assert.deepEqual(director.playbackFinished(next[0].playId, 2600), []);
  assert.equal(director.snapshot().phase, 'visible-idle');
});

test('이전 재생 ID의 늦은 완료와 중복 완료는 무시한다', () => {
  const director = createSequenceDirector(CFG);
  const oldId = revealOnce(director);
  const [hide] = director.setDecision('near', 1000);

  assert.deepEqual(director.playbackFinished(oldId, 1100), []);
  assert.equal(director.snapshot().phase, 'hiding');
  director.playbackFinished(hide.playId, 1700);
  assert.deepEqual(director.playbackFinished(hide.playId, 1710), []); // 중복
  assert.equal(director.snapshot().phase, 'hidden-idle');
  assert.equal(director.snapshot().ignoredCompletions, 2);
});

test('unknown이면 진행 중 클립을 취소하고 숨은 상태로 안전 대기, 회복하면 새 ID로 다시 시작한다', () => {
  const director = createSequenceDirector(CFG);
  const [reveal] = director.setDecision('far', 0);

  const actions = director.setDecision('unknown', 300);
  assert.deepEqual(actions, [{ type: 'cancel', playId: reveal.playId }, { type: 'pose', pose: 'hidden' }]);
  assert.deepEqual([director.snapshot().phase, director.snapshot().playId], ['hidden-idle', null]);
  assert.deepEqual(director.playbackFinished(reveal.playId, 900), []); // 취소된 재생의 늦은 완료

  const [again] = plays(director.setDecision('far', 1500));
  assert.equal(again.clip, 'reveal');
  assert.ok(again.playId > reveal.playId);

  // 보이는 대기 중 unknown도 연출 없이 숨은 자세로 둔다(far로 처리하지 않음).
  director.playbackFinished(again.playId, 2400);
  assert.deepEqual(director.setDecision('unknown', 2500), [{ type: 'pose', pose: 'hidden' }]);
  assert.equal(director.snapshot().phase, 'hidden-idle');
});

test('재생 timeout은 오류로 처리하고, 늦은 완료를 받지 않으며, 대기 후 같은 far에서 새 ID로 재시도한다', () => {
  const director = createSequenceDirector(CFG);
  const [reveal] = director.setDecision('far', 0);

  assert.deepEqual(director.tick(1900), []); // 900 + 여유 1000 = 1900까지는 기다린다
  const timedOut = director.tick(1901);
  assert.deepEqual(timedOut, [{ type: 'cancel', playId: reveal.playId }, { type: 'pose', pose: 'hidden' }]);
  assert.equal(director.snapshot().lastError.reason, 'timeout');
  assert.deepEqual(director.playbackFinished(reveal.playId, 2000), []);
  assert.equal(director.snapshot().phase, 'hidden-idle');

  assert.deepEqual(director.tick(4900), []); // 재시도 대기 중
  const [retry] = plays(director.tick(4901));
  assert.equal(retry.clip, 'reveal');
  assert.ok(retry.playId > reveal.playId);

  // 기한을 넘겨 도착한 완료는 성공이 아니라 timeout으로 처리된다.
  const late = director.playbackFinished(retry.playId, 4901 + 1901);
  assert.equal(late[0].type, 'cancel');
  assert.equal(director.snapshot().phase, 'hidden-idle');
});

test('재생기 오류도 현재 ID일 때만 받아 안전 대기로 전환한다', () => {
  const director = createSequenceDirector(CFG);
  const oldId = revealOnce(director);
  const [hide] = director.setDecision('near', 1000);

  assert.deepEqual(director.playbackFailed(oldId, 'AbortError', 1100), []);
  const actions = director.playbackFailed(hide.playId, 'decode-error', 1200);
  assert.deepEqual(actions, [{ type: 'cancel', playId: hide.playId }, { type: 'pose', pose: 'hidden' }]);
  assert.deepEqual(director.snapshot().lastError, { playId: hide.playId, reason: 'decode-error', atMs: 1200 });
});

test('재시도 대기가 끝나는 호출에서 들어온 새 판정으로 재평가한다(이전 판정으로 시작하지 않음)', () => {
  const director = createSequenceDirector(CFG);
  const [reveal] = director.setDecision('far', 0);
  director.playbackFailed(reveal.playId, 'decode-error', 100); // 재시도 시각 3100

  assert.deepEqual(director.setDecision('near', 3101), []); // 이전 far로 등장하지 않는다
  assert.deepEqual(director.snapshot().phase, 'hidden-idle');
  assert.deepEqual(plays(director.setDecision('far', 3200)).map((a) => a.clip), ['reveal']);
});
