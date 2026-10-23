// 개발 패널의 실센서·설정 영역(개발용): 입력 선택, COM 포트 연결, 센서 상태, 앱 판정 설정, 센서 자체 설정.
// 서버 조작은 같은 origin JSON POST(/api/sensor/…)로만 한다. 판정·시퀀스 코어를 직접 부르지 않는다(입력 전환·설정 적용은 main.js 콜백).
// 관객 화면에는 아무것도 그리지 않는다.

import { validateAppSettings, validateSensorConfig } from '../config/input-settings.js';

const CONN_LABELS = { idle: '연결 안 됨', opening: '여는 중…', open: '연결됨', 'retry-wait': '재연결 대기' };
const BLOCK_LABELS = {
  'not-connected': '연결 확정 전',
  configuring: '센서 설정 명령 처리 중 — 판정 안전 정지',
  mode: '거리/속도 모드 보고 없음 — 판정 안전 정지',
};
const RESULT_LABELS = {
  'board-ack': '보드 처리 응답 수신(펌웨어 cmd/mode applied) — 센서 실제 적용은 미확인',
  timeout: '응답 시간 초과 — 보드가 늦게 처리했을 수 있어 실제 적용 여부를 알 수 없음',
  disconnected: '연결 해제·끊김으로 중단 — 일부만 처리됐을 수 있음',
  'write-failed': '전송 실패',
  rejected: '보드가 명령을 거절(unknown command)',
};
const ITEM_LABELS = { waiting: '대기', sent: '보냄·응답 대기', acked: '보드 응답', timeout: '시간 초과', failed: '전송 실패', rejected: '거절' };

const ms = (v) => (v === null || v === undefined ? '-' : `${Math.round(v)} ms`);
const m2 = (v) => (typeof v === 'number' ? `${v.toFixed(2)} m` : '-');
const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleTimeString('ko-KR', { hour12: false });
};

function makeRows(dl, rows) {
  const cells = {};
  for (const [key, label] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dl.append(dt, dd);
    cells[key] = dd;
  }
  return cells;
}

