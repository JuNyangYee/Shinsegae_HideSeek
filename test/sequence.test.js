import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTINGS } from '../public/display/config/settings.js';
import { createSequenceDirector } from '../public/display/core/sequence.js';

// 실제 설정(클립 표·순환)을 쓴다. 재생 오류 재시도·timeout 여유만 읽기 쉬운 값으로.
const CFG = { ...SETTINGS.sequence, playTimeoutMarginMs: 4000, playbackRetryDelayMs: 3000 };

const plays = (actions) => actions.filter((a) => a.type === 'play');
const clipsOf = (actions) => plays(actions).map((a) => a.clip);
const types = (actions) => actions.map((a) => a.type);

// 안전 정지에서 far로 시작해 복귀(SC4)를 끝내고 첫 놀이(SC0A)를 받는다. 그 재생을 돌려준다.
function startPlaying(director, t = 0) {
  const [ret] = plays(director.setDecision('far', t));
  assert.equal(ret.clip, 'SC4_Return_To_Play');
  const [first] = plays(director.playbackFinished(ret.playId, t + 7000));
  assert.equal(first.clip, 'SC0A_Pat');
  assert.equal(director.snapshot().phase, 'play');
  return first;
}

test('안전 정지·unknown에서 시작해 far면 복귀 후 SC0A → B → C → A로 순환한다', () => {
  const director = createSequenceDirector(CFG);
  assert.deepEqual([director.snapshot().phase, director.snapshot().decision], ['safe', 'unknown']);
  let cur = startPlaying(director);
  const seen = [cur.clip];
  for (let i = 0; i < 3; i += 1) {
    [cur] = plays(director.playbackFinished(cur.playId, 8000 * (i + 2)));
    seen.push(cur.clip);
  }
  assert.deepEqual(seen, ['SC0A_Pat', 'SC0B_Roll', 'SC0C_Playful', 'SC0A_Pat']);
});

test('far → mid는 놀이를 끊고 눈치챔 1회, 같은 mid에서는 반복하지 않고, far를 거쳐 다시 오면 또 눈치챈다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);

  const toMid = director.setDecision('mid', 9000);
  assert.deepEqual(types(toMid), ['cancel', 'play']);
  assert.equal(toMid[0].playId, play.playId);
  const [notice] = plays(toMid);
  assert.equal(notice.clip, 'SC1_Notice');

  // 눈치챔이 끝나면 중간 대기(SC1b 없음 → 놀이 순환 대체). 이어지는 mid에서 눈치챔이 다시 나오지 않는다.
  let [wait] = plays(director.playbackFinished(notice.playId, 17100));
  assert.equal(wait.clip, CFG.midIdleCycle[0]);
  assert.deepEqual(director.setDecision('mid', 17200), []);
  [wait] = plays(director.playbackFinished(wait.playId, 25200));
  assert.notEqual(wait.clip, 'SC1_Notice');

  // far로 돌아가면 루프는 그대로 이어지고, 다시 mid에 오면 눈치챔을 다시 한다.
  assert.deepEqual(director.setDecision('far', 26000), []);
  assert.deepEqual(clipsOf(director.setDecision('mid', 27000)), ['SC1_Notice']);
});

test('near는 보이는 루프·눈치챔을 바로 끊고 숨기, 숨는 중 바뀐 판정은 최신 하나만 끝난 뒤 반영한다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  const [notice] = plays(director.setDecision('mid', 8000));

  const duckActions = director.setDecision('near', 9000);
  assert.deepEqual(types(duckActions), ['cancel', 'play']);
  assert.equal(duckActions[0].playId, notice.playId);
  const [duck] = plays(duckActions);
  assert.equal(duck.clip, 'SC2_Duck');
  assert.ok(duck.playId > play.playId);

  // 숨는 중 far → mid → far: 끊지 않고 저장만, 끝나면 최신 far로 복귀
  assert.deepEqual(director.setDecision('far', 9500), []);
  assert.deepEqual(director.setDecision('mid', 9600), []);
  assert.deepEqual(director.setDecision('far', 9700), []);
  assert.deepEqual(clipsOf(director.playbackFinished(duck.playId, 13100)), ['SC4_Return_To_Play']);
});

