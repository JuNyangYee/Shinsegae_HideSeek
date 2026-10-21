import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSeqPlayer, mirrorStartSec } from '../public/display/scene/seq-player.js';

// 재생기의 미리 되감기·표시 보호·취소 경쟁만 확인한다. 실제 디코딩·화면은 브라우저에서 따로 확인한다.
// 가짜 영상: 탐색(currentTime 쓰기)은 finishSeek()를 부를 때까지 끝나지 않는다.
class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.seeking = false;
    this.ended = false;
    this.paused = true;
    this.error = null;
    this.seeks = 0;
    this.playCalls = 0;
    this.time = 0;
  }
  get currentTime() {
    return this.time;
  }
  set currentTime(value) {
    this.time = value;
    this.ended = false;
    this.seeking = true;
    this.seeks += 1;
  }
  becomeReady() {
    this.readyState = 4;
    this.dispatchEvent(new Event('loadeddata'));
  }
  loadMetadata() {
    this.readyState = 1;
    this.dispatchEvent(new Event('loadedmetadata'));
  }
  // 재생이 진행된 것처럼 시각을 옮기고 timeupdate를 보낸다.
  advanceTo(sec) {
    this.time = sec;
    this.dispatchEvent(new Event('timeupdate'));
  }
  finishSeek() {
    this.seeking = false;
    this.dispatchEvent(new Event('seeked'));
  }
  end() {
    this.time = 8;
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event('ended'));
  }
  play() {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
  setAttribute() {}
  removeAttribute() {}
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
// C만 편집 구간(1~3초)이 있다.
const CLIPS = {
  A: { file: 'A.mp4', durationMs: 8000 },
  B: { file: 'B.mp4', durationMs: 8000 },
  C: { file: 'C.mp4', durationMs: 4000, inSec: 1, outSec: 3 },
};

// followDisplay: 표시 변경 알림 때 렌더러가 바로 새 요소로 바꾸고(섞는 이전 요소도 계속 씀) 흉내 낸다(false면 렌더러가 이전 요소를 계속 그림).
function setup({ followDisplay }) {
  const videos = [];
  const events = [];
  let shown = null;
  let fading = null;
  const player = createSeqPlayer({
    clips: CLIPS,
    seqBase: '/media/seq/',
    safeStillUrl: '/media/pose/H.png',
    onFinished: (playId) => events.push(['finished', playId]),
    onError: (playId, reason) => events.push(['error', playId, reason]),
    onDisplayChange: () => {
      if (!followDisplay) return;
      shown = player.display?.element ?? null;
      fading = player.display?.blendFrom ?? null;
    },
    isShown: (element) => element === shown || element === fading,
    createVideoElement: () => {
      const video = new FakeVideo();
      videos.push(video);
      return video;
    },
    createImage: () => ({ removeAttribute() {} }),
  });
  player.preload();
  const [a, b, c] = videos;
  a.becomeReady();
  b.becomeReady();
  return { player, a, b, c, events, setShown: (el) => (shown = el), endFade: () => (fading = null) };
}

test('끝난 영상은 표시가 바뀐 뒤에만 미리 되감고, 되감는 중 재생 차례가 오면 탐색을 기다려 다시 탐색하지 않는다', async () => {
  const { player, a, b, events } = setup({ followDisplay: true });
  player.play({ playId: 1, clip: 'A' });
  await flush();
  assert.equal(player.display.element, a);
  a.end();
  assert.deepEqual(events, [['finished', 1]]);
  await flush();
  assert.equal(a.seeks, 0); // 아직 표시 중인 끝 프레임은 건드리지 않는다

  player.play({ playId: 2, clip: 'B' });
  await flush();
  assert.equal(player.display.element, b);
  assert.equal(b.seeks, 0); // 처음 재생이라 탐색 없음
  assert.deepEqual([a.seeks, a.seeking], [1, true]); // 표시가 B로 바뀐 뒤 A를 미리 되감기 시작

  b.end();
  player.play({ playId: 3, clip: 'A' }); // A가 아직 되감기 중
  await flush();
  assert.equal(a.playCalls, 1); // 탐색이 끝나기 전에는 시작하지 않는다
  assert.equal(player.display.element, b); // 그동안 이전 프레임 유지
  a.finishSeek();
  await flush();
  assert.equal(a.playCalls, 2);
  assert.equal(a.seeks, 1); // 다시 탐색하지 않음
  assert.equal(player.display.element, a);
  const last = player.snapshot(0).transitions.at(-1);
  assert.deepEqual([last.playId, last.waitedRewind, last.seeked], [3, true, false]);
  assert.notEqual(last.prevEndedMs, null);
  assert.equal(b.seeks, 1); // 이번엔 B가 미리 되감긴다
  player.dispose();
});

test('렌더러가 아직 그리는 요소는 미리 되감지 않는다', async () => {
  const { player, a, b, setShown } = setup({ followDisplay: false });
  player.play({ playId: 1, clip: 'A' });
  await flush();
  setShown(a); // 렌더러가 A를 그리는 중
  a.end();
  player.play({ playId: 2, clip: 'B' });
  await flush();
  assert.equal(player.display.element, b);
  assert.equal(a.seeks, 0); // 렌더러가 B로 바꾸기 전이라 A는 그대로
  player.dispose();
});

test('되감기 탐색을 기다리던 재생이 취소되면 늦은 seeked에도 시작·표시 교체·알림이 없다', async () => {
  const { player, a, b, events } = setup({ followDisplay: true });
  player.play({ playId: 1, clip: 'A' });
  await flush();
  a.end();
  player.play({ playId: 2, clip: 'B' });
  await flush();
  b.end(); // A는 되감기 중
  player.play({ playId: 3, clip: 'A' });
  await flush();
  player.cancel(3);
  a.finishSeek();
  await flush();
  assert.equal(a.playCalls, 1);
  assert.equal(player.display.element, b);
  assert.deepEqual(events, [['finished', 1], ['finished', 2]]);
  player.dispose();
});

test('취소 뒤 표시 중인 같은 클립을 다시 재생하면 재생 시작 때 0초로 탐색하고, 탐색이 끝나면 시작한다', async () => {
  const { player, a } = setup({ followDisplay: true });
  player.play({ playId: 1, clip: 'A' });
  await flush();
  a.time = 3; // 재생 도중
  player.cancel(1); // 표시는 A의 멈춘 프레임 그대로
  assert.equal(player.display.element, a);
  player.play({ playId: 2, clip: 'A' });
  await flush();
  assert.deepEqual([a.seeks, a.seeking, a.playCalls], [1, true, 1]); // 명시 탐색 중, 아직 시작 안 함
  a.finishSeek();
  await flush();
  assert.equal(a.playCalls, 2);
  assert.equal(a.seeks, 1);
  assert.equal(player.snapshot(0).transitions.at(-1).seeked, true);
  player.dispose();
});

test('편집 구간: 불러오면 inSec으로 미리 감고, out에 닿으면 멈추고 완료를 한 번만 알리며, 취소 뒤에는 알리지 않는다', async () => {
  const { player, c, events } = setup({ followDisplay: true });
  c.loadMetadata(); // 메타데이터가 오면 시작점(1초)으로 미리 감는다
  assert.deepEqual([c.seeks, c.time, c.seeking], [1, 1, true]);
  c.finishSeek();
  c.becomeReady();
  player.play({ playId: 1, clip: 'C' });
  await flush();
  assert.equal(c.seeks, 1); // 이미 시작점이라 다시 탐색하지 않음
  assert.equal(player.display.element, c);
  c.advanceTo(2.5);
  assert.deepEqual(events, []);
  c.advanceTo(3.01); // out(3초) 도달
  assert.deepEqual([events, c.paused], [[['finished', 1]], true]);
  c.advanceTo(3.2);
  c.end();
  assert.deepEqual(events, [['finished', 1]]); // 뒤늦은 timeupdate·ended로 중복 알림 없음
  assert.equal(player.snapshot(0).transitions.at(-1).endedBy, 'out');

  // 다시 재생: 표시 중이라 미리 감지 않았으니 시작 때 inSec으로 탐색, 그 뒤 취소하면 out에 닿아도 알리지 않는다
  player.play({ playId: 2, clip: 'C' });
  await flush();
  assert.deepEqual([c.seeks, c.time], [2, 1]);
  c.finishSeek();
  await flush();
  player.cancel(2);
  c.advanceTo(3.5);
  assert.deepEqual(events, [['finished', 1]]);
  player.dispose();
});

test('out 확인 타이머: 남은 영상 시간 뒤 실제 시각을 확인하고, 아직이면 다시 잰다(길이만으로 완료하지 않음)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { player, c, events } = setup({ followDisplay: true });
  c.loadMetadata();
  c.finishSeek();
  c.becomeReady();
  player.play({ playId: 1, clip: 'C' });
  await flush();
  t.mock.timers.tick(2000); // 남은 2초가 지났지만 영상 시각은 그대로(멈칫) → 완료 아님
  assert.deepEqual(events, []);
  c.time = 2.9; // timeupdate 없이 시각만 진행
  t.mock.timers.tick(2000);
  assert.deepEqual(events, []);
  c.time = 3.0;
  t.mock.timers.tick(100); // 다시 잰 타이머(남은 0.1초)
  assert.deepEqual(events, [['finished', 1]]);
  player.dispose();
});

