// 영상 재생기: 시퀀스 코어의 지시(play · cancel · pose)를 실제 <video>·정지 이미지로 실행하고, 완료·오류를 재생 ID와 함께 알린다.
// 화면에 그리지는 않는다 — 지금 보여야 할 요소(display)를 렌더러(scene/stage-renderer.js)가 읽어 그린다.
//
// 규칙(ThrowSnow scene/seq-media.js·seq-scene.js의 취소·정리 방식을 참고해 새로 씀):
//   - 영상은 서버의 /media/seq/ 주소를 그대로 연다(서버가 Range를 지원해 탐색 가능). 음소거 + playsinline으로 자동 재생.
//   - 편집 구간(clips[].inSec·outSec, 원본 파일은 그대로): 재생은 inSec에서 시작하고, 실제 영상 시각(currentTime)이 outSec에 닿으면
//     멈추고 완료로 알린다(outSec이 없으면 'ended'). 확인은 timeupdate와 남은 시간만큼의 한 번짜리 타이머(닿지 않았으면 다시 잼)로 하고,
//     타이머는 시각을 확인할 뿐 길이만으로 성공 처리하지 않는다(timeout은 코어가 오류로 판정). 완료 알림은 재생마다 한 번.
//   - 모든 비동기 단계(준비 대기·탐색·play() 약속)는 재생 토큰을 확인한다. 취소·교체된 재생의 늦은 결과는 알리지 않고,
//     늦게 시작된 영상이 지금 재생이 아니면 바로 멈춘다(숨김·안전 정지 중에 영상이 혼자 진행하지 않게).
//   - 다음 클립이 실제로 재생을 시작할 때까지 이전 화면(멈춘 마지막 프레임 또는 H 정지 이미지)을 그대로 둔다(검은 화면 방지).
//     play의 blendMs > 0이고 지금 보이는 것이 다른 영상이면, 새 영상이 재생을 시작할 때 display에 blendFrom(멈춘 이전 영상)·blendMs를
//     실어 렌더러가 짧게 섞게 한다(새 영상은 그동안에도 재생 — 정지 시간 추가 없음). 섞는 시간은 코어가 정한다(자연 전환 150 ms,
//     거리로 도중에 바꾸는 강제 전환 200 ms, 임시값). 같은 영상 재시작·H 이미지에서 시작은 섞지 않고, 안전 정지(H)는 바로 덮는다.
//   - 불러오기·탐색·재생 오류는 그 재생의 오류로 알린다. 오류가 난 영상 요소는 다음 재생 때 새로 만든다(재시도).
//   - 자동 재생이 막히면(NotAllowedError) 'autoplay-blocked' 오류로 알리고 blocked를 켠다 — 사용자 조작 뒤 clearBlocked()로 푼다.
//   - 안전 정지 이미지(H)는 실패하면 stillRetryMs마다 새 <img>로 다시 불러온다. 시도마다 세대 번호를 두어 이전 시도의 늦은 load·error는 무시한다.
//     준비 전·실패 중에는 렌더러가 가림 화면을 그리고(이전 영상 프레임을 남기지 않음), 부르는 쪽이 stillStatus로 오류를 화면에 알린다.
//   - 전환 대기 줄이기: 표시가 바뀌면 onDisplayChange로 바로 알린다(렌더러가 다음 화면 갱신을 기다리지 않고 첫 그림을 그림).
//     그 뒤 지금 쓰지 않는 영상(표시 중·재생 중·렌더러가 아직 쓰는 요소 — 섞는 중인 이전 영상 포함 — 제외)을 미리 inSec으로
//     되감아 다음 재생 때 탐색 대기를 없앤다. 처음 불러온 영상도 메타데이터가 오면 inSec으로 미리 감는다.
//     미리 되감는 중에 그 영상이 재생 차례가 되면 탐색이 끝나기를 기다린 뒤 시작한다(다시 탐색하지 않음).
//     표시 중인 영상은 건드리지 않는다 — 같은 영상을 다시 재생할 때만(예: 숨은 대기 뒤 SC3) 재생 시작 때 탐색한다.
//   - 진단: 최근 전환마다 이전 클립 끝 → 재생 요청 → 준비(탐색) → 재생 시작(표시 교체) → 첫 영상 프레임 시각을 남긴다.

