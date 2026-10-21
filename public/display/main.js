// 표시 페이지 조립: 모의 입력 → 근접 판정 → 시퀀스 상태 → 영상 재생기 → 무대 렌더러(유화 후처리)·진단.
// 판정·시퀀스 코어는 순수 모듈이고, DOM·타이머·영상·WebGL은 여기와 scene/ 모듈만 다룬다.

import { SETTINGS } from './config/settings.js';
import { createProximityJudge } from './core/proximity.js';
import { clipPlayMs, createSequenceDirector } from './core/sequence.js';
import { createMockInput } from './input/mock-input.js';
import { bindMockControls } from './input/mock-controls.js';
import { createSeqPlayer } from './scene/seq-player.js';
import { createDiagnostics } from './scene/diagnostics.js';

const now = () => performance.now();
const query = new URLSearchParams(location.search);

const stage = document.getElementById('stage');
const canvas = document.getElementById('stage-canvas');
const messageEl = document.getElementById('stage-message');
const warningEl = document.getElementById('stage-warning');
const panel = document.getElementById('dev-panel');
const oilToggle = document.getElementById('oil-toggle');
const compareToggle = document.getElementById('compare-toggle');

// ── 개발 패널: 운영 화면에서는 기본 숨김, ?debug=1이나 D 키로 연다 ──
function setPanel(open) {
  panel.hidden = !open;
  document.body.classList.toggle('dev-open', open);
}
setPanel(query.get('debug') === '1');

const { nearBelowM, farAboveM, retreatMarginM } = SETTINGS.proximity;
document.getElementById('threshold-hint').textContent =
  `근거리 < ${nearBelowM.toFixed(2)} m ≤ 중간 ≤ ${farAboveM.toFixed(2)} m < 원거리 (기획값) · 멀어질 때 +${retreatMarginM.toFixed(2)} m 여유(임시)`;

const midSubstitute = SETTINGS.sequence.clips.SC1b_Glance.file === null;
const diagnostics = createDiagnostics(document.getElementById('diag-list'), {
  note: `${midSubstitute ? '중간 거리 대기: SC1b_Glance 영상 없음 → SC0A/B/C 놀이 순환으로 대체 · ' : ''}`
    + `SC1_Notice 원본 ${(SETTINGS.sequence.clips.SC1_Notice.durationMs / 1000).toFixed(2)} s · 편집 재생 ${(clipPlayMs(SETTINGS.sequence.clips.SC1_Notice) / 1000).toFixed(2)} s(v02 목표 3 s)`
    + ` · 편집 구간은 임시값 · 모의 입력(실제 센서 아님)`,
});

const judge = createProximityJudge(SETTINGS.proximity);
const director = createSequenceDirector(SETTINGS.sequence);
let stageRenderer = null; // 아래에서 만든다(재생기의 표시 변경 알림이 참조하므로 먼저 선언)

const player = createSeqPlayer({
  clips: SETTINGS.sequence.clips,
  seqBase: SETTINGS.media.seqBase,
  safeStillUrl: SETTINGS.media.safeStillUrl,
  now,
  onFinished: (playId) => apply(director.playbackFinished(playId, now())),
  onError: (playId, reason) => apply(director.playbackFailed(playId, reason, now())),
  // 표시가 바뀌면 렌더러가 다음 화면 갱신을 기다리지 않고 바로 그린다. 렌더러가 아직 쓰는 요소(그리는 중·섞는 중)는 재생기가 미리 되감지 않는다.
  onDisplayChange: () => stageRenderer?.refresh(),
  isShown: (element) => stageRenderer?.usesElement(element) ?? false,
});

// 시퀀스 코어가 낸 지시를 재생기에 전달한다.
function apply(actions) {
  for (const action of actions) {
    if (action.type === 'play') player.play(action);
    else if (action.type === 'cancel') player.cancel(action.playId);
    else if (action.type === 'pose') player.setPose(action.pose);
  }
  updateMessages();
}

// 판정이 바뀔 때만 시퀀스 코어에 알린다.
function onJudgement(result, nowMs) {
  if (result.changed) apply(director.setDecision(result.decision, nowMs));
}

// ── 일시 중지 사유(탭 숨김·그리기 불가): 하나라도 있으면 안전 정지, 모두 풀리면 최신 판정으로 다시 시작 ──
const suspendReasons = new Set();
function setSuspendReason(reason, on) {
  const before = suspendReasons.size > 0;
  if (on) suspendReasons.add(reason);
  else suspendReasons.delete(reason);
  const after = suspendReasons.size > 0;
  if (before !== after) apply(director.setSuspended(after, now()));
}

