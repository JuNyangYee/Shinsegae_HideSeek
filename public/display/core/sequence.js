// 시퀀스 상태(연출 코어): 근접 판정 + 재생 완료/오류/연결 구간 도달 → 단계 전환과 재생 지시.
// DOM·타이머 없는 순수 모듈이다. 현재 시각(nowMs)은 호출하는 쪽이 넣는다. 영상 위치는 모른다 — 재생기가 실제 위치로 알린다.
//
// 단계(phase):
//   safe    — 안전 정지(H 정지 이미지). 시작·unknown·재생 오류 대기·일시 중지(탭 숨김·렌더러 실패).
//   play    — 보이는 놀이 루프(far: SC0A → B → C 순환, mid: 눈치챈 뒤 대기 — SC1b가 없어 같은 순환으로 대체).
//   notice  — SC1_Notice 1회(far → mid 진입).
//   duck    — SC2_Duck 1회(P → H).
//   hidden  — 숨은 대기(H, 클립 없음). 자동으로 재생하는 클립 없이 숨은 마지막 프레임을 유지하고, mid·far가 되면 복귀한다.
//             (사용자 요청 2026-10-21로 SC3_Hidden_Clue(너구리 빼꼼) 자동 재생은 폐지 — 원본 파일은 미사용 자료로 보존.)
//   return  — SC4_Return_To_Play 1회(H → P).
//   rehide  — SC4 역방향 파생 영상(SC4R) 1회(지금 자세 → H). 복귀 도중 near가 되면 지금 보이는 자세에서 거꾸로 숨는다.
//
// 복귀 정/역 반전(사용자 요청 2026-10-21): return 중 near → 바로 rehide, rehide 중 mid·far → 바로 return. 연결 대기 없이
// 안정된 판정이 오는 즉시 바꾸고, 섞지 않으며(blendMs 0), 재생기가 지금 보이는 프레임의 대응 지점부터 시작한다(지시의 mirror).
// 서 있는 SC2로 건너뛰지 않는다. 다 나와 놀이(play)가 된 뒤의 near는 아래 연결 대기 → SC2 숨기.
//
// 판정 변화와 진행 중 클립 — 자세 연결 구간(사용자 요청 2026-10-21: "고정시간으로 끊지 말고 적정 시간에 교체"):
//   - 놀이·눈치챔(P→P) 중에 다른 클립이 필요한 판정이 오면 **연결 대기**(목적 하나: duck·notice·play)를 두고 재생기에 지켜볼 목적을
//     알린다(cueWatch). 재생기가 실제 영상 위치가 그 클립의 연결 가능 자세 구간(settings clips[].cues, 원본 프레임을 보고 정한 임시값)
//     안에 들어온 것을 알리면(cueReached) 현재 재생 ID·대기·목적이 아직 맞을 때만 그 자리에서 최신 판정의 다음 클립으로 바꾼다.
//     벽시계 시간만으로 끊지 않는다(앞선 "판정 + 0.8초 강제 전환" 폐지). 구간이 없거나 다 지나면 정상 완료(out) 때 최신 판정으로 잇는다.
//   - 판정이 되돌아오면 대기를 취소하고(cueWatch target null), 목적이 바뀌면 새 목적을 알린다(대기는 하나뿐).
//   - 클립이 끝나거나 연결 구간에서 이어질 때 다른 영상이면 naturalBlendMs로 짧게 섞는다(재생기가 판단).
//   - 숨기(SC2 P→H)는 끊지 않는다 — 몸이 숨는 동작을 마친 뒤 최신 판정으로 고른다.
//   - unknown·재생 오류·timeout·일시 중지는 즉시 안전 정지(대기 취소). 현재 재생의 오류는 다른 처리보다 먼저 받는다.
//   - 클립이 없는 숨은 대기 중에는 mid·far가 되면 바로 복귀한다.
//
// 모든 입력 함수는 재생 계층에 줄 지시 목록을 돌려준다.
//   { type: 'play', playId, clip, phase, durationMs, blendMs, mirror, via }
//     durationMs = 편집 구간 길이(mirror면 남은 구간의 상한), mirror = 정/역 짝의 대응 지점부터 시작,
//     via = 연결 구간에서 이어졌으면 { clip, atSec, fromSec, toSec }(진단용), 아니면 null
//   { type: 'cueWatch', playId, target }   // 그 재생에서 target(다음 단계) 연결 구간을 지켜보라. target null = 그만
//   { type: 'cancel', playId }
//   { type: 'pose', pose: 'hidden' }   // 연출 없이 H 정지 이미지로 바로 둔다(안전 정지)