export function bindSensorPanel({ root = document, apiBase, staleMs, getInputMode, setInputMode, onAppSettingsSaved }) {
  const $ = (id) => root.getElementById(id);
  const sourceButtons = root.querySelectorAll('[data-source]');
  const sourceHint = $('source-hint');
  const portSelect = $('sensor-port');
  const refreshBtn = $('sensor-refresh');
  const connectBtn = $('sensor-connect');
  const disconnectBtn = $('sensor-disconnect');
  const connLine = $('sensor-conn');
  const errorLine = $('sensor-error');
  const appForm = $('app-form');
  const appResult = $('app-result');
  const appStore = $('app-store');
  const sensorForm = $('sensor-form');
  const sensorSubmit = sensorForm.querySelector('button[type="submit"]');
  const cmdResult = $('sensor-cmd-result');

  const status = makeRows($('sensor-status'), [
    ['raw', '센서 원본 거리'],
    ['stable', '안정화 거리(판정 입력)'],
    ['presence', '감지'],
    ['motion', '속도 · 에너지'],
    ['age', '마지막 거리 수신'],
    ['mode', '보고 모드'],
    ['hb', 'heartbeat'],
    ['boot', '보드 부팅 메시지'],
    ['counts', '수신 수'],
    ['log', '최근 보드 메시지'],
  ]);
  const record = makeRows($('sensor-config-record'), [
    ['desired', '희망 설정(서버 저장)'],
    ['progress', '진행'],
    ['last', '최근 전송'],
    ['actual', '센서 실제 설정'],
  ]);
  record.actual.textContent = '읽어오지 못함 — 현재 펌웨어에 설정 조회 명령이 없습니다(알 수 없음). 참고: 기존 Python 툴 저장 기록 0.3~3.0 m · mode 1(센서에서 읽은 값 아님)';

  let latest = null; // 서버 상태 { link, settings }
  let portsKey = '';
  let appDirty = false;
  let sensorDirty = false;
  let appliedApp = null;

  async function post(path, body = {}) {
    try {
      const res = await fetch(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return { ok: res.ok && data?.ok === true, data, message: data?.message ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, data: null, message: `로컬 서버에 연결하지 못했습니다: ${err.message}` };
    }
  }

  // ── 입력 선택 ──
  for (const button of sourceButtons) {
    button.addEventListener('click', () => {
      setInputMode(button.dataset.source);
      renderSource();
    });
  }

  function renderSource() {
    const mode = getInputMode();
    for (const button of sourceButtons) button.setAttribute('aria-pressed', String(button.dataset.source === mode));
    sourceHint.textContent = mode === 'sensor'
      ? '판정 입력: 실센서. 모의 조작(버튼·N/M/F)은 쓰지 않습니다.'
      : '판정 입력: 모의 입력(개발용, 실제 센서 아님). 센서 상태는 표시만 합니다.';
  }

  // ── 포트 ──
  refreshBtn.addEventListener('click', async () => {
    const r = await post('ports/refresh');
    if (!r.ok) showError(r.message);
  });
  connectBtn.addEventListener('click', async () => {
    if (!portSelect.value) return;
    const r = await post('connect', { path: portSelect.value });
    if (!r.ok) showError(r.message);
  });
  disconnectBtn.addEventListener('click', async () => {
    const r = await post('disconnect');
    if (!r.ok) showError(r.message);
  });

  let localError = null; // 조작 요청 실패 문구 { message, untilMs } — 몇 초 동안 보인다
  function showError(message) {
    localError = { message, untilMs: performance.now() + 6000 };
    errorLine.hidden = false;
    errorLine.textContent = message;
  }

  function renderPorts(link) {
    const key = JSON.stringify(link.ports.map((p) => [p.path, p.label]));
    if (key === portsKey) return;
    portsKey = key;
    const keep = portSelect.value;
    portSelect.replaceChildren();
    if (link.ports.length === 0) {
      const opt = new Option('포트 없음', '');
      opt.disabled = true;
      portSelect.append(opt);
    }
    for (const p of link.ports) portSelect.append(new Option(p.label, p.path));
    const prefer = [keep, link.selected, link.ports.filter((p) => p.candidate).length === 1 ? link.ports.find((p) => p.candidate).path : null];
    const pick = prefer.find((v) => v && link.ports.some((p) => p.path === v));
    if (pick) portSelect.value = pick;
  }

  // ── 앱 판정 설정 ──
  const appInputs = () => Object.fromEntries([...appForm.elements].filter((el) => el.name).map((el) => [el.name, el]));
  function fillApp(app) {
    const els = appInputs();
    for (const [key, el] of Object.entries(els)) el.value = String(app[key]);
    appDirty = false;
  }
  function readApp() {
    const out = {};
    for (const [key, el] of Object.entries(appInputs())) out[key] = el.value.trim() === '' ? NaN : Number(el.value);
    return out;
  }
  appForm.addEventListener('input', () => {
    appDirty = true;
  });
  $('app-revert').addEventListener('click', () => {
    if (appliedApp) fillApp(appliedApp);
    appResult.textContent = '현재 적용값으로 되돌렸습니다.';
  });
  appForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const checked = validateAppSettings(readApp());
    if (!checked.ok) {
      appResult.textContent = `적용 안 함 — ${checked.errors.join(' ')}`;
      return;
    }
    appResult.textContent = '저장 중…';
    const r = await post('app-settings', checked.value);
    if (!r.ok) {
      appResult.textContent = `적용 안 함 — ${r.message}`;
      return;
    }
    appliedApp = r.data.app;
    fillApp(appliedApp);
    onAppSettingsSaved(appliedApp);
    appResult.textContent = `저장·적용됨(${clock(new Date().toISOString())}) — 판정 후보·안정화를 초기화했습니다(잠시 안전 정지 후 다시 판정).`;
  });

  // ── 센서 자체 설정 ──
  const sensorInputs = () => Object.fromEntries([...sensorForm.elements].filter((el) => el.name).map((el) => [el.name, el]));
  function fillSensor(v) {
    const els = sensorInputs();
    els.rangeMinM.value = v.rangeMinM.toFixed(1);
    els.rangeMaxM.value = v.rangeMaxM.toFixed(1);
    els.thrFactor.value = String(v.thrFactor);
    els.microMotion.checked = v.microMotion;
    els.distanceMode.checked = v.distanceMode;
    sensorDirty = false;
  }
  function readSensor() {
    const els = sensorInputs();
    const num = (el) => (el.value.trim() === '' ? NaN : Number(el.value));
    return {
      rangeMinM: num(els.rangeMinM),
      rangeMaxM: num(els.rangeMaxM),
      thrFactor: num(els.thrFactor),
      microMotion: els.microMotion.checked,
      distanceMode: els.distanceMode.checked,
    };
  }
  sensorForm.addEventListener('input', () => {
    sensorDirty = true;
  });
  sensorForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const checked = validateSensorConfig(readSensor());
    if (!checked.ok) {
      cmdResult.textContent = `보내지 않음 — ${checked.errors.join(' ')}`;
      return;
    }
    cmdResult.textContent = '보내는 중…';
    const r = await post('config', checked.value);
    if (!r.ok) {
      cmdResult.textContent = `보내지 않음 — ${r.message}`;
      return;
    }
    sensorDirty = false;
    cmdResult.textContent = '명령을 차례로 보내는 중입니다(진행·결과는 아래).';
  });

  const desiredText = (v) => `${v.rangeMinM.toFixed(1)}~${v.rangeMaxM.toFixed(1)} m · 감도 ${v.thrFactor} · 미세 움직임 ${v.microMotion ? '켬' : '끔'} · mode 1 ${v.distanceMode ? '포함' : '안 보냄'}`;

  function renderCommand(link, settings) {
    const cmd = link.command;
    record.desired.textContent = desiredText(settings.sensorDesired);
    if (cmd.current) {
      const item = cmd.current.items[cmd.current.index];
      record.progress.textContent = `보내는 중 ${cmd.current.index + 1}/${cmd.current.items.length}: ${item?.line ?? '-'}`;
    } else if (link.conn === 'open' && cmd.awaitHb) {
      record.progress.textContent = '보드 heartbeat 대기 중(받기 전에는 명령을 보내지 않음)';
    } else {
      record.progress.textContent = link.conn === 'open' ? '없음(보낼 수 있음)' : '없음(연결 안 됨)';
    }
    if (cmd.ignoredAcks) record.progress.textContent += ` · 무시한 늦은 응답 ${cmd.ignoredAcks}`;
    const last = cmd.last ?? settings.sensorLastSent;
    record.last.textContent = last
      ? `${clock(last.finishedAt)} ${RESULT_LABELS[last.result] ?? last.result}${last.detail ? ` (${last.detail})` : ''} · `
        + `${last.items.map((it) => `${it.line} → ${ITEM_LABELS[it.state] ?? it.state}`).join(' / ')}`
        + `${cmd.last ? '' : ' (이전 실행 기록)'}${settings.recordError ? ` · ${settings.recordError}` : ''}`
      : '없음';
    sensorSubmit.disabled = link.conn !== 'open' || cmd.busy;
  }

  function renderLink(link, sseOpen) {
    let tone = 'idle';
    let text = CONN_LABELS[link.conn] ?? link.conn;
    if (link.selected) text += ` · ${link.selected}${link.selectedBy === 'auto' ? '(자동 선택)' : ''}`;
    if (link.conn === 'open') {
      tone = link.usable ? 'ok' : 'warn';
      text += link.usable ? ' · 거리 수신 사용 가능' : ` · ${BLOCK_LABELS[link.blockReason] ?? link.blockReason}`;
    } else if (link.conn === 'retry-wait') {
      tone = 'bad';
      text += link.reconnectInMs === null ? '' : ` (${Math.ceil(link.reconnectInMs / 1000)}초 뒤 다시 시도)`;
    } else if (link.conn === 'idle' && !link.selected && link.autoNote) {
      text += ` · ${link.autoNote}`;
    }
    if (!sseOpen) {
      tone = 'bad';
      text = `로컬 서버 이벤트 연결 끊김 — 다시 연결 중 (마지막 상태: ${text})`;
    }
    connLine.textContent = text;
    connLine.dataset.tone = tone;
    if (localError && performance.now() > localError.untilMs) localError = null;
    const err = localError?.message ?? link.error?.message ?? link.portsError ?? null;
    errorLine.hidden = !err;
    errorLine.textContent = err ?? '';
    connectBtn.disabled = link.ports.length === 0;
    disconnectBtn.disabled = !link.want && link.conn === 'idle';
  }

  function renderStatus(snap, link) {
    const f = snap.lastFrame;
    if (!f) status.raw.textContent = '아직 없음';
    else if (f.status === 'ok') status.raw.textContent = `${m2(f.distM)} (n=${f.n})`;
    else if (f.status === 'no-target') status.raw.textContent = '감지 없음(n=0 — 거리 값은 쓰지 않음)';
    else if (f.status === 'invalid') status.raw.textContent = `거절한 프레임(${f.reason})`;
    else status.raw.textContent = `사용 안 함(${f.reason})${typeof f.distM === 'number' ? ` · ${m2(f.distM)}` : ''}`;

    if (!snap.active) status.stable.textContent = '실센서 미선택 — 판정에 쓰지 않음';
    else if (snap.stabilizer?.filling) status.stable.textContent = `중앙값 창 채우는 중 ${snap.stabilizer.filling}`;
    else if (!snap.lastOut) status.stable.textContent = '없음(초기화 후 대기)';
    else if (snap.lastOut.status === 'ok') status.stable.textContent = `${m2(snap.lastOut.distanceM)}${snap.lastOut.held ? ' · n=0 유예 중 유지' : ''}`;
    else status.stable.textContent = '감지 없음 → 원거리(기본 놀이)';

    status.presence.textContent = f && (f.status === 'ok' || f.status === 'no-target') ? (f.n > 0 ? `있음 (n=${f.n})` : '없음') : '-';
    status.motion.textContent = f && typeof f.speedMps === 'number' ? `${f.speedMps.toFixed(2)} m/s · ${f.energy}` : '-';
    status.age.textContent = snap.distanceAgeMs === null
      ? '아직 없음'
      : `${ms(snap.distanceAgeMs)} 전${snap.distanceAgeMs > staleMs ? ' — 끊김(무수신)' : ''}`;

    const d = link.device;
    status.mode.textContent = d.mode === 'speed' ? 'speed(거리/속도)' : `${d.mode} — 거리 모드 아님`;
    status.hb.textContent = d.hb
      ? `${ms(d.hb.agoMs)} 전 · 보드 기준 센서 프레임 경과 ${ms(d.hb.frameAgeMs)} · 센서 UART ${d.hb.baud ?? '-'} · 보드 가동 ${d.hb.upSec} s`
      : '아직 없음';
    status.boot.textContent = d.boot.count ? `이번 연결에서 ${d.boot.count}회 (마지막 ${ms(d.boot.agoMs)} 전, fw ${d.boot.fw ?? '-'})` : '이번 연결에서 없음';
    const c = d.counts;
    status.counts.textContent = `감지 ${c.presence} · n=0 ${c.noTarget} · 형식 오류 ${c.invalid} · 긴 줄 버림 ${c.dropped} · JSON 아님 ${c.text} · 존재 모드 ${c.exist}`;
    const lastLog = d.logs[d.logs.length - 1];
    status.log.textContent = lastLog ? `${lastLog.msg} (${ms(lastLog.agoMs)} 전)` : '없음';
  }

  // 서버 상태가 올 때마다(그리고 패널이 열려 있으면 주기적으로) 부른다.
  function render(snap) {
    renderSource();
    const state = snap.state;
    if (!state) {
      connLine.textContent = snap.sseOpen ? '상태 받는 중…' : '로컬 서버 이벤트에 연결 중…';
      connLine.dataset.tone = 'idle';
      return;
    }
    latest = state;
    const { link, settings } = state;
    renderPorts(link);
    renderLink(link, snap.sseOpen);
    renderStatus(snap, link);
    renderCommand(link, settings);
    if (!appDirty && JSON.stringify(settings.app) !== JSON.stringify(appliedApp)) {
      appliedApp = settings.app;
      fillApp(appliedApp);
    }
    if (!sensorDirty) fillSensor(settings.sensorDesired);
    appStore.textContent = `저장 파일: ${settings.file} · 현재 적용값: ${settings.appSource === 'file' ? '저장 파일' : '기본값(config/settings.js)'}`
      + (settings.loadError ? ` · ${settings.loadError}` : '');
  }

  renderSource();
  return { render, latest: () => latest };
}
