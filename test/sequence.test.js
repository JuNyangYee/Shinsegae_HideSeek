import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTINGS } from '../public/display/config/settings.js';
import { clipPlayMs, createSequenceDirector } from '../public/display/core/sequence.js';

// 실제 설정(클립 표·편집 구간·순환)을 쓴다. 재시도·timeout 여유·전환 예약·섞기 시간만 읽기 쉬운 값으로 고정.
const CFG = {
  ...SETTINGS.sequence,
  playTimeoutMarginMs: 4000,
  playbackRetryDelayMs: 3000,
  switchWithinMs: 800,
  naturalBlendMs: 150,
  forcedBlendMs: 200,
};

const plays = (actions) => actions.filter((a) => a.type === 'play');
const clipsOf = (actions) => plays(actions).map((a) => a.clip);
const types = (actions) => actions.map((a) => a.type);

// 안전 정지에서 far로 시작해 복귀(SC4)를 끝내고 첫 놀이(SC0A)를 받는다. 그 재생을 돌려준다.
function startPlaying(director, t = 0) {
  const [ret] = plays(director.setDecision('far', t));
  assert.equal(ret.clip, 'SC4_Return_To_Play');
  const [first] = plays(director.playbackFinished(ret.playId, t + 5000));
  assert.equal(first.clip, 'SC0A_Pat');
  assert.equal(director.snapshot().phase, 'play');
  return first;
}

test('편집 구간 길이: 재생 지시의 durationMs와 timeout은 원본이 아니라 inSec~outSec 길이를 쓴다', () => {
  assert.equal(clipPlayMs(CFG.clips.SC0A_Pat), 6750);
  assert.equal(clipPlayMs(CFG.clips.SC2_Duck), 2000);
  assert.equal(clipPlayMs(CFG.clips.SC3_Hidden_Clue), CFG.clips.SC3_Hidden_Clue.durationMs); // 편집 없음 = 원본 전체
  const director = createSequenceDirector(CFG);
  const [ret] = plays(director.setDecision('far', 0));
  assert.equal(ret.durationMs, 5500);
  const deadline = 5500 + CFG.playTimeoutMarginMs;
  assert.deepEqual(director.tick(deadline), []);
  assert.deepEqual(types(director.tick(deadline + 1)), ['cancel', 'pose']);
  assert.equal(director.snapshot().lastError.reason, 'timeout');
});

test('안전 정지·unknown에서 시작해 far면 복귀 후 SC0A → B → C → A로 순환, 이어지는 전환은 짧게 섞는다', () => {
  const director = createSequenceDirector(CFG);
  let cur = startPlaying(director);
  assert.deepEqual([cur.blendMs, cur.forced], [150, false]);
  const seen = [cur.clip];
  for (let i = 0; i < 3; i += 1) {
    [cur] = plays(director.playbackFinished(cur.playId, 5000 + 6000 * (i + 1)));
    seen.push(cur.clip);
  }
  assert.deepEqual(seen, ['SC0A_Pat', 'SC0B_Roll', 'SC0C_Playful', 'SC0A_Pat']);
});

test('놀이 중 mid: 예약 시간 안에 클립이 끝나면 자연 전환으로 눈치챔, 같은 mid에서는 반복하지 않는다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  assert.deepEqual(director.setDecision('mid', 10000), []); // 바로 끊지 않고 예약
  assert.equal(director.snapshot().switchAtMs, 10800);
  const [notice] = plays(director.playbackFinished(play.playId, 10500)); // 예약 전에 끝남
  assert.deepEqual([notice.clip, notice.forced, notice.blendMs], ['SC1_Notice', false, 150]);
  assert.deepEqual([director.snapshot().switchAtMs, director.snapshot().lastSwitch.outcome], [null, 'natural']);
  const [wait] = plays(director.playbackFinished(notice.playId, 15000));
  assert.equal(wait.clip, CFG.midIdleCycle[0]);
  assert.deepEqual(director.setDecision('mid', 15100), []);
  assert.equal(director.snapshot().switchAtMs, null); // 이미 눈치챘으면 바꿀 필요 없음
});

test('놀이 중 near: 0.8초 안에 끝나지 않으면 강제로 숨기(섞기 200 ms), 그 전 tick은 기다린다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  assert.deepEqual(director.setDecision('near', 6000), []);
  assert.deepEqual(director.tick(6799), []);
  const forced = director.tick(6800);
  assert.deepEqual(types(forced), ['cancel', 'play']);
  assert.equal(forced[0].playId, play.playId);
  assert.deepEqual([forced[1].clip, forced[1].forced, forced[1].blendMs], ['SC2_Duck', true, 200]);
  assert.equal(director.snapshot().lastSwitch.outcome, 'forced');
  assert.deepEqual(director.playbackFinished(play.playId, 6900), []); // 강제로 바뀐 이전 재생의 늦은 완료는 무시
});

