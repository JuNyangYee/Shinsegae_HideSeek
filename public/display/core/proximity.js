// 근접 판정: 공통 근접 샘플 → 안정화된 near / far / unknown.
// DOM·타이머 없는 순수 모듈이다. 현재 시각(nowMs)은 호출하는 쪽이 넣는다.
//
// 공통 근접 샘플: { source, timestampMs, status: 'ok' | 'no-target' | 'error', distanceM? }
// - timestampMs: 페이지 단조 시계(performance.now()) 기준 ms
// - distanceM: status가 'ok'일 때만, 0 이상의 m

export const DECISIONS = Object.freeze(['unknown', 'near', 'far']);
const STATUSES = new Set(['ok', 'no-target', 'error']);

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

export function createProximityJudge(cfg) {
  if (!(cfg.nearMaxM < cfg.farMinM)) throw new Error('nearMaxM은 farMinM보다 작아야 한다');

  let decision = 'unknown';
  let candidate = null; // { zone: 'near' | 'far', sinceMs, lastMs }
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

  function zoneOf(distanceM) {
    if (distanceM <= cfg.nearMaxM) return 'near';
    if (distanceM >= cfg.farMinM) return 'far';
    return 'between';
  }

  function holdMsFor(zone) {
    return zone === 'near' ? cfg.nearHoldMs : cfg.farHoldMs;
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
    if (sample.status === 'no-target') {
      // 임시 정책: 이전 안정 판정을 유지하고(unknown이면 unknown), 진행 중 후보만 끊는다.
      candidate = null;
      return result(decision !== before);
    }

    const zone = zoneOf(sample.distanceM);
    if (zone === 'between' || zone === decision) {
      // 사이 구간은 이전 판정 유지, 같은 판정 구간이면 바꿀 것이 없다. 어느 쪽이든 반대 후보는 끊긴다.
      candidate = null;
      return result(decision !== before);
    }
    if (!candidate || candidate.zone !== zone) candidate = { zone, sinceMs: ts, lastMs: ts };
    candidate.lastMs = ts;
    if (ts - candidate.sinceMs >= holdMsFor(zone)) {
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
        requiredMs: holdMsFor(candidate.zone),
      },
      lastSample,
      lastSampleAgeMs: lastSample ? nowMs - lastSample.timestampMs : null,
      lastRejection,
    };
  }

  return { update, tick, snapshot };
}
