// 영상 재생기: 시퀀스 코어의 지시(play · cancel · pose)를 실제 <video>·정지 이미지로 실행하고, 완료·오류를 재생 ID와 함께 알린다.
// 화면에 그리지는 않는다 — 지금 보여야 할 요소(display)를 렌더러(scene/stage-renderer.js)가 읽어 그린다.
//
// 규칙(ThrowSnow scene/seq-media.js·seq-scene.js의 취소·정리 방식을 참고해 새로 씀):
//   - 영상은 서버의 /media/seq/ 주소를 그대로 연다(서버가 Range를 지원해 탐색 가능). 음소거 + playsinline으로 자동 재생.
//   - 완료는 실제 'ended' 이벤트로만 알린다. 길이 타이머로 성공 처리하지 않는다(timeout은 코어가 오류로 판정).
//   - 모든 비동기 단계(준비 대기·탐색·play() 약속)는 재생 토큰을 확인한다. 취소·교체된 재생의 늦은 결과는 알리지 않고,
//     늦게 시작된 영상이 지금 재생이 아니면 바로 멈춘다(숨김·안전 정지 중에 영상이 혼자 진행하지 않게).
//   - 다음 클립이 실제로 재생을 시작할 때까지 이전 화면(멈춘 마지막 프레임 또는 H 정지 이미지)을 그대로 둔다(검은 화면 방지).
//     클립 사이 겹침(크로스페이드)은 하지 않는다(캐릭터가 두 겹으로 보이지 않게).
//   - 불러오기·탐색·재생 오류는 그 재생의 오류로 알린다. 오류가 난 영상 요소는 다음 재생 때 새로 만든다(재시도).
//   - 자동 재생이 막히면(NotAllowedError) 'autoplay-blocked' 오류로 알리고 blocked를 켠다 — 사용자 조작 뒤 clearBlocked()로 푼다.
//   - 안전 정지 이미지(H)는 실패하면 stillRetryMs마다 새 <img>로 다시 불러온다. 시도마다 세대 번호를 두어 이전 시도의 늦은 load·error는 무시한다.
//     준비 전·실패 중에는 렌더러가 가림 화면을 그리고(이전 영상 프레임을 남기지 않음), 부르는 쪽이 stillStatus로 오류를 화면에 알린다.

const HAVE_CURRENT_DATA = 2;

function mediaErrorText(video) {
  const code = video.error?.code;
  return code === undefined ? 'media-error' : `media-error-${code}`;
}

export function createSeqPlayer({ clips, seqBase, safeStillUrl, stillRetryMs = 3000, onFinished, onError, now = () => performance.now() }) {
  // 클립 이름 → { clip, url, video, loads, lastError }
  const entries = {};
  for (const [clip, def] of Object.entries(clips)) {
    if (def.file) entries[clip] = { clip, url: `${seqBase}${def.file}`, video: null, loads: 0, lastError: null };
  }

  let current = null; // 진행 중 재생 토큰 { playId, clip, video, stage, startedMs, listeners }
  let last = null; // 마지막으로 끝난 재생 { playId, clip, outcome, reason, atMs, startedMs }
  let display = null; // 지금 보여야 할 것 { kind: 'video' | 'image', element, clip }
  let blocked = false;
  let disposed = false;

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
    const image = new Image();
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
    if (display?.kind === 'image') display = { kind: 'image', element: image, clip: null };
    image.src = safeStillUrl;
  }
  loadStill();

  // ── 영상 요소 ──
  function releaseVideo(video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  function createVideo(entry) {
    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.loop = false;
    video.src = entry.url;
    entry.loads += 1;
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

  // 이벤트 하나를 기다린다. 토큰이 바뀌어도 기다림은 끝까지 가지만, 부르는 쪽이 끝난 뒤 토큰을 확인한다.
  function waitFor(video, okEvent, check) {
    return new Promise((resolve, reject) => {
      if (check()) {
        resolve();
        return;
      }
      const done = (fn, value) => {
        video.removeEventListener(okEvent, onOk);
        video.removeEventListener('error', onErr);
        fn(value);
      };
      const onOk = () => done(resolve);
      const onErr = () => done(reject, new Error(mediaErrorText(video)));
      video.addEventListener(okEvent, onOk);
      video.addEventListener('error', onErr);
    });
  }

  function detach(token) {
    for (const [type, fn] of token.listeners) token.video?.removeEventListener(type, fn);
    token.listeners = [];
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
    try {
      token.stage = 'loading';
      await waitFor(video, 'loadeddata', () => video.readyState >= HAVE_CURRENT_DATA);
      if (!isCurrent(token)) return;
      if (video.currentTime !== 0 || video.ended) {
        token.stage = 'seeking';
        video.pause();
        const seeked = waitFor(video, 'seeked', () => false);
        video.currentTime = 0;
        await seeked;
        if (!isCurrent(token)) return;
      }
      const onEnded = () => {
        if (!isCurrent(token)) return;
        finish(token, 'finished');
        onFinished(token.playId);
      };
      const onMediaError = () => fail(token, mediaErrorText(video));
      token.listeners = [['ended', onEnded], ['error', onMediaError]];
      for (const [type, fn] of token.listeners) video.addEventListener(type, fn);
      token.stage = 'starting';
      video.playbackRate = 1;
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
      // 실제 재생이 시작된 뒤에야 화면을 바꾼다(그 전까지 이전 프레임 유지).
      display = { kind: 'video', element: video, clip: token.clip };
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
    // 새 클립 재생. 진행 중 재생은 교체(취소)된다.
    play({ playId, clip }) {
      if (disposed) return;
      stopCurrent('replaced');
      const token = { playId, clip, video: null, stage: 'pending', startedMs: now(), listeners: [] };
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
      display = { kind: 'image', element: still.image, clip: null };
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
          paused: v ? v.paused : null,
        };
      };
      return {
        current: current && tokenInfo(current),
        last,
        display: display && { kind: display.kind, clip: display.clip },
        blocked,
        still: `${still.status}(시도 ${still.attempts})`,
        sources: Object.fromEntries(
          Object.values(entries).map((e) => [
            e.clip,
            { readyState: e.video?.readyState ?? null, error: e.video?.error ? mediaErrorText(e.video) : e.lastError, loads: e.loads },
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
