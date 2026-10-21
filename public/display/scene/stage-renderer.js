// 무대 렌더러: 재생기가 정한 표시 요소(영상 또는 H 정지 이미지)를 9:16 무대에 그리고, 그 위에 유화 후처리를 입힌다.
// Three.js(0.186.1)·WebGL2. 진행은 정하지 않는다 — 매 그림마다 getDisplay()로 지금 보여야 할 요소를 읽을 뿐이다.
//
// 참고: ThrowSnow scene/seq-scene.js(HEAD 1fa49de)의 텍스처·색 공간 처리와 그리기 경로 시험 방식을 단일 전체 화면 영상에 맞게 줄여 새로 썼다.
//   - 텍스처는 sRGB 값 그대로 읽고(NoColorSpace) 셰이더에서 선형으로 바꾼다. 화면에 직접 그리면 colorspace_fragment가 sRGB로 내보내고,
//     후처리 장면 타깃(선형)에 그리면 그대로 두며 유화 필터가 다시 sRGB로 바꿔 처리한다. 톤 매핑 없음(Three 기본 NoToneMapping).
//   - 그리기 경로: 후처리(반정밀 → 8비트)와 직접 그리기를 운영 그리기 함수를 그대로 불러 GL 오류로 시험한다(probe).
//   - 그리기 박자: renderFps(12)로 그린다(필터의 「초당 그림」). 영상은 실제 시간 24fps 1배속으로 재생되고 그림만 12fps로 표본한다.
// 실패 정책:
//   - 유화를 켰는데 후처리를 쓸 수 없거나(시험 실패) 실행 중 실패(예외·첫 획 층 칠함 확인 실패)하면 **원본(직접 그리기)으로 바꾸고 오류를 보인다**.
//     O로 끄고 다시 켜면 새로 시험한다(복구).
//   - 직접 그리기마저 실패하면 그릴 수 없음(fatal) — onStatus로 알리고 recoverRetryMs마다 다시 시험한다.