const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const TRANSITION_LOG = 6; // 진단용으로 남기는 최근 전환 수
const POS_EPS_SEC = 0.02; // 시작 위치 비교 허용(24fps 한 프레임의 절반 미만)
const OUT_TIMER_MIN_MS = 20; // out 확인 타이머 최소 간격

// 편집 구간: inSec(기본 0), outSec(없거나 inSec 이하이면 원본 끝 = null).
export function editRange(def) {
  const inSec = Number.isFinite(def.inSec) && def.inSec > 0 ? def.inSec : 0;
  const outSec = Number.isFinite(def.outSec) && def.outSec > inSec ? def.outSec : null;
  return { inSec, outSec };
}

function mediaErrorText(video) {
  const code = video.error?.code;
  return code === undefined ? 'media-error' : `media-error-${code}`;
}

// onDisplayChange(): display가 바뀐 직후(렌더러가 바로 그리게). isShown(element): 렌더러가 아직 그 요소를 쓰는가(그리는 중·섞는 중 — 미리 되감기 제외).
// createVideoElement·createImage: 테스트에서 가짜 미디어 요소를 넣을 때만 바꾼다.
export function createSeqPlayer({
  clips,
  seqBase,
  safeStillUrl,
  stillRetryMs = 3000,
  onFinished,
  onError,
  onDisplayChange = () => {},
  isShown = () => false,
  now = () => performance.now(),
  createVideoElement = () => document.createElement('video'),
  createImage = () => new Image(),
}) {
  // 클립 이름 → { clip, url, inSec, outSec, video, loads, rewinds, lastError }
  const entries = {};
  for (const [clip, def] of Object.entries(clips)) {
    if (def.file) entries[clip] = { clip, url: `${seqBase}${def.file}`, ...editRange(def), video: null, loads: 0, rewinds: 0, lastError: null };
  }

  let current = null; // 진행 중 재생 토큰 { playId, clip, video, stage, startedMs, listeners }
  let last = null; // 마지막으로 끝난 재생 { playId, clip, outcome, reason, atMs, startedMs }
  let display = null; // 지금 보여야 할 것 { kind: 'video' | 'image', element, clip }
  let blocked = false;
  let disposed = false;
  const transitions = []; // 최근 전환 계측(진단) — 새것이 뒤

  function setDisplay(next) {
    display = next;
    try {
      onDisplayChange();
    } catch (error) {
      console.error('표시 변경 알림 처리 실패:', error); // 그리기 쪽 문제를 재생 오류로 바꾸지 않는다
    }
  }

  // ── 안전 정지 이미지 ──
  const still = { image: null, status: 'loading', gen: 0, attempts: 0, retryTimer: null };
  function loadStill() {
    clearTimeout(still.retryTimer);
    still.retryTimer = null;
    const gen = ++still.gen;
    const previous = still.image;
    if (previous) {
      // 실패한 이전 시도만 여기로 온다(준비된 이미지는 다시 불러오지 않음). 렌더러가 텍스처를 정리하도록 src도 뗀다.
      previous.onload = null;
      previous.onerror = null;
      previous.removeAttribute('src');
    }
    const image = createImage();
    image.onload = () => {
      if (disposed || gen !== still.gen) return; // 이전 시도의 늦은 이벤트
      still.status = 'ready';
    };
    image.onerror = () => {
      if (disposed || gen !== still.gen) return;
      still.status = 'error';
      console.error(`안전 정지 이미지를 불러오지 못했습니다: ${safeStillUrl} — ${stillRetryMs} ms 뒤 다시 시도`);
      still.retryTimer = setTimeout(loadStill, stillRetryMs);
    };
    still.image = image;
    still.status = 'loading';
    still.attempts += 1;
    // 지금 안전 정지 중이면 새 이미지를 보이게 한다(준비될 때까지 렌더러는 가림 화면).
    image.src = safeStillUrl;
    if (display?.kind === 'image') setDisplay({ kind: 'image', element: image, clip: null });
  }
  loadStill();

  // ── 영상 요소 ──
  function releaseVideo(video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  function createVideo(entry) {
    const video = createVideoElement();
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.loop = false;
    video.src = entry.url;
    entry.loads += 1;
    // 처음 불러온 영상도 쓰기 전에 편집 시작점으로 미리 감아 둔다(지금 재생 중이면 rewindIdle이 건너뜀).
    if (entry.inSec > 0) video.addEventListener('loadedmetadata', () => rewindIdle(), { once: true });
    video.load();
    return video;
  }
  // 오류가 난 요소는 버리고 새로 만든다(재시도 때 다시 불러오기).
  function videoFor(entry) {
    if (entry.video && entry.video.error) {
      if (display?.element === entry.video) display = null; // 해제한 요소를 그리지 않게(아래 pose·다음 클립이 채움)
      releaseVideo(entry.video);
      entry.video = null;
    }
    if (!entry.video) entry.video = createVideo(entry);
    return entry.video;
  }

  const isCurrent = (token) => !disposed && current === token;

  // check()가 참이 될 때까지 기다린다(okEvents 중 하나가 올 때마다 다시 확인). 토큰이 바뀌어도 기다림은 끝까지 가지만,
  // 부르는 쪽이 끝난 뒤 토큰을 확인한다.
  function waitUntil(video, okEvents, check) {
    return new Promise((resolve, reject) => {
      if (check()) {
        resolve();
        return;
      }
      const done = (fn, value) => {
        for (const type of okEvents) video.removeEventListener(type, onOk);
        video.removeEventListener('error', onErr);
        fn(value);
      };
      const onOk = () => {
        if (check()) done(resolve);
      };
      const onErr = () => done(reject, new Error(mediaErrorText(video)));
      for (const type of okEvents) video.addEventListener(type, onOk);
      video.addEventListener('error', onErr);
    });
  }

  const atIn = (video, entry) => !video.ended && Math.abs(video.currentTime - entry.inSec) <= POS_EPS_SEC;

  // 지금 쓰지 않는 영상을 미리 편집 시작점(inSec)으로 되감는다(다음 재생 때 탐색 대기 줄이기). 표시 중·재생 중·렌더러가 아직 쓰는 요소,
  // 아직 불러오는 중·탐색 중·오류 난 요소는 건드리지 않는다.
  function rewindIdle() {
    if (disposed) return;
    for (const entry of Object.values(entries)) {
      const video = entry.video;
      if (!video || video.error || video.seeking || video.readyState < HAVE_METADATA) continue;
      if (video === display?.element || video === current?.video || isShown(video)) continue;
      if (atIn(video, entry)) continue;
      video.pause();
      video.currentTime = entry.inSec;
      entry.rewinds += 1;
    }
  }

  function detach(token) {
    for (const [type, fn] of token.listeners) token.video?.removeEventListener(type, fn);
    token.listeners = [];
    clearTimeout(token.outTimer);
    token.outTimer = null;
  }

  // 정상 완료(out 도달 또는 ended) — 재생마다 한 번만 알린다.
  function complete(token, by) {
    if (!isCurrent(token)) return;
    token.metrics.endedBy = by;
    finish(token, 'finished');
    onFinished(token.playId);
  }

  // out 확인: 재생 중인 영상의 실제 시각이 outSec에 닿았으면 그 프레임에서 멈추고 완료한다. 더 확인할 필요가 없으면 true.
  function checkOut(token, entry) {
    if (!isCurrent(token)) return true;
    if (token.stage !== 'playing' || token.video.currentTime < entry.outSec) return false;
    token.video.pause();
    complete(token, 'out');
    return true;
  }
  // 남은 영상 시간만큼 뒤에 한 번 확인한다(닿지 않았으면 다시 잰다). 지속 루프가 아니라 재생마다 몇 번뿐이다.
  function armOut(token, entry) {
    clearTimeout(token.outTimer);
    if (!isCurrent(token)) return;
    const video = token.video;
    const remainingMs = ((entry.outSec - video.currentTime) / (video.playbackRate || 1)) * 1000;
    token.outTimer = setTimeout(() => {
      token.outTimer = null;
      if (!checkOut(token, entry)) armOut(token, entry);
    }, Math.max(OUT_TIMER_MIN_MS, remainingMs));
  }

  function finish(token, outcome, reason = null) {
    detach(token);
    last = { playId: token.playId, clip: token.clip, outcome, reason, atMs: now(), startedMs: token.startedMs };
    if (current === token) current = null;
  }

  function fail(token, reason) {
    if (!isCurrent(token)) return;
    token.video?.pause();
    const entry = entries[token.clip];
    if (entry) entry.lastError = reason;
    finish(token, 'error', reason);
    onError(token.playId, reason);
  }

  async function run(token) {
    const entry = entries[token.clip];
    if (!entry) {
      // 알림은 항상 비동기로(코어가 지시를 처리하는 도중에 다시 들어오지 않게).
      queueMicrotask(() => fail(token, 'no-source'));
      return;
    }
    const video = videoFor(entry);
    token.video = video;
    const m = token.metrics;
    try {
      token.stage = 'loading';
      // 미리 되감기 중이면(seeking) 그 탐색이 끝나기를 기다린다 — loadeddata는 처음 한 번만 오므로 seeked·canplay로도 다시 확인한다.
      if (video.seeking) m.waitedRewind = true;
      await waitUntil(video, ['loadeddata', 'seeked', 'canplay'], () => video.readyState >= HAVE_CURRENT_DATA && !video.seeking);
      if (!isCurrent(token)) return;
      if (!atIn(video, entry)) {
        token.stage = 'seeking';
        m.seeked = true;
        video.pause();
        video.currentTime = entry.inSec; // 여기서 seeking이 켜지고 seeked 때 꺼진다
        await waitUntil(video, ['seeked'], () => !video.seeking);
        if (!isCurrent(token)) return;
      }
      m.readyMs = now();
      const onEnded = () => complete(token, 'ended');
      const onMediaError = () => fail(token, mediaErrorText(video));
      token.listeners = [['ended', onEnded], ['error', onMediaError]];
      if (entry.outSec !== null) token.listeners.push(['timeupdate', () => checkOut(token, entry)]);
      for (const [type, fn] of token.listeners) video.addEventListener(type, fn);
      token.stage = 'starting';
      video.playbackRate = 1;
      // 진단: 재생 시작 뒤 실제로 화면에 나간 첫 영상 프레임 시각(지원하는 브라우저만).
      video.requestVideoFrameCallback?.((frameNow, meta) => {
        // 한 번만, 그리고 이 재생이 아직 현재일 때만 기록한다(취소·교체 뒤 같은 영상을 다시 쓸 때 늦게 온 콜백을 옛 전환에 남기지 않음).
        if (m.firstFrameMs !== null || !isCurrent(token)) return;
        m.firstFrameMs = frameNow;
        m.firstFrameMediaSec = meta?.mediaTime ?? null;
      });
      try {
        await video.play();
      } catch (error) {
        if (!isCurrent(token)) return;
        if (error?.name === 'NotAllowedError') {
          blocked = true;
          fail(token, 'autoplay-blocked');
        } else {
          fail(token, `play-failed${error?.name ? `:${error.name}` : ''}`);
        }
        return;
      }
      if (!isCurrent(token)) return;
      token.stage = 'playing';
      entry.lastError = null;
      m.playingMs = now();
      if (entry.outSec !== null) armOut(token, entry);
      // 실제 재생이 시작된 뒤에야 화면을 바꾼다(그 전까지 이전 프레임 유지). 바로 알려 렌더러가 첫 그림을 그리게 한 뒤,
      // 이제 쓰지 않는 영상(방금 끝난 이전 클립 등)을 미리 되감는다. 강제 전환이면 지금 보이던 이전 영상과 섞게 한다.
      const from = token.blendFrom;
      const blendFrom = from !== null && display?.element === from && from !== video ? from : null;
      m.blended = blendFrom !== null;
      setDisplay({ kind: 'video', element: video, clip: token.clip, blendFrom, blendMs: blendFrom ? token.blendMs : 0 });
      rewindIdle();
    } catch (error) {
      fail(token, error?.message || 'load-failed');
    } finally {
      // 취소·교체된 재생이 늦게 시작했으면 멈춘다 — 지금 재생이 같은 요소를 쓰면 그대로 둔다.
      if (!isCurrent(token) && current?.video !== video && !video.paused) video.pause();
    }
  }

  function stopCurrent(outcome) {
    if (!current) return;
    const token = current;
    token.video?.pause();
    finish(token, outcome);
  }

  return {
    // 새 클립 재생. 진행 중 재생은 교체(취소)된다. blendMs > 0이면 지금 보이는 (다른) 영상과 짧게 섞는다(forced = 거리로 도중에 바꿈, 진단용).
    play({ playId, clip, blendMs = 0, forced = false }) {
      if (disposed) return;
      // 섞을 이전 화면: 지금 보이는 영상(취소되면 그 프레임에서 멈춤). H 이미지·가림 화면에서는 섞지 않는다.
      const blendFrom = blendMs > 0 && display?.kind === 'video' ? display.element : null;
      stopCurrent('replaced');
      const startedMs = now();
      // 진단: 이전 클립이 정상으로 끝난 직후의 재생이면 끝난 시각도 남긴다(끝 → 요청 지연).
      const metrics = {
        playId,
        clip,
        fromClip: display ? display.clip ?? 'H' : null,
        prevEndedMs: last?.outcome === 'finished' ? last.atMs : null,
        requestMs: startedMs,
        waitedRewind: false,
        seeked: false,
        readyMs: null,
        playingMs: null,
        firstFrameMs: null,
        firstFrameMediaSec: null,
        blendMs,
        forced,
        blended: false,
        endedBy: null,
      };
      transitions.push(metrics);
      if (transitions.length > TRANSITION_LOG) transitions.shift();
      const token = { playId, clip, video: null, stage: 'pending', startedMs, listeners: [], metrics, blendFrom, blendMs, outTimer: null };
      current = token;
      run(token);
    },
    cancel(playId) {
      if (current?.playId === playId) stopCurrent('cancelled');
    },
    // 안전 정지: 모든 영상을 멈추고 H 정지 이미지를 보인다.
    setPose(pose) {
      if (pose !== 'hidden' || disposed) return;
      stopCurrent('cancelled');
      for (const entry of Object.values(entries)) entry.video?.pause();
      setDisplay({ kind: 'image', element: still.image, clip: null });
      rewindIdle();
    },
    // 모든 영상 요소를 미리 만들어 불러온다(첫 재생 지연 줄이기).
    preload() {
      for (const entry of Object.values(entries)) videoFor(entry);
    },
    get display() {
      return display;
    },
    get blocked() {
      return blocked;
    },
    // 안전 정지 이미지 상태: 'loading' | 'ready' | 'error'(재시도 예약됨).
    get stillStatus() {
      return still.status;
    },
    clearBlocked() {
      blocked = false;
    },
    snapshot(nowMs) {
      const tokenInfo = (t) => {
        const v = t.video;
        return {
          playId: t.playId,
          clip: t.clip,
          stage: t.stage,
          elapsedMs: nowMs - t.startedMs,
          readyState: v?.readyState ?? null,
          currentTimeSec: v ? v.currentTime : null,
          durationSec: v && Number.isFinite(v.duration) ? v.duration : null,
          inSec: entries[t.clip]?.inSec ?? null,
          outSec: entries[t.clip]?.outSec ?? null,
          paused: v ? v.paused : null,
        };
      };
      return {
        current: current && tokenInfo(current),
        last,
        display: display && { kind: display.kind, clip: display.clip, blended: Boolean(display.blendFrom) },
        blocked,
        still: `${still.status}(시도 ${still.attempts})`,
        transitions: transitions.map((t) => ({ ...t })),
        sources: Object.fromEntries(
          Object.values(entries).map((e) => [
            e.clip,
            {
              readyState: e.video?.readyState ?? null,
              error: e.video?.error ? mediaErrorText(e.video) : e.lastError,
              loads: e.loads,
              rewinds: e.rewinds,
            },
          ]),
        ),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (current) detach(current);
      current = null;
      display = null;
      for (const entry of Object.values(entries)) {
        if (entry.video) releaseVideo(entry.video);
        entry.video = null;
      }
      clearTimeout(still.retryTimer);
      still.image.onload = null;
      still.image.onerror = null;
      still.image.removeAttribute('src');
    },
  };
}
