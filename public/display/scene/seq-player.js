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
//     실어 렌더러가 짧게 섞게 한다(새 영상은 그동안에도 재생 — 정지 시간 추가 없음). 섞는 시간은 코어가 정한다(naturalBlendMs 150 ms,
//     정/역 반전 0, 임시값). 같은 영상 재시작·H 이미지에서 시작은 섞지 않고, 안전 정지(H)는 바로 덮는다.
//   - 불러오기·탐색·재생 오류는 그 재생의 오류로 알린다. 오류가 난 영상 요소는 다음 재생 때 새로 만든다(재시도).
//   - 자동 재생이 막히면(NotAllowedError) 'autoplay-blocked' 오류로 알리고 blocked를 켠다 — 사용자 조작 뒤 clearBlocked()로 푼다.
//   - 안전 정지 이미지(H)는 실패하면 stillRetryMs마다 새 <img>로 다시 불러온다. 시도마다 세대 번호를 두어 이전 시도의 늦은 load·error는 무시한다.
//     준비 전·실패 중에는 렌더러가 가림 화면을 그리고(이전 영상 프레임을 남기지 않음), 부르는 쪽이 stillStatus로 오류를 화면에 알린다.
//   - 전환 대기 줄이기: 표시가 바뀌면 onDisplayChange로 바로 알린다(렌더러가 다음 화면 갱신을 기다리지 않고 첫 그림을 그림).
//     그 뒤 지금 쓰지 않는 영상(표시 중·재생 중·렌더러가 아직 쓰는 요소 — 섞는 중인 이전 영상 포함 — 제외)을 미리 inSec으로
//     되감아 다음 재생 때 탐색 대기를 없앤다. 처음 불러온 영상도 메타데이터가 오면 inSec으로 미리 감는다.
//     미리 되감는 중에 그 영상이 재생 차례가 되면 탐색이 끝나기를 기다린 뒤 시작한다(다시 탐색하지 않음).
//     표시 중인 영상은 건드리지 않는다 — 같은 영상을 다시 재생할 때만(예: 취소 뒤 같은 클립) 재생 시작 때 탐색한다.
//   - 정/역 짝(clips[].mirrorOf, 복귀 SC4 ↔ 역방향 SC4R): play의 mirror면 시작 지점을 **요청 순간 실제로 보이는 프레임**(display)에서
//     정한다 — 보이는 것이 짝 영상이면 프레임 대응 지점(mirrorStartSec), 같은 영상이면 그 프레임, 둘 다 아니면(아직 짝이 화면에
//     나오기 전) 모두 숨은 자세의 시각(hiddenSec). 요청됐지만 아직 준비 중인 영상은 보이는 것이 아니므로 기준으로 쓰지 않는다.
//     새 영상이 그 지점에서 재생을 시작할 때까지 이전 프레임을 유지한다(섞지 않음).
//   - 자세 연결 구간(clips[].cues): 코어가 watchCues(playId, target)로 지켜볼 목적을 주면, **재생이 실제로 시작된 뒤** 그 영상의
//     currentTime이 목적에 맞는 구간 [fromSec, toSec] 안일 때 onCue(playId, target, via)로 알린다(구간마다 한 번). 확인은 timeupdate와,
//     다음 구간 시작까지 남은 영상 시간만큼의 한 번짜리 타이머(아직이면 다시 잼)로 한다 — 고빈도 폴링 없음. 준비·탐색 중이거나
//     시작 전에는 판단하지 않는다(로딩 시간·탐색 전 위치로 전환하지 않음). 늦게 확인해 구간을 통째로 지났으면 그 구간은 건너뛰고
//     다음 구간이나 정상 out에서 처리한다. 영상이 멈추거나(stall) 시각이 그대로면 구간 밖에서는 알리지 않고 다시 잴 뿐이다.
//     취소·교체·목적 변경(target null 포함) 뒤의 늦은 확인은 재생 토큰으로 막는다. 전환 여부는 코어가 다시 검증한다.
//   - 진단: 최근 전환마다 이전 클립 끝 → 재생 요청 → 준비(탐색) → 재생 시작(표시 교체) → 첫 영상 프레임 시각을 남긴다.

const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const TRANSITION_LOG = 6; // 진단용으로 남기는 최근 전환 수
const POS_EPS_SEC = 0.02; // 시작 위치 비교 허용(24fps 한 프레임의 절반 미만)
const OUT_TIMER_MIN_MS = 20; // out 확인 타이머 최소 간격
const CUE_TIMER_MIN_MS = 20; // 연결 구간 확인 타이머 최소 간격(구간 시작 직전 여러 번 깨지 않게)
const CUE_STALL_RECHECK_MS = 250; // 영상 시각이 지난 확인 때와 같으면(멈춤·버퍼링) 이 간격으로만 다시 본다(timeupdate 수준)

// 편집 구간: inSec(기본 0), outSec(없거나 inSec 이하이면 원본 끝 = null).
export function editRange(def) {
  const inSec = Number.isFinite(def.inSec) && def.inSec > 0 ? def.inSec : 0;
  const outSec = Number.isFinite(def.outSec) && def.outSec > inSec ? def.outSec : null;
  return { inSec, outSec };
}

