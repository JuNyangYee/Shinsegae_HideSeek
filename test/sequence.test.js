import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTINGS } from '../public/display/config/settings.js';
import { clipPlayMs, createSequenceDirector } from '../public/display/core/sequence.js';

// 실제 설정(클립 표·편집 구간·연결 구간·순환)을 쓴다. 재시도·timeout 여유·섞기 시간만 읽기 쉬운 값으로 고정.
const CFG = {
  ...SETTINGS.sequence,
  playTimeoutMarginMs: 4000,
  playbackRetryDelayMs: 3000,
  naturalBlendMs: 150,
};

const plays = (actions) => actions.filter((a) => a.type === 'play');
const clipsOf = (actions) => plays(actions).map((a) => a.clip);
const types = (actions) => actions.map((a) => a.type);
const via = (clip, atSec, fromSec, toSec) => ({ clip, atSec, fromSec, toSec });

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
  assert.equal(clipPlayMs(CFG.clips.SC0A_Pat), 7000);
  assert.equal(clipPlayMs(CFG.clips.SC0C_Playful), 7750); // 처음(0초)부터
  assert.equal(clipPlayMs(CFG.clips.SC2_Duck), 3500); // 놀라는 예비 동작(0초)부터
  assert.equal(CFG.clips.SC3_Hidden_Clue, undefined); // 너구리 빼꼼(SC3)은 실행 클립이 아님
  assert.equal(CFG.switchWithinMs, undefined); // 고정 0.8초 강제 전환 설정은 폐지
  assert.equal(CFG.forcedBlendMs, undefined);
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
  assert.deepEqual([cur.blendMs, cur.via], [150, null]);
  const seen = [cur.clip];
  for (let i = 0; i < 3; i += 1) {
    [cur] = plays(director.playbackFinished(cur.playId, 5000 + 6000 * (i + 1)));
    seen.push(cur.clip);
  }
  assert.deepEqual(seen, ['SC0A_Pat', 'SC0B_Roll', 'SC0C_Playful', 'SC0A_Pat']);
});

test('놀이 중 near: 벽시계 시간이 아무리 지나도 끊지 않고(연결 대기), 연결 구간 알림이 와야 그 자리에서 숨기', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  const watch = director.setDecision('near', 6000);
  assert.deepEqual(watch, [{ type: 'cueWatch', playId: play.playId, target: 'duck' }]);
  for (const t of [6800, 7000, 9000, 10900]) assert.deepEqual(director.tick(t), []); // 0.8초가 지나도 강제 전환 없음
  assert.deepEqual(director.snapshot().pending, { playId: play.playId, target: 'duck', sinceMs: 6000 });

  const cue = via('SC0A_Pat', 2.41, 2.375, 2.625);
  const actions = director.cueReached(play.playId, 'duck', cue, 11000);
  assert.deepEqual(types(actions), ['cancel', 'play']);
  assert.equal(actions[0].playId, play.playId);
  assert.deepEqual([actions[1].clip, actions[1].blendMs, actions[1].via], ['SC2_Duck', 150, cue]);
  assert.deepEqual([director.snapshot().pending, director.snapshot().lastSwitch.outcome, director.snapshot().lastSwitch.via], [null, 'cue', cue]);
  assert.deepEqual(director.playbackFinished(play.playId, 11100), []); // 바뀐 이전 재생의 늦은 완료는 무시
});

test('연결 구간 알림은 현재 재생·대기·목적이 맞을 때만 받는다(이전 playId·대기 없음·목적 불일치는 무시)', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  const cue = via('SC0A_Pat', 0.3, 0.25, 0.375);
  assert.deepEqual(director.cueReached(play.playId, 'duck', cue, 5100), []); // 대기 없음(far)
  director.setDecision('near', 5200);
  assert.deepEqual(director.cueReached(play.playId - 1, 'duck', cue, 5300), []); // 이전 재생
  assert.deepEqual(director.cueReached(play.playId, 'notice', cue, 5300), []); // 목적 불일치
  assert.equal(director.snapshot().ignoredCues, 3);
  assert.equal(director.snapshot().phase, 'play');
});

