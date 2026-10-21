import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSeqPlayer } from '../public/display/scene/seq-player.js';

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
const CLIPS = { A: { file: 'A.mp4', durationMs: 8000 }, B: { file: 'B.mp4', durationMs: 8000 } };

// followDisplay: 표시 변경 알림 때 렌더러가 바로 새 요소로 바꾼 것처럼 흉내 낸다(false면 렌더러가 이전 요소를 계속 그림).
function setup({ followDisplay }) {
  const videos = [];
  const events = [];
  let shown = null;
  const player = createSeqPlayer({
    clips: CLIPS,
    seqBase: '/media/seq/',
    safeStillUrl: '/media/pose/H.png',
    onFinished: (playId) => events.push(['finished', playId]),
    onError: (playId, reason) => events.push(['error', playId, reason]),
    onDisplayChange: () => {
      if (followDisplay) shown = player.display?.element ?? null;
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
  const [a, b] = videos;
  a.becomeReady();
  b.becomeReady();
  return { player, a, b, events, setShown: (el) => (shown = el) };
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