// 연결 구간 정리: { fromSec, toSec, targets(없으면 모든 목적) } — 시작 순으로, 잘못된 구간은 버린다.
export function normalizeCues(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => Number.isFinite(c?.fromSec) && Number.isFinite(c?.toSec) && c.toSec >= c.fromSec)
    .map((c) => ({ fromSec: c.fromSec, toSec: c.toSec, targets: Array.isArray(c.targets) && c.targets.length ? [...c.targets] : null }))
    .sort((a, b) => a.fromSec - b.fromSec);
}

// 프레임 번호(그 시각에 보이는 프레임 = 시작 PTS가 그 시각 이하인 마지막 프레임). 부동소수 오차로 앞 프레임이 되지 않게 아주 작은 여유.
function frameAt(sec, fps, frames) {
  return Math.min(frames - 1, Math.max(0, Math.floor(sec * fps + 1e-6)));
}
// 프레임 가운데 시각(탐색이 그 프레임에 확실히 떨어지게).
const frameMidSec = (index, fps) => (index + 0.5) / fps;

// 정/역 짝의 대응 시작 시각: 한쪽에서 fromSec에 보이는 프레임 i ↔ 다른 쪽 프레임 (frames − 1 − i). 프레임 가운데 시각을 돌려준다.
// (duration − t가 아니라 프레임 번호로 대응시킨다 — 마지막 PTS는 길이보다 한 프레임 짧다.)
export function mirrorStartSec(fromSec, frames, fps) {
  return frameMidSec(frames - 1 - frameAt(fromSec, fps, frames), fps);
}

function mediaErrorText(video) {
  const code = video.error?.code;
  return code === undefined ? 'media-error' : `media-error-${code}`;
}

