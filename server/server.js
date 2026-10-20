// 로컬 정적 서버: public/만 127.0.0.1에서 제공한다. 외부 의존성 없음.
// 실행: npm start (PORT 환경 변수로 포트 변경, 기본 8091, 0이면 빈 포트 자동 선택)

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8091;
const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const ENTRY_PATH = '/display/';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

function parsePort(raw) {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return port <= 65535 ? port : null;
}

function sendText(res, req, status, message, headers = {}) {
  const body = `${message}\n`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// 요청 경로를 public/ 안의 실제 파일 경로로 바꾼다. 허용하지 않는 경로면 null.
function resolvePublicPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  // 숨김 파일·폴더(.env, .git 등)와 상위 경로(..)는 제공하지 않는다.
  if (decoded.split('/').some((segment) => segment.startsWith('.'))) return null;
  const filePath = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) return null;
  return filePath;
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, req, 405, '허용하지 않는 요청 방식입니다.', { Allow: 'GET, HEAD' });
    return;
  }

  const { pathname } = new URL(req.url, `http://${HOST}`);
  if (pathname === '/') {
    sendText(res, req, 302, `${ENTRY_PATH}로 이동합니다.`, { Location: ENTRY_PATH });
    return;
  }

  let filePath = resolvePublicPath(pathname);
  if (!filePath) {
    sendText(res, req, 404, '찾을 수 없습니다.');
    return;
  }

  let info;
  try {
    info = await stat(filePath);
    if (info.isDirectory()) {
      if (!pathname.endsWith('/')) {
        sendText(res, req, 301, '폴더 주소로 이동합니다.', { Location: `${pathname}/` });
        return;
      }
      filePath = path.join(filePath, 'index.html');
      info = await stat(filePath);
    }
  } catch {
    info = null;
  }
  if (!info || !info.isFile()) {
    sendText(res, req, 404, '찾을 수 없습니다.');
    return;
  }

  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': 'no-store', // 개발용: 수정이 바로 보이게
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath)
    .on('error', () => res.destroy())
    .pipe(res);
}

const port = parsePort(process.env.PORT);
if (port === null) {
  console.error(`PORT 값이 올바르지 않습니다: "${process.env.PORT}". 0~65535 사이의 정수를 지정하세요.`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('요청 처리 중 오류:', err);
    if (!res.headersSent) sendText(res, req, 500, '서버 오류입니다.');
    else res.destroy();
  });
});

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
  console.log(`숨바꼭질 표시 페이지: http://${HOST}:${actualPort}${ENTRY_PATH}`);
  console.log('종료하려면 Ctrl+C를 누르세요.');
});
