// 표시 페이지 조립: 모의 입력 → 근접 판정 → 시퀀스 상태 → 더미 재생기·진단.

import { SETTINGS } from './config/settings.js';
import { createProximityJudge } from './core/proximity.js';
import { createSequenceDirector } from './core/sequence.js';
import { createMockInput } from './input/mock-input.js';
import { bindMockControls } from './input/mock-controls.js';
import { createDummyPlayer } from './scene/dummy-player.js';
import { createDiagnostics, PHASE_LABELS } from './scene/diagnostics.js';

const now = () => performance.now();

const stage = document.getElementById('stage');
const phaseLabel = document.getElementById('stage-phase');
const diagnosticsEl = document.getElementById('diagnostics');

const judge = createProximityJudge(SETTINGS.proximity);

// 임계값 안내는 실제 판정 설정에서 만든다(설정을 바꿔도 어긋나지 않게).
const { nearMaxM, farMinM } = SETTINGS.proximity;
document.getElementById('threshold-hint').textContent =
  `가까움 ≤ ${nearMaxM.toFixed(1)} m · 멀어짐 ≥ ${farMinM.toFixed(1)} m · 사이는 이전 판정 유지 (임시값)`;
const director = createSequenceDirector(SETTINGS.sequence);
const diagnostics = createDiagnostics(document.getElementById('diag-list'));

const player = createDummyPlayer({
  element: document.getElementById('figure'),
  now,
  onFinished: (playId) => apply(director.playbackFinished(playId, now())),
  onError: (playId, reason) => apply(director.playbackFailed(playId, reason, now())),
});

// 시퀀스 코어가 낸 지시를 재생기에 전달한다.
function apply(actions) {
  for (const action of actions) {
    if (action.type === 'play') player.play(action);
    else if (action.type === 'cancel') player.cancel(action.playId);
    else if (action.type === 'pose') player.setPose(action.pose);
  }
  const { phase } = director.snapshot();
  if (stage.dataset.phase !== phase) {
    stage.dataset.phase = phase;
    phaseLabel.textContent = PHASE_LABELS[phase];
  }
}

// 판정이 바뀔 때만 시퀀스 코어에 알린다.
function onJudgement(result, nowMs) {
  if (result.changed) apply(director.setDecision(result.decision, nowMs));
}

const mock = createMockInput({
  ...SETTINGS.mock,
  now,
  onSample: (sample) => {
    const t = now();
    onJudgement(judge.update(sample, t), t);
  },
});

const controls = bindMockControls(mock, SETTINGS.mock, {
  onToggleDiagnostics: () => {
    diagnosticsEl.open = !diagnosticsEl.open;
  },
});

function tick() {
  const t = now();
  onJudgement(judge.tick(t), t); // 샘플이 끊기면 stale → unknown
  apply(director.tick(t)); // 재생 timeout, 재생 오류 후 재시도
  diagnostics.render({
    input: mock.getState(),
    judge: judge.snapshot(t),
    seq: director.snapshot(),
    player: player.snapshot(t),
    nowMs: t,
  });
}

player.setPose('hidden');
apply([]);
mock.start();
controls.refresh(); // 전송 시작 후 조작부 표시를 실제 상태에 맞춘다
tick();
setInterval(tick, SETTINGS.display.tickMs);
