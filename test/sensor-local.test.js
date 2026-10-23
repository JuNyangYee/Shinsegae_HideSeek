// 로컬 서버 실센서 연결의 위험 지점만 확인한다(실제 장치·serialport 없이 가짜 backend·가짜 타이머).
// 줄 분할·해석, 무수신/heartbeat 구분, 안정화(중앙값·n=0 유예·공백·초기화), 연결 취소·사용 중·늦은 open,
// 명령 시간 초과 뒤 늦은 응답, 설정 검증·저장, API 보호·SSE(지나간 프레임 재전송 없음).

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createRequestListener } from '../server/app.js';
import { createSensorApi } from '../server/sensor/api.js';
import { createLineSplitter, parseDeviceLine } from '../server/sensor/protocol.js';
import { createSerialLink } from '../server/sensor/serial-link.js';
import { createSettingsStore } from '../server/sensor/settings-store.js';
import { createStabilizer } from '../public/display/core/stabilizer.js';
import { defaultAppSettings, validateAppSettings, validateSensorConfig } from '../public/display/config/input-settings.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const tmpDirs = [];
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

function fakeClock() {
  let t = 0;
  let seq = 0;
  const list = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => {
        seq += 1;
        list.set(seq, { at: t + ms, fn });
        return seq;
      },
      clearTimeout: (id) => list.delete(id),
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const entry of list) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        list.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    pending: () => list.size,
  };
}

// 가짜 시리얼 backend: open은 테스트가 resolveOpen/failOpen으로 끝낸다.
function fakeBackend(ports) {
  const opens = [];
  return {
    opens,
    list: async () => ports,
    open(portPath, handlers) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const dev = {
        path: portPath,
        writes: [],
        closed: false,
        send: (text) => handlers.onData(Buffer.from(text)),
        drop: (err) => handlers.onClose(err),
      };
      dev.resolveOpen = () => resolve({ write: async (s) => dev.writes.push(s), close: async () => { dev.closed = true; } });
      dev.failOpen = (err) => reject(err);
      opens.push(dev);
      return promise;
    },
  };
}

const CH343 = { path: 'COM4', vendorId: '1A86', productId: '55D3', friendlyName: 'USB-Enhanced-SERIAL CH343 (COM4)' };
const COM1 = { path: 'COM1', friendlyName: '통신 포트(COM1)' };
const presence = (n, dist, ts = 1000) => `{"type":"presence","n":${n},"dist":${dist},"speed":-0.40,"energy":120,"ts":${ts}}\n`;
const hb = (mode = 'speed') => `{"type":"hb","up":10,"frames":100,"baud":9600,"mode":"${mode}","age":40,"ts":10000}\n`;

async function openLink(extra = {}) {
  const clock = fakeClock();
  const backend = fakeBackend([CH343, COM1]);
  const frames = [];
  const link = createSerialLink({ backend, now: clock.now, timers: clock.timers, onFrame: (f) => frames.push(f), ...extra });
  await link.connect('COM4');
  await flush();
  const dev = backend.opens.at(-1);
  dev.resolveOpen();
  await flush();
  return { clock, backend, frames, link, dev };
}

test('줄 분할: 나뉜·붙은 조각, CRLF, 긴 줄 버림 후 회복 / 해석: n=0 거리는 버리고 n>0 거리 0·NaN은 거절', () => {
  const lines = [];
  let dropped = 0;
  const sp = createLineSplitter({ maxLineBytes: 64, onLine: (l) => lines.push(l), onDrop: () => { dropped += 1; } });
  sp.push(Buffer.from('{"type":"hb",'));
  sp.push(Buffer.from('"x":1}\r\n{"a":1}\n{"b"'));
  sp.push(Buffer.from(':2}\n'));
  sp.push(Buffer.from('x'.repeat(50)));
  sp.push(Buffer.from('y'.repeat(50)));
  sp.push(Buffer.from('zz\n{"c":3}\n'));
  assert.deepEqual(lines, ['{"type":"hb","x":1}', '{"a":1}', '{"b":2}', '{"c":3}']);
  assert.equal(dropped, 1);

  const ok = parseDeviceLine(presence(1, 0.97).trim());
  assert.equal(ok.valid, true);
  assert.equal(ok.distM, 0.97);
  const none = parseDeviceLine(presence(0, 0).trim());
  assert.deepEqual([none.valid, none.n, none.distM], [true, 0, null]);
  assert.equal(parseDeviceLine(presence(1, 0).trim()).reason, 'zero-distance');
  assert.equal(parseDeviceLine(presence(1, 99).trim()).reason, 'distance-out-of-range');
  assert.equal(parseDeviceLine('{"type":"presence","n":1,"dist":nan,"speed":0,"energy":1,"ts":1}').reason, 'bad-json');
  assert.equal(parseDeviceLine('{"type":"presence","n":1,"dist":"1.0","speed":0,"energy":1,"ts":1}').reason, 'bad-number');
  assert.equal(parseDeviceLine(hb().trim()).mode, 'speed');
  assert.equal(parseDeviceLine('{"type":"log","msg":"cmd applied","ts":5}').msg, 'cmd applied');
  assert.equal(parseDeviceLine('ESP-ROM:esp32s3-20210327').type, 'text');
});

