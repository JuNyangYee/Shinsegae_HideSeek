// 센서 API(같은 로컬 서버, /api/sensor/…). 서버 → 브라우저는 SSE(EventSource), 조작은 JSON POST.
//
//   GET  /api/sensor/state            연결·장치·명령·설정 상태
//   GET  /api/sensor/events           SSE: event state(상태, 변경 때와 1초마다) / event frame(센서 프레임, 받을 때마다)
//   POST /api/sensor/ports/refresh    포트 목록 새로고침
//   POST /api/sensor/connect          { path } — 목록에 있는 포트만
//   POST /api/sensor/disconnect       {} — 자동 재연결도 취소
//   POST /api/sensor/app-settings     앱 판정 설정 전체 — 검증·저장 성공 때만 적용
//   POST /api/sensor/config           센서 자체 설정 희망값 — 고정 명령만 순차 전송
//
// 보호(로컬 개발 서버 범위): Host가 loopback이어야 하고, POST는 같은 origin(Origin 헤더 일치)·application/json·작은 본문·허용 키만.
// 별도 인증은 없다. 지나간 프레임을 새 SSE 연결에 다시 보내지 않는다(새 연결은 상태만 받고, 프레임은 그 뒤 실제로 받은 것만).

import { validateAppSettings, validateSensorConfig } from '../../public/display/config/input-settings.js';

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/i;