test('되돌아오면 대기 취소(cueWatch null), 목적이 바뀌면 최신 목적 하나만 — 지나간 near로 숨지 않는다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  director.setDecision('near', 6000);
  assert.deepEqual(director.setDecision('far', 6300), [{ type: 'cueWatch', playId: play.playId, target: null }]);
  assert.deepEqual([director.snapshot().pending, director.snapshot().lastSwitch.outcome], [null, 'cancelled']);
  assert.deepEqual(director.cueReached(play.playId, 'duck', via('SC0A_Pat', 2.4, 2.375, 2.625), 7000), []); // 늦은 알림 무시
  const [next] = plays(director.playbackFinished(play.playId, 12000));
  assert.equal(next.clip, 'SC0B_Roll'); // 놀이 계속

  // near → mid(눈치챔 전): 목적이 notice로 바뀌고, 예전 목적(duck) 알림은 무시, notice 알림에 눈치챔
  director.setDecision('near', 13000);
  assert.deepEqual(director.setDecision('mid', 13500), [{ type: 'cueWatch', playId: next.playId, target: 'notice' }]);
  assert.deepEqual(director.snapshot().pending, { playId: next.playId, target: 'notice', sinceMs: 13000 });
  assert.deepEqual(director.cueReached(next.playId, 'duck', via('SC0B_Roll', 6.8, 6.75, 8.0), 14000), []);
  assert.deepEqual(clipsOf(director.cueReached(next.playId, 'notice', via('SC0B_Roll', 6.8, 6.75, 8.0), 14100)), ['SC1_Notice']);
});

test('연결 구간 없이 끝나면(구간을 놓쳤거나 없음) 정상 완료 때 최신 판정으로 잇는다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  director.setDecision('mid', 6000);
  const [notice] = plays(director.playbackFinished(play.playId, 12000));
  assert.deepEqual([notice.clip, notice.via], ['SC1_Notice', null]);
  assert.equal(director.snapshot().lastSwitch.outcome, 'natural');
  const [wait] = plays(director.playbackFinished(notice.playId, 17000));
  assert.equal(wait.clip, CFG.midIdleCycle[0]);
  assert.deepEqual(director.setDecision('mid', 17100), []); // 이미 눈치챔 — 대기 없음
  assert.equal(director.snapshot().pending, null);
});

test('눈치챔 중 near·far는 연결 대기(duck·play), 복귀 중 mid·far와 숨기 중 판정 변화는 대기하지 않는다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  director.setDecision('mid', 6000);
  const [notice] = plays(director.playbackFinished(play.playId, 6500));
  assert.deepEqual(director.setDecision('far', 7000), [{ type: 'cueWatch', playId: notice.playId, target: 'play' }]);
  const toPlay = director.cueReached(notice.playId, 'play', via('SC1_Notice', 6.3, 6.25, 6.75), 7500);
  assert.deepEqual([types(toPlay), toPlay[1].phase], [['cancel', 'play'], 'play']);

  const r = createSequenceDirector(CFG);
  plays(r.setDecision('mid', 0));
  assert.deepEqual(r.setDecision('far', 1000), []); // 복귀 중 같은 나오는 방향
  assert.equal(r.snapshot().pending, null);

  const d = createSequenceDirector(CFG);
  const p = startPlaying(d, 0);
  d.setDecision('near', 6000);
  const [duck] = plays(d.playbackFinished(p.playId, 6500));
  assert.deepEqual(d.setDecision('far', 7000), []); // 숨는 동작은 끝까지(대기 없음)
  assert.deepEqual([d.snapshot().pending, d.tick(9000)], [null, []]);
  const [ret] = plays(d.playbackFinished(duck.playId, 9900));
  assert.equal(ret.clip, 'SC4_Return_To_Play');
});

test('연결 대기 중 현재 클립 오류는 다른 처리보다 먼저 즉시 안전 정지·재시도, 그 뒤 연결 알림은 무시', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  director.setDecision('near', 6000);
  assert.deepEqual(director.playbackFailed(play.playId - 1, 'old', 6500), []); // 이전 ID: 현재 재생을 실패시키지 않음
  const failed = director.playbackFailed(play.playId, 'media-error-3', 6810);
  assert.deepEqual(failed, [{ type: 'cancel', playId: play.playId }, { type: 'pose', pose: 'hidden' }]);
  const snap = director.snapshot();
  assert.deepEqual([snap.phase, snap.pending, snap.lastSwitch.outcome, snap.lastError.reason], ['safe', null, 'safe', 'media-error-3']);
  assert.notEqual(snap.retryAtMs, null);
  assert.deepEqual(director.cueReached(play.playId, 'duck', via('SC0A_Pat', 2.4, 2.375, 2.625), 6900), []);
});