test('전환 예약이 지난 뒤 다음 tick 전에 현재 클립 오류가 오면 강제 전환이 아니라 즉시 안전 정지·재시도, 이전 ID 오류는 무시', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  director.setDecision('near', 6000); // 예약 6800
  assert.deepEqual(director.playbackFailed(play.playId - 1, 'old', 6500), []); // 이전 ID: 현재 재생을 실패시키지 않음
  const failed = director.playbackFailed(play.playId, 'media-error-3', 6810);
  assert.deepEqual(failed, [{ type: 'cancel', playId: play.playId }, { type: 'pose', pose: 'hidden' }]);
  const snap = director.snapshot();
  assert.deepEqual([snap.phase, snap.switchAtMs, snap.lastError.reason], ['safe', null, 'media-error-3']);
  assert.notEqual(snap.retryAtMs, null);
  assert.deepEqual(director.tick(6900), []); // 취소된 예약으로 강제 전환하지 않는다
});

test('예약 중 판정이 되돌아오면 취소하고, 바뀐 목표는 하나의 예약으로 최신 판정만 실행한다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  // near → far(빠른 되돌아옴): 예약 취소, 놀이 계속, 지나간 near는 실행하지 않는다
  director.setDecision('near', 6000);
  assert.deepEqual(director.setDecision('far', 6300), []);
  assert.deepEqual([director.snapshot().switchAtMs, director.snapshot().lastSwitch.outcome], [null, 'cancelled']);
  assert.deepEqual(director.tick(7000), []);
  const [next] = plays(director.playbackFinished(play.playId, 12000));
  assert.equal(next.clip, 'SC0B_Roll');

  // near → mid: 예약 시각은 처음 것 그대로, 실행 때 최신 판정 mid로 눈치챔
  director.setDecision('near', 13000);
  assert.deepEqual(director.setDecision('mid', 13500), []);
  assert.equal(director.snapshot().switchAtMs, 13800);
  assert.deepEqual(clipsOf(director.tick(13800)), ['SC1_Notice']);
});

test('눈치챔 중 far, 복귀 중 near는 예약 뒤 강제 전환, 복귀 중 mid·far는 예약하지 않는다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  director.setDecision('mid', 6000);
  const [notice] = plays(director.playbackFinished(play.playId, 6500));
  // 눈치챔 중 far → 0.8초 뒤 놀이로
  director.setDecision('far', 7000);
  const toPlay = director.tick(7800);
  assert.deepEqual(types(toPlay), ['cancel', 'play']);
  assert.equal(toPlay[0].playId, notice.playId);
  assert.deepEqual([toPlay[1].phase, toPlay[1].forced], ['play', true]);

  // 복귀 중 near → 0.8초 뒤 숨기, 복귀 중 mid는 예약 없음
  const r = createSequenceDirector(CFG);
  const [ret] = plays(r.setDecision('mid', 0));
  assert.deepEqual(r.setDecision('far', 1000), []);
  assert.equal(r.snapshot().switchAtMs, null);
  r.setDecision('near', 2000);
  const toDuck = r.tick(2800);
  assert.deepEqual(types(toDuck), ['cancel', 'play']);
  assert.equal(toDuck[0].playId, ret.playId);
  assert.deepEqual([toDuck[1].clip, toDuck[1].forced], ['SC2_Duck', true]);
});

test('숨기(SC2) 중 멀어져도 예약하지 않고 숨는 동작을 마친 뒤 복귀한다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  director.setDecision('near', 6000);
  const [duck] = plays(director.playbackFinished(play.playId, 6500));
  assert.equal(duck.clip, 'SC2_Duck');
  assert.deepEqual(director.setDecision('far', 7000), []);
  assert.equal(director.snapshot().switchAtMs, null);
  assert.deepEqual(director.tick(8000), []); // 0.8초가 지나도 끊지 않음
  const [ret] = plays(director.playbackFinished(duck.playId, 8400));
  assert.deepEqual([ret.clip, ret.forced], ['SC4_Return_To_Play', false]);
});

test('숨은 대기 → 랜덤 대기 뒤 SC3 1회(섞지 않음) → 새 랜덤 대기, 대기 중 mid는 바로 복귀', () => {
  const draws = [0, 0.5];
  let calls = 0;
  const director = createSequenceDirector(CFG, { random: () => draws[calls++] });
  const { minMs, maxMs } = CFG.hiddenClueDelayMs;
  director.setDecision('near', 0); // 시작 near → 숨은 대기부터
  let snap = director.snapshot();
  assert.deepEqual([snap.phase, snap.playId, snap.clueAtMs, snap.noticed], ['hidden', null, minMs, true]);
  assert.deepEqual(director.tick(minMs - 1), []); // 대기 중 tick은 다시 추첨하지 않는다
  assert.equal(calls, 1);

  const [clue] = plays(director.tick(minMs));
  assert.deepEqual([clue.clip, clue.blendMs], ['SC3_Hidden_Clue', 0]);
  const t1 = minMs + 4100;
  assert.deepEqual(director.playbackFinished(clue.playId, t1), []);
  assert.equal(director.snapshot().clueAtMs, t1 + Math.round(minMs + 0.5 * (maxMs - minMs)));
  assert.equal(calls, 2);

  const back = director.setDecision('mid', t1 + 1000);
  assert.deepEqual(types(back), ['play']); // 끊을 클립이 없으니 바로
  assert.equal(back[0].clip, 'SC4_Return_To_Play');
  assert.equal(director.snapshot().clueAtMs, null);
  assert.deepEqual(clipsOf(director.playbackFinished(back[0].playId, t1 + 6000)), [CFG.midIdleCycle[0]]); // 눈치챔 없이 중간 대기
});

