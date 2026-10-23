// mmWave 센서 보드(ESP32) USB 시리얼 연결 관리: 포트 목록·선택, 연결·해제·자동 재연결, 줄 수신·해석, 고정 설정 명령 전송.
// 실제 장치는 backend(server/sensor/serial-backend.js)를 통해서만 연다 — 이 모듈을 import해도 장치를 열지 않는다(테스트는 가짜 backend).
//
// 안전 규칙:
//   - 연결할 때 보드에 아무 명령도 보내지 않는다(설정·모드·재부팅 없음). 기존 JSON 스트림 수신부터 시작한다.
//   - 연결 세대(generation)로 늦은 open·close·data·명령 응답이 새 연결에 섞이지 않게 한다.
//   - 수동 해제는 자동 재연결을 취소한다. 다른 프로그램(Python 툴 등)이 포트를 쓰고 있으면 안내만 하고 그 프로그램을 건드리지 않는다.
//   - 명령은 한 번에 한 묶음(최대 4줄)만. 펌웨어의 "cmd applied"/"mode applied"는 보드가 처리를 마쳤다는 뜻일 뿐 센서 적용 확인이 아니다.

import { validateSensorConfig } from '../../public/display/config/input-settings.js';
import { createLineSplitter, parseDeviceLine } from './protocol.js';

// 알려진 센서 보드 USB-UART 칩(VID, 소문자 16진). 현재 보드는 CH343(1a86:55d3).
export const KNOWN_SENSOR_VIDS = Object.freeze({ '1a86': 'WCH CH34x', '10c4': 'Silicon Labs CP210x', '303a': 'Espressif USB' });

const MAX_LOGS = 8;

// 희망 설정 → 펌웨어 고정 명령. 원문 명령 입력은 받지 않는다. 펌웨어 PC 줄 버퍼(96바이트)보다 짧다.
export function buildSensorCommands(value) {
  const items = [
    { line: `cmd setRange ${value.rangeMinM.toFixed(1)} ${value.rangeMaxM.toFixed(1)}`, expect: 'cmd applied' },
    { line: `cmd setThrFactor ${value.thrFactor}`, expect: 'cmd applied' },
    { line: `cmd setMicroMotion ${value.microMotion ? 1 : 0}`, expect: 'cmd applied' },
  ];
  if (value.distanceMode) items.push({ line: 'mode 1', expect: 'mode applied' });
  return items;
}

export function describeOpenError(err, path, reconnectMs) {
  const raw = String(err?.message ?? err);
  const retry = `${Math.round(reconnectMs / 1000)}초마다 다시 시도합니다.`;
  if (/access denied|EBUSY|EACCES|resource busy|cannot lock|in use/i.test(raw)) {
    return {
      kind: 'busy',
      message: `${path}을(를) 다른 프로그램이 사용 중입니다. 기존 Python 센서 툴(sensor_tool)·시리얼 모니터 등 이 포트를 연 프로그램을 닫아 주세요. ${retry} (${raw})`,
    };
  }
  if (/file not found|ENOENT|cannot find|no such file|not exist/i.test(raw)) {
    return { kind: 'not-found', message: `${path}을(를) 찾을 수 없습니다. USB 케이블·보드 연결을 확인하세요. ${retry} (${raw})` };
  }
  return { kind: 'open-failed', message: `${path} 열기 실패. ${retry} (${raw})` };
}

function describePort(p) {
  const vid = typeof p.vendorId === 'string' ? p.vendorId.toLowerCase() : null;
  const pid = typeof p.productId === 'string' ? p.productId.toLowerCase() : null;
  const name = p.friendlyName || p.manufacturer || '알 수 없는 장치';
  const candidate = vid !== null && Object.hasOwn(KNOWN_SENSOR_VIDS, vid);
  return {
    path: String(p.path),
    name: String(name).slice(0, 80),
    vid,
    pid,
    candidate,
    label: `${p.path} — ${name}${vid ? ` (${vid}:${pid ?? '----'})` : ''}${candidate ? ' · 센서 보드 후보' : ''}`,
  };
}