test('복귀 정/역 반전: 복귀 중 near는 대기 없이 바로 역방향(섞기 0, 대응 지점), 역방향 중 mid·far는 바로 정방향', () => {
  const director = createSequenceDirector(CFG);
  const [ret] = plays(director.setDecision('far', 0));
  const toRehide = director.setDecision('near', 2000);
  assert.deepEqual(types(toRehide), ['cancel', 'play']);
  assert.equal(toRehide[0].playId, ret.playId);
  const rehide = toRehide[1];
  assert.deepEqual([rehide.clip, rehide.phase, rehide.mirror, rehide.blendMs], ['SC4R_Rehide', 'rehide', true, 0]);
  assert.equal(rehide.durationMs, 5500); // 역방향 구간 1.0~6.5초 전체(남은 구간의 상한)
  assert.deepEqual([director.snapshot().pending, director.snapshot().noticed], [null, true]);
  assert.deepEqual(director.tick(3000), []); // 같은 방향 near 유지 중에는 그대로

  const toReturn = director.setDecision('far', 3500);
  assert.deepEqual(types(toReturn), ['cancel', 'play']);
  assert.equal(toReturn[0].playId, rehide.playId);
  assert.deepEqual([toReturn[1].clip, toReturn[1].phase, toReturn[1].mirror, toReturn[1].blendMs], ['SC4_Return_To_Play', 'return', true, 0]);
  assert.deepEqual(director.playbackFinished(rehide.playId, 3600), []); // 반전으로 취소된 재생의 늦은 완료는 무시

  // 다시 near → 역방향, 끝까지 가면 클립 없는 숨은 대기
  const [rehide2] = plays(director.setDecision('near', 4000));
  assert.equal(rehide2.clip, 'SC4R_Rehide');
  assert.deepEqual(director.playbackFinished(rehide2.playId, 6000), []);
  const snap = director.snapshot();
  assert.deepEqual([snap.phase, snap.playId], ['hidden', null]);

  // 숨은 끝에서 mid → 일반 복귀(편집 시작점, 대응 지점 아님)
  const [again] = plays(director.setDecision('mid', 7000));
  assert.deepEqual([again.clip, again.mirror], ['SC4_Return_To_Play', false]);
  // 다 나와 놀이가 된 뒤의 near는 연결 대기 → SC2 숨기
  const [play] = plays(director.playbackFinished(again.playId, 12000));
  assert.equal(play.phase, 'play');
  assert.deepEqual(director.setDecision('near', 12500), [{ type: 'cueWatch', playId: play.playId, target: 'duck' }]);
  assert.deepEqual(clipsOf(director.cueReached(play.playId, 'duck', via(play.clip, 0.3, 0.25, 0.375), 12600)), ['SC2_Duck']);
});

test('역방향 중 unknown·오류는 즉시 H 안전 정지, 역방향 중 mid는 바로 정방향', () => {
  const director = createSequenceDirector(CFG);
  plays(director.setDecision('far', 0));
  const [rehide] = plays(director.setDecision('near', 1000));
  assert.deepEqual(director.setDecision('unknown', 1500), [{ type: 'cancel', playId: rehide.playId }, { type: 'pose', pose: 'hidden' }]);

  const d2 = createSequenceDirector(CFG);
  plays(d2.setDecision('far', 0));
  const [r2] = plays(d2.setDecision('near', 1000));
  const failed = d2.playbackFailed(r2.playId, 'media-error-4', 1200); // 역방향 파일 누락·손상: SC2로 대신하지 않음
  assert.deepEqual(failed, [{ type: 'cancel', playId: r2.playId }, { type: 'pose', pose: 'hidden' }]);
  assert.equal(d2.snapshot().phase, 'safe');

  const d3 = createSequenceDirector(CFG);
  plays(d3.setDecision('far', 0));
  const [r3] = plays(d3.setDecision('near', 1000));
  d3.setDecision('mid', 1400); // 바로 정방향으로 반전
  assert.equal(d3.snapshot().phase, 'return');
  assert.notEqual(d3.snapshot().playId, r3.playId);
});

