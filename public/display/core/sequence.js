// 시퀀스 상태(연출 코어): 근접 판정 + 재생 완료/오류 → 단계 전환과 재생 지시.
// DOM·타이머 없는 순수 모듈이다. 현재 시각(nowMs)은 호출하는 쪽이 넣는다.
//
// 단계(phase):
//   safe    — 안전 정지(H 정지 이미지). 시작·unknown·재생 오류 대기·일시 중지(탭 숨김·렌더러 실패).
//   play    — 보이는 놀이 루프(far: SC0A → B → C 순환, mid: 눈치챈 뒤 대기 — SC1b가 없어 같은 순환으로 대체).
//   notice  — SC1_Notice 1회(far → mid 진입).
//   duck    — SC2_Duck 1회(P → H).
//   hidden  — SC3_Hidden_Clue 반복(H → H).
//   return  — SC4_Return_To_Play 1회(H → P).
//
// 모든 입력 함수는 재생 계층에 줄 지시 목록을 돌려준다.
//   { type: 'play', playId, clip, phase, durationMs }
//   { type: 'cancel', playId }
//   { type: 'pose', pose: 'hidden' }   // 연출 없이 H 정지 이미지로 바로 둔다(안전 정지)

export const PHASES = Object.freeze(['safe', 'play', 'notice', 'duck', 'hidden', 'return']);
// 캐릭터가 숨은 자세(H)로 끝나는 단계. 여기서 끝나면 다음은 숨은 루프나 복귀다.
const HIDDEN_END = new Set(['safe', 'duck', 'hidden']);

export function createSequenceDirector(cfg) {
  let phase = 'safe'; // unknown을 멀어짐으로 오인해 저절로 나오지 않게 안전 정지로 시작
  let decision = 'unknown'; // 가장 최근 판정 하나만 보관한다(큐 없음)
  let current = null; // 진행 중 재생 { playId, clip, deadlineMs }
  let lastPlayId = 0;
  let noticed = false; // 이번 근접 방문(far가 아닌 동안)에 이미 관객을 알아챘는가 — 같은 mid에서 눈치챔 반복 금지
  const cycleIndex = { play: 0, mid: 0 };
  let retryAtMs = null; // 재생 오류 후 다시 판단할 시각. null이면 오류 대기 아님
  let suspended = false; // 탭 숨김·렌더러 실패 등 바깥 사정으로 멈춤
  let lastError = null; // { playId, clip, reason, atMs }
  let ignoredCompletions = 0;

  function startClip(nextPhase, clip, nowMs) {
    const durationMs = cfg.clips[clip].durationMs;
    const playId = ++lastPlayId;
    current = { playId, clip, deadlineMs: nowMs + durationMs + cfg.playTimeoutMarginMs };
    phase = nextPhase;
    if (nextPhase !== 'play' && decision !== 'far') noticed = true; // 눈치챔·숨기·숨음·복귀는 관객을 이미 안 상태
    return [{ type: 'play', playId, clip, phase: nextPhase, durationMs }];
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

  // 진행 중 클립을 취소하고 H 정지 이미지로 안전 정지한다.
  function safeStop() {
    const actions = interrupt();
    phase = 'safe';
    actions.push({ type: 'pose', pose: 'hidden' });
    return actions;
  }

  // 진행 중 클립이 없을 때 지금 단계(방금 끝난 단계 또는 safe)와 최신 판정으로 다음 클립을 고른다.
  function advance(nowMs) {
    if (current || suspended || retryAtMs !== null || decision === 'unknown') return [];
    if (HIDDEN_END.has(phase)) {
      return decision === 'near' ? startClip('hidden', cfg.hiddenClip, nowMs) : startClip('return', cfg.returnClip, nowMs);
    }
    // 보이는 자세(P)로 끝남: play · notice · return
    if (decision === 'near') return startClip('duck', cfg.duckClip, nowMs);
    if (decision === 'mid' && !noticed) return startClip('notice', cfg.noticeClip, nowMs);
    return startClip('play', nextLoopClip(), nowMs);
  }

  // 판정이 바뀌었을 때, 진행 중 클립을 바로 끊어야 하는가.
  function shouldInterrupt() {
    if (phase === 'play') return decision === 'near' || (decision === 'mid' && !noticed && cfg.interruptPlayForNotice);
    if (phase === 'notice') return decision === 'near';
    if (phase === 'hidden') return decision !== 'near';
    return false; // duck·return: 끝난 뒤 최신 판정으로 재평가
  }

  function fail(reason, nowMs) {
    lastError = { playId: current.playId, clip: current.clip, reason, atMs: nowMs };
    retryAtMs = nowMs + cfg.playbackRetryDelayMs;
    return safeStop();
  }

  // 시간에 따른 처리: 재생 timeout은 오류, 오류 대기가 끝나면 다시 판단.
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
      if (current || phase !== 'safe') actions.push(...safeStop());
      return actions;
    }
    if (current && shouldInterrupt()) actions.push(...interrupt());
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
    return actions.concat(advance(nowMs));
  }

  function playbackFailed(playId, reason, nowMs) {
    const actions = expire(nowMs);
    if (!isCurrent(playId)) return actions;
    return actions.concat(fail(reason || 'playback-error', nowMs));
  }

  function tick(nowMs) {
    return expire(nowMs);
  }

  // 바깥 사정(탭 숨김·렌더러 실패)으로 멈추거나 다시 시작한다. 멈추면 안전 정지, 풀리면 최신 판정으로 다시 시작.
  function setSuspended(on, nowMs) {
    if (on === suspended) return [];
    suspended = on;
    if (on) return phase === 'safe' && !current ? [] : safeStop();
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
      lastError,
      ignoredCompletions,
    };
  }

  return { setDecision, playbackFinished, playbackFailed, tick, setSuspended, retryNow, snapshot };
}