test('섞기: 다른 영상으로 넘어가면 이전 영상을 blendFrom으로 넘기고 섞는 동안 되감지 않으며, 같은 영상 재시작·blendMs 0은 섞지 않는다', async () => {
  const { player, a, b, endFade } = setup({ followDisplay: true });
  player.play({ playId: 1, clip: 'A' });
  await flush();
  a.time = 3; // 재생 도중
  player.play({ playId: 2, clip: 'B', blendMs: 200, forced: true }); // 거리 강제 전환
  await flush();
  assert.equal(player.display.element, b);
  assert.deepEqual([player.display.blendFrom, player.display.blendMs], [a, 200]);
  assert.equal(a.seeks, 0); // 섞는 중인 이전 영상은 미리 되감지 않는다
  const last = player.snapshot(0).transitions.at(-1);
  assert.deepEqual([last.forced, last.blended], [true, true]);

  endFade(); // 렌더러가 섞기를 끝냄 → 다음 표시 변경 때 되감긴다
  b.time = 2;
  player.play({ playId: 3, clip: 'B', blendMs: 150 }); // 같은 영상 재시작
  await flush();
  b.finishSeek();
  await flush();
  assert.equal(player.display.blendFrom, null);
  assert.equal(a.seeks, 1);
  player.play({ playId: 4, clip: 'A', blendMs: 0 });
  await flush();
  a.finishSeek();
  await flush();
  assert.equal(player.display.blendFrom, null);
  player.dispose();
});

