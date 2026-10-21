// 로컬 서버의 요청 처리(listen하지 않음 — 테스트가 import해 쓴다). 실행 진입점은 server/server.js.
//
// 제공 범위:
//   - public/ 아래 정적 파일(숨김·상위 경로 차단).
//   - /vendor/three/ 아래는 node_modules/three/build/의 고정 두 파일만(three.module.js, three.core.js). node_modules 전체는 제공하지 않는다.
//   - /media/ 아래는 server/media.js의 고정 allowlist만(기본 public/display/assets/의 영상·정지 이미지, Range 지원).

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMedia, resolveMediaDirs } from './media.js';

export const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
export const THREE_BUILD_DIR = path.resolve(fileURLToPath(new URL('../node_modules/three/build/', import.meta.url)));
export const ENTRY_PATH = '/display/';

// /vendor/three/ 주소 → three/build/ 파일. three.module.js가 ./three.core.js를 불러오므로 둘만 연다.
const VENDOR_FILES = Object.freeze({
  '/vendor/three/three.module.js': 'three.module.js',
  '/vendor/three/three.core.js': 'three.core.js',
});

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
  '.txt': 'text/plain; charset=utf-8',
};

export function sendText(res, req, status, message, headers = {}) {
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

async function sendStaticFile(req, res, filePath, info) {
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

async function fileInfo(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

// options: { mediaDirs: { seq, pose } } — 없으면 환경 변수·기본 경로(server/media.js).
export function createHandler({ mediaDirs = resolveMediaDirs(), threeDir = THREE_BUILD_DIR } = {}) {
  return async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, req, 405, '허용하지 않는 요청 방식입니다.', { Allow: 'GET, HEAD' });
      return;
    }

    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (pathname === '/') {
      sendText(res, req, 302, `${ENTRY_PATH}로 이동합니다.`, { Location: ENTRY_PATH });
      return;
    }

    if (await handleMedia(req, res, pathname, mediaDirs, sendText)) return;

    if (pathname.startsWith('/vendor/')) {
      const name = Object.hasOwn(VENDOR_FILES, pathname) ? VENDOR_FILES[pathname] : null;
      const filePath = name === null ? null : path.join(threeDir, name);
      const info = filePath === null ? null : await fileInfo(filePath);
      if (!info || !info.isFile()) {
        sendText(res, req, 404, '찾을 수 없습니다.');
        return;
      }
      await sendStaticFile(req, res, filePath, info);
      return;
    }

    let filePath = resolvePublicPath(pathname);
    if (!filePath) {
      sendText(res, req, 404, '찾을 수 없습니다.');
      return;
    }
    let info = await fileInfo(filePath);
    if (info?.isDirectory()) {
      if (!pathname.endsWith('/')) {
        sendText(res, req, 301, '폴더 주소로 이동합니다.', { Location: `${pathname}/` });
        return;
      }
      filePath = path.join(filePath, 'index.html');
      info = await fileInfo(filePath);
    }
    if (!info || !info.isFile()) {
      sendText(res, req, 404, '찾을 수 없습니다.');
      return;
    }
    await sendStaticFile(req, res, filePath, info);
  };
}

// 요청 처리 예외를 500으로 바꾸는 http 요청 함수.
export function createRequestListener(options) {
  const handle = createHandler(options);
  return (req, res) => {
    handle(req, res).catch((err) => {
      console.error('요청 처리 중 오류:', err);
      if (!res.headersSent) sendText(res, req, 500, '서버 오류입니다.');
      else res.destroy();
    });
  };
}
