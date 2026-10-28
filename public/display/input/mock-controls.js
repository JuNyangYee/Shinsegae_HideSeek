// 모의 입력 조작부(개발용): 페이지 컨트롤과 단축키를 모의 입력 어댑터 호출로 바꾼다.
// 판정·시퀀스 코어에는 DOM 이벤트를 넘기지 않는다. 유화(O)·패널(D) 키는 부르는 쪽 콜백으로 넘긴다(입력 선택과 무관하게 동작).
// 모의 조작(버튼·슬라이더·N/M/F)은 isActive()가 참일 때(패널에서 '모의 입력'을 고른 동안)만 동작한다 — 실센서 중에는 판정에 끼어들지 않는다.
// 숫자 1/2/3(센서 없이 거리 시험)은 예외: 실센서 중이어도 프리셋 거리를 먼저 정한 뒤 activate()로 모의 입력으로 바꾸고 정상 전송을 이어 간다.

const MODE_LABELS = { ok: '정상 감지', 'no-target': '감지 없음', error: '입력 오류' };

// 글자·범위 입력을 조작하는 중에는 단축키를 가로채지 않는다.
function isEditingTarget(target) {
  return target instanceof Element
    && target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

// 숫자 키 → 거리 프리셋. 위 숫자 줄과 숫자패드(NumLock 켬 — 꺼져 있으면 key가 숫자가 아니라 무시)를 같이 본다.
const DIGIT_PRESETS = {
  Digit1: 'near', Numpad1: 'near',
  Digit2: 'mid', Numpad2: 'mid',
  Digit3: 'far', Numpad3: 'far',
};

export function bindMockControls(mock, settings, { root = document, onTogglePanel, onToggleOil, isActive = () => true, activate } = {}) {
  const slider = root.getElementById('distance');
  const distanceOut = root.getElementById('distance-value');
  const modeOut = root.getElementById('input-mode');
  const buttons = root.querySelectorAll('[data-action]');

  slider.min = String(settings.minDistanceM);
  slider.max = String(settings.maxDistanceM);
  slider.step = String(settings.stepM);
  slider.value = String(mock.getState().distanceM);

  function refresh() {
    const { distanceM, mode, sending } = mock.getState();
    slider.value = String(distanceM);
    distanceOut.textContent = `${distanceM.toFixed(2)} m`;
    modeOut.textContent = `${MODE_LABELS[mode]} · ${sending ? '전송 중' : '전송 중단'}`;
    modeOut.dataset.mode = sending ? mode : 'stopped';
    for (const button of buttons) {
      const action = button.dataset.action;
      if (action === 'no-target' || action === 'error') button.setAttribute('aria-pressed', String(mode === action));
      if (action === 'stop') button.setAttribute('aria-pressed', String(!sending));
    }
  }

  // 거리 프리셋은 정상 감지로 돌린다(감지 없음·입력 오류 중에 눌러도 그 거리가 보내지게).
  const preset = (m) => () => {
    mock.setDistance(m);
    mock.setMode('ok');
  };
  const actions = {
    near: preset(settings.nearPresetM),
    mid: preset(settings.midPresetM),
    far: preset(settings.farPresetM),
    'no-target': () => mock.setMode('no-target'),
    error: () => mock.setMode('error'),
    stop: () => mock.stop(),
    resume: () => mock.resumeNormal(),
  };

  function run(action) {
    if (!isActive()) return;
    actions[action]?.();
    refresh();
  }

  // 숫자 키 프리셋: 거리·정상 감지를 먼저 정하고(전환 직후 첫 샘플이 이전 거리·오류가 되지 않게) 실센서 중이면 모의 입력으로 바꾼다.
  // 이미 모의 입력이면 입력을 다시 초기화하지 않고(키마다 안전 정지로 튀지 않게) 전송 중단이었으면 전송만 다시 시작한다.
  function selectPreset(action) {
    if (!isActive() && !activate) return;
    actions[action]();
    if (!isActive()) activate();
    if (isActive()) mock.start();
    refresh();
  }

  slider.addEventListener('input', () => {
    if (!isActive()) return;
    mock.setDistance(slider.value);
    refresh();
  });
  for (const button of buttons) {
    button.addEventListener('click', () => run(button.dataset.action));
  }

  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.isComposing || isEditingTarget(event.target)) return;
    // 한글 입력 상태에서도 같은 자리의 키로 동작하도록 물리 키(code)로 본다.
    const presets = { KeyN: 'near', KeyM: 'mid', KeyF: 'far' };
    if (Object.hasOwn(presets, event.code)) {
      if (!isActive()) return; // 실센서 중에는 N/M/F를 쓰지도 가로채지도 않는다
      run(presets[event.code]);
    } else if (Object.hasOwn(DIGIT_PRESETS, event.code)) {
      if (event.shiftKey || !/^[0-9]$/.test(event.key)) return; // Shift 조합·NumLock 꺼진 숫자패드는 가로채지 않는다
      selectPreset(DIGIT_PRESETS[event.code]);
    } else if (event.code === 'KeyO') onToggleOil?.();
    else if (event.code === 'KeyD') onTogglePanel?.();
    else return;
    event.preventDefault();
  });

  refresh();
  return { refresh };
}
