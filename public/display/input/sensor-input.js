// 실센서 입력 어댑터: 로컬 서버 SSE(같은 origin)의 센서 프레임 → 안정화(core/stabilizer.js) → 공통 근접 샘플.
// 판정은 하지 않는다. 시각은 프레임을 받은 페이지 시각(performance.now())만 쓴다 — 보드(MCU) ts는 표시에만.
//
// - 서버가 프레임마다 상태를 붙여 보낸다: ok(감지 거리) / no-target(n=0) / error(설정 중·연결 확정 전·거리 모드 아님) / invalid(형식·범위 오류).
// - error·연결 세대나 사용 가능 여부 변경·SSE 끊김 → 필터를 비우고 오류 샘플(즉시 unknown = 안전 정지).
// - invalid → 필터를 비우고 거절로 알린다(판정 후보를 끊음). 계속되면 판정의 stale이 unknown으로 만든다.
// - 프레임이 오지 않으면 아무것도 내지 않는다(이전 거리를 스스로 다시 보내지 않음). 새 SSE 연결은 상태만 받고 지나간 프레임을 받지 않는다.
// - 활성(실센서 선택) 상태가 아니면 상태 표시용으로만 받고 판정에 넘기지 않는다.

import { createStabilizer } from '../core/stabilizer.js';

export function createSensorInput({ eventsUrl, source, maxGapMs, now = () => performance.now(), onSample, onReject, onState }) {
  let es = null;
  let active = false;
  let sseOpen = false;
  let state = null; // 서버 상태 { link, settings }
  let linkKey = null; // 연결 세대 + 사용 가능 여부
  let stabilizeCfg = null;
  let stabilizer = null;
  let lastFrame = null; // { frame, atMs } — 받은 페이지 시각
  let lastDistanceAtMs = null; // 마지막 거리 프레임(감지·n=0) 수신 시각
  let lastOut = null; // 마지막으로 판정에 보낸 샘플 { status, distanceM, held, atMs }
  const counts = { frames: 0, sent: 0, errors: 0, rejected: 0 };

  function configure(cfg) {
    stabilizeCfg = { medianWindow: cfg.medianWindow, absentGraceMs: cfg.absentGraceMs, maxGapMs };
    stabilizer = createStabilizer(stabilizeCfg);
    lastOut = null;
  }

  function sendError(reason) {
    stabilizer?.reset(reason);
    lastOut = null;
    if (!active) return;
    counts.errors += 1;
    onSample({ source, timestampMs: now(), status: 'error' }, reason);
  }

  function handleFrame(frame) {
    const t = now();
    counts.frames += 1;
    lastFrame = { frame, atMs: t };
    if (frame.status === 'ok' || frame.status === 'no-target') lastDistanceAtMs = t;
    if (!active || stabilizer === null) return;
    if (frame.status === 'error') {
      sendError(frame.reason ?? 'device-error');
      return;
    }
    if (frame.status === 'invalid') {
      stabilizer.reset('invalid');
      lastOut = null;
      counts.rejected += 1;
      onReject(`센서 프레임 거절(${frame.reason})`, t);
      return;
    }
    const out = stabilizer.push(
      frame.status === 'ok' ? { status: 'ok', distanceM: frame.distM } : { status: 'no-target' },
      t,
    );
    if (out === null) return; // 중앙값 창 채우는 중
    const sample = { source, timestampMs: t, status: out.status };
    if (out.status === 'ok') sample.distanceM = out.distanceM;
    lastOut = { ...out, atMs: t };
    counts.sent += 1;
    onSample(sample);
  }

  function handleState(next) {
    state = next;
    const key = `${next.link.generation}:${next.link.usable}`;
    if (key !== linkKey) {
      linkKey = key;
      if (next.link.usable) {
        stabilizer?.reset('link');
        lastOut = null;
      } else sendError(next.link.blockReason ?? 'link');
    }
    onState(next);
  }

  function parse(event) {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  }

  function start() {
    if (es !== null) return;
    es = new EventSource(eventsUrl);
    es.addEventListener('open', () => {
      sseOpen = true;
    });
    es.addEventListener('state', (event) => {
      sseOpen = true;
      const data = parse(event);
      if (data?.link) handleState(data);
    });
    es.addEventListener('frame', (event) => {
      const data = parse(event);
      if (data) handleFrame(data);
    });
    // 서버 연결이 끊기면(서버 종료 등) 안전 정지. EventSource가 스스로 다시 연결하고, 다시 받은 상태부터 새로 시작한다.
    es.addEventListener('error', () => {
      if (!sseOpen && linkKey === null) return;
      sseOpen = false;
      linkKey = null;
      sendError('server-events-lost');
      onState(state);
    });
  }

  function stop() {
    es?.close();
    es = null;
    sseOpen = false;
  }

  // 실센서를 판정 입력으로 쓸지. 바뀔 때 필터를 비운다(이전 입력의 거리가 섞이지 않게).
  function setActive(on) {
    if (active === on) return;
    active = on;
    stabilizer?.reset('source');
    lastOut = null;
    if (on && state && !state.link.usable) sendError(state.link.blockReason ?? 'link');
  }

  function snapshot(nowMs) {
    return {
      active,
      sseOpen,
      state,
      lastFrame: lastFrame && { ...lastFrame.frame, ageMs: nowMs - lastFrame.atMs },
      distanceAgeMs: lastDistanceAtMs === null ? null : nowMs - lastDistanceAtMs,
      stabilizer: stabilizer?.snapshot(nowMs) ?? null,
      lastOut: lastOut && { ...lastOut, ageMs: nowMs - lastOut.atMs },
      counts: { ...counts },
    };
  }

  return { start, stop, configure, setActive, snapshot };
}