test('안정화: 중앙값이 단발 튐을 막고, n=0은 유예 안에서만 유지, 공백·초기화 뒤 이전 거리를 쓰지 않는다', () => {
  const st = createStabilizer({ medianWindow: 3, absentGraceMs: 350, maxGapMs: 300 });
  const ok = (d, t) => st.push({ status: 'ok', distanceM: d }, t);
  assert.equal(ok(1.0, 0), null); // 창 채우는 중
  assert.equal(ok(1.1, 100), null);
  assert.equal(ok(1.0, 200).distanceM, 1.0);
  assert.equal(ok(0.3, 300).distanceM, 1.0); // 단발 튐(0.3)은 중앙값에 묻힌다
  const none = (t) => st.push({ status: 'no-target' }, t);
  assert.deepEqual(none(400), { status: 'ok', distanceM: 1.0, held: true });
  assert.equal(none(700).held, true); // 300 ms < 350
  assert.equal(none(800).status, 'no-target'); // 400 ms ≥ 350 → 감지 없음, 창 비움
  assert.equal(ok(0.5, 900), null); // 이전 거리 없이 다시 채운다
  ok(0.5, 1000);
  assert.equal(ok(0.5, 1100).distanceM, 0.5);
  assert.equal(ok(0.5, 1500), null); // 400 ms 공백 → 창을 비우고 다시 채움
  st.reset('settings');
  assert.equal(none(1600).status, 'no-target'); // 초기화 뒤에는 유지할 거리가 없다
  assert.equal(st.snapshot(1600).lastResetReason, 'settings');
});

test('heartbeat는 거리 수신 시각을 갱신하지 않고, 프레임은 설정 처리 중·존재 모드면 오류로 표시된다', async () => {
  const { clock, frames, link, dev } = await openLink();
  dev.send(presence(1, 1.2));
  assert.equal(frames.at(-1).status, 'ok');
  assert.equal(link.snapshot().usable, true);
  clock.advance(1000);
  dev.send(hb());
  clock.advance(1000);
  dev.send(hb());
  const snap = link.snapshot();
  assert.equal(snap.device.frameAgoMs, 2000); // hb 두 번에도 마지막 거리 프레임 경과는 그대로
  assert.equal(snap.device.hb.agoMs, 0);
  dev.send('{"type":"exist","exist":1,"ts":5}\n');
  assert.deepEqual([frames.at(-1).status, frames.at(-1).reason], ['error', 'not-distance-mode']);
  assert.equal(link.snapshot().usable, false);
  dev.send(presence(0, 0));
  assert.equal(frames.at(-1).status, 'no-target');
  dev.send('garbage-without-newline'.repeat(40) + '\n');
  assert.equal(link.snapshot().device.counts.dropped, 1);
});

