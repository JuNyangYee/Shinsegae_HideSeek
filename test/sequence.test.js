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

test('판정이 바뀌어도 진행 중 클립은 끝까지 재생하고, 끝난 뒤 최신 판정 하나만 반영한다(far → mid 눈치챔 1회)', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);

  assert.deepEqual(director.setDecision('mid', 9000), []); // 놀이를 끊지 않는다
  const [notice] = plays(director.playbackFinished(play.playId, 16100));
  assert.equal(notice.clip, 'SC1_Notice');

  // 눈치챔이 끝나면 중간 대기(SC1b 없음 → 놀이 순환 대체). 이어지는 mid에서 눈치챔이 다시 나오지 않는다.
  let [wait] = plays(director.playbackFinished(notice.playId, 24200));
  assert.equal(wait.clip, CFG.midIdleCycle[0]);
  [wait] = plays(director.playbackFinished(wait.playId, 32300));
  assert.notEqual(wait.clip, 'SC1_Notice');

  // far를 거쳐 다시 mid에 오면 다시 눈치챈다(역시 클립 끝에서).
  assert.deepEqual(director.setDecision('far', 33000), []);
  assert.deepEqual(director.setDecision('mid', 34000), []);
  assert.deepEqual(clipsOf(director.playbackFinished(wait.playId, 40400)), ['SC1_Notice']);
});

test('near도 놀이·눈치챔을 끊지 않고 끝난 뒤 숨기, 빠르게 near → far로 돌아오면 지나간 near는 실행하지 않는다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);

  // 놀이 중 near → far: 끝났을 때 최신 판정 far만 반영 → 놀이 계속
  assert.deepEqual(director.setDecision('near', 8500), []);
  assert.deepEqual(director.setDecision('far', 8800), []);
  const [next] = plays(director.playbackFinished(play.playId, 15100));
  assert.equal(next.clip, 'SC0B_Roll');

  // 놀이 → mid(끝에서 눈치챔) → 눈치챔 중 near(끝에서 숨기)
  assert.deepEqual(director.setDecision('mid', 16000), []);
  const [notice] = plays(director.playbackFinished(next.playId, 23200));
  assert.equal(notice.clip, 'SC1_Notice');
  assert.deepEqual(director.setDecision('near', 24000), []);
  const [duck] = plays(director.playbackFinished(notice.playId, 31300));
  assert.equal(duck.clip, 'SC2_Duck');

  // 숨는 중 far → mid → far: 저장만, 끝나면 최신 far로 복귀
  assert.deepEqual(director.setDecision('far', 31500), []);
  assert.deepEqual(director.setDecision('mid', 31600), []);
  assert.deepEqual(director.setDecision('far', 31700), []);
  assert.deepEqual(clipsOf(director.playbackFinished(duck.playId, 35400)), ['SC4_Return_To_Play']);
});

test('숨기가 끝나면 숨은 대기 → 랜덤 대기 뒤 SC3 1회 → 새 랜덤 대기, 대기 중 mid는 바로 복귀', () => {
  const draws = [0, 0.5];
  let calls = 0;
  const director = createSequenceDirector(CFG, { random: () => draws[calls++] });
  const { minMs, maxMs } = CFG.hiddenClueDelayMs;
  const play = startPlaying(director, 0);
  director.setDecision('near', 1000);
  const [duck] = plays(director.playbackFinished(play.playId, 8100));
  assert.equal(duck.clip, 'SC2_Duck');

  // 숨기 끝 → 클립 없는 숨은 대기(첫 추첨 0 → minMs)
  assert.deepEqual(director.playbackFinished(duck.playId, 12200), []);
  let snap = director.snapshot();
  assert.deepEqual([snap.phase, snap.playId, snap.clueAtMs], ['hidden', null, 12200 + minMs]);
  assert.deepEqual(director.tick(12200 + minMs - 1), []); // 대기 중 tick은 다시 추첨하지 않는다
  assert.equal(calls, 1);

  const [clue] = plays(director.tick(12200 + minMs));
  assert.equal(clue.clip, 'SC3_Hidden_Clue');
  assert.equal(director.snapshot().clueAtMs, null);
  // 단서 끝 → 새 랜덤 대기(두 번째 추첨 0.5)
  const t1 = 12200 + minMs + 4100;
  assert.deepEqual(director.playbackFinished(clue.playId, t1), []);
  assert.equal(director.snapshot().clueAtMs, t1 + Math.round(minMs + 0.5 * (maxMs - minMs)));
  assert.equal(calls, 2);

  // 대기 중 mid → 끊을 클립 없이 바로 복귀, 예약 취소. 복귀 뒤에는 눈치챔 없이 중간 대기.
  const back = director.setDecision('mid', t1 + 1000);
  assert.deepEqual(types(back), ['play']);
  assert.equal(back[0].clip, 'SC4_Return_To_Play');
  assert.equal(director.snapshot().clueAtMs, null);
  assert.deepEqual(clipsOf(director.playbackFinished(back[0].playId, t1 + 8100)), [CFG.midIdleCycle[0]]);
});

