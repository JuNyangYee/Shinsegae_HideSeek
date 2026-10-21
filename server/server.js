// 로컬 서버 실행 진입점: 127.0.0.1에서 public/·three 고정 파일·외부 미디어 allowlist를 제공한다(요청 처리는 server/app.js).
// 실행: npm start (PORT 환경 변수로 포트 변경, 기본 8091, 0이면 빈 포트 자동 선택. SEQ_DIR·POSE_DIR로 미디어 폴더 변경)

import { access } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { ENTRY_PATH, THREE_BUILD_DIR, createRequestListener } from './app.js';
import { MEDIA_ENV, resolveMediaDirs } from './media.js';

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

const server = http.createServer(createRequestListener({ mediaDirs }));

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
  console.log('종료하려면 Ctrl+C를 누르세요.');
});
