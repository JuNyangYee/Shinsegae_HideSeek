// 모의 입력 조작부(개발용): 페이지 컨트롤과 단축키를 모의 입력 어댑터 호출로 바꾼다.
// 판정·시퀀스 코어에는 DOM 이벤트를 넘기지 않는다. 유화(O)·패널(D) 키는 부르는 쪽 콜백으로 넘긴다.

const MODE_LABELS = { ok: '정상 감지', 'no-target': '감지 없음', error: '입력 오류' };

// 글자·범위 입력을 조작하는 중에는 단축키를 가로채지 않는다.
function isEditingTarget(target) {
  return target instanceof Element
    && target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

export function bindMockControls(mock, settings, { root = document, onTogglePanel, onToggleOil } = {}) {
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
    actions[action]?.();
    refresh();
  }

  slider.addEventListener('input', () => {
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
    if (event.code === 'KeyN') run('near');
    else if (event.code === 'KeyM') run('mid');
    else if (event.code === 'KeyF') run('far');
    else if (event.code === 'KeyO') onToggleOil?.();
    else if (event.code === 'KeyD') onTogglePanel?.();
    else return;
    event.preventDefault();
  });

  refresh();
  return { refresh };
}