test('연결: 목록 밖 경로 거절, 사용 중이면 Python 툴 안내 후 재시도, 수동 해제는 재연결을 취소하고 늦게 열린 핸들은 닫는다', async () => {
  const clock = fakeClock();
  const backend = fakeBackend([CH343, COM1]);
  const link = createSerialLink({ backend, now: clock.now, timers: clock.timers, reconnectMs: 3000 });
  const bad = await link.connect('C:/Windows/notepad.exe');
  assert.equal(bad.code, 'unknown-port');
  assert.equal(backend.opens.length, 0);

  await link.connect('COM4');
  await flush();
  backend.opens[0].failOpen(new Error('Opening COM4: Access denied'));
  await flush();
  let snap = link.snapshot();
  assert.equal(snap.error.kind, 'busy');
  assert.match(snap.error.message, /Python 센서 툴/);
  assert.equal(snap.conn, 'retry-wait');
  clock.advance(3000);
  await flush();
  assert.equal(backend.opens.length, 2); // 자동 재시도

  link.disconnect(); // 재시도가 열리는 중에 수동 해제
  backend.opens[1].resolveOpen();
  await flush();
  assert.equal(backend.opens[1].closed, true); // 늦게 열린 핸들은 바로 닫힘
  snap = link.snapshot();
  assert.equal(snap.conn, 'idle');
  clock.advance(10000);
  await flush();
  assert.equal(backend.opens.length, 2); // 더 이상 재연결하지 않음
  assert.equal(clock.pending(), 0);
});

test('자동 선택은 센서 보드 후보가 1개일 때만 열고, 여러 개면 열지 않는다', async () => {
  const one = fakeBackend([COM1, CH343]);
  const linkOne = createSerialLink({ backend: one, timers: fakeClock().timers });
  await linkOne.autoSelect();
  await flush();
  assert.deepEqual(one.opens.map((d) => d.path), ['COM4']);

  const two = fakeBackend([CH343, { ...CH343, path: 'COM7' }, COM1]);
  const linkTwo = createSerialLink({ backend: two, timers: fakeClock().timers });
  await linkTwo.autoSelect();
  await flush();
  assert.equal(two.opens.length, 0);
  assert.match(linkTwo.snapshot().autoNote, /2개/);
});

test('명령: heartbeat 전에는 보내지 않고, 시간 초과 뒤 늦은 응답은 무시되며 새 명령을 완료시키지 않는다', async () => {
  const done = [];
  const { clock, frames, link, dev } = await openLink({ commandTimeoutMs: 10000, onCommandDone: (r) => done.push(r) });
  const cfg = { rangeMinM: 0.3, rangeMaxM: 3, thrFactor: 10, microMotion: false, distanceMode: true };
  assert.equal(link.sendSensorConfig(cfg).code, 'not-ready'); // 연결 직후 hb 전
  assert.equal(dev.writes.length, 0); // 연결만으로는 아무것도 쓰지 않는다
  dev.send(hb());
  assert.equal(link.sendSensorConfig({ ...cfg, rangeMinM: 0.35 }).code, 'invalid');
  assert.equal(link.sendSensorConfig(cfg).ok, true);
  assert.deepEqual(dev.writes, ['cmd setRange 0.3 3.0\n']);
  assert.equal(link.sendSensorConfig(cfg).code, 'busy');
  dev.send(presence(1, 1.0));
  assert.deepEqual([frames.at(-1).status, frames.at(-1).reason], ['error', 'configuring']);
  dev.send('{"type":"log","msg":"cmd applied","ts":1}\n');
  assert.equal(dev.writes.at(-1), 'cmd setThrFactor 10\n');

  clock.advance(10000); // 두 번째 명령 시간 초과
  assert.equal(done.at(-1).result, 'timeout');
  assert.deepEqual(done.at(-1).items.map((i) => i.state), ['acked', 'timeout', 'waiting', 'waiting']);
  assert.equal(link.sendSensorConfig(cfg).code, 'not-ready'); // hb를 받기 전에는 새 명령 금지
  dev.send('{"type":"log","msg":"cmd applied","ts":2}\n'); // 늦은 응답
  assert.equal(link.snapshot().command.ignoredAcks, 1);
  dev.send(hb());
  assert.equal(link.sendSensorConfig(cfg).ok, true);
  for (const _ of [1, 2, 3]) dev.send('{"type":"log","msg":"cmd applied","ts":3}\n');
  assert.equal(dev.writes.at(-1), 'mode 1\n');
  dev.send('{"type":"log","msg":"cmd applied","ts":4}\n'); // mode 1에는 cmd applied가 맞지 않음
  assert.equal(link.snapshot().command.busy, true);
  dev.send('{"type":"log","msg":"mode applied","ts":5}\n');
  assert.equal(done.at(-1).result, 'board-ack');
  assert.equal(link.snapshot().command.busy, false);

  // 처리 중 연결이 끊기면 중단으로 기록하고, 새 연결은 다시 hb를 기다린다.
  link.sendSensorConfig(cfg);
  dev.drop(new Error('USB 분리'));
  assert.equal(done.at(-1).result, 'disconnected');
  assert.equal(link.snapshot().conn, 'retry-wait');
});

