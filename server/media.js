// 미디어 제공: 실행용 영상·정지 이미지를 고정 allowlist로만 /media/... 주소에 연결한다.
// 기본은 저장소에 포함한 public/display/assets/ 아래 원본 사본(변환 없음). 환경 변수로 다른 폴더를 가리킬 수 있다.
// 폴더 목록·allowlist 밖 파일·상위 경로·심볼릭 링크로 바깥을 가리키는 파일은 404.
// 영상 탐색을 위해 HEAD와 단일 bytes Range(206 / 416)를 지원한다.

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 기본 경로: 이 파일 위치 기준(프로젝트 폴더를 옮기거나 다른 cwd에서 실행해도 같다). 환경 변수로 덮어씀.
export const DEFAULT_MEDIA_DIRS = Object.freeze({
  seq: path.resolve(fileURLToPath(new URL('../public/display/assets/seq/', import.meta.url))),
  pose: path.resolve(fileURLToPath(new URL('../public/display/assets/pose/', import.meta.url))),
});

// 환경 변수 이름(폴더 묶음 → 변수).
export const MEDIA_ENV = Object.freeze({ seq: 'SEQ_DIR', pose: 'POSE_DIR' });

// 주소 → { root: 폴더 묶음, file: 그 폴더 바로 아래 파일 이름 }. 이 표에 없는 주소는 모두 404.
// SC1b_Glance.mp4는 아직 제공되지 않아 넣지 않았다(생기면 여기와 public/display/config/settings.js에 함께 추가).
const ALLOWLIST = Object.freeze({
  '/media/seq/SC0A_Pat.mp4': { root: 'seq', file: 'SC0A_Pat.mp4' },
  '/media/seq/SC0B_Roll.mp4': { root: 'seq', file: 'SC0B_Roll.mp4' },
  '/media/seq/SC0C_Playful.mp4': { root: 'seq', file: 'SC0C_Playful.mp4' },
  '/media/seq/SC1_Notice.mp4': { root: 'seq', file: 'SC1_Notice.mp4' },
  '/media/seq/SC2_Duck.mp4': { root: 'seq', file: 'SC2_Duck.mp4' },
  // SC3(너구리 빼꼼)는 사용자 요청(2026-10-21)으로 재생하지 않는다. 원본 보존용으로 주소만 남긴다(표시 페이지는 요청하지 않음).
  '/media/seq/SC3_Hidden_Clue.mp4': { root: 'seq', file: 'SC3_Hidden_Clue.mp4' },
  '/media/seq/SC4_Return_To_Play.mp4': { root: 'seq', file: 'SC4_Return_To_Play.mp4' },
  // SC4 원본 프레임을 역순으로 인코딩한 파생 영상(복귀 도중 다시 숨기). 원본 7개와 함께 SEQ_DIR에 있어야 한다.
  '/media/seq/SC4_Return_To_Play_Reverse.mp4': { root: 'seq', file: 'SC4_Return_To_Play_Reverse.mp4' },
  '/media/pose/H_Hidden.png': { root: 'pose', file: 'H_Hidden.png' },
});

export const MEDIA_PATHS = Object.freeze(Object.keys(ALLOWLIST));

const MEDIA_TYPES = { '.mp4': 'video/mp4', '.png': 'image/png' };

// env → { seq, pose } 절대 경로. 환경 변수의 상대 경로는 실행 cwd 기준으로 푼다.
export function resolveMediaDirs(env = process.env) {
  const out = {};
  for (const [root, name] of Object.entries(MEDIA_ENV)) {
    const raw = env[name];
    out[root] = path.resolve(raw === undefined || raw === '' ? DEFAULT_MEDIA_DIRS[root] : raw);
  }
  return out;
}

// 주소(디코딩 전 pathname) → allowlist 항목 또는 null. 디코딩한 뒤 표와 **글자 그대로** 같아야 한다.
export function lookupMedia(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  return Object.hasOwn(ALLOWLIST, decoded) ? ALLOWLIST[decoded] : null;
}

// allowlist 항목 → 실제 파일 경로. 심볼릭 링크를 풀어 실제 위치가 그 폴더 바로 아래 같은 이름의 일반 파일일 때만. 아니면 null.
export async function resolveMediaFile(entry, dirs) {
  const root = dirs[entry.root];
  if (!root) return null;
  try {
    const realRoot = await realpath(root);
    const realFile = await realpath(path.join(root, entry.file));
    if (path.dirname(realFile) !== realRoot || path.basename(realFile) !== entry.file) return null;
    const info = await stat(realFile);
    return info.isFile() ? { filePath: realFile, size: info.size, mtime: info.mtime } : null;
  } catch {
    return null;
  }
}

// Range 헤더 → { start, end } | 'unsatisfiable' | null(무시하고 전체). 단일 bytes 범위만 다룬다. 여러 범위·형식 오류는 무시(전체 200).
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, a, b] = match;
  if (a === '' && b === '') return null;
  let start;
  let end;
  if (a === '') {
    // 끝에서 b바이트
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (b !== '' && Number(b) < start) return null; // 형식 오류(끝 < 시작)는 무시
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start >= size || size === 0) return 'unsatisfiable';
  return { start, end };
}

// 미디어 요청 처리. 처리했으면 true(응답 완료), allowlist 주소가 아니면 false(부르는 쪽이 다른 경로로).
export async function handleMedia(req, res, pathname, dirs, sendText) {
  if (!pathname.startsWith('/media/')) return false;
  const entry = lookupMedia(pathname);
  const found = entry ? await resolveMediaFile(entry, dirs) : null;
  if (!found) {
    sendText(res, req, 404, '찾을 수 없습니다.');
    return true;
  }
  const { filePath, size, mtime } = found;
  const type = MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const common = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Last-Modified': mtime.toUTCString(),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  // If-Range(검증 값)는 다루지 않으므로 함께 오면 범위를 무시하고 전체를 보낸다.
  const range = req.headers['if-range'] === undefined ? parseRange(req.headers.range, size) : null;
  if (range === 'unsatisfiable') {
    sendText(res, req, 416, '요청한 범위를 제공할 수 없습니다.', { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
    return true;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, {
    ...common,
    'Content-Length': length,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return true;
  }
  createReadStream(filePath, { start, end })
    .on('error', () => res.destroy())
    .pipe(res);
  return true;
}