import * as THREE from 'three';
import { createOilPost } from '../render/oil-post.js';

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAGMENT = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
void main() {
  vec3 c = texture2D(map, vUv).rgb;
  gl_FragColor = vec4(srgbToLinear(c), 1.0);
  #include <colorspace_fragment>
}`;

const HAVE_CURRENT_DATA = 2;

function elementReady(element) {
  if (element instanceof HTMLVideoElement) return element.readyState >= HAVE_CURRENT_DATA && element.videoWidth > 0;
  return element.complete && element.naturalWidth > 0;
}
function elementSize(element) {
  return element instanceof HTMLVideoElement
    ? { width: element.videoWidth, height: element.videoHeight }
    : { width: element.naturalWidth, height: element.naturalHeight };
}

// cfg: SETTINGS.render. getDisplay() → { kind, element, clip } | null. onStatus(status) — 경로·오류가 바뀔 때.
export function createStageRenderer(canvas, { cfg, getDisplay, onStatus }) {
  const W = cfg.aspect.width * 120; // 1080
  const H = cfg.aspect.height * 120; // 1920
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false }); // WebGL2를 못 쓰면 예외(부르는 쪽이 한국어 오류 표시)
  const gl = renderer.getContext();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.OrthographicCamera(0, W, H, 0, -1, 1);
  const geometry = new THREE.PlaneGeometry(1, 1);
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: blank } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.position.set(W / 2, H / 2, 0);
  mesh.scale.set(W, H, 1);
  scene.add(mesh);

  let post;
  try {
    post = createOilPost(THREE, renderer, cfg.oilStroke);
    // 유화 처리 크기는 화면(CSS) 크기와 상관없이 고정 9:16 기준 — 짧은 변 1080 → 정확히 1080 × 1920.
    // 실제 CSS 크기(반올림 오차로 1080 × 1918 등)를 쓰지 않는다. 화면 출력 크기는 캔버스(resize)가 정한다.
    post.setSize(cfg.aspect.width, cfg.aspect.height);
  } catch (error) {
    post = null;
    console.error('유화 후처리를 만들지 못했습니다:', error);
  }

  // ── 텍스처(요소마다 하나) ──
  const textures = new Map(); // element → { texture, onSeeked }
  function textureFor(element) {
    let item = textures.get(element);
    if (!item) {
      const isVideo = element instanceof HTMLVideoElement;
      const texture = isVideo ? new THREE.VideoTexture(element) : new THREE.Texture(element);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      // 멈춘 채 탐색한 영상도 그 프레임을 올린다(VideoTexture는 재생 중 새 프레임만 올림).
      const onSeeked = () => {
        texture.needsUpdate = true;
      };
      if (isVideo) element.addEventListener('seeked', onSeeked);
      item = { texture, onSeeked };
      textures.set(element, item);
    }
    return item.texture;
  }
  function dropTexture(element) {
    const item = textures.get(element);
    if (!item) return;
    element.removeEventListener('seeked', item.onSeeked);
    item.texture.dispose();
    textures.delete(element);
  }
  // 재생기가 해제한 요소(src 없음)의 텍스처를 정리한다.
  function sweepTextures() {
    for (const element of textures.keys()) {
      if (element !== shown.element && !element.getAttribute('src')) dropTexture(element);
    }
  }

  // 지금 그리는 요소. 다음 **영상**이 그릴 준비가 될 때까지 이전 것을 그대로 둔다.
  // 안전 정지(H 이미지)는 예외다: 이미지가 아직 불러오는 중이거나 실패했으면 이전 영상 프레임(캐릭터가 보이는 화면)을 남기지 않고
  // 검정 가림 화면(kind 'cover')으로 바꾼다. 이미지가 준비되면 그때 이미지로 바꾼다.
  const shown = { element: null, kind: null, clip: null };
  function syncDisplay() {
    const d = getDisplay();
    if (!d || d.element === shown.element) return false;
    if (!elementReady(d.element)) {
      if (d.kind !== 'image' || shown.kind === 'cover') return false;
      shown.element = null;
      shown.kind = 'cover';
      shown.clip = null;
      material.uniforms.map.value = blank;
      mesh.scale.set(W, H, 1);
      return true;
    }
    shown.element = d.element;
    shown.kind = d.kind;
    shown.clip = d.clip;
    material.uniforms.map.value = textureFor(d.element);
    // contain: 원본 비율 그대로 무대 안에 맞춘다(480:852·941:1672 ≈ 9:16, 아주 작은 위아래 여백).
    const { width, height } = elementSize(d.element);
    const s = Math.min(W / width, H / height);
    mesh.scale.set(width * s, height * s, 1);
    sweepTextures();
    return true;
  }

  // ── 그리기 경로 ──
  let wantOil = cfg.oilEnabled;
  let probeResult = { postType: null, direct: false, attempts: [] };
  let oilFault = null; // 유화 실행 중 실패 사유(원본 경로가 있으면 원본으로 대체 중)
  let fault = null; // 쓸 수 있는 경로가 없음(공통 복구 상태) { detail, retryAtMs } — recoverRetryMs마다 다시 시험
  let healthBaseline = 0; // 유화를 (다시) 켠 시점의 칠함 확인 결과 수 — 그 뒤의 결과로만 실패를 판단

  function renderWith(path) {
    if (path === 'post') {
      post.render(scene, camera, { target: null });
    } else {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    }
  }
  function tryRender(path) {
    if (gl.isContextLost()) return false;
    for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i += 1);
    renderWith(path);
    return gl.getError() === gl.NO_ERROR;
  }
  function attempt(fn) {
    try {
      return fn() === true;
    } catch {
      return false;
    }
  }
  function probe() {
    const attempts = [];
    let postType = null;
    if (post !== null) {
      const half = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
      for (const type of half ? ['half', 'byte'] : ['byte']) {
        const ok = attempt(() => post.configure(type) && tryRender('post'));
        attempts.push(`post:${type} ${ok ? '성공' : '실패'}`);
        if (ok) {
          postType = type;
          break;
        }
      }
    } else {
      attempts.push('post 생성 실패');
    }
    const direct = attempt(() => tryRender('direct'));
    attempts.push(`direct ${direct ? '성공' : '실패'}`);
    probeResult = { postType, direct, attempts };
    if (post !== null) healthBaseline = post.health.checked;
    enterFaultIfNoPath(`화면을 그릴 수 없습니다 (${attempts.join(', ')})`);
  }
  // 고를 수 있는 경로(복구 상태와 무관). 유화 실패(oilFault)면 후처리는 고르지 않는다.
  function choosePath() {
    const postOk = probeResult.postType !== null && oilFault === null;
    if (wantOil && postOk) return 'post';
    if (probeResult.direct) return 'direct';
    if (postOk) return 'post'; // 직접 그리기가 안 되면 후처리 강제
    return null;
  }
  function currentPath() {
    return fault === null ? choosePath() : null;
  }
  // 고를 경로가 없으면 공통 복구 상태로 들어간다(이미 들어가 있으면 사유만 유지).
  function enterFaultIfNoPath(detail) {
    if (fault === null && choosePath() === null) fault = { detail, retryAtMs: performance.now() + cfg.recoverRetryMs };
  }
  // 복구 시험: 다시 시험한 뒤 실제로 고를 경로가 생겼을 때만 복구 상태를 푼다.
  // 원본(직접) 경로가 있으면 유화 실패는 그대로 두고 원본 대체·경고를 유지한다(유화 재시도는 O).
  // 원본 경로가 없고 후처리 시험이 통과하면 유화 실패를 지우고 후처리로 다시 시도한다(칠함 확인은 그 뒤 결과로 다시 판단).
  function tryRecover(nowMs) {
    fault = null;
    probe(); // 경로가 없으면 여기서 새 시험 결과를 사유로 다시 복구 상태가 된다
    if (fault !== null && !probeResult.direct && probeResult.postType !== null && oilFault !== null) {
      oilFault = null;
      fault = null;
    }
    if (fault !== null) fault.retryAtMs = nowMs + cfg.recoverRetryMs;
  }

  function status() {
    const path = currentPath();
    let oilError = null;
    if (wantOil && path !== 'post') {
      oilError = oilFault ?? `유화 필터를 쓸 수 없습니다 (${probeResult.attempts.join(', ')})`;
    }
    let fatal = null;
    if (fault !== null) fatal = fault.detail;
    else if (path === null) fatal = `화면을 그릴 수 없습니다 (${probeResult.attempts.join(', ')})`;
    return { path, wantOil, oilActive: path === 'post', oilError, fatal, postType: probeResult.postType, probe: probeResult.attempts.join(', ') };
  }
  let lastStatusKey = '';
  function reportStatus() {
    const s = status();
    const key = JSON.stringify(s);
    if (key === lastStatusKey) return;
    lastStatusKey = key;
    if (s.oilError) console.error(`유화 필터 오류 — 원본으로 표시: ${s.oilError}`);
    if (s.fatal) console.error(s.fatal);
    onStatus?.(s);
  }

  // ── 박자(ThrowSnow render/frame-loop.js createRenderCadence와 같은 규칙: 1000/fps 격자, 늦어도 격자가 밀리지 않음, 2 ms 허용) ──
  const intervalMs = 1000 / cfg.renderFps;
  let nextDrawMs = null;
  function due(nowMs) {
    if (nextDrawMs === null) {
      nextDrawMs = nowMs + intervalMs;
      return true;
    }
    if (nowMs + 2 < nextDrawMs) return false;
    nextDrawMs += (Math.floor((nowMs + 2 - nextDrawMs) / intervalMs) + 1) * intervalMs;
    return true;
  }

  const drawTimes = [];
  // 진단: 화면 갱신(requestAnimationFrame) 호출 시각 — 그림/s가 낮을 때 브라우저가 갱신 자체를 줄였는지(rAF/s) 박자 문제인지 가른다.
  const frameTimes = [];
  let lastDrawMs = null;
  let disposed = false;

  function frame() {
    if (disposed) return;
    const nowMs = performance.now();
    frameTimes.push(nowMs);
    while (frameTimes.length > 0 && nowMs - frameTimes[0] > 1000) frameTimes.shift();
    if (fault !== null) {
      if (nowMs >= fault.retryAtMs) {
        tryRecover(nowMs);
        nextDrawMs = null;
        reportStatus();
      }
      return;
    }
    if (syncDisplay()) nextDrawMs = null; // 표시가 바뀌면 박자를 기다리지 않고 바로 그린다
    if (!due(nowMs)) return;
    const path = currentPath();
    if (path === null) return;
    const started = performance.now();
    try {
      renderWith(path);
    } catch (error) {
      if (path === 'post') {
        oilFault = `유화 그리기 실패: ${error?.message ?? error}`;
        enterFaultIfNoPath(`화면을 그릴 수 없습니다 (${oilFault}, 원본 경로 없음)`);
      } else {
        probeResult = { ...probeResult, direct: false };
        enterFaultIfNoPath(`화면 그리기 실패: ${error?.message ?? error}`);
      }
      nextDrawMs = null;
      reportStatus();
      return;
    }
    if (path === 'post') {
      const health = post.health;
      if (!health.ok && health.checked > healthBaseline) {
        oilFault = `유화 필터 칠함 확인 실패: ${health.detail}`;
        enterFaultIfNoPath(`화면을 그릴 수 없습니다 (${oilFault}, 원본 경로 없음)`);
        nextDrawMs = null;
        reportStatus();
        return;
      }
    }
    lastDrawMs = performance.now() - started;
    drawTimes.push(nowMs);
    while (drawTimes.length > 0 && nowMs - drawTimes[0] > 1000) drawTimes.shift();
  }

  probe();
  renderer.setAnimationLoop(frame);
  queueMicrotask(reportStatus);

  let viewport = { width: 0, height: 0, pixelRatio: 0 };
  return {
    // 캔버스 CSS 크기(px). 크기가 바뀌면 다시 시험한다.
    resize(width, height) {
      if (!(width > 0 && height > 0)) return;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, cfg.maxPixelRatio);
      if (width === viewport.width && height === viewport.height && pixelRatio === viewport.pixelRatio) return;
      viewport = { width, height, pixelRatio };
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
      probe();
      nextDrawMs = null;
      reportStatus();
    },
    // 유화 켬/끔(O 키·진단 체크). 켤 때는 이전 실패를 지우고 새로 시험한다.
    setOil(on) {
      wantOil = Boolean(on);
      if (wantOil) {
        oilFault = null;
        probe();
      }
      nextDrawMs = null;
      reportStatus();
    },
    get oil() {
      return wantOil;
    },
    // 원본 비교: 화면 왼쪽 compareSplit만큼을 필터 없는 원본으로(유화 필터의 split, 경계에 흰 선).
    setCompare(on) {
      if (post === null) return;
      if (post.setParams({ split: on ? cfg.compareSplit : 0 })) probe();
      nextDrawMs = null;
      reportStatus();
    },
    get compare() {
      return (post?.params.split ?? 0) > 0;
    },
    status,
    stats() {
      const nowMs = performance.now();
      return {
        ...status(),
        drawRate: drawTimes.filter((t) => nowMs - t <= 1000).length,
        frameRate: frameTimes.filter((t) => nowMs - t <= 1000).length,
        renderFps: cfg.renderFps,
        lastDrawMs,
        viewport,
        internal: post?.internal ?? null,
        health: post?.health ?? null,
        shown: { kind: shown.kind, clip: shown.clip },
        textures: renderer.info.memory.textures,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      for (const element of [...textures.keys()]) dropTexture(element);
      blank.dispose();
      geometry.dispose();
      material.dispose();
      post?.dispose();
      renderer.dispose();
    },
  };
}
