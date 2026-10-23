// 로컬 서버 실행 진입점: 127.0.0.1에서 public/·three 고정 파일·미디어 allowlist·센서 API를 제공한다(요청 처리는 server/app.js).
// mmWave 센서 보드(ESP32 USB 시리얼 115200 JSON 줄)를 이 서버가 직접 읽어 같은 origin SSE로 표시 페이지에 보낸다(server/sensor/).
// 실행: npm start (PORT 환경 변수로 포트 변경, 기본 8091, 0이면 빈 포트 자동 선택. SEQ_DIR·POSE_DIR로 미디어 폴더 변경, 기본은 public/display/assets/)

import { access } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { ENTRY_PATH, THREE_BUILD_DIR, createRequestListener } from './app.js';
import { MEDIA_ENV, resolveMediaDirs } from './media.js';
import { createSensorApi } from './sensor/api.js';
import { loadSerialBackend } from './sensor/serial-backend.js';
import { createSerialLink } from './sensor/serial-link.js';
import { createSettingsStore } from './sensor/settings-store.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8091;

function parsePort(raw) {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return port <= 65535 ? port : null;
}

const port = parsePort(process.env.PORT);
if (port === null) {
  console.error(`PORT 값이 올바르지 않습니다: "${process.env.PORT}". 0~65535 사이의 정수를 지정하세요.`);
  process.exit(1);
}

const mediaDirs = resolveMediaDirs();
for (const [root, dir] of Object.entries(mediaDirs)) {
  try {
    await access(dir);
  } catch {
    console.warn(`[경고] 미디어 폴더를 찾지 못했습니다(${MEDIA_ENV[root]}): ${dir} — 이 폴더의 /media/ 주소는 404입니다.`);
  }
}
try {
  await access(path.join(THREE_BUILD_DIR, 'three.module.js'));
} catch {
  console.warn('[경고] node_modules/three/build/를 찾지 못했습니다. 화면을 그릴 수 없습니다. npm ci를 실행하세요.');
}

// ── mmWave 센서(ESP32 USB 시리얼) — 이 서버가 직접 읽는다. Python 툴·WebSocket 8765가 필요 없다 ──
const store = createSettingsStore();
await store.load();
const settingsInfo = store.snapshot();
if (settingsInfo.loadError) console.warn(`[경고] ${settingsInfo.loadError}`);

let backend;
try {
  backend = await loadSerialBackend();
} catch (err) {
  console.warn(`[경고] serialport 모듈을 불러오지 못했습니다(npm ci 필요). 실센서 연결 없이 시작합니다: ${err.message}`);
  const unavailable = async () => {
    throw new Error('serialport 모듈 없음 — npm ci 후 서버를 다시 시작하세요');
  };
  backend = { list: unavailable, open: unavailable };
}

let sensorApi = null;
const link = createSerialLink({
  backend,
  onChange: () => sensorApi?.onLinkChange(),
  onFrame: (frame) => sensorApi?.onFrame(frame),
  onCommandDone: (record) => sensorApi?.onCommandDone(record),
});
sensorApi = createSensorApi({ link, store });

const server = http.createServer(createRequestListener({ mediaDirs, sensorApi }));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`포트 ${port}이(가) 이미 사용 중입니다. 다른 포트를 쓰려면 PORT 환경 변수를 지정하세요(예: PORT=8092 npm start).`);
  } else if (err.code === 'EACCES') {
    console.error(`포트 ${port}을(를) 열 권한이 없습니다. 다른 포트를 지정하세요.`);
  } else {
    console.error('서버를 시작하지 못했습니다:', err.message);
  }
  process.exit(1);
});

server.listen(port, HOST, () => {
  const { port: actualPort } = server.address();
  console.log(`숨바꼭질 표시 페이지: http://${HOST}:${actualPort}${ENTRY_PATH} (개발 패널: ?debug=1 또는 D 키)`);
  console.log(`영상 폴더(SEQ_DIR): ${mediaDirs.seq}`);
  console.log(`정지 이미지 폴더(POSE_DIR): ${mediaDirs.pose}`);
  console.log(`패널 설정 파일: ${settingsInfo.file}`);
  console.log('종료하려면 Ctrl+C를 누르세요.');
  // 알려진 센서 보드 후보가 1개일 때만 자동으로 연다(명령은 보내지 않음). 여러 개·없음이면 패널에서 고른다.
  link.autoSelect().then(() => {
    const s = link.snapshot();
    console.log(`[센서] ${s.autoNote ?? s.portsError ?? '-'}`);
  });
});

// 종료 때 시리얼 포트·SSE 연결·타이머를 정리한다.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  sensorApi.close();
  await Promise.race([link.shutdown(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  server.close();
  server.closeAllConnections?.();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
