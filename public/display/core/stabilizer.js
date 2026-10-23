// 실센서 입력 안정화: 센서 프레임(감지 거리 / 감지 없음) → 근접 판정에 넘길 샘플. DOM·타이머 없는 순수 모듈.
//
// 하는 일(임시값, 패널에서 조절):
//   - 짧은 중앙값: 최근 감지 거리 medianWindow개의 중앙값. 단발 튐을 줄인다. 창이 다 차기 전에는 샘플을 내지 않는다(null).
//   - 짧은 무감지 유예: 감지 중 n=0이 absentGraceMs 안에 끝나면 직전 안정화 거리를 유지한 샘플을 낸다(held). 넘으면 감지 없음.
// 하지 않는 일:
//   - 프레임이 오지 않을 때 이전 거리를 스스로 다시 내지 않는다(실제 프레임이 올 때만 샘플을 낸다 — 끊김은 판정의 stale이 처리).
//   - 지속적인 잘못된 측정(계속 틀린 거리)은 고치지 못한다.
// 시각(tMs)은 프레임을 받은 페이지 시각(performance.now())이다. 센서·MCU 시각을 넣지 않는다.

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// cfg: { medianWindow, absentGraceMs, maxGapMs } — maxGapMs: 프레임 간격이 이보다 크면 창·유예를 처음부터(공백을 잇지 않음).
export function createStabilizer(cfg) {
  let window = []; // 최근 감지 거리(m)
  let stableM = null; // 마지막으로 낸 안정화 거리(창이 찬 뒤)
  let absentSinceMs = null; // 이번 무감지가 시작된 프레임 시각
  let lastFrameMs = null;
  let rawM = null; // 마지막 원본 감지 거리
  let held = false;
  let resets = 0;
  let lastResetReason = null;

  function clear() {
    window = [];
    stableM = null;
    absentSinceMs = null;
    held = false;
  }

  // 오류·연결 변경·입력 전환·설정 변경 때 부른다. 이전 거리·유예가 새 입력에 섞이지 않게 한다.
  function reset(reason = 'reset') {
    clear();
    lastFrameMs = null;
    rawM = null;
    resets += 1;
    lastResetReason = reason;
  }

  // frame: { status: 'ok', distanceM } | { status: 'no-target' }. → { status, distanceM?, held } 또는 null(아직 낼 샘플 없음).
  function push(frame, tMs) {
    if (lastFrameMs !== null && tMs - lastFrameMs > cfg.maxGapMs) {
      clear();
      lastResetReason = 'gap';
    }
    lastFrameMs = tMs;

    if (frame.status === 'ok') {
      rawM = frame.distanceM;
      absentSinceMs = null;
      held = false;
      window.push(frame.distanceM);
      if (window.length > cfg.medianWindow) window.shift();
      if (window.length < cfg.medianWindow) return null; // 창 채우는 중
      stableM = median(window);
      return { status: 'ok', distanceM: stableM, held: false };
    }

    // 감지 없음(n=0). dist 값은 쓰지 않는다(0 m를 근거리로 쓰지 않음).
    rawM = null;
    if (absentSinceMs === null) absentSinceMs = tMs;
    if (stableM !== null && tMs - absentSinceMs < cfg.absentGraceMs) {
      held = true;
      return { status: 'ok', distanceM: stableM, held: true };
    }
    const since = absentSinceMs;
    clear();
    absentSinceMs = since;
    return { status: 'no-target', held: false };
  }

  function snapshot(nowMs) {
    return {
      rawM,
      stableM,
      held,
      filling: window.length > 0 && window.length < cfg.medianWindow ? `${window.length}/${cfg.medianWindow}` : null,
      absentForMs: absentSinceMs === null ? null : nowMs - absentSinceMs,
      resets,
      lastResetReason,
    };
  }

  return { push, reset, snapshot };
}