test('설정 검증·저장: near+margin<far 위반·모르는 키 거절, 저장값은 다시 읽히고 저장 실패는 적용하지 않는다', async () => {
  const base = defaultAppSettings();
  assert.equal(validateAppSettings(base).ok, true);
  assert.equal(validateAppSettings({ ...base, nearBelowM: 1.2, farAboveM: 1.2 }).ok, false);
  assert.equal(validateAppSettings({ ...base, nearBelowM: 1.15, farAboveM: 1.2, retreatMarginM: 0.05 }).ok, false);
  assert.equal(validateAppSettings({ ...base, medianWindow: 4 }).ok, false);
  assert.equal(validateAppSettings({ ...base, staleMs: 10 }).ok, false);
  assert.equal(validateAppSettings({ ...base, nearBelowM: '0.6' }).ok, false);
  assert.equal(validateSensorConfig({ rangeMinM: 3, rangeMaxM: 0.3, thrFactor: 10, microMotion: false, distanceMode: true }).ok, false);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'hideseek-settings-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'nested', 'settings.json');
  const store = createSettingsStore({ file });
  await store.load();
  assert.equal(store.snapshot().appSource, 'default');
  const next = { ...base, nearBelowM: 0.5, medianWindow: 5 };
  assert.equal((await store.saveApp(next)).ok, true);
  const again = createSettingsStore({ file });
  await again.load();
  assert.deepEqual([again.snapshot().app.nearBelowM, again.snapshot().app.medianWindow, again.snapshot().appSource], [0.5, 5, 'file']);

  const blocker = path.join(dir, 'blocker');
  await writeFile(blocker, 'x');
  const broken = createSettingsStore({ file: path.join(blocker, 'settings.json') }); // 폴더 자리에 파일 → 저장 실패
  const r = await broken.saveApp(next);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'save-failed');
  assert.equal(broken.snapshot().app.nearBelowM, base.nearBelowM); // 메모리에도 적용하지 않음
});