export const PHASES = Object.freeze(['safe', 'play', 'notice', 'duck', 'hidden', 'return', 'rehide']);
// 캐릭터가 숨은 자세(H)로 끝나는 단계. 여기서 끝나면 다음은 숨은 대기나 복귀다.
const HIDDEN_END = new Set(['safe', 'duck', 'hidden', 'rehide']);

// 클립의 실제 재생 길이(ms) = 편집 구간(inSec ~ outSec). outSec이 없으면 원본 끝(durationMs)까지.
export function clipPlayMs(def) {
  const endSec = def.outSec ?? def.durationMs / 1000;
  return Math.round((endSec - (def.inSec ?? 0)) * 1000);
}

export function createSequenceDirector(cfg) {
  let phase = 'safe'; // unknown을 멀어짐으로 오인해 저절로 나오지 않게 안전 정지로 시작
  let decision = 'unknown'; // 가장 최근 판정 하나만 보관한다(큐 없음)
  let current = null; // 진행 중 재생 { playId, clip, deadlineMs }
  let lastPlayId = 0;
  let noticed = false; // 이번 근접 방문(far가 아닌 동안)에 이미 관객을 알아챘는가 — 같은 mid에서 눈치챔 반복 금지
  const cycleIndex = { play: 0, mid: 0 };
  let retryAtMs = null; // 재생 오류 후 다시 판단할 시각. null이면 오류 대기 아님
  let pending = null; // 연결 대기 { playId, target, sinceMs }. null이면 대기 없음
  let lastSwitch = null; // 진단: 마지막 대기의 결과 { outcome: 'cue'|'natural'|'cancelled'|'safe', target, atMs, via }
  let suspended = false; // 탭 숨김·렌더러 실패 등 바깥 사정으로 멈춤
  let lastError = null; // { playId, clip, reason, atMs }
  let ignoredCompletions = 0;
  let ignoredCues = 0; // 받지 않은 연결 구간 알림(이전 재생·대기 없음·목적이 바뀜)

  function endPending(outcome, nowMs, via = null) {
    if (pending === null) return;
    lastSwitch = { outcome, target: pending.target, atMs: nowMs, via };
    pending = null;
  }

  // mirror: 복귀 정/역 반전 — 지금 보이는 프레임의 대응 지점부터 시작하므로 남은 길이를 모른다. timeout은 편집 구간 전체(상한)로 잡는다.
  function startClip(nextPhase, clip, nowMs, { mirror = false, via = null } = {}) {
    const durationMs = clipPlayMs(cfg.clips[clip]);
    // 정/역 반전은 같은 자세에서 이어지므로 섞지 않는다.
    const blendMs = mirror ? 0 : cfg.naturalBlendMs;
    const playId = ++lastPlayId;
    current = { playId, clip, deadlineMs: nowMs + durationMs + cfg.playTimeoutMarginMs };
    phase = nextPhase;
    if (nextPhase !== 'play' && decision !== 'far') noticed = true; // 눈치챔·숨기·숨음·복귀는 관객을 이미 안 상태
    return [{ type: 'play', playId, clip, phase: nextPhase, durationMs, blendMs, mirror, via }];
  }

  // 진행 중 클립을 지금 판정으로 바꿔야 한다면 그 목적(다음 단계), 아니면 null. 연결 대기는 놀이·눈치챔(P→P)에서만:
  //   play → near면 duck, mid(눈치챔 전)면 notice / notice → near면 duck, far면 play.
  //   duck은 숨는 동작을 끝까지, return·rehide는 정/역 반전(shouldFlip), hidden은 클립 없음(판정 변화 때 advance가 바로 복귀).
  function switchTarget() {
    if (!current) return null;
    if (phase === 'play') {
      if (decision === 'near') return 'duck';
      if (decision === 'mid' && !noticed) return 'notice';
      return null;
    }
    if (phase === 'notice') {
      if (decision === 'near') return 'duck';
      if (decision === 'far') return 'play';
      return null;
    }
    return null;
  }

  // 복귀 정/역 반전이 필요한가: 나오는 중(return)에 near, 다시 숨는 중(rehide)에 mid·far.
  function shouldFlip() {
    if (!current) return false;
    if (phase === 'return') return decision === 'near';
    if (phase === 'rehide') return decision === 'mid' || decision === 'far';
    return false;
  }
  function flip(nowMs) {
    const actions = interrupt();
    return phase === 'return'
      ? actions.concat(startClip('rehide', cfg.rehideClip, nowMs, { mirror: true }))
      : actions.concat(startClip('return', cfg.returnClip, nowMs, { mirror: true }));
  }

  function nextLoopClip() {
    const key = decision === 'mid' ? 'mid' : 'play';
    const cycle = key === 'mid' ? cfg.midIdleCycle : cfg.playCycle;
    const clip = cycle[cycleIndex[key] % cycle.length];
    cycleIndex[key] = (cycleIndex[key] + 1) % cycle.length;
    return clip;
  }

  // 진행 중 클립을 끊는다(재생 ID 무효화).
  function interrupt() {
    if (!current) return [];
    const actions = [{ type: 'cancel', playId: current.playId }];
    current = null;
    return actions;
  }

  // 숨은 대기: 화면은 그대로(숨기·다시 숨기 클립의 마지막 프레임 또는 H 정지 이미지) 둔다. 자동 재생 클립·타이머 없음.
  function enterHiddenWait() {
    phase = 'hidden';
    noticed = true; // near에서만 들어온다 — 숨은 상태는 관객을 이미 안 상태(클립을 시작하는 단계와 같게)
    return [];
  }

  // 진행 중 클립을 취소하고 H 정지 이미지로 안전 정지한다(연결 대기도 취소).
  function safeStop(nowMs) {
    const actions = interrupt();
    phase = 'safe';
    endPending('safe', nowMs);
    actions.push({ type: 'pose', pose: 'hidden' });
    return actions;
  }

  // 진행 중 클립이 없을 때 지금 단계(방금 끝난·끊긴 단계 또는 safe)와 최신 판정으로 다음 클립을 고른다.
  function advance(nowMs, via = null) {
    if (current || suspended || retryAtMs !== null || decision === 'unknown') return [];
    if (HIDDEN_END.has(phase)) {
      if (decision !== 'near') return startClip('return', cfg.returnClip, nowMs); // 숨은 대기 중이면 바로 복귀
      return phase === 'hidden' ? [] : enterHiddenWait(); // 숨기·다시 숨기가 끝났거나 안전 정지에서 시작 → 숨은 대기(이미 대기 중이면 그대로)
    }
    // 보이는 자세(P)로 끝남: play · notice · return
    if (decision === 'near') return startClip('duck', cfg.duckClip, nowMs, { via });
    if (decision === 'mid' && !noticed) return startClip('notice', cfg.noticeClip, nowMs, { via });
    return startClip('play', nextLoopClip(), nowMs, { via });
  }

  // 판정이 바뀐 뒤 연결 대기를 맞춘다: 목적이 생기거나 바뀌면 알리고, 없어지면 취소한다.
  function reviewPending(nowMs) {
    const target = switchTarget();
    if (target === (pending?.target ?? null)) return [];
    if (target === null) {
      const { playId } = pending;
      endPending('cancelled', nowMs);
      return [{ type: 'cueWatch', playId, target: null }];
    }
    pending = { playId: current.playId, target, sinceMs: pending?.sinceMs ?? nowMs };
    return [{ type: 'cueWatch', playId: current.playId, target }];
  }

  function fail(reason, nowMs) {
    lastError = { playId: current.playId, clip: current.clip, reason, atMs: nowMs };
    retryAtMs = nowMs + cfg.playbackRetryDelayMs;
    return safeStop(nowMs);
  }

  // 시간에 따른 처리: 재생 timeout은 오류, 오류 대기가 끝나면 다시 판단. (연결 대기는 시간으로 실행하지 않는다.)
  function expire(nowMs) {
    if (current && nowMs > current.deadlineMs) return fail('timeout', nowMs);
    if (retryAtMs !== null && nowMs >= retryAtMs) {
      retryAtMs = null;
      return advance(nowMs);
    }
    return [];
  }

  function setDecision(next, nowMs) {
    // 판정을 먼저 저장해야 이 호출에서 끝나는 재시도 대기가 최신 판정으로 재평가된다.
    const changed = next !== decision;
    decision = next;
    if (changed && next === 'far') noticed = false; // 멀어졌다가 다시 오면 다시 눈치챈다
    const actions = expire(nowMs);
    if (!changed) return actions;
    // unknown(센서 오류·stale): 진행 중이든 아니든 바로 안전 정지
    if (decision === 'unknown') {
      if (current || phase !== 'safe') actions.push(...safeStop(nowMs));
      return actions;
    }
    // 진행 중이면: 복귀 정/역 반전은 바로, 그 밖에는 끊지 않고 연결 대기를 맞춘다. 클립이 없으면 바로 고른다.
    if (current) {
      if (shouldFlip()) {
        endPending('cancelled', nowMs);
        return actions.concat(flip(nowMs));
      }
      return actions.concat(reviewPending(nowMs));
    }
    return actions.concat(advance(nowMs));
  }

  function isCurrent(playId) {
    if (current && current.playId === playId) return true;
    ignoredCompletions += 1; // 이전 재생의 늦은 알림, 중복 알림, 취소된 재생의 알림
    return false;
  }

  function playbackFinished(playId, nowMs) {
    const actions = expire(nowMs); // 기한을 넘긴 완료는 성공으로 받지 않는다
    if (!isCurrent(playId)) return actions;
    current = null;
    endPending('natural', nowMs); // 연결 구간에서 잇지 못하고 끝남 — 최신 판정으로 정상 완료에서 잇는다
    return actions.concat(advance(nowMs));
  }

  function playbackFailed(playId, reason, nowMs) {
    // 현재 재생의 오류는 timeout·연결 처리보다 먼저 받는다 — 즉시 안전 정지·재시도.
    if (current && current.playId === playId) return fail(reason || 'playback-error', nowMs);
    // 이전·취소된 재생의 늦은 오류는 현재 재생을 실패시키지 않는다(시간 처리만 하고 무시한 알림으로 센다).
    const actions = expire(nowMs);
    ignoredCompletions += 1;
    return actions;
  }

  // 재생기 알림: 재생 playId의 실제 영상 위치가 target 연결 구간 안이다. via = { clip, atSec, fromSec, toSec }.
  // 지금 재생·대기·목적이 모두 맞을 때만 그 자리에서 잇는다(늦은·이전 재생·목적이 바뀐 알림은 무시하고 센다).
  function cueReached(playId, target, via, nowMs) {
    const actions = expire(nowMs);
    const valid = current !== null && current.playId === playId && pending !== null && pending.playId === playId
      && pending.target === target && switchTarget() === target;
    if (!valid) {
      ignoredCues += 1;
      return actions;
    }
    endPending('cue', nowMs, via);
    return actions.concat(interrupt(), advance(nowMs, via));
  }

  function tick(nowMs) {
    return expire(nowMs);
  }

  // 바깥 사정(탭 숨김·렌더러 실패)으로 멈추거나 다시 시작한다. 멈추면 안전 정지, 풀리면 최신 판정으로 다시 시작.
  function setSuspended(on, nowMs) {
    if (on === suspended) return [];
    suspended = on;
    if (on) return phase === 'safe' && !current ? [] : safeStop(nowMs);
    return advance(nowMs);
  }

  // 재생 오류 대기를 건너뛰고 바로 다시 판단한다(사용자 조작 — 자동 재생 막힘 해제 등).
  function retryNow(nowMs) {
    if (retryAtMs === null) return [];
    retryAtMs = null;
    return advance(nowMs);
  }

  function snapshot() {
    return {
      phase,
      decision,
      playId: current ? current.playId : null,
      clip: current ? current.clip : null,
      lastPlayId,
      noticed,
      suspended,
      retryAtMs,
      pending: pending && { ...pending },
      lastSwitch,
      lastError,
      ignoredCompletions,
      ignoredCues,
    };
  }

  return { setDecision, playbackFinished, playbackFailed, cueReached, tick, setSuspended, retryNow, snapshot };
}
