// 시퀀스 상태(연출 코어): 근접 판정 + 재생 완료/오류 → 상태 전환과 재생 지시.
// DOM·타이머 없는 순수 모듈이다. 현재 시각(nowMs)은 호출하는 쪽이 넣는다.
//
// 모든 입력 함수는 재생 계층에 줄 지시 목록을 돌려준다.
//   { type: 'play', playId, clip: 'hide' | 'reveal', durationMs }
//   { type: 'cancel', playId }
//   { type: 'pose', pose: 'hidden' }   // 연출 없이 숨은 자세로 바로 둔다(안전 대기)

export const PHASES = Object.freeze(['visible-idle', 'hiding', 'hidden-idle', 'revealing']);

export function createSequenceDirector(cfg) {
  let phase = 'hidden-idle'; // unknown을 far로 오인해 저절로 등장하지 않게 숨은 상태로 시작
  let decision = 'unknown'; // 가장 최근 판정 하나만 보관한다(큐 없음)
  let current = null; // 진행 중 재생 { playId, clip, deadlineMs }
  let lastPlayId = 0;
  let retryAtMs = null; // 재생 오류 후 다시 판단할 시각. null이면 오류 대기 아님
  let lastError = null; // { playId, reason, atMs }
  let ignoredCompletions = 0;

  function startClip(clip, nowMs) {
    const durationMs = clip === 'hide' ? cfg.hideMs : cfg.revealMs;
    const playId = ++lastPlayId;
    current = { playId, clip, deadlineMs: nowMs + durationMs + cfg.playTimeoutMarginMs };
    phase = clip === 'hide' ? 'hiding' : 'revealing';
    return [{ type: 'play', playId, clip, durationMs }];
  }

  // 진행 중 클립을 취소하고 재생 ID를 무효화한 뒤 숨은 상태로 안전 대기한다.
  function safeHide() {
    const actions = [];
    if (current) actions.push({ type: 'cancel', playId: current.playId });
    current = null;
    phase = 'hidden-idle';
    actions.push({ type: 'pose', pose: 'hidden' });
    return actions;
  }

  // 대기 상태에서 최신 판정과 상태가 어긋날 때만 전환한다.
  function evaluate(nowMs) {
    if (current || retryAtMs !== null) return [];
    if (phase === 'visible-idle' && decision === 'near') return startClip('hide', nowMs);
    if (phase === 'hidden-idle' && decision === 'far') return startClip('reveal', nowMs);
    return [];
  }

  function fail(reason, nowMs) {
    lastError = { playId: current.playId, reason, atMs: nowMs };
    retryAtMs = nowMs + cfg.playbackRetryDelayMs;
    return safeHide();
  }

  // 시간에 따른 처리: 재생 timeout은 오류, 오류 대기가 끝나면 다시 판단.
  function expire(nowMs) {
    if (current && nowMs > current.deadlineMs) return fail('timeout', nowMs);
    if (retryAtMs !== null && nowMs >= retryAtMs) {
      retryAtMs = null;
      return evaluate(nowMs);
    }
    return [];
  }

  function setDecision(next, nowMs) {
    // 판정을 먼저 저장해야 이 호출에서 끝나는 재시도 대기가 최신 판정으로 재평가된다.
    const changed = next !== decision;
    decision = next;
    const actions = expire(nowMs);
    if (!changed) return actions;
    // unknown(센서 오류·stale·근거 부족): 진행 중이든 아니든 바로 숨은 상태로 안전 대기
    if (decision === 'unknown') {
      if (current || phase !== 'hidden-idle') actions.push(...safeHide());
      return actions;
    }
    // 전환 중이면 판정만 덮어쓰고 클립 완료 후 재평가한다.
    return actions.concat(evaluate(nowMs));
  }

  function isCurrent(playId) {
    if (current && current.playId === playId) return true;
    ignoredCompletions += 1; // 이전 재생의 늦은 알림, 중복 알림, 취소된 재생의 알림
    return false;
  }

  function playbackFinished(playId, nowMs) {
    const actions = expire(nowMs); // 기한을 넘긴 완료는 성공으로 받지 않는다
    if (!isCurrent(playId)) return actions;
    phase = current.clip === 'hide' ? 'hidden-idle' : 'visible-idle';
    current = null;
    return actions.concat(evaluate(nowMs));
  }

  function playbackFailed(playId, reason, nowMs) {
    const actions = expire(nowMs);
    if (!isCurrent(playId)) return actions;
    return actions.concat(fail(reason || 'playback-error', nowMs));
  }

  function tick(nowMs) {
    return expire(nowMs);
  }

  function snapshot() {
    return {
      phase,
      decision,
      playId: current ? current.playId : null,
      clip: current ? current.clip : null,
      lastPlayId,
      retryAtMs,
      lastError,
      ignoredCompletions,
    };
  }

  return { setDecision, playbackFinished, playbackFailed, tick, snapshot };
}