// onCue(playId, target, via): 지켜보던 재생이 target 연결 구간 안에 있다(via = { clip, atSec, fromSec, toSec }).
// onDisplayChange(): display가 바뀐 직후(렌더러가 바로 그리게). isShown(element): 렌더러가 아직 그 요소를 쓰는가(그리는 중·섞는 중 — 미리 되감기 제외).
// createVideoElement·createImage: 테스트에서 가짜 미디어 요소를 넣을 때만 바꾼다.
export function createSeqPlayer({
  clips,
  seqBase,
  safeStillUrl,
  stillRetryMs = 3000,
  onFinished,
  onError,
  onCue = () => {},
  onDisplayChange = () => {},
  isShown = () => false,
  now = () => performance.now(),
  createVideoElement = () => document.createElement('video'),
  createImage = () => new Image(),
}) {
  // 클립 이름 → { clip, url, inSec, outSec, video, loads, rewinds, lastError }
  const entries = {};
  for (const [clip, def] of Object.entries(clips)) {
    if (!def.file) continue;
    entries[clip] = {
      clip, url: `${seqBase}${def.file}`, ...editRange(def),
      mirror: def.mirrorOf ? { of: def.mirrorOf, frames: def.frames, fps: def.fps, hiddenSec: def.hiddenSec } : null,
      cues: normalizeCues(def.cues),
      video: null, loads: 0, rewinds: 0, lastError: null,
    };
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
    clearTimeout(token.cueTimer);
    token.cueTimer = null;
  }

  // ── 자세 연결 구간 ──
  const cueFits = (cue, target) => cue.targets === null || cue.targets.includes(target);
  // 지켜보는 목적이 있고 실제로 재생 중일 때만 위치를 본다(준비·탐색 중·시작 전 제외). 구간 안이면 알린다(구간마다 한 번).
  function checkCue(token) {
    if (!isCurrent(token) || token.cueTarget === null || token.stage !== 'playing') return;
    const video = token.video;
    if (video.seeking) return;
    const entry = entries[token.clip];
    const t = video.currentTime;
    for (const [index, cue] of entry.cues.entries()) {
      if (token.cueFired.has(index) || !cueFits(cue, token.cueTarget)) continue;
      if (t < cue.fromSec || t > cue.toSec) continue;
      token.cueFired.add(index);
      const via = { clip: token.clip, atSec: t, fromSec: cue.fromSec, toSec: cue.toSec };
      token.metrics.cue = via;
      onCue(token.playId, token.cueTarget, via); // 코어가 다시 검증한다 — 이어지면 이 토큰은 교체된다
      return;
    }
  }
  // 다음(아직 오지 않은) 맞는 구간 시작까지 남은 영상 시간만큼 뒤에 한 번 확인한다. 없으면 정상 out을 기다린다.
  function armCue(token) {
    clearTimeout(token.cueTimer);
    token.cueTimer = null;
    if (!isCurrent(token) || token.cueTarget === null || token.stage !== 'playing') return;
    const video = token.video;
    const t = video.currentTime;
    const next = entries[token.clip].cues.find((c, i) => !token.cueFired.has(i) && cueFits(c, token.cueTarget) && c.toSec >= t);
    if (!next) return;
    const stalled = token.cueLastSec === t; // 지난 확인 뒤로 영상이 진행하지 않음
    token.cueLastSec = t;
    const waitMs = Math.max(stalled ? CUE_STALL_RECHECK_MS : CUE_TIMER_MIN_MS, ((next.fromSec - t) / (video.playbackRate || 1)) * 1000);
    token.cueTimer = setTimeout(() => {
      token.cueTimer = null;
      checkCue(token);
      armCue(token); // 아직이거나(멈춤) 이 구간을 지나쳤으면 다음 구간으로
    }, waitMs);
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
      const startSec = token.startSec ?? entry.inSec; // 정/역 반전이면 요청 때 정한 대응 지점, 아니면 편집 시작점
      if (video.ended || Math.abs(video.currentTime - startSec) > POS_EPS_SEC) {
        token.stage = 'seeking';
        m.seeked = true;
        video.pause();
        video.currentTime = startSec; // 여기서 seeking이 켜지고 seeked 때 꺼진다
        await waitUntil(video, ['seeked'], () => !video.seeking);
        if (!isCurrent(token)) return;
      }
      m.readyMs = now();
      const onEnded = () => complete(token, 'ended');
      const onMediaError = () => fail(token, mediaErrorText(video));
      token.listeners = [['ended', onEnded], ['error', onMediaError]];
      if (entry.outSec !== null) token.listeners.push(['timeupdate', () => checkOut(token, entry)]);
      if (entry.cues.length > 0) token.listeners.push(['timeupdate', () => checkCue(token)]);
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
      // 시작 전에 연결 대기가 왔으면 첫 실제 영상 위치부터 판단한다.
      if (token.cueTarget !== null && isCurrent(token)) {
        checkCue(token);
        armCue(token);
      }
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

  // 정/역 짝의 시작 시각을 지금 실제로 보이는 프레임(display)으로 정한다. 편집 구간 안(끝 한 프레임 전까지)으로 자른다.
  function mirrorStart(entry) {
    const { of, frames, fps, hiddenSec } = entry.mirror;
    const shown = display?.kind === 'video' ? display : null;
    let sec;
    let from;
    if (shown && shown.clip === of) {
      sec = mirrorStartSec(shown.element.currentTime, frames, fps); // 짝 영상의 보이는 프레임 → 대응 프레임
      from = `${of}@${shown.element.currentTime.toFixed(3)}`;
    } else if (shown && shown.clip === entry.clip) {
      sec = frameMidSec(frameAt(shown.element.currentTime, fps, frames), fps); // 같은 영상이 보이는 중(짝이 아직 화면에 안 나옴) → 그 자리부터
      from = `${entry.clip}@${shown.element.currentTime.toFixed(3)}`;
    } else {
      sec = hiddenSec ?? entry.inSec; // 짝이 화면에 나오기 전: 보이는 것은 숨은 자세
      from = 'hidden';
    }
    const hi = (entry.outSec ?? (frames - 1) / fps) - 1 / fps;
    return { sec: Math.min(Math.max(sec, entry.inSec), hi), from };
  }

  return {
    // 새 클립 재생. 진행 중 재생은 교체(취소)된다. blendMs > 0이면 지금 보이는 (다른) 영상과 짧게 섞는다.
    // mirror면 정/역 짝의 대응 지점부터 시작한다(시작 지점은 취소·되감기 전에, 지금 보이는 프레임으로 정함).
    // via: 연결 구간에서 이어졌으면 그 구간·실제 위치(진단용).
    play({ playId, clip, blendMs = 0, mirror = false, via = null }) {
      if (disposed) return;
      const mirrorEntry = mirror && entries[clip]?.mirror ? entries[clip] : null;
      const start = mirrorEntry ? mirrorStart(mirrorEntry) : null;
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
        via,
        cue: null,
        mirror: start ? `${start.from} → ${start.sec.toFixed(3)} s` : null,
        blended: false,
        endedBy: null,
      };
      transitions.push(metrics);
      if (transitions.length > TRANSITION_LOG) transitions.shift();
      const token = {
        playId, clip, video: null, stage: 'pending', startedMs, listeners: [], metrics, blendFrom, blendMs, outTimer: null,
        cueTarget: null, cueFired: new Set(), cueTimer: null, cueLastSec: null,
        startSec: start ? start.sec : null,
      };
      current = token;
      run(token);
    },
    // 연결 구간 지켜보기: target(다음 단계) 또는 null(그만). 지금 재생이 그 playId일 때만. 목적이 바뀌면 구간을 처음부터 다시 본다.
    watchCues(playId, target) {
      const token = current;
      if (!token || token.playId !== playId) return;
      token.cueTarget = target ?? null;
      token.cueFired = new Set();
      token.cueLastSec = null;
      clearTimeout(token.cueTimer);
      token.cueTimer = null;
      if (token.cueTarget === null) return;
      checkCue(token); // 재생 시작 전이면 아무것도 하지 않고, 시작 때 첫 실제 위치부터 본다
      if (isCurrent(token)) armCue(token);
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
          cueTarget: t.cueTarget,
          cues: (entries[t.clip]?.cues ?? []).filter((c) => t.cueTarget === null || cueFits(c, t.cueTarget)),
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