test('숨은 루프는 near 동안 SC3 반복, mid가 되면 바로 복귀하고 끝난 뒤 눈치챔 없이 중간 대기', () => {
  const director = createSequenceDirector(CFG);
  startPlaying(director, 0);
  const [duck] = plays(director.setDecision('near', 8000));
  const [hidden1] = plays(director.playbackFinished(duck.playId, 12100));
  assert.equal(hidden1.clip, 'SC3_Hidden_Clue');
  const [hidden2] = plays(director.playbackFinished(hidden1.playId, 16200));
  assert.equal(hidden2.clip, 'SC3_Hidden_Clue');
  assert.ok(hidden2.playId > hidden1.playId);

  const back = director.setDecision('mid', 17000);
  assert.deepEqual(types(back), ['cancel', 'play']);
  const [ret] = plays(back);
  assert.equal(ret.clip, 'SC4_Return_To_Play');
  const after = clipsOf(director.playbackFinished(ret.playId, 24100));
  assert.deepEqual(after, [CFG.midIdleCycle[0]]);
  assert.notDeepEqual(after, ['SC1_Notice']);

  // 복귀 중 near가 되면 끊지 않고, 복귀가 끝난 뒤 다시 숨는다.
  const [duck2] = plays(director.setDecision('near', 25000));
  const [hidden3] = plays(director.playbackFinished(duck2.playId, 29100));
  const [ret2] = plays(director.setDecision('far', 30000));
  assert.equal(ret2.clip, 'SC4_Return_To_Play');
  assert.ok(hidden3.playId < ret2.playId);
  assert.deepEqual(director.setDecision('near', 31000), []);
  assert.deepEqual(clipsOf(director.playbackFinished(ret2.playId, 37100)), ['SC2_Duck']);
});

test('unknown은 숨는 중에도 즉시 취소하고 H 안전 정지, 늦은 완료는 무시, 회복이 near면 바로 숨은 루프', () => {
  const director = createSequenceDirector(CFG);
  startPlaying(director, 0);
  const [duck] = plays(director.setDecision('near', 8000));

  const stop = director.setDecision('unknown', 9000);
  assert.deepEqual(stop, [{ type: 'cancel', playId: duck.playId }, { type: 'pose', pose: 'hidden' }]);
  assert.deepEqual([director.snapshot().phase, director.snapshot().playId], ['safe', null]);
  assert.deepEqual(director.playbackFinished(duck.playId, 12100), []); // 취소된 재생의 늦은 완료
  assert.equal(director.snapshot().ignoredCompletions, 1);

  assert.deepEqual(clipsOf(director.setDecision('near', 13000)), ['SC3_Hidden_Clue']);
});

test('재생 timeout은 오류로 안전 정지, 기한 뒤 완료는 받지 않고, 대기 후 같은 판정으로 새 ID 재시도', () => {
  const director = createSequenceDirector(CFG);
  const [ret] = plays(director.setDecision('far', 0));
  const deadline = CFG.clips.SC4_Return_To_Play.durationMs + CFG.playTimeoutMarginMs;

  assert.deepEqual(director.tick(deadline), []);
  const timedOut = director.tick(deadline + 1);
  assert.deepEqual(timedOut, [{ type: 'cancel', playId: ret.playId }, { type: 'pose', pose: 'hidden' }]);
  assert.equal(director.snapshot().lastError.reason, 'timeout');
  assert.deepEqual(director.playbackFinished(ret.playId, deadline + 10), []);

  assert.deepEqual(director.tick(deadline + 1 + 2999), []); // 재시도 대기 중
  const [retry] = plays(director.tick(deadline + 1 + 3000));
  assert.equal(retry.clip, 'SC4_Return_To_Play');
  assert.ok(retry.playId > ret.playId);
});

test('재생기 오류는 현재 ID만 받고, retryNow로 대기를 건너뛰며, 일시 중지 중에는 아무것도 재생하지 않는다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  assert.deepEqual(director.playbackFailed(play.playId - 1, 'old', 100), []); // 이전 ID
  const failed = director.playbackFailed(play.playId, 'autoplay-blocked', 200);
  assert.deepEqual(failed, [{ type: 'cancel', playId: play.playId }, { type: 'pose', pose: 'hidden' }]);
  assert.notEqual(director.snapshot().retryAtMs, null);
  assert.deepEqual(clipsOf(director.retryNow(300)), ['SC4_Return_To_Play']); // H에서 다시 시작하므로 복귀부터

  // 탭 숨김 등으로 멈추면 안전 정지, 멈춘 동안 판정이 바뀌어도 재생하지 않고, 풀리면 최신 판정으로 시작
  assert.deepEqual(types(director.setSuspended(true, 400)), ['cancel', 'pose']);
  assert.deepEqual(director.setDecision('near', 500), []);
  assert.deepEqual(clipsOf(director.setSuspended(false, 600)), ['SC3_Hidden_Clue']);
});