test('정/역 대응 시각: 보이는 프레임 i ↔ 짝 프레임 (N−1−i), 프레임 가운데 시각(길이−t가 아님)', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(mirrorStartSec(0.5, 169, 24), 156.5 / 24); // SC4 편집 시작(프레임 12, 숨음) ↔ SC4R 프레임 156
  near(mirrorStartSec(6.0, 169, 24), 24.5 / 24); // SC4 편집 끝(프레임 144) ↔ SC4R 프레임 24
  near(mirrorStartSec(13 / 24, 169, 24), 155.5 / 24); // 프레임 경계 시각은 그 프레임으로
  near(mirrorStartSec(3.03, 169, 24), (168 - 72 + 0.5) / 24); // 프레임 72 표시 중
  near(mirrorStartSec(mirrorStartSec(3.03, 169, 24), 169, 24), 72.5 / 24); // 두 번 반전하면 같은 프레임
  near(mirrorStartSec(99, 169, 24), 0.5 / 24); // 범위 밖은 끝 프레임으로
});

// 정/역 짝(F ↔ R, 169프레임 24fps, SC4·SC4R과 같은 편집 구간)과 다른 영상 A.
const MIRROR_CLIPS = {
  A: { file: 'A.mp4', durationMs: 8000 },
  F: { file: 'F.mp4', durationMs: 7042, inSec: 0.5, outSec: 6.0, mirrorOf: 'R', frames: 169, fps: 24, hiddenSec: 0.5 },
  R: { file: 'R.mp4', durationMs: 7042, inSec: 1.0, outSec: 6.5, mirrorOf: 'F', frames: 169, fps: 24, hiddenSec: 6.5 },
};
function setupMirror() {
  const videos = [];
  const events = [];
  let shown = null;
  const player = createSeqPlayer({
    clips: MIRROR_CLIPS,
    seqBase: '/media/seq/',
    safeStillUrl: '/media/pose/H.png',
    onFinished: (playId) => events.push(['finished', playId]),
    onError: (playId, reason) => events.push(['error', playId, reason]),
    onDisplayChange: () => {
      shown = player.display?.element ?? null;
    },
    isShown: (element) => element === shown,
    createVideoElement: () => {
      const video = new FakeVideo();
      videos.push(video);
      return video;
    },
    createImage: () => ({ removeAttribute() {} }),
  });
  player.preload();
  const [a, f, r] = videos;
  for (const v of videos) v.becomeReady();
  return { player, a, f, r, events };
}
// 재생 요청 뒤 탐색이 필요하면 끝내고 재생 시작까지 진행한다.
async function startPlay(player, video, action) {
  player.play(action);
  await flush();
  if (video.seeking) video.finishSeek();
  await flush();
}