export function createSerialLink({
  backend,
  now = () => performance.now(),
  wallClock = () => new Date().toISOString(),
  timers = { setTimeout, clearTimeout },
  reconnectMs = 3000,
  commandTimeoutMs = 10000, // 펌웨어 configure()는 sensorStop 재시도 포함 최대 약 5.5초 동안 막힌다
  onChange = () => {},
  onFrame = () => {},
  onCommandDone = () => {},
}) {
  let ports = [];
  let portsError = null;
  let autoNote = null;
  let selected = null; // { path, by: 'auto' | 'user' }
  let want = false; // 사용자가(또는 자동 선택이) 연결을 원함
  let conn = 'idle'; // idle | opening | open | retry-wait
  let error = null; // { kind, message }
  let generation = 0;
  let handle = null;
  let pendingClose = Promise.resolve();
  let reconnectTimer = null;
  let reconnectAtMs = null;
  let openedAtMs = null;
  let device = freshDevice();
  let batchSeq = 0;
  let batch = null; // 진행 중 명령 묶음
  let commandTimer = null;
  let awaitHb = true; // 연결 직후·명령 시간 초과 뒤: 보드 heartbeat를 받기 전에는 새 명령을 보내지 않는다(늦은 응답이 새 명령을 끝내지 않게)
  let lastCommand = null;
  let ignoredAcks = 0;
  let frameSeq = 0;
  let intentSeq = 0; // 연결 의도 토큰: 연결·자동 선택·해제·종료마다 올린다(포트 목록 조회를 기다린 이전 요청은 무시)

  const splitter = createLineSplitter({
    onLine: (text) => handleLine(text),
    onDrop: () => {
      device.counts.dropped += 1;
    },
  });

  function freshDevice() {
    return {
      mode: 'unknown', // 마지막으로 보고된 센서 출력 모드: speed(거리/속도) | exist | unknown | none ...
      hb: null, // { upSec, frames, baud, mode, frameAgeMs, atMs }
      boot: { count: 0, fw: null, atMs: null },
      lastFrame: null, // 마지막 유효 presence { n, distM, speedMps, energy, mcuTs, atMs }
      lastFrameAtMs: null, // 마지막 유효 거리 프레임(n=0 포함) 수신 시각(서버 단조 시계) — heartbeat로 갱신하지 않는다
      lastInvalid: null, // { reason, atMs }
      logs: [], // 최근 보드 메시지 { msg, atMs }
      counts: { presence: 0, noTarget: 0, invalid: 0, hb: 0, exist: 0, text: 0, dropped: 0 },
    };
  }

  const changed = () => onChange();

  function blockReason() {
    if (conn !== 'open') return 'not-connected';
    if (batch) return 'configuring';
    if (device.mode !== 'speed') return 'mode';
    return null;
  }

  function pushLog(msg) {
    device.logs.push({ msg, atMs: now() });
    if (device.logs.length > MAX_LOGS) device.logs.shift();
  }

  // ── 줄 처리 ──
  function emitFrame(status, extra) {
    frameSeq += 1;
    onFrame({ seq: frameSeq, generation, status, ...extra });
  }

  function handleLine(text) {
    const m = parseDeviceLine(text);
    const t = now();
    switch (m.type) {
      case 'presence': {
        if (!m.valid) {
          device.counts.invalid += 1;
          device.lastInvalid = { reason: m.reason, atMs: t };
          const block = conn !== 'open' ? 'not-connected' : batch ? 'configuring' : null;
          emitFrame(block ? 'error' : 'invalid', { reason: block ?? m.reason });
          return;
        }
        const modeChanged = device.mode !== 'speed';
        device.mode = 'speed'; // 펌웨어는 $DFDMD 프레임을 받을 때 mode를 speed로 둔다
        if (modeChanged) changed(); // 사용 가능 여부가 바뀌었음을 프레임보다 먼저 알린다
        device.lastFrame = { n: m.n, distM: m.distM, speedMps: m.speedMps, energy: m.energy, mcuTs: m.mcuTs, atMs: t };
        device.lastFrameAtMs = t;
        if (m.n > 0) device.counts.presence += 1;
        else device.counts.noTarget += 1;
        const frame = { n: m.n, distM: m.distM, speedMps: m.speedMps, energy: m.energy, mcuTs: m.mcuTs };
        // 설정 명령 처리 중·연결 확정 전 프레임은 판정에 쓰지 않는다(오류 = 안전 정지).
        const block = blockReason();
        if (block) emitFrame('error', { reason: block, ...frame });
        else emitFrame(m.n > 0 ? 'ok' : 'no-target', frame);
        return;
      }
      case 'exist':
        device.counts.exist += 1;
        if (device.mode !== 'exist') {
          device.mode = 'exist';
          changed();
        }
        emitFrame('error', { reason: 'not-distance-mode' });
        return;
      case 'hb':
        if (!m.valid) {
          device.counts.invalid += 1;
          device.lastInvalid = { reason: m.reason, atMs: t };
          return;
        }
        device.counts.hb += 1;
        device.hb = { upSec: m.upSec, frames: m.frames, baud: m.baud, mode: m.mode, frameAgeMs: m.frameAgeMs, atMs: t };
        device.mode = m.mode;
        if (awaitHb && !batch) awaitHb = false;
        changed();
        return;
      case 'boot':
        device.boot = { count: device.boot.count + 1, fw: m.fw, atMs: t };
        device.mode = 'unknown';
        pushLog(`보드 부팅 메시지(fw ${m.fw ?? '-'})`);
        changed();
        return;
      case 'log':
        pushLog(m.msg);
        handleBoardLog(m.msg);
        changed();
        return;
      case 'text':
        device.counts.text += 1;
        pushLog(`(JSON 아님) ${m.text}`);
        changed();
        return;
      case 'invalid': {
        // 해석되지 않는 줄(예: dist:nan → JSON 오류)도 거절 프레임으로 알려 브라우저 안정화·판정 후보를 끊는다.
        device.counts.invalid += 1;
        device.lastInvalid = { reason: m.reason, atMs: t };
        const block = conn !== 'open' ? 'not-connected' : batch ? 'configuring' : null;
        emitFrame(block ? 'error' : 'invalid', { reason: block ?? m.reason });
        return;
      }
      default:
        return; // raw 등은 쓰지 않는다
    }
  }

  // ── 명령 ──
  function handleBoardLog(msg) {
    const isAck = msg === 'cmd applied' || msg === 'mode applied';
    const item = batch?.items[batch.index];
    if (item && item.state === 'sent') {
      if (msg === item.expect) {
        timers.clearTimeout(commandTimer);
        commandTimer = null;
        item.state = 'acked';
        batch.index += 1;
        sendNext();
        return;
      }
      if (msg.startsWith('unknown command')) {
        item.state = 'rejected';
        finishBatch('rejected', '보드가 명령을 알아듣지 못했습니다.');
        return;
      }
    }
    if (isAck) ignoredAcks += 1; // 시간 초과·해제 뒤 늦게 온 응답 — 어떤 명령도 완료시키지 않는다
  }

  function sendNext() {
    const b = batch;
    const item = b.items[b.index];
    if (!item) {
      finishBatch('board-ack', null);
      return;
    }
    item.state = 'sent';
    const gen = generation;
    const h = handle;
    h.write(`${item.line}\n`).catch((err) => {
      if (batch !== b || gen !== generation) return;
      item.state = 'failed';
      finishBatch('write-failed', String(err?.message ?? err));
    });
    commandTimer = timers.setTimeout(() => {
      commandTimer = null;
      if (batch !== b) return;
      item.state = 'timeout';
      awaitHb = true;
      finishBatch('timeout', `${Math.round(commandTimeoutMs / 1000)}초 안에 보드 응답 없음 — 늦게 처리했을 수 있어 실제 적용 여부를 알 수 없습니다.`);
    }, commandTimeoutMs);
    changed();
  }

  function finishBatch(result, detail) {
    if (!batch) return;
    if (commandTimer !== null) timers.clearTimeout(commandTimer);
    commandTimer = null;
    const b = batch;
    batch = null;
    lastCommand = {
      id: b.id,
      result,
      detail,
      value: b.value,
      items: b.items.map(({ line, state }) => ({ line, state })),
      startedAt: b.startedAt,
      finishedAt: wallClock(),
    };
    onCommandDone(lastCommand);
    changed();
  }

  function sendSensorConfig(input) {
    const checked = validateSensorConfig(input);
    if (!checked.ok) return { ok: false, code: 'invalid', message: checked.errors.join(' ') };
    if (conn !== 'open' || handle === null) return { ok: false, code: 'not-connected', message: '센서 보드가 연결되어 있지 않습니다.' };
    if (batch) return { ok: false, code: 'busy', message: '이전 센서 명령을 처리하는 중입니다.' };
    if (awaitHb) {
      return { ok: false, code: 'not-ready', message: '보드 heartbeat를 아직 받지 못했습니다(연결 직후 또는 명령 시간 초과 뒤). 잠시 뒤 다시 시도하세요.' };
    }
    batchSeq += 1;
    batch = {
      id: batchSeq,
      value: checked.value,
      items: buildSensorCommands(checked.value).map((it) => ({ ...it, state: 'waiting' })),
      index: 0,
      startedAt: wallClock(),
    };
    sendNext();
    return { ok: true, id: batchSeq };
  }

  // ── 연결 ──
  function dropHandle() {
    const h = handle;
    handle = null;
    if (h) pendingClose = h.close().catch(() => {});
  }

  function clearReconnect() {
    if (reconnectTimer !== null) timers.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAtMs = null;
  }

  function scheduleReconnect() {
    clearReconnect();
    if (!want) return;
    reconnectAtMs = now() + reconnectMs;
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      reconnectAtMs = null;
      if (want) openNow();
    }, reconnectMs);
  }

  // 지금 연결(또는 연결 시도)을 끝낸다. 세대를 올려 이전 연결의 늦은 콜백을 모두 무시한다.
  function endConnection(reason) {
    generation += 1;
    finishBatch('disconnected', reason);
    dropHandle();
    splitter.reset();
    openedAtMs = null;
  }

  async function openNow() {
    clearReconnect();
    const gen = ++generation;
    const path = selected.path;
    conn = 'opening';
    device = freshDevice();
    awaitHb = true;
    splitter.reset();
    changed();
    await pendingClose; // 이전 핸들이 완전히 닫힌 뒤 연다(같은 포트 재연결 때 사용 중 오류 방지)
    if (gen !== generation) return;
    let h;
    try {
      h = await backend.open(path, {
        onData: (buf) => {
          if (gen === generation) splitter.push(buf);
        },
        onClose: (err) => {
          if (gen !== generation) return;
          endConnection('연결 끊김');
          conn = want ? 'retry-wait' : 'idle';
          error = { kind: 'closed', message: `${path} 연결이 끊겼습니다(${err?.message ?? 'USB 분리 또는 장치 재시작'}). ${Math.round(reconnectMs / 1000)}초마다 다시 연결합니다.` };
          scheduleReconnect();
          changed();
        },
      });
    } catch (err) {
      if (gen !== generation) return;
      conn = want ? 'retry-wait' : 'idle';
      error = describeOpenError(err, path, reconnectMs);
      scheduleReconnect();
      changed();
      return;
    }
    if (gen !== generation || !want) {
      // 그 사이 해제·다른 포트 연결 — 늦게 열린 핸들은 바로 닫는다.
      pendingClose = h.close().catch(() => {});
      return;
    }
    handle = h;
    conn = 'open';
    error = null;
    openedAtMs = now();
    changed();
  }

  async function refreshPorts() {
    try {
      const list = await backend.list();
      ports = list.map(describePort).sort((a, b) => Number(b.candidate) - Number(a.candidate) || a.path.localeCompare(b.path));
      portsError = null;
    } catch (err) {
      portsError = `포트 목록을 읽지 못했습니다: ${err?.message ?? err}`;
    }
    changed();
    return ports;
  }

  // 시작 때: 알려진 센서 보드 후보가 정확히 1개일 때만 고르고 연결한다(일반 COM1 등에는 자동으로 열지 않는다).
  async function autoSelect() {
    const intent = ++intentSeq;
    await refreshPorts();
    if (intent !== intentSeq) return; // 조회 중 수동 해제·연결 요청·종료가 있었다
    if (selected !== null || portsError) return;
    const candidates = ports.filter((p) => p.candidate);
    if (candidates.length === 1) {
      autoNote = `센서 보드 후보 ${candidates[0].path} 자동 선택`;
      selected = { path: candidates[0].path, by: 'auto' };
      want = true;
      openNow();
    } else {
      autoNote = candidates.length === 0
        ? '알려진 센서 보드(USB-UART CH34x/CP210x/Espressif)가 없습니다. 연결 후 새로고침하세요.'
        : `센서 보드 후보가 ${candidates.length}개입니다. 패널에서 포트를 골라 연결하세요.`;
    }
    changed();
  }

  // 사용자가 고른 포트로 연결. 경로는 방금 읽은 목록에 있어야 한다(임의 경로를 열지 않음).
  async function connect(path) {
    const intent = ++intentSeq;
    await refreshPorts();
    if (intent !== intentSeq) {
      return { ok: false, code: 'superseded', message: '포트 목록을 읽는 동안 해제·다른 연결 요청이 있어 이 연결 요청은 취소했습니다.' };
    }
    if (typeof path !== 'string' || !ports.some((p) => p.path === path)) {
      return { ok: false, code: 'unknown-port', message: `포트 목록에 없는 경로입니다: ${String(path).slice(0, 40)}` };
    }
    if (want && selected?.path === path && (conn === 'open' || conn === 'opening')) return { ok: true };
    endConnection('다른 연결 요청');
    selected = { path, by: 'user' };
    want = true;
    error = null;
    openNow();
    return { ok: true };
  }

  // 수동 해제: 자동 재연결도 취소한다.
  function disconnect() {
    intentSeq += 1;
    want = false;
    clearReconnect();
    endConnection('수동 해제');
    conn = 'idle';
    error = null;
    changed();
    return { ok: true };
  }

  async function shutdown() {
    intentSeq += 1;
    want = false;
    clearReconnect();
    endConnection('서버 종료');
    conn = 'idle';
    await pendingClose;
  }

  function snapshot() {
    const t = now();
    const ago = (ms) => (ms === null || ms === undefined ? null : Math.max(0, Math.round(t - ms)));
    const reason = blockReason();
    return {
      ports,
      portsError,
      autoNote,
      selected: selected?.path ?? null,
      selectedBy: selected?.by ?? null,
      want,
      conn,
      error,
      reconnectInMs: reconnectAtMs === null ? null : Math.max(0, Math.round(reconnectAtMs - t)),
      generation,
      openedAgoMs: ago(openedAtMs),
      usable: reason === null,
      blockReason: reason,
      device: {
        mode: device.mode,
        hb: device.hb && { ...device.hb, atMs: undefined, agoMs: ago(device.hb.atMs) },
        boot: { count: device.boot.count, fw: device.boot.fw, agoMs: ago(device.boot.atMs) },
        lastFrame: device.lastFrame && { ...device.lastFrame, atMs: undefined },
        frameAgoMs: ago(device.lastFrameAtMs),
        lastInvalid: device.lastInvalid && { reason: device.lastInvalid.reason, agoMs: ago(device.lastInvalid.atMs) },
        logs: device.logs.map((l) => ({ msg: l.msg, agoMs: ago(l.atMs) })),
        counts: { ...device.counts },
      },
      command: {
        busy: batch !== null,
        awaitHb,
        current: batch && { id: batch.id, index: batch.index, items: batch.items.map(({ line, state }) => ({ line, state })) },
        last: lastCommand,
        ignoredAcks,
      },
    };
  }

  return { refreshPorts, autoSelect, connect, disconnect, sendSensorConfig, shutdown, snapshot };
}
