// 더미 재생기: 캐릭터 요소를 Web Animations API로 움직여 숨기·등장 "클립"을 흉내 낸다.
// 최종 영상 재생기로 바꿀 수 있도록 계약을 작게 둔다.
//   play({ playId, clip, durationMs })  — 재생 시작. 결과는 onFinished(playId) / onError(playId, reason)로 알린다
//   cancel(playId)                      — 그 재생이 진행 중이면 멈추고 알림을 보내지 않는다
//   setPose(pose)                       — 'visible' | 'hidden' 자세로 바로 둔다
//   snapshot(nowMs)                     — 진단용: 진행 중 재생과 마지막으로 끝난 재생의 실제 animation 상태
// 완료는 실제 animation.finished로만 알린다. 알림은 항상 비동기라 상태 코어에 재진입하지 않는다.
// 이 프로토타입은 임시 연출이며 최종 아트·영상이 아니다.

const VISIBLE = 'translateY(0%)';
const HIDDEN = 'translateY(80%)'; // 전경 언덕 뒤로 완전히 내려간 자리(styles.css의 [data-pose="hidden"]과 같게)

const KEYFRAMES = {
  // 살짝 움찔한 뒤 언덕 뒤로 쏙 내려간다
  hide: [
    { transform: VISIBLE, offset: 0, easing: 'ease-out' },
    { transform: 'translateY(-5%)', offset: 0.2, easing: 'ease-in' },
    { transform: HIDDEN, offset: 1 },
  ],
  // 천천히 고개를 내밀고 톡 올라온다
  reveal: [
    { transform: HIDDEN, offset: 0, easing: 'ease-out' },
    { transform: 'translateY(35%)', offset: 0.35, easing: 'ease-in-out' },
    { transform: 'translateY(-6%)', offset: 0.75, easing: 'ease-in-out' },
    { transform: VISIBLE, offset: 1 },
  ],
};

const END_POSE = { hide: 'hidden', reveal: 'visible' };

export function createDummyPlayer({ element, onFinished, onError, now = () => performance.now() }) {
  let current = null; // { playId, clip, durationMs, startedAtMs, animation }
  let last = null; // 마지막으로 끝난 재생: 끝난 순간의 animation 상태(진단용)

  function describe(entry, nowMs) {
    const { animation } = entry;
    const currentTime = animation.currentTime === null ? null : Number(animation.currentTime);
    return {
      playId: entry.playId,
      clip: entry.clip,
      durationMs: entry.durationMs,
      playState: animation.playState,
      pending: animation.pending,
      currentTimeMs: currentTime,
      elapsedMs: nowMs - entry.startedAtMs, // 실제 경과(벽시계)와 animation 진행을 비교하려고 둔다
    };
  }

  function end(outcome) {
    last = { ...describe(current, now()), outcome };
    current = null;
  }

  function setPose(pose) {
    element.dataset.pose = pose;
  }

  function stopCurrent() {
    if (!current) return;
    const { animation } = current;
    end('cancelled'); // 먼저 비워서 cancel이 일으키는 거절 알림을 무시한다
    animation.cancel();
  }

  function failLater(playId, reason) {
    Promise.resolve().then(() => onError(playId, reason));
  }

  function play({ playId, clip, durationMs }) {
    stopCurrent();
    const keyframes = KEYFRAMES[clip];
    if (!keyframes) return failLater(playId, `unknown-clip:${clip}`);
    if (typeof element.animate !== 'function') return failLater(playId, 'no-web-animations');

    let animation;
    try {
      animation = element.animate(keyframes, { duration: durationMs, fill: 'forwards' });
    } catch (err) {
      return failLater(playId, err?.name || 'animate-failed');
    }
    current = { playId, clip, durationMs, startedAtMs: now(), animation };
    animation.finished.then(
      () => {
        if (current?.animation !== animation) return; // 취소됐거나 다른 재생으로 바뀜
        end('finished');
        setPose(END_POSE[clip]);
        animation.cancel(); // 끝 자세는 data-pose가 잡으므로 fill 효과를 정리한다
        onFinished(playId);
      },
      (err) => {
        if (current?.animation !== animation) return;
        end('error');
        onError(playId, err?.name || 'animation-error');
      },
    );
  }

  function cancel(playId) {
    if (current && current.playId === playId) stopCurrent();
  }

  function snapshot(nowMs) {
    return { current: current && describe(current, nowMs), last };
  }

  return { play, cancel, setPose, snapshot };
}