// ── 무대 렌더러(Three.js). 모듈 불러오기·WebGL2 생성 실패도 한국어 오류로 보인다 ──
let renderStatus = null;
let rendererError = null;
try {
  const { createStageRenderer } = await import('./scene/stage-renderer.js');
  stageRenderer = createStageRenderer(canvas, {
    cfg: SETTINGS.render,
    getDisplay: () => player.display,
    onStatus: (status) => {
      renderStatus = status;
      oilToggle.checked = status.wantOil;
      setSuspendReason('그리기 불가', status.fatal !== null);
      updateMessages();
    },
  });
} catch (error) {
  console.error('렌더러를 만들지 못했습니다:', error);
  rendererError = `화면을 그릴 수 없습니다.\nWebGL2를 사용할 수 없거나 렌더러를 만들지 못했습니다.\n(${error?.message ?? error})`;
  setSuspendReason('렌더러 없음', true);
}

function updateMessages() {
  const fatal = rendererError ?? renderStatus?.fatal ?? null;
  let message = null;
  let clickable = false;
  if (fatal) {
    message = fatal.startsWith('화면을') ? fatal : `화면을 그릴 수 없습니다.\n${fatal}`;
  } else {
    const lines = [];
    // 안전 정지 중인데 H 이미지가 없으면 렌더러는 가림(검정) 화면을 그린다 — 그 이유를 화면에 알린다.
    if (player.display?.kind === 'image' && player.stillStatus === 'error') {
      lines.push('안전 정지 화면(H 이미지)을 불러오지 못했습니다.\n다시 시도하는 중입니다. (POSE_DIR의 H_Hidden.png 확인)');
    }
    if (player.blocked) {
      lines.push('브라우저가 자동 재생을 막았습니다.\n화면을 클릭하거나 아무 키나 누르면 재생을 시작합니다.');
      clickable = true;
    }
    if (lines.length > 0) message = lines.join('\n\n');
  }
  messageEl.hidden = message === null;
  messageEl.textContent = message ?? '';
  messageEl.dataset.clickable = String(clickable);
  const oilError = renderStatus?.oilError ?? null;
  warningEl.hidden = oilError === null;
  warningEl.textContent = oilError === null ? '' : `유화 필터 오류 — 원본으로 표시 중 (O로 다시 시도)\n${oilError}`;
}

// 자동 재생이 막혔으면 사용자 조작 뒤 바로 다시 시도한다(명시 재시도).
function resumeAfterGesture() {
  if (!player.blocked) return;
  player.clearBlocked();
  apply(director.retryNow(now()));
}
window.addEventListener('pointerdown', resumeAfterGesture);
window.addEventListener('keydown', resumeAfterGesture);

function setOil(on) {
  stageRenderer?.setOil(on);
  oilToggle.checked = stageRenderer?.oil ?? false;
}
oilToggle.checked = stageRenderer?.oil ?? false;
oilToggle.disabled = stageRenderer === null;
compareToggle.disabled = stageRenderer === null;
oilToggle.addEventListener('change', () => setOil(oilToggle.checked));
compareToggle.addEventListener('change', () => stageRenderer?.setCompare(compareToggle.checked));

// 캔버스 크기 = 무대 칸 크기(9:16 contain은 CSS가 맞춘다).
if (stageRenderer !== null) {
  new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    stageRenderer.resize(Math.round(width), Math.round(height));
  }).observe(stage);
}

// 탭이 숨겨지면 안전 정지(영상이 보이지 않는 곳에서 혼자 진행하지 않게), 돌아오면 최신 판정으로 다시 시작.
document.addEventListener('visibilitychange', () => setSuspendReason('탭 숨김', document.hidden));
setSuspendReason('탭 숨김', document.hidden);

const mock = createMockInput({
  ...SETTINGS.mock,
  now,
  onSample: (sample) => {
    const t = now();
    onJudgement(judge.update(sample, t), t);
  },
});

const controls = bindMockControls(mock, SETTINGS.mock, {
  onTogglePanel: () => setPanel(panel.hidden),
  onToggleOil: () => setOil(!(stageRenderer?.oil ?? false)),
});

function tick() {
  const t = now();
  onJudgement(judge.tick(t), t); // 샘플이 끊기면 stale → unknown
  apply(director.tick(t)); // 재생 timeout, 재생 오류 후 재시도(apply가 화면 메시지도 갱신 — 안전 이미지 재시도 상태 반영)
  if (panel.hidden) return;
  diagnostics.render({
    input: mock.getState(),
    judge: judge.snapshot(t),
    seq: director.snapshot(),
    player: player.snapshot(t),
    render: stageRenderer?.stats() ?? null,
    suspendedBy: [...suspendReasons],
    nowMs: t,
  });
}

player.setPose('hidden');
player.preload();
apply([]);
mock.start();
controls.refresh(); // 전송 시작 후 조작부 표시를 실제 상태에 맞춘다
tick();
setInterval(tick, SETTINGS.display.tickMs);

// 페이지를 떠날 때 정리(뒤로 가기 캐시로 보관되는 경우는 그대로 둔다).
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  mock.stop();
  stageRenderer?.dispose();
  player.dispose();
});