test('복귀 도중 반전: 보이는 정방향 프레임의 대응 지점에서 역방향 시작, 준비 중에는 정방향 프레임 유지, 섞지 않음', async (t) => {
  const { player, f, r } = setupMirror();
  t.after(() => player.dispose());
  await startPlay(player, f, { playId: 1, clip: 'F' });
  assert.equal(player.display.element, f);
  assert.deepEqual([r.time, r.seeking], [1, true]); // 정방향 표시 뒤 역방향은 편집 시작점으로 미리 감기는 중
  f.time = 3.03; // 프레임 72가 보이는 중
  player.cancel(1);
  player.play({ playId: 2, clip: 'R', mirror: true, blendMs: 0 });
  await flush();
  assert.equal(r.time, 1); // 미리 감기 탐색이 끝나기를 기다림
  r.finishSeek();
  await flush();
  assert.ok(Math.abs(r.time - 96.5 / 24) < 1e-9); // 그다음 대응 지점(168 − 72 = 96)으로 탐색
  assert.equal(r.seeking, true);
  assert.equal(player.display.element, f); // 역방향이 준비될 때까지 정방향 멈춘 프레임 유지
  assert.equal(f.seeks, 1); // (F 자신의 편집 시작 탐색 1회뿐) 보이는 정방향은 되감지 않음
  r.finishSeek();
  await flush();
  assert.equal(player.display.element, r);
  assert.equal(player.display.blendFrom, null);
  assert.match(player.snapshot(0).transitions.at(-1).mirror, /^F@3\.030 → 4\.021 s$/);
});

test('역방향 준비 중 다시 반전: 아직 보이는 정방향 그 프레임부터 이어 가고, 늦은 역방향 seeked는 무시', async (t) => {
  const { player, f, r, events } = setupMirror();
  t.after(() => player.dispose());
  await startPlay(player, f, { playId: 1, clip: 'F' });
  f.time = 3.03;
  player.cancel(1);
  player.play({ playId: 2, clip: 'R', mirror: true });
  await flush();
  assert.equal(r.seeking, true); // 역방향은 아직 탐색 중(화면에 안 나옴)
  player.cancel(2);
  const seeksBefore = f.seeks;
  player.play({ playId: 3, clip: 'F', mirror: true }); // 보이는 것은 여전히 정방향 프레임 72 → 그 자리에서 이어 감
  await flush();
  assert.deepEqual([f.seeks, f.time, f.playCalls], [seeksBefore, 3.03, 2]); // 이미 그 프레임이라 탐색 없이 바로 재생
  r.finishSeek(); // 취소된 역방향의 늦은 탐색 완료
  await flush();
  assert.equal(player.display.element, f);
  assert.equal(r.playCalls, 0);
  assert.deepEqual(events, []);
});

test('짝이 아직 화면에 나오기 전 반전하면(보이는 것은 숨은 자세) 역방향은 숨은 끝 직전에서 시작한다', async (t) => {
  const { player, a, r } = setupMirror();
  t.after(() => player.dispose());
  await startPlay(player, a, { playId: 1, clip: 'A' }); // 다른 영상이 보이는 중
  player.play({ playId: 2, clip: 'R', mirror: true });
  await flush();
  r.finishSeek(); // 미리 감기 완료
  await flush();
  assert.ok(Math.abs(r.time - (6.5 - 1 / 24)) < 1e-9); // hiddenSec 6.5를 out 한 프레임 전으로
});