test('숨은 대기는 자동 재생 없이 오래 지나도 그대로이고(너구리 빼꼼 없음), mid·far가 되면 바로 복귀한다', () => {
  const director = createSequenceDirector(CFG);
  director.setDecision('near', 0); // 시작 near → 숨은 대기부터
  const snap = director.snapshot();
  assert.deepEqual([snap.phase, snap.playId, snap.noticed], ['hidden', null, true]);
  for (const t of [8000, 16000, 60000, 600000]) assert.deepEqual(director.tick(t), []); // 시간이 많이 지나도 클립 없음
  assert.deepEqual(director.setDecision('near', 600100), []);
  assert.deepEqual([director.snapshot().phase, director.snapshot().playId], ['hidden', null]);

  const back = director.setDecision('mid', 601000);
  assert.deepEqual(types(back), ['play']); // 끊을 클립이 없으니 바로
  assert.deepEqual([back[0].clip, back[0].mirror], ['SC4_Return_To_Play', false]);
  assert.deepEqual(clipsOf(director.playbackFinished(back[0].playId, 606000)), [CFG.midIdleCycle[0]]); // 눈치챔 없이 중간 대기
});

test('unknown은 즉시 취소·H 안전 정지·대기 취소, 늦은 완료는 무시, 회복 near는 숨은 대기, 대기 중 unknown은 안전 정지', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  director.setDecision('near', 6000); // 연결 대기 중
  const stop = director.setDecision('unknown', 6300);
  assert.deepEqual(stop, [{ type: 'cancel', playId: play.playId }, { type: 'pose', pose: 'hidden' }]);
  assert.deepEqual([director.snapshot().phase, director.snapshot().pending, director.snapshot().lastSwitch.outcome], ['safe', null, 'safe']);
  assert.deepEqual(director.tick(7000), []);
  assert.deepEqual(director.playbackFinished(play.playId, 7100), []);
  assert.equal(director.snapshot().ignoredCompletions, 1);

  assert.deepEqual(director.setDecision('near', 8000), []); // 숨은 대기부터
  assert.deepEqual([director.snapshot().phase, director.snapshot().playId], ['hidden', null]);
  assert.deepEqual(director.setDecision('unknown', 9000), [{ type: 'pose', pose: 'hidden' }]);
  assert.equal(director.snapshot().phase, 'safe');
  assert.deepEqual(director.tick(30000), []);
});

test('재생 timeout·재생기 오류는 안전 정지 후 재시도, retryNow, 일시 중지는 대기를 취소하고 재생하지 않는다', () => {
  const director = createSequenceDirector(CFG);
  const play = startPlaying(director, 0);
  assert.deepEqual(director.playbackFailed(play.playId - 1, 'old', 5100), []); // 이전 ID
  const failed = director.playbackFailed(play.playId, 'autoplay-blocked', 5200);
  assert.deepEqual(failed, [{ type: 'cancel', playId: play.playId }, { type: 'pose', pose: 'hidden' }]);
  assert.notEqual(director.snapshot().retryAtMs, null);
  const [retry] = plays(director.retryNow(5300)); // H에서 다시 시작하므로 복귀부터
  assert.equal(retry.clip, 'SC4_Return_To_Play');

  const [play2] = plays(director.playbackFinished(retry.playId, 5350)); // 복귀 완료 → 놀이
  assert.equal(play2.phase, 'play');
  director.setDecision('near', 5400); // 놀이 중 near → 연결 대기
  assert.notEqual(director.snapshot().pending, null);
  assert.deepEqual(types(director.setSuspended(true, 5500)), ['cancel', 'pose']);
  assert.equal(director.snapshot().pending, null);
  assert.deepEqual(director.tick(6500), []);
  assert.deepEqual(director.setSuspended(false, 6600), []); // 풀리면 near → 숨은 대기
  assert.equal(director.snapshot().phase, 'hidden');
  assert.deepEqual(types(director.setSuspended(true, 6700)), ['pose']); // 다시 멈추면 안전 정지
  assert.equal(director.snapshot().phase, 'safe');
});