export function createSensorApi({
  link,
  store,
  maxBodyBytes = 4096,
  maxClients = 8,
  maxBufferedBytes = 256 * 1024, // 이보다 많이 밀린 느린 수신자는 끊는다(EventSource가 다시 연결한다)
  stateIntervalMs = 1000,
  timers = { setInterval, clearInterval },
}) {
  const clients = new Set();
  let stateTimer = null;
  let recordError = null;

  function fullState() {
    return { link: link.snapshot(), settings: { ...store.snapshot(), recordError } };
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(text);
  }

  const fail = (res, status, code, message) => sendJson(res, status, { ok: false, code, message });

  // ── SSE ──
  function write(client, chunk) {
    if (client.res.destroyed) {
      drop(client);
      return;
    }
    if (client.res.writableLength > maxBufferedBytes) {
      drop(client);
      client.res.destroy();
      return;
    }
    client.res.write(chunk);
  }

  function drop(client) {
    clients.delete(client);
    if (clients.size === 0 && stateTimer !== null) {
      timers.clearInterval(stateTimer);
      stateTimer = null;
    }
  }

  function broadcast(event, data) {
    if (clients.size === 0) return;
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...clients]) write(client, chunk);
  }

  const broadcastState = () => broadcast('state', fullState());

  function openEvents(req, res) {
    if (clients.size >= maxClients) {
      fail(res, 503, 'too-many-clients', '센서 이벤트 연결이 너무 많습니다.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    const client = { res };
    clients.add(client);
    const cleanup = () => drop(client);
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    write(client, `retry: 2000\nevent: state\ndata: ${JSON.stringify(fullState())}\n\n`);
    // 1초마다 상태(경과 시간 갱신·연결 유지). 끊김·재연결 대기 중에도 화면 표시가 멈추지 않게.
    if (stateTimer === null) stateTimer = timers.setInterval(broadcastState, stateIntervalMs);
  }

  // ── POST 본문 ──
  function readJson(req) {
    return new Promise((resolve) => {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        resolve({ error: [413, 'too-large', '요청 본문이 너무 큽니다.'] });
        req.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      let done = false;
      req.on('data', (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > maxBodyBytes) {
          done = true;
          resolve({ error: [413, 'too-large', '요청 본문이 너무 큽니다.'] });
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const body = text === '' ? {} : JSON.parse(text);
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            resolve({ error: [400, 'bad-json', 'JSON 객체가 아닙니다.'] });
          } else resolve({ body });
        } catch {
          resolve({ error: [400, 'bad-json', 'JSON 형식이 올바르지 않습니다.'] });
        }
      });
      req.on('error', () => {
        if (done) return;
        done = true;
        resolve({ error: [400, 'bad-request', '요청을 읽지 못했습니다.'] });
      });
    });
  }

  // POST 보호: 같은 origin(브라우저가 보내는 Origin이 이 서버 주소와 같아야 함) + JSON.
  function postGuard(req) {
    const origin = req.headers.origin;
    if (origin !== `http://${req.headers.host}`) return [403, 'bad-origin', '같은 주소의 페이지에서만 바꿀 수 있습니다.'];
    const type = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!type.startsWith('application/json')) return [415, 'bad-type', 'application/json 요청만 받습니다.'];
    return null;
  }

  const onlyKeys = (body, keys) => Object.keys(body).every((k) => keys.includes(k));

  const ROUTES = {
    'GET /api/sensor/state': async (req, res) => sendJson(res, 200, { ok: true, ...fullState() }),
    'GET /api/sensor/events': async (req, res) => openEvents(req, res),

    'POST /api/sensor/ports/refresh': async (req, res, body) => {
      if (!onlyKeys(body, [])) return fail(res, 400, 'bad-keys', '허용하지 않는 항목이 있습니다.');
      await link.refreshPorts();
      return sendJson(res, 200, { ok: true, ...fullState() });
    },

    'POST /api/sensor/connect': async (req, res, body) => {
      if (!onlyKeys(body, ['path']) || typeof body.path !== 'string' || body.path.length > 64) {
        return fail(res, 400, 'bad-path', '포트 경로가 올바르지 않습니다.');
      }
      const result = await link.connect(body.path);
      if (!result.ok) return fail(res, 400, result.code, result.message);
      return sendJson(res, 200, { ok: true, ...fullState() });
    },

    'POST /api/sensor/disconnect': async (req, res, body) => {
      if (!onlyKeys(body, [])) return fail(res, 400, 'bad-keys', '허용하지 않는 항목이 있습니다.');
      link.disconnect();
      return sendJson(res, 200, { ok: true, ...fullState() });
    },

    'POST /api/sensor/app-settings': async (req, res, body) => {
      const checked = validateAppSettings(body);
      if (!checked.ok) return sendJson(res, 400, { ok: false, code: 'invalid', message: checked.errors.join(' '), errors: checked.errors });
      const saved = await store.saveApp(checked.value);
      if (!saved.ok) return sendJson(res, 500, { ok: false, code: saved.code, message: saved.errors.join(' '), errors: saved.errors });
      broadcastState();
      return sendJson(res, 200, { ok: true, app: saved.value, ...fullState() });
    },

    'POST /api/sensor/config': async (req, res, body) => {
      const checked = validateSensorConfig(body);
      if (!checked.ok) return sendJson(res, 400, { ok: false, code: 'invalid', message: checked.errors.join(' '), errors: checked.errors });
      // 보낼 수 있는 상태인지 먼저 본 뒤(연결·처리 중·heartbeat) 희망값을 저장하고 보낸다.
      const snap = link.snapshot();
      if (snap.conn !== 'open') return fail(res, 409, 'not-connected', '센서 보드가 연결되어 있지 않습니다.');
      if (snap.command.busy) return fail(res, 409, 'busy', '이전 센서 명령을 처리하는 중입니다.');
      const saved = await store.saveSensorDesired(checked.value);
      if (!saved.ok) return sendJson(res, 500, { ok: false, code: saved.code, message: saved.errors.join(' ') });
      const sent = link.sendSensorConfig(checked.value);
      if (!sent.ok) return fail(res, 409, sent.code, `${sent.message} (희망값은 저장됨, 보내지 않음)`);
      return sendJson(res, 202, { ok: true, id: sent.id, ...fullState() });
    },
  };

  // /api/ 요청 처리. 처리했으면 true.
  async function handle(req, res, pathname) {
    if (!LOOPBACK_HOST.test(String(req.headers.host ?? ''))) {
      fail(res, 403, 'bad-host', '로컬 주소(127.0.0.1)로만 접근할 수 있습니다.');
      return true;
    }
    const route = ROUTES[`${req.method} ${pathname}`];
    if (!route) {
      const known = Object.keys(ROUTES).some((k) => k.endsWith(` ${pathname}`));
      if (known) fail(res, 405, 'bad-method', '허용하지 않는 요청 방식입니다.');
      else fail(res, 404, 'not-found', '찾을 수 없습니다.');
      return true;
    }
    if (req.method === 'POST') {
      const guard = postGuard(req);
      if (guard) {
        req.resume();
        fail(res, ...guard);
        return true;
      }
      const { body, error } = await readJson(req);
      if (error) {
        fail(res, ...error);
        return true;
      }
      await route(req, res, body);
      return true;
    }
    await route(req, res);
    return true;
  }

  // 연결 관리 모듈 콜백에 잇는다.
  function onLinkChange() {
    broadcastState();
  }

  function onFrame(frame) {
    broadcast('frame', frame);
  }

  async function onCommandDone(record) {
    recordError = await store.recordSensorSend(record);
    broadcastState();
  }

  function close() {
    if (stateTimer !== null) timers.clearInterval(stateTimer);
    stateTimer = null;
    for (const client of [...clients]) {
      clients.delete(client);
      client.res.end();
    }
  }

  return { handle, onLinkChange, onFrame, onCommandDone, close, clientCount: () => clients.size };
}