test('API: POST는 같은 origin·JSON만, 잘못된 값은 저장 안 함, SSE는 상태 후 실시간 프레임만(새 연결에 지나간 프레임 없음)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hideseek-api-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'settings.json');
  const store = createSettingsStore({ file });
  await store.load();
  const backend = fakeBackend([CH343]);
  let api = null;
  const link = createSerialLink({
    backend,
    onChange: () => api?.onLinkChange(),
    onFrame: (f) => api?.onFrame(f),
  });
  api = createSensorApi({ link, store });
  const server = http.createServer(createRequestListener({ sensorApi: api, mediaDirs: { seq: dir, pose: dir } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = { Origin: origin, 'Content-Type': 'application/json' }) =>
    fetch(`${origin}/api/sensor/${p}`, { method: 'POST', headers, body: JSON.stringify(body) });

  try {
    assert.equal((await post('app-settings', defaultAppSettings(), { 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await post('app-settings', defaultAppSettings(), { Origin: 'http://evil.example', 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await post('app-settings', defaultAppSettings(), { Origin: origin, 'Content-Type': 'text/plain' })).status, 415);
    const invalid = await post('app-settings', { ...defaultAppSettings(), farAboveM: 0.6 });
    assert.equal(invalid.status, 400);
    await assert.rejects(readFile(file)); // 잘못된 값은 저장하지 않음
    const saved = await post('app-settings', { ...defaultAppSettings(), nearBelowM: 0.55 });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).app.nearBelowM, 0.55);
    assert.equal((await post('connect', { path: '\\\\.\\COM99' })).status, 400);
    assert.equal((await post('config', { rangeMinM: 0.3, rangeMaxM: 3, thrFactor: 10, microMotion: false, distanceMode: true })).status, 409);

    // SSE: 연결 → 프레임 → 두 번째 연결은 상태만(지나간 프레임 없음)
    await post('connect', { path: 'COM4' });
    await flush();
    backend.opens[0].resolveOpen();
    await flush();
    const ac = new AbortController();
    const res = await fetch(`${origin}/api/sensor/events`, { signal: ac.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (pattern) => {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await readUntil(/event: state/);
    backend.opens[0].send(presence(1, 0.8));
    await readUntil(/event: frame/);
    assert.match(text, /"distM":0.8/);

    const ac2 = new AbortController();
    const res2 = await fetch(`${origin}/api/sensor/events`, { signal: ac2.signal });
    const reader2 = res2.body.getReader();
    const first = decoder.decode((await reader2.read()).value);
    assert.match(first, /event: state/);
    assert.doesNotMatch(first, /event: frame/);
    assert.equal(api.clientCount(), 2);
    ac.abort();
    ac2.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(api.clientCount(), 0); // 끊긴 수신자는 정리
  } finally {
    api.close();
    await link.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('검수 수정: 해석되지 않는 JSON 줄도 거절 프레임으로 알리고, 설정 처리 중에는 오류(안전 정지)로 보낸다', async () => {
  const { frames, link, dev } = await openLink();
  dev.send(presence(1, 1.0));
  dev.send('{"type":"presence","n":1,"dist":nan,"speed":0.00,"energy":1,"ts":1}\n');
  assert.deepEqual([frames.at(-1).status, frames.at(-1).reason], ['invalid', 'bad-json']);
  dev.send(hb());
  link.sendSensorConfig({ rangeMinM: 0.3, rangeMaxM: 3, thrFactor: 10, microMotion: false, distanceMode: false });
  dev.send('{"type":"presence",broken\n');
  assert.deepEqual([frames.at(-1).status, frames.at(-1).reason], ['error', 'configuring']);
});

test('검수 수정: 포트 목록 조회를 기다리는 연결·자동 선택은 그 사이 해제·후속 요청·종료로 취소된다', async () => {
  // 목록 조회를 테스트가 끝내는 backend
  const deferredBackend = () => {
    const base = fakeBackend([CH343, { ...CH343, path: 'COM7', vendorId: '0000' }, COM1]);
    const pending = [];
    base.list = () => new Promise((resolve) => pending.push(() => resolve([CH343, { ...CH343, path: 'COM7', vendorId: '0000' }, COM1])));
    return { base, pending };
  };

  // 연결 요청 직후 해제 → 늦은 목록 조회가 want를 되살리지 않는다
  let { base, pending } = deferredBackend();
  let link = createSerialLink({ backend: base, timers: fakeClock().timers });
  const late = link.connect('COM4');
  link.disconnect();
  pending.shift()();
  assert.equal((await late).code, 'superseded');
  await flush();
  assert.deepEqual([base.opens.length, link.snapshot().want, link.snapshot().conn], [0, false, 'idle']);

  // 앞 연결의 목록 조회가 늦게 끝나도 후속 연결(COM7)만 연다
  ({ base, pending } = deferredBackend());
  link = createSerialLink({ backend: base, timers: fakeClock().timers });
  const first = link.connect('COM4');
  const second = link.connect('COM7');
  pending.pop()(); // 후속 요청의 조회가 먼저 끝남
  assert.equal((await second).ok, true);
  pending.shift()();
  assert.equal((await first).code, 'superseded');
  await flush();
  assert.deepEqual(base.opens.map((d) => d.path), ['COM7']);
  assert.equal(link.snapshot().selected, 'COM7');

  // 자동 선택 조회 중 해제·종료 → 열지 않는다
  for (const cancel of ['disconnect', 'shutdown']) {
    ({ base, pending } = deferredBackend());
    link = createSerialLink({ backend: base, timers: fakeClock().timers });
    const auto = link.autoSelect();
    if (cancel === 'disconnect') link.disconnect();
    else await link.shutdown();
    pending.shift()();
    await auto;
    await flush();
    assert.equal(base.opens.length, 0, cancel);
    assert.equal(link.snapshot().want, false, cancel);
  }
});
