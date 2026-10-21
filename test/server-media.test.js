import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createRequestListener } from '../server/app.js';
import { MEDIA_PATHS, parseRange } from '../server/media.js';
import { SETTINGS } from '../public/display/config/settings.js';

// 임시 폴더에 가짜 미디어를 만들고 이 테스트 안에서만 임시 포트로 서버를 띄운다(앱 서버를 따로 실행하지 않음).
let dir;
let server;
let base;
const BODY = Buffer.from('0123456789abcdefghij'); // 20바이트

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'hideseek-media-'));
  const seq = path.join(dir, 'seq');
  const pose = path.join(dir, 'pose');
  await mkdir(seq);
  await mkdir(pose);
  await writeFile(path.join(seq, 'SC0A_Pat.mp4'), BODY);
  await writeFile(path.join(seq, 'secret.txt'), 'no');
  await writeFile(path.join(dir, 'outside.mp4'), 'outside');
  await writeFile(path.join(pose, 'H_Hidden.png'), 'png');
  server = http.createServer(createRequestListener({ mediaDirs: { seq, pose } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const get = (url, headers = {}, method = 'GET') => fetch(`${base}${url}`, { method, headers, redirect: 'manual' });

test('allowlist 영상은 200·Accept-Ranges, 단일 Range는 206, 범위 밖은 416, HEAD는 본문 없음', async () => {
  const full = await get('/media/seq/SC0A_Pat.mp4');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), BODY);

  const part = await get('/media/seq/SC0A_Pat.mp4', { Range: 'bytes=2-5' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-5/20');
  assert.equal(await part.text(), '2345');

  const tail = await get('/media/seq/SC0A_Pat.mp4', { Range: 'bytes=-3' });
  assert.equal(tail.status, 206);
  assert.equal(await tail.text(), 'hij');

  const outOfRange = await get('/media/seq/SC0A_Pat.mp4', { Range: 'bytes=20-' });
  assert.equal(outOfRange.status, 416);
  assert.equal(outOfRange.headers.get('content-range'), 'bytes */20');

  const head = await get('/media/seq/SC0A_Pat.mp4', { Range: 'bytes=0-9' }, 'HEAD');
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  assert.deepEqual(parseRange('bytes=0-1,4-5', 20), null); // 여러 범위는 무시(전체)
});

test('allowlist 밖 파일·상위 경로·인코딩 우회·폴더·docs·node_modules는 404', async () => {
  for (const url of [
    '/media/seq/secret.txt',
    '/media/seq/',
    '/media/',
    '/media/seq/..%2Foutside.mp4',
    '/media/seq/%2e%2e/outside.mp4',
    '/media/seq/SC0A_Pat.mp4%00',
    '/media/seq/sc0a_pat.mp4',
    '/media/seq/SC1_Notice.mp4', // allowlist에 있지만 폴더에 없음
    '/docs/PROJECT.md',
    '/node_modules/three/package.json',
    '/vendor/three/three.cjs',
    '/vendor/three/../package.json',
  ]) {
    const res = await get(url);
    assert.equal(res.status, 404, url);
  }
  assert.equal((await get('/vendor/three/three.module.js')).status, 200);
});

test('심볼릭 링크로 폴더 밖을 가리키는 allowlist 이름은 404', async (t) => {
  try {
    // H_Hidden.png 자리를 폴더 밖 파일을 가리키는 링크로 바꾼다.
    await rm(path.join(dir, 'pose', 'H_Hidden.png'));
    await symlink(path.join(dir, 'outside.mp4'), path.join(dir, 'pose', 'H_Hidden.png'));
  } catch (error) {
    t.skip(`심볼릭 링크를 만들 수 없음(${error.code})`);
    return;
  }
  assert.equal((await get('/media/pose/H_Hidden.png')).status, 404);
});

test('표시 페이지의 영상·정지 이미지 주소는 모두 서버 allowlist에 있다', () => {
  const { clips } = SETTINGS.sequence;
  for (const def of Object.values(clips)) {
    if (def.file) assert.ok(MEDIA_PATHS.includes(`${SETTINGS.media.seqBase}${def.file}`), def.file);
  }
  assert.ok(MEDIA_PATHS.includes(SETTINGS.media.safeStillUrl));
});
