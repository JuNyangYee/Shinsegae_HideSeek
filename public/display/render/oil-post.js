// 유화 후처리 래퍼: 장면 → 장면 타깃(선형) → 「유화 · 획」 필터(oil-stroke-fx.js) → 화면.
//
// [축약 이식] ThrowSnow D:/2026-09_ShinsegaeChristmas/006_Works/003_ThrowSnow/public/display/render/post-fx.js
// (HEAD 1fa49de283a46cd8ca73da5a7d50e6b77a32e842)의 createPostFx에서 oil-stroke 경로만 남겼다(sf1 필터·덧그림 장면·얼굴 보호 입력은 뺐다).
// 남긴 계산은 원본과 같다:
//   - 처리 크기: 화면 크기와 상관없이 짧은 변 referenceShortSide(1080) px, 짝수로 반올림(9:16 무대 → 1080 × 1920).
//   - 장면 타깃: MSAA 4, 'half'(반정밀) 또는 'byte'(8비트) — configure(type). 그릴 수 있는지는 부르는 쪽이 실제로 그려 시험한다.
//   - 그림 번호(시드) = 그린 횟수 % 997(oil-strokes.js drawingSeed) — 「획 다시 그리기」(boil) 비율만큼 획이 그림마다 바뀐다.

import { createOilStrokeFilter, oilStrokeDefaults } from './oil-stroke-fx.js';
import { drawingSeed } from './oil-strokes.js';

export function createOilPost(THREE, renderer, config) {
  const TYPES = { half: THREE.HalfFloatType, byte: THREE.UnsignedByteType };
  let targetType = 'half';
  let size = { width: 1, height: 1 };
  let view = { width: 1, height: 1 };
  const makeSceneTarget = () => new THREE.WebGLRenderTarget(size.width, size.height, { samples: 4, type: TYPES[targetType], depthBuffer: false });
  let sceneTarget = makeSceneTarget();
  let params = oilStrokeDefaults(config);
  const filter = createOilStrokeFilter(THREE, renderer, config);
  filter.setParams(params);
  filter.configure(targetType);
  let drawCount = 0;

  function applySize() {
    const scale = config.referenceShortSide / Math.min(view.width, view.height);
    const round = (x) => Math.round(x / 2) * 2;
    const w = Math.max(2, round(view.width * scale));
    const h = Math.max(2, round(view.height * scale));
    const changed = w !== size.width || h !== size.height;
    size = { width: w, height: h };
    sceneTarget.setSize(w, h);
    filter.setSize(w, h);
    return changed;
  }

  return {
    // 화면(캔버스) 크기 CSS px → 내부 해상도. 반환: 내부 해상도가 바뀌었는가.
    setSize(width, height) {
      view = { width, height };
      return applySize();
    },
    render(scene, camera, { target = null, seed = null } = {}) {
      drawCount += 1;
      const autoClear = renderer.autoClear;
      try {
        renderer.setRenderTarget(sceneTarget);
        renderer.render(scene, camera);
        filter.render(sceneTarget.texture, target, { face: null, seed: seed ?? drawingSeed(drawCount) });
      } finally {
        renderer.autoClear = autoClear;
        renderer.setRenderTarget(null);
      }
    },
    // 'half' | 'byte'. 반환: 그 형식으로 만들었는가.
    configure(type) {
      if (!Object.hasOwn(TYPES, type) || TYPES[type] === undefined) return false;
      if (type === targetType) return true;
      sceneTarget.dispose();
      targetType = type;
      sceneTarget = makeSceneTarget();
      sceneTarget.setSize(size.width, size.height);
      filter.configure(type);
      return true;
    },
    // 조정값(예: 원본 비교 split). 반환: 실행 단계 구성이 바뀌었는가(바뀌면 부르는 쪽이 다시 시험).
    setParams(next) {
      params = { ...params, ...next };
      const before = filter.stages;
      filter.setParams(params);
      return filter.stages !== before;
    },
    get params() {
      return { ...params };
    },
    get health() {
      return filter.health;
    },
    pollHealth() {
      return filter.pollHealth();
    },
    get internal() {
      return { width: size.width, height: size.height, targetType, ...filter.stats };
    },
    dispose() {
      sceneTarget.dispose();
      filter.dispose();
    },
  };
}