test('단서(SC3) 중 멀어지면 0.8초 뒤 강제로 복귀하고, 그 전에 끝나면 자연스럽게 복귀한다', () => {
  const director = createSequenceDirector(CFG, { random: () => 0 });
  const { minMs } = CFG.hiddenClueDelayMs;
  director.setDecision('near', 0);
  const [clue] = plays(director.tick(minMs));
  director.setDecision('far', minMs + 1000);
  const forced = director.tick(minMs + 1800);
  assert.deepEqual(types(forced), ['cancel', 'play']);
  assert.equal(forced[0].playId, clue.playId);
  assert.deepEqual([forced[1].clip, forced[1].forced, forced[1].blendMs], ['SC4_Return_To_Play', true, 200]);

  const d2 = createSequenceDirector(CFG, { random: () => 0 });
  d2.setDecision('near', 0);
  const [clue2] = plays(d2.tick(minMs));
  d2.setDecision('mid', minMs + 3600);
  assert.deepEqual(clipsOf(d2.playbackFinished(clue2.playId, minMs + 4042)), ['SC4_Return_To_Play']);
});

test('unknown은 즉시 취소·H 안전 정지·예약 취소, 늦은 완료는 무시, 회복 near는 숨은 대기, 대기 중 unknown은 단서 예약 취소', () => {
  const director = createSequenceDirector(CFG, { random: () => 0 });
  const play = startPlaying(director, 0);
  director.setDecision('near', 6000); // 전환 예약 중
  const stop = director.setDecision('unknown', 6300);
  assert.deepEqual(stop, [{ type: 'cancel', playId: play.playId }, { type: 'pose', pose: 'hidden' }]);
  assert.deepEqual([director.snapshot().phase, director.snapshot().switchAtMs, director.snapshot().lastSwitch.outcome], ['safe', null, 'safe']);
  assert.deepEqual(director.tick(7000), []); // 취소된 예약은 실행하지 않는다
  assert.deepEqual(director.playbackFinished(play.playId, 7100), []);
  assert.equal(director.snapshot().ignoredCompletions, 1);

  assert.deepEqual(director.setDecision('near', 8000), []); // 숨은 대기부터
  assert.deepEqual([director.snapshot().phase, director.snapshot().clueAtMs], ['hidden', 8000 + CFG.hiddenClueDelayMs.minMs]);
  assert.deepEqual(director.setDecision('unknown', 9000), [{ type: 'pose', pose: 'hidden' }]);
  assert.deepEqual([director.snapshot().phase, director.snapshot().clueAtMs], ['safe', null]);
  assert.deepEqual(director.tick(8000 + CFG.hiddenClueDelayMs.minMs + 1), []);
});

test('재생 timeout·재생기 오류는 안전 정지 후 재시도, retryNow, 일시 중지는 예약을 취소하고 재생하지 않는다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  assert.deepEqual(director.playbackFailed(play.playId - 1, 'old', 5100), []); // 이전 ID
  const failed = director.playbackFailed(play.playId, 'autoplay-blocked', 5200);
  assert.deepEqual(failed, [{ type: 'cancel', playId: play.playId }, { type: 'pose', pose: 'hidden' }]);
  assert.notEqual(director.snapshot().retryAtMs, null);
  const [retry] = plays(director.retryNow(5300)); // H에서 다시 시작하므로 복귀부터
  assert.equal(retry.clip, 'SC4_Return_To_Play');

  director.setDecision('near', 5400); // 복귀 중 near → 예약
  assert.notEqual(director.snapshot().switchAtMs, null);
  assert.deepEqual(types(director.setSuspended(true, 5500)), ['cancel', 'pose']);
  assert.equal(director.snapshot().switchAtMs, null);
  assert.deepEqual(director.tick(6500), []);
  assert.deepEqual(director.setSuspended(false, 6600), []); // 풀리면 near → 숨은 대기(단서 예약)
  assert.equal(director.snapshot().phase, 'hidden');
  assert.notEqual(director.snapshot().clueAtMs, null);
  assert.deepEqual(types(director.setSuspended(true, 6700)), ['pose']); // 다시 멈추면 단서 예약 취소
  assert.equal(director.snapshot().clueAtMs, null);
});
