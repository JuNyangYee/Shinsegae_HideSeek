// 근접 판정: 공통 근접 샘플 → 안정화된 far / mid / near / unknown.
// DOM·타이머 없는 순수 모듈이다. 현재 시각(nowMs)은 호출하는 쪽이 넣는다.
//
// 공통 근접 샘플: { source, timestampMs, status: 'ok' | 'no-target' | 'error', distanceM? }
// - timestampMs: 페이지 단조 시계(performance.now()) 기준 ms
// - distanceM: status가 'ok'일 때만, 0 이상의 m
// - no-target(장치 정상, 감지 대상 없음)은 원거리(far) 구역 샘플로 본다(v02: 입력 없음 = 기본 놀이).
// - error·stale(샘플 끊김)은 unknown(안전 정지)이다. no-target과 섞지 않는다.

export const DECISIONS = Object.freeze(['unknown', 'far', 'mid', 'near']);
const STATUSES = new Set(['ok', 'no-target', 'error']);
// 가까운 정도(클수록 가깝다). unknown은 순서가 없다.
const RANK = Object.freeze({ far: 0, mid: 1, near: 2 });

// 샘플이 규격에 맞지 않으면 거절 사유를, 맞으면 null을 돌려준다.
export function validateSample(sample) {
  if (sample === null || typeof sample !== 'object') return 'not-object';
  if (typeof sample.source !== 'string' || sample.source === '') return 'bad-source';
  if (!Number.isFinite(sample.timestampMs) || sample.timestampMs < 0) return 'bad-timestamp';
  if (!STATUSES.has(sample.status)) return 'bad-status';
  if (sample.status === 'ok') {
    if (!Number.isFinite(sample.distanceM)) return 'bad-distance';
    if (sample.distanceM < 0) return 'negative-distance';
  }
  return null;
}

// 거리 → 구역. current(지금 안정 판정)보다 가까운 쪽에서 멀어질 때만 경계에 retreatMarginM을 더한다.
//   near/mid 경계: current가 near면 거리 < nearBelowM + 여유 → near, 아니면 거리 < nearBelowM → near.
//   mid/far 경계: current가 near·mid면 거리 > farAboveM + 여유 → far, 아니면(far·unknown) 거리 > farAboveM → far.
export function zoneOf(distanceM, current, cfg) {
  const margin = cfg.retreatMarginM;
  const nearLimit = current === 'near' ? cfg.nearBelowM + margin : cfg.nearBelowM;
  const farLimit = current === 'near' || current === 'mid' ? cfg.farAboveM + margin : cfg.farAboveM;
  if (distanceM < nearLimit) return 'near';
  if (distanceM > farLimit) return 'far';
  return 'mid';
}

// 후보 zone이 판정이 되기까지의 유지 시간. 더 가까워지면 approachHoldMs, 더 멀어지거나 unknown에서 회복하면 retreatHoldMs.
export function holdMsFor(zone, current, cfg) {
  if (current !== 'unknown' && RANK[zone] > RANK[current]) return cfg.approachHoldMs;
  return cfg.retreatHoldMs;
}

export function createProximityJudge(cfg) {
  if (!(cfg.nearBelowM + cfg.retreatMarginM < cfg.farAboveM)) {
    throw new Error('nearBelowM + retreatMarginM은 farAboveM보다 작아야 한다');
  }

  let decision = 'unknown';
  let candidate = null; // { zone, sinceMs, lastMs }
  let lastSample = null; // 마지막으로 받아들인 샘플
  let stale = false;
  let lastRejection = null; // { reason, atMs }

  function setDecision(next) {
    const changed = next !== decision;
    decision = next;
    return changed;
  }

  function goUnknown() {
    candidate = null;
    return setDecision('unknown');
  }

  function reject(reason, nowMs) {
    // 거절한 샘플은 판정 근거로 쓰지 않고, 이어지던 후보도 끊는다(유지 시간 거짓 충족 방지).
    // 마지막 정상 샘플 시각은 그대로라 거절만 이어지면 tick에서 stale이 된다.
    lastRejection = { reason, atMs: nowMs };
    candidate = null;
    return { decision, changed: false, accepted: false, reason };
  }

  function result(changed) {
    return { decision, changed, accepted: true, reason: null };
  }

  // 샘플 하나를 반영한다. changed는 이 호출 전후로 판정이 바뀌었는지다.
  function update(sample, nowMs) {
    const invalid = validateSample(sample);
    if (invalid) return reject(invalid, nowMs);
    const ts = sample.timestampMs;
    if (ts > nowMs) return reject('future-timestamp', nowMs);
    if (nowMs - ts > cfg.staleMs) return reject('too-old', nowMs);
    if (lastSample && ts < lastSample.timestampMs) return reject('out-of-order', nowMs);

    const before = decision;
    // tick이 늦게 돌아 놓친 신호 공백도 stale로 처리한다.
    if (lastSample && ts - lastSample.timestampMs > cfg.staleMs) goUnknown();
    // 후보 유지 중 간격이 벌어지면 그 공백을 유지 시간으로 세지 않는다.
    if (candidate && ts - candidate.lastMs > cfg.maxSampleGapMs) candidate = null;

    lastSample = sample;
    stale = false;

    if (sample.status === 'error') {
      goUnknown();
      return result(decision !== before);
    }

    const zone = sample.status === 'no-target' ? 'far' : zoneOf(sample.distanceM, decision, cfg);
    if (zone === decision) {
      // 지금 판정과 같은 구역이면 바꿀 것이 없고, 다른 구역 후보는 끊긴다.
      candidate = null;
      return result(false);
    }
    if (!candidate || candidate.zone !== zone) candidate = { zone, sinceMs: ts, lastMs: ts };
    candidate.lastMs = ts;
    if (ts - candidate.sinceMs >= holdMsFor(zone, decision, cfg)) {
      candidate = null;
      setDecision(zone);
    }
    return result(decision !== before);
  }

  // 샘플이 오지 않아도 주기적으로 불러 stale을 확인한다.
  function tick(nowMs) {
    if (!lastSample || stale) return { decision, changed: false };
    if (nowMs - lastSample.timestampMs > cfg.staleMs) {
      stale = true;
      const changed = goUnknown();
      return { decision, changed };
    }
    return { decision, changed: false };
  }

  function snapshot(nowMs) {
    return {
      decision,
      stale,
      candidate: candidate && {
        zone: candidate.zone,
        heldMs: candidate.lastMs - candidate.sinceMs,
        requiredMs: holdMsFor(candidate.zone, decision, cfg),
      },
      lastSample,
      lastSampleAgeMs: lastSample ? nowMs - lastSample.timestampMs : null,
      lastRejection,
    };
  }

  return { update, tick, snapshot };
}