test('단서(SC3) 재생 중 mid는 끝까지 재생한 뒤 복귀한다', () => {
  const director = createSequenceDirector(CFG, { random: () => 0 });
  director.setDecision('near', 0); // 시작 near → 숨은 대기부터
  assert.deepEqual([director.snapshot().phase, director.snapshot().noticed], ['hidden', true]); // 숨은 대기는 관객 인지 상태
  const [clue] = plays(director.tick(CFG.hiddenClueDelayMs.minMs));
  assert.equal(clue.clip, 'SC3_Hidden_Clue');
  assert.deepEqual(director.setDecision('mid', CFG.hiddenClueDelayMs.minMs + 1000), []);
  assert.deepEqual(clipsOf(director.playbackFinished(clue.playId, CFG.hiddenClueDelayMs.minMs + 4100)), ['SC4_Return_To_Play']);
});

test('unknown은 숨는 중에도 즉시 취소하고 H 안전 정지, 늦은 완료는 무시, 회복이 near면 숨은 대기, 대기 중 unknown은 예약 취소', () => {
  const director = createSequenceDirector(CFG, { random: () => 0 });
  const play = startPlaying(director, 0);
  director.setDecision('near', 1000);
  const [duck] = plays(director.playbackFinished(play.playId, 8100));

  const stop = director.setDecision('unknown', 9000);
  assert.deepEqual(stop, [{ type: 'cancel', playId: duck.playId }, { type: 'pose', pose: 'hidden' }]);
  assert.deepEqual([director.snapshot().phase, director.snapshot().playId], ['safe', null]);
  assert.deepEqual(director.playbackFinished(duck.playId, 12100), []); // 취소된 재생의 늦은 완료
  assert.equal(director.snapshot().ignoredCompletions, 1);

  assert.deepEqual(director.setDecision('near', 13000), []); // 숨은 대기부터(SC3 바로 재생 안 함)
  assert.deepEqual([director.snapshot().phase, director.snapshot().clueAtMs], ['hidden', 13000 + CFG.hiddenClueDelayMs.minMs]);

  assert.deepEqual(director.setDecision('unknown', 14000), [{ type: 'pose', pose: 'hidden' }]);
  assert.deepEqual([director.snapshot().phase, director.snapshot().clueAtMs], ['safe', null]);
  assert.deepEqual(director.tick(13000 + CFG.hiddenClueDelayMs.minMs + 1), []); // 취소된 예약은 재생하지 않는다
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
  assert.deepEqual(director.setSuspended(false, 600), []); // 풀리면 near → 숨은 대기(단서 예약)
  assert.equal(director.snapshot().phase, 'hidden');
  assert.notEqual(director.snapshot().clueAtMs, null);
  assert.deepEqual(types(director.setSuspended(true, 700)), ['pose']); // 다시 멈추면 예약 취소
  assert.equal(director.snapshot().clueAtMs, null);
});
