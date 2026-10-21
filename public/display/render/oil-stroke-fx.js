// [이식] ThrowSnow D:/2026-09_ShinsegaeChristmas/006_Works/003_ThrowSnow/public/display/render/oil-stroke-fx.js (HEAD 1fa49de283a46cd8ca73da5a7d50e6b77a32e842)
// 2026-10-21 숨바꼭질에 사용자 요청(같은 유화 필터)으로 내용 그대로 복사했다 — 셰이더·획 알고리즘·기본값을 바꾸지 않는다.
// 아래 원문 주석의 작업 기호·docs 경로·SYSTEM 절은 ThrowSnow 저장소 기준이다. 숨바꼭질 쪽 설명은 docs/SYSTEM.md 7장.
//
// 「유화 · 획 (세부 보존)」 후처리 필터 (작업 N, 2026-10-16 사용자 결정: 원본에는 유화 느낌을 넣지 않고 PC 후처리로 입힌다).
//
// 출처: 팀 동료의 「재료 필터 갤러리」(https://nau-filter-gallery.vercel.app/, 2026-10-16 배포본) 프리셋 oil2f.
// 소스 저장소가 없어 배포된 단일 HTML의 스크립트·GLSL을 읽고 유화 분기(uMedium == 1)만 옮겼다. 계산은 원본과 같게 두고,
// 다른 점(입력 색 공간 변환, 해상도 비례, 얼굴 보호, 8비트 강등 부호화, 삼각형 띠 → 색인 삼각형)은 아래에 적었다.
// 분석·비교: docs/logs/2026-10-16-03-oil-filter-port.md.
//
// 단계(그릴 때마다 = 스톱모션이면 정지 레이어 박자):
//   1. 색 보정(grade): 장면(선형) → sRGB 값으로 바꾼 뒤 따뜻한 색·톤 곡선 → grade 타깃(내부 해상도, 8비트, 밉맵).
//   2. 방향장(flow, 절반 해상도): 밝기 Sobel → 구조 텐서(gx², gy², gx·gy) → 가로·세로 가우스(σ 2.5) → 고유 벡터 = 형태를 따라가는 방향
//      (평평한 곳은 60° 기본 방향으로 섞음, 이방성 A·세기).
//   3. 밑칠(under): grade의 밉 4.5단계(아주 흐린 색)로 바탕을 채운다. 높이 = 0.5.
//   4. 획 층 세 개(굵기 36·18·8 px × 붓 크기): 칸마다 획 하나(oil-strokes.js), 획 = 방향장을 따라 6마디 구부러진 띠(정점 14개),
//      색 = 칸 중심의 grade 밉 색(층마다 3.8·2.6·1.4단계) + 난수 흔들림. 둘째·셋째 층은 세부가 있는 곳(밉 두 단계 밝기 차 > 문턱)에만.
//      붓털 잡음으로 가장자리·끝이 갈라진 알파, 높이(붓털 홈)를 함께 기록(MRT: 색 + 높이).
//   5. 보완 층(「세부 보존」, Hertzmann 1998): 지금까지의 칠을 사본으로 떠서, 칸 3×3 표본의 평균 오차(grade 밉 0.6단계와의 RGB 거리)가
//      문턱(0.22)을 넘는 칸에만 가는 획(굵기 3.5 px)을 최대 오차 지점에 칠한다 — 눈 하이라이트·입선 같은 세부가 살아난다.
//   6. 마무리(finish): 높이로 법선 → 왼쪽 위 빛의 확산·반사(강도에 비례), 캔버스 결(sin 격자), 비네트 → 화면(또는 보관 타깃).
//
// 원본과 다른 점:
//   - 입력: 원본은 영상·이미지의 sRGB 값을 그대로 쓴다. 우리 장면 타깃은 선형이므로 1단계에서 sRGB로 바꿔 같은 값에서 시작하고,
//     마무리에서 출력 색 공간(화면 = sRGB, 렌더 타깃 = 선형)에 맞춰 내보낸다.
//   - 처리 크기: 원본은 입력 크기와 상관없이 짧은 변 1080 px 그림에서 px 단위 수치를 쓴다(원본 allocate). 작업 P부터 post-fx.js가
//     oil-stroke를 늘 짧은 변 referenceShortSide(1080) px에서 처리하므로 비율은 1이다(다른 크기로 부르면 획 굵기·간격·길이·흐림을
//     짧은 변 / referenceShortSide 비율로 늘이고 줄이며 밉 단계에 log2(비율)을 더한다 — 시험·대체용).
//   - 얼굴 보호: 원본에는 없다. 곰돌이 얼굴 영역에서 faceProtect만큼 색 보정한 원본을 섞는다(IP 가이드, SYSTEM 4.11 기존 규칙 — 2.5D만,
//     영상 레이어는 얼굴 영역을 넘기지 않아 원본과 같다).
//   - 8비트 강등: 반정밀 타깃을 쓸 수 없으면 방향장 타깃을 8비트로 만들고 부호 있는 값을 0~1로 부호화한다(구조 텐서는 32배로 담음,
//     원본은 그 경우 값이 잘림). 정밀도가 낮아 원본과 같은 결과는 아니다(강등 경로).
//   - 획 띠: Three.js는 삼각형 띠를 그리지 않으므로 같은 정점 14개를 색인 삼각형 12개로 그린다(덮는 화소는 같다).
//   - 조작부: 원본과 같다(core/filter-params.js). 처리 해상도(q)는 원본에서도 이 프리셋 결과에 영향이 없어 값만 기억한다. 비교 위치(split)는 원본처럼
//     마무리에서 왼쪽을 필터 없는 원본으로(원본 uSrc = 올린 영상 그대로 → 우리는 장면 타깃을 sRGB로 바꾼 값).

import { createStrokeCache, makeStrokes } from './oil-strokes.js';

const QUAD_VERTEX = /* glsl */ `
in vec3 position;
in vec2 uv;
out vec2 vUV;
void main() {
  vUV = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const HEAD = /* glsl */ `
precision highp float;
precision highp int;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x), u.y); }
float lum(vec3 c){ return dot(c, vec3(.299,.587,.114)); }
vec3 toSrgb(vec3 c){ c = max(c, 0.); return mix(pow(c, vec3(1./2.4))*1.055 - .055, c*12.92, vec3(lessThanEqual(c, vec3(.0031308)))); }
vec3 toLinear(vec3 c){ return mix(pow((c + .055)/1.055, vec3(2.4)), c/12.92, vec3(lessThanEqual(c, vec3(.04045)))); }
`;

// 1. 색 보정(원본 FS_GRADE). 원본의 `mix(vec3(l), g, 1.0)`(채도 그대로)은 결과가 같아 뺐다.
const GRADE_FRAGMENT = /* glsl */ `${HEAD}
uniform sampler2D tScene;
uniform float uAmt;
in vec2 vUV;
out vec4 o;
void main(){
  vec3 c = clamp(toSrgb(texture(tScene, vUV).rgb), 0., 1.);
  vec3 g = c*vec3(1.035,1.0,0.94);
  float k = 0.08; g = g*(1.+k)/(1.+k*g);
  g = mix(g, vec3(.15,.10,.07), .03);
  o = vec4(mix(c, g, uAmt), 1.);
}`;

// 2a. 구조 텐서(원본 FS_SST). uTexel = 절반 해상도 화소(grade의 밉 1단계 근처를 읽는다 — 원본과 같음).
const SST_FRAGMENT = /* glsl */ `${HEAD}
uniform sampler2D uTex;
uniform vec2 uTexel;
in vec2 vUV;
out vec4 o;
float L(vec2 d){ return lum(texture(uTex, vUV + d*uTexel).rgb); }
void main(){
  float tl=L(vec2(-1,1)), t=L(vec2(0,1)), tr=L(vec2(1,1));
  float l=L(vec2(-1,0)), r=L(vec2(1,0));
  float bl=L(vec2(-1,-1)), b=L(vec2(0,-1)), br=L(vec2(1,-1));
  float gx = (tr + 2.*r + br - tl - 2.*l - bl)*.25;
  float gy = (tl + 2.*t + tr - bl - 2.*b - br)*.25;
  o = vec4(gx*gx, gy*gy, gx*gy, 1.);
#ifdef FLOW_BYTE
  o.xyz = vec3(o.xy*FLOW_BYTE_SCALE, o.z*FLOW_BYTE_SCALE*.5 + .5);
#endif
}`;

// 2b. 분리 가우스(원본 FS_BLUR).
const BLUR_FRAGMENT = /* glsl */ `${HEAD}
uniform sampler2D uTex;
uniform vec2 uDir;
uniform float uSigma;
in vec2 vUV;
out vec4 o;
void main(){
  vec4 s = vec4(0.); float ws = 0.; float R = ceil(2.*uSigma);
  for (int i=-12;i<=12;i++){ float fi=float(i); if (abs(fi)>R) continue;
    float w = exp(-fi*fi/(2.*uSigma*uSigma)); s += w*texture(uTex, vUV + fi*uDir); ws += w; }
  o = s/ws;
}`;

// 2c. 방향장(원본 FS_TFM): xy = 방향(cos, sin), z = 각, w = 이방성 × 세기.
const TFM_FRAGMENT = /* glsl */ `${HEAD}
uniform sampler2D uTex;
in vec2 vUV;
out vec4 o;
void main(){
  vec3 g = texture(uTex, vUV).xyz; float E=g.x, G=g.y, F=g.z;
#ifdef FLOW_BYTE
  E /= FLOW_BYTE_SCALE; G /= FLOW_BYTE_SCALE; F = (F*2. - 1.)/FLOW_BYTE_SCALE;
#endif
  float disc = sqrt((E-G)*(E-G) + 4.*F*F);
  float l1 = .5*(E+G+disc), l2 = .5*(E+G-disc);
  vec2 t = vec2(l1 - E, -F);
  t = length(t) > 1e-9 ? normalize(t) : vec2(0.,1.);
  float A = (l1+l2) > 1e-9 ? (l1-l2)/(l1+l2) : 0.;
  float str = (E+G)/(E+G+4e-5);
  float w = clamp(A*str*1.3, 0., 1.);
  vec2 d = vec2(cos(1.0472), sin(1.0472));
  vec2 t2 = vec2(t.x*t.x - t.y*t.y, 2.*t.x*t.y), d2 = vec2(d.x*d.x - d.y*d.y, 2.*d.x*d.y);
  vec2 m2 = mix(d2, t2, w);
  float ang = .5*atan(m2.y, m2.x);
  o = vec4(cos(ang), sin(ang), ang, A*str);
#ifdef FLOW_BYTE
  o.xy = o.xy*.5 + .5;
#endif
}`;

// 3. 밑칠(원본 FS_UNDER, 유화).
const UNDER_FRAGMENT = /* glsl */ `${HEAD}
uniform sampler2D uGrade;
uniform float uLodBias;
in vec2 vUV;
layout(location=0) out vec4 oC;
layout(location=1) out vec4 oH;
void main(){
  oC = vec4(textureLod(uGrade, vUV, 4.5 + uLodBias).rgb, 1.);
  oH = vec4(.5, .5, .5, 1.);
}`;

// 4·5. 획(원본 VS_STROKE, 유화 분기). aVid = 띠의 정점 번호 0~13(원본 gl_VertexID), aS = 획(중심 x·y, 난수 z·w).
const STROKE_VERTEX = /* glsl */ `${HEAD}
in float aVid;
in vec4 aS;
uniform sampler2D uGrade, uTFM, uCanvas;
uniform vec2 uRes;
uniform float uLen, uWid, uLod, uDetMin, uJit, uErrT, uCell;
out vec2 vSt; out vec3 vCol; out float vR;
const int NSEG = 6;
vec2 flowAt(vec2 uv){
  vec2 d = texture(uTFM, uv).xy;
#ifdef FLOW_BYTE
  d = d*2. - 1.;
#endif
  return d;
}
void main(){
  int vid = int(aVid + .5);
  int sec = vid / 2; float side = (vid % 2 == 0) ? -1. : 1.;
  vec2 c = aS.xy;
  bool keep = true;
  if (uErrT > 0.) {
    float sum = 0., best = -1.; vec2 bc = c;
    for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++){
      vec2 q = c + vec2(float(i), float(j))*uCell*.4/uRes;
      float e = length(textureLod(uGrade, q, uLod).rgb - texture(uCanvas, q).rgb);
      sum += e; if (e > best) { best = e; bc = q; }
    }
    if (sum/9. < uErrT) keep = false;
    c = bc;
  }
  vec3 col = textureLod(uGrade, c, uLod).rgb;
  float det = abs(lum(textureLod(uGrade, c, uLod).rgb) - lum(textureLod(uGrade, c, uLod + 2.5).rgb));
  if (uDetMin > 0. && det < uDetMin) keep = false;
  vec2 dir0 = flowAt(c);
  if (!keep) { gl_Position = vec4(2., 2., 2., 1.); return; }
  float t = float(sec)/float(NSEG) - .5;
  float L = uLen*(.75 + .5*aS.z), W = uWid*(.8 + .4*aS.w);
  vec2 p = c*uRes;
  float target = t*L, dist = abs(target), sgn = target < 0. ? -1. : 1.;
  vec2 dcur = dir0*sgn; float trav = 0.; float stepL = L/float(NSEG);
  for (int k=0; k<NSEG; k++){
    if (trav >= dist - 1e-3) break;
    float s = min(stepL, dist - trav);
    vec2 nd = flowAt(p/uRes);
    if (dot(nd, dcur) < 0.) nd = -nd;
    dcur = normalize(mix(dcur, nd, .7));
    p += dcur*s; trav += s;
  }
  vec2 tang = dist < 1e-3 ? dir0 : dcur*sgn;
  vec2 nrm = vec2(-tang.y, tang.x);
  float taper = mix(.55, 1., 1. - pow(abs(t)*2., 2.));
  p += nrm*side*W*.5*taper;
  gl_Position = vec4(p/uRes*2. - 1., 0., 1.);
  vSt = vec2(t + .5, side);
  vCol = clamp(col*(1. + (aS.z - .5)*uJit*2.)*vec3(1. + (aS.w - .5)*uJit, 1., 1. - (aS.w - .5)*uJit), 0., 1.);
  vR = aS.z*37.1 + aS.w*11.3;
}`;

// 원본 FS_STROKE 유화 분기: 붓털 홈이 길이 방향으로, 붓 끝에서 물감이 갈라진다.
const STROKE_FRAGMENT = /* glsl */ `${HEAD}
in vec2 vSt; in vec3 vCol; in float vR;
uniform float uLen, uWid;
layout(location=0) out vec4 oC;
layout(location=1) out vec4 oH;
void main(){
  float u = vSt.x, av = abs(vSt.y);
  float bris = vnoise(vec2(u*uLen/2.2, vSt.y*uWid*.45 + vR*13.));
  float edge = 1. - smoothstep(.72, 1., av + (bris - .5)*.4);
  float a = edge*smoothstep(0., .06, u)*smoothstep(1., .9, u);
  a *= mix(1., step(.38, bris), smoothstep(.7, 1., u));
  vec3 col = vCol*(.92 + .16*bris);
  float h = .3 + .6*bris*edge;
  a = clamp(a, 0., 1.);
  oC = vec4(col, a); oH = vec4(vec3(h), a);
}`;

// 5 앞. 지금까지의 칠 → 사본(원본 blitFramebuffer). 같은 크기·화소 중심이라 값이 그대로 옮겨진다.
const COPY_FRAGMENT = /* glsl */ `${HEAD}
uniform sampler2D uSrc;
in vec2 vUV;
out vec4 o;
void main(){ o = texture(uSrc, vUV); }`;

// 6. 마무리(원본 FS_COMPOSE 유화 분기 + 비네트 + 비교 위치 uSplit). 원본의 깜빡임(uFlick = 1)은 뺐다. 얼굴 보호는 우리 추가.
const FINISH_FRAGMENT = /* glsl */ `${HEAD}
uniform sampler2D uPaint, uHgt, uGrade, uSrc;
uniform vec2 uRes, uTexel;
uniform float uStr, uOutputSrgb, uFaceProtect, uAspect, uSplit;
uniform vec4 uFace;
in vec2 vUV;
out vec4 o;
float faceMask(vec2 uv){
  if (uFace.z <= 0.) return 0.;
  vec2 d = (uv - uFace.xy)*vec2(uAspect, 1.);
  return 1. - smoothstep(uFace.z*.75, uFace.z*1.05, length(d));
}
void main(){
  vec2 uv = vUV;
  vec3 c = texture(uPaint, uv).rgb;
  float h0 = texture(uHgt, uv).r, hx = texture(uHgt, uv + vec2(uTexel.x, 0.)).r, hy = texture(uHgt, uv + vec2(0., uTexel.y)).r;
  vec3 n = normalize(vec3((h0 - hx)*6.*uStr, (h0 - hy)*6.*uStr, 1.));
  vec3 Ld = normalize(vec3(-.5, .65, .8));
  float diff = dot(n, Ld), spec = pow(max(dot(reflect(-Ld, n), vec3(0.,0.,1.)), 0.), 22.)*.1*uStr;
  c = c*(.84 + .26*diff) + spec;
  vec2 q = uv*uRes/4.6;
  c *= 1. + .02*uStr*sin(q.x*6.2832)*sin(q.y*6.2832);
  c = mix(c, textureLod(uGrade, uv, 0.).rgb, faceMask(uv)*uFaceProtect);
  vec2 d = uv - .5; c *= 1. - .12*dot(d,d)*2.;
  if (uv.x < uSplit) c = toSrgb(texture(uSrc, uv).rgb);
  if (abs(uv.x - uSplit) < uTexel.x*1.5 && uSplit > 0.) c = vec3(1.);
  c = clamp(c, 0., 1.);
  o = vec4(uOutputSrgb > .5 ? c : toLinear(c), 1.);
}`;

// 띠의 정점 14개(0~13)를 색인 삼각형 12개로: (i, i+1, i+2).
const STRIP_VERTICES = 14;
const STRIP_INDEX = Array.from({ length: STRIP_VERTICES - 2 }, (_, i) => [i, i + 1, i + 2]).flat();

// 조정값(params)의 처음 값: 설정(config)에서. strength~split은 원본 조작부(core/filter-params.js), refine·refineThreshold·faceProtect는
// 조작부 없는 고정값(원본 프리셋 값·2.5D 얼굴 보호 — 장면 코드·테스트만 바꾼다).
export function oilStrokeDefaults(config) {
  return {
    strength: config.strength,
    size: config.size,
    boil: config.boil,
    grade: config.grade,
    split: config.split,
    refine: config.refine.enabled,
    refineThreshold: config.refine.errorThreshold,
    faceProtect: config.faceProtect,
  };
}

// 내부 해상도의 짧은 변 → 원본(짧은 변 referenceShortSide px) 대비 비율.
export function resolutionRatio(width, height, referenceShortSide) {
  return Math.min(width, height) / referenceShortSide;
}

// THREE: Three.js 모듈, renderer: WebGLRenderer, config: RENDER_STYLE.post.oilStroke.
export function createOilStrokeFilter(THREE, renderer, config) {
  let params = oilStrokeDefaults(config);
  let flowType = 'half';
  const TYPES = { half: THREE.HalfFloatType, byte: THREE.UnsignedByteType };
  let size = { width: 1, height: 1 };
  let ratio = 1;
  const cache = createStrokeCache();

  const flowTarget = (w, h) => new THREE.WebGLRenderTarget(w, h, { type: TYPES[flowType], depthBuffer: false });
  const makeTargets = () => {
    const { width: w, height: h } = size;
    const fw = Math.max(1, Math.round(w / 2));
    const fh = Math.max(1, Math.round(h / 2));
    return {
      grade: new THREE.WebGLRenderTarget(w, h, {
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
      }),
      sst: flowTarget(fw, fh),
      sst2: flowTarget(fw, fh),
      tfm: flowTarget(fw, fh),
      // 칠(색 + 높이, MRT)과 보완 층이 비교할 사본.
      paint: new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false, count: 2 }),
      paintCopy: new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false }),
    };
  };
  let targets = makeTargets();
  const disposeTargets = () => Object.values(targets).forEach((t) => t.dispose());

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeometry = new THREE.PlaneGeometry(2, 2);
  // 8비트 방향장: 작은 기울기가 0으로 잘리지 않게 텐서 값을 FLOW_BYTE_SCALE배 해서 담는다(강한 가장자리는 1에서 잘림 — 화질 저하는 로그 참고).
  const flowDefines = () => (flowType === 'byte' ? { FLOW_BYTE: '', FLOW_BYTE_SCALE: '32.0' } : {});
  // stage: 진단·테스트(가짜 렌더러)가 단계를 알아보는 이름.
  const material = (stage, fragmentShader, uniforms, extra = {}) =>
    new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERTEX,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
      userData: { postStage: stage },
      ...extra,
    });
  const v2 = () => ({ value: new THREE.Vector2(1, 1) });
  const gradeMaterial = material('grade', GRADE_FRAGMENT, { tScene: { value: null }, uAmt: { value: params.grade } });
  const sstMaterial = material('flow', SST_FRAGMENT, { uTex: { value: null }, uTexel: v2() }, { defines: flowDefines() });
  const blurMaterial = material('flow', BLUR_FRAGMENT, { uTex: { value: null }, uDir: v2(), uSigma: { value: config.flowSigma } });
  const tfmMaterial = material('flow', TFM_FRAGMENT, { uTex: { value: null } }, { defines: flowDefines() });
  const underMaterial = material('under', UNDER_FRAGMENT, { uGrade: { value: null }, uLodBias: { value: 0 } });
  const copyMaterial = material('refine-copy', COPY_FRAGMENT, { uSrc: { value: null } });
  const finishMaterial = material('finish', FINISH_FRAGMENT, {
    uPaint: { value: null },
    uHgt: { value: null },
    uGrade: { value: null },
    uRes: v2(),
    uTexel: v2(),
    uStr: { value: params.strength },
    uOutputSrgb: { value: 1 },
    uSrc: { value: null },
    uSplit: { value: 0 },
    uFaceProtect: { value: params.faceProtect },
    uAspect: { value: 16 / 9 },
    uFace: { value: new THREE.Vector4(0, 0, 0, 0) },
  });
  const blending = {
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.SrcAlphaFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  };
  const strokeUniforms = () => ({
    uGrade: { value: null },
    uTFM: { value: null },
    uCanvas: { value: null },
    uRes: v2(),
    uLen: { value: 1 },
    uWid: { value: 1 },
    uLod: { value: 0 },
    uDetMin: { value: 0 },
    uJit: { value: 0 },
    uErrT: { value: 0 },
    uCell: { value: 1 },
  });
  const strokeMaterial = (stage) =>
    new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: STROKE_VERTEX,
      fragmentShader: STROKE_FRAGMENT,
      uniforms: strokeUniforms(),
      defines: flowDefines(),
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      userData: { postStage: stage },
      ...blending,
    });
  const layerMaterial = strokeMaterial('strokes');
  const refineMaterial = strokeMaterial('refine');
  const materials = [gradeMaterial, sstMaterial, blurMaterial, tfmMaterial, underMaterial, copyMaterial, finishMaterial, layerMaterial, refineMaterial];

  const quad = new THREE.Mesh(quadGeometry, gradeMaterial);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const strokeMesh = new THREE.Mesh(quadGeometry, layerMaterial);
  strokeMesh.frustumCulled = false;
  const strokeScene = new THREE.Scene();
  strokeScene.add(strokeMesh);

  // 층마다 획 기하(인스턴스 수가 바뀌면 새로 만든다 — Three.js가 최대 인스턴스 수를 처음 한 번만 잰다).
  // 작업 Q(결함 수정): 정점 번호 속성(aVid)도 기하마다 따로 만든다. Three.js는 기하를 dispose()하면 그 기하의 **모든 속성 GL 버퍼를 지우고**
  // (WebGLGeometries onGeometryDispose), VAO 캐시는 속성 객체가 같으면 다시 묶지 않는다(WebGLBindingStates needsUpdate). 그래서 네 층이 aVid 하나를
  // 같이 쓰면, 붓·코 크기를 바꿔 층 기하를 새로 만들 때 이전 기하의 dispose가 공유 버퍼를 지워, 그때 묶여 있던 층(첫·둘째 층)의 VAO에서 aVid 버퍼가
  // 풀렸다 — 그 층의 그리기는 INVALID_OPERATION("no buffer is bound to enabled attribute")으로 거부되어 평평한 곳이 흐린 밑칠로 남았다
  // (2026-10-19 사용자 보고, 경위는 작업 Q 로그).
  const makeVidAttribute = () => new THREE.BufferAttribute(new Float32Array(STRIP_VERTICES).map((_, i) => i), 1);
  const layerGeometry = new Map(); // 층 번호 → { geometry, attribute, n, uploaded }
  function strokeGeometry(li, list) {
    let entry = layerGeometry.get(li);
    if (entry === undefined || entry.n !== list.n) {
      entry?.geometry.dispose();
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.setIndex(STRIP_INDEX);
      geometry.setAttribute('aVid', makeVidAttribute());
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(list.n * 4), 4);
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aS', attribute);
      geometry.instanceCount = list.n;
      entry = { geometry, attribute, n: list.n, uploaded: null };
      layerGeometry.set(li, entry);
    }
    // 내용이 바뀐 때만 올린다(획 다시 그리기 0이면 처음 한 번).
    if (list.changing || entry.uploaded !== list.data) {
      entry.attribute.array.set(list.data);
      entry.attribute.needsUpdate = true;
      entry.uploaded = list.data;
    }
    return entry.geometry;
  }
  function disposeGeometry() {
    for (const { geometry } of layerGeometry.values()) geometry.dispose();
    layerGeometry.clear();
  }

  let strokeCount = 0;
  let lastStrokeMs = null;
  let lastSeed = null;
  // 진단(작업 Q): 마지막 그림의 층별 인스턴스 수·칸 간격, 타깃을 새로 만든 횟수(세대).
  let layerStats = [];
  let generation = 0;

  // 첫 층 칠함 확인(작업 Q — 실패를 숨기지 않음): 첫 층은 세부 문턱·오차 문턱이 없어 획이 있으면 반드시 화소를 칠한다(원본도 같음).
  // 실행 중 그리기는 GL 오류를 읽지 않으므로(경로 시험 때만 — 작업 Q의 공유 aVid 결함은 첫·둘째 층 그리기가 INVALID_OPERATION으로 거부됐는데도
  // 보이지 않았다), 획 그리기 실패를 WebGL2 화소 통과 질의(ANY_SAMPLES_PASSED_CONSERVATIVE)로 확인한다 — 첫 층이 칠한 화소가 있는지 본다.
  // 결과는 몇 프레임 뒤 나오므로 그 뒤에 읽는다.
  // 획이 있는데 COVERAGE_FAIL_LIMIT 그림 연속 화소 0이면: 층 기하를 버려 다음 그림에 새로 만들고(자가 복구), health를 실패로 둔다
  // (부르는 쪽 — 영상 레이어·2.5D 장면 — 이 준비 상태·경로로 전달). 실패한 뒤에는 **통과하는 결과를 읽어야만** 다시 정상이다(결과가 늦거나 안 오면 실패 유지).
  // 결과는 그림을 그릴 때 말고도 pollHealth()로 수거한다(검수 반영, 기준 9e11950 필수 1 — 후처리를 그리지 않는 복구 중에도 읽음).
  // 질의를 못 쓰는 환경이면 확인 안 함(supported false).
  const COVERAGE_FAIL_LIMIT = 2;
  const COVERAGE_PENDING_MAX = 4;
  const gl = renderer.getContext?.() ?? null;
  const coverageTarget = gl && typeof gl.createQuery === 'function' ? gl.ANY_SAMPLES_PASSED_CONSERVATIVE : undefined;
  const coverage = { supported: coverageTarget !== undefined, pending: [], failedStreak: 0, checked: 0, failures: 0, lastOk: null, ok: true, detail: null };
  function pollCoverage() {
    while (coverage.pending.length > 0 && gl.getQueryParameter(coverage.pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
      const { query, n } = coverage.pending.shift();
      const passed = Boolean(gl.getQueryParameter(query, gl.QUERY_RESULT));
      gl.deleteQuery(query);
      coverage.checked += 1;
      coverage.lastOk = passed || n === 0;
      if (coverage.lastOk) {
        coverage.failedStreak = 0;
        coverage.ok = true;
        coverage.detail = null;
        continue;
      }
      coverage.failedStreak += 1;
      coverage.failures += 1;
      if (coverage.failedStreak >= COVERAGE_FAIL_LIMIT) {
        coverage.ok = false;
        coverage.detail = `첫 획 층이 화면을 칠하지 못함(획 ${n}개, 화소 0, ${coverage.failedStreak}그림 연속)`;
        disposeGeometry(); // 자가 복구: 다음 그림에 층 기하를 새로 만든다
      }
    }
  }
  function disposeCoverage() {
    for (const { query } of coverage.pending.splice(0)) gl.deleteQuery(query);
  }

  function pass(materialToUse, target) {
    quad.material = materialToUse;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, camera);
  }

  // 획 층 하나를 칠 타깃(MRT)에 그린다. 반환: 그린 획 수(버린 획 포함).
  function drawLayer(li, layer, materialToUse, seed, errorThreshold) {
    const k = ratio * params.size;
    const started = performance.now();
    const list = makeStrokes(cache, { li, spacing: layer.spacingPx * k, W: size.width, H: size.height, boil: params.boil, seed });
    lastStrokeMs += performance.now() - started;
    const u = materialToUse.uniforms;
    u.uGrade.value = targets.grade.texture;
    u.uTFM.value = targets.tfm.texture;
    u.uCanvas.value = targets.paintCopy.texture;
    u.uRes.value.set(size.width, size.height);
    u.uLen.value = layer.lengthPx * k;
    u.uWid.value = layer.widthPx * k;
    u.uLod.value = layer.lod + Math.log2(ratio);
    u.uDetMin.value = layer.detailMin ?? 0;
    u.uJit.value = 0.05 * params.strength;
    u.uErrT.value = errorThreshold;
    u.uCell.value = layer.spacingPx * k;
    strokeMesh.geometry = strokeGeometry(li, list);
    strokeMesh.material = materialToUse;
    renderer.setRenderTarget(targets.paint);
    const checkCoverage = coverage.supported && li === 0 && coverage.pending.length < COVERAGE_PENDING_MAX;
    const query = checkCoverage ? gl.createQuery() : null;
    if (query !== null) gl.beginQuery(coverageTarget, query);
    try {
      renderer.render(strokeScene, camera);
    } finally {
      if (query !== null) {
        gl.endQuery(coverageTarget);
        coverage.pending.push({ query, n: list.n });
      }
    }
    layerStats.push({ li, n: list.n, instanceCount: strokeMesh.geometry.instanceCount, spacing: layer.spacingPx * k });
    return list.n;
  }

  return {
    name: 'oil-stroke',
    // 내부 해상도(px)를 정한다. 같으면 아무것도 하지 않는다.
    setSize(width, height) {
      if (width === size.width && height === size.height) return;
      size = { width, height };
      ratio = resolutionRatio(width, height, config.referenceShortSide);
      disposeTargets();
      disposeGeometry();
      targets = makeTargets();
      generation += 1;
    },
    // 방향장 타깃 형식('half' | 'byte'). 장면 타깃은 post-fx.js가 바꾼다.
    configure(type) {
      if (type === flowType) return;
      flowType = type;
      disposeTargets();
      targets = makeTargets();
      for (const m of [sstMaterial, tfmMaterial, layerMaterial, refineMaterial]) {
        m.defines = flowDefines();
        m.needsUpdate = true;
      }
    },
    setParams(next) {
      params = { ...params, ...next };
    },
    get params() {
      return { ...params };
    },
    // 첫 층 칠함 확인 결과(작업 Q). ok false면 부르는 쪽이 실패로 다룬다. pending = 아직 결과를 못 읽은 질의 수, checked = 읽은 결과 수.
    get health() {
      return { ok: coverage.ok, detail: coverage.detail, supported: coverage.supported, pending: coverage.pending.length, checked: coverage.checked };
    },
    // 그리지 않고 도착한 질의 결과만 수거한다(복구 중·정지 페이지). 반환: health.
    pollHealth() {
      if (coverage.supported) pollCoverage();
      return this.health;
    },
    // 실행할 단계 구성(검수 반영, 기준 a5c33f6 필수 1): 이 값이 바뀌는 조정값은 시험하지 않은 단계를 운영 중에 처음 돌리므로
    // post-fx.js가 다시 시험을 요청한다. 지금은 보완 층(refine-copy·refine)을 켜고 끄는 것만 단계 구성을 바꾼다.
    get stages() {
      return ['grade', 'flow', 'under', 'strokes', ...(params.refine ? ['refine-copy', 'refine'] : []), 'finish'].join(',');
    },
    // 내부 해상도에서 쓰는 비율·획 수·획 목록 CPU 시간·마지막 그림 번호(진단).
    get stats() {
      const sizeOf = (t) => `${t.width}x${t.height}`;
      return {
        ratio, strokes: strokeCount, strokeMs: lastStrokeMs, flowType, seed: lastSeed, generation, size: sizeOf(size),
        targets: Object.fromEntries(Object.entries(targets).map(([name, t]) => [name, sizeOf(t)])),
        layers: layerStats.map((l) => ({ ...l })),
        coverage: { supported: coverage.supported, ok: coverage.ok, checked: coverage.checked, failures: coverage.failures, lastOk: coverage.lastOk, pending: coverage.pending.length },
      };
    },
    // sceneTexture(선형) → target(null = 화면). face: { x, y, radius } 또는 null. seed: 그림 번호(0~996).
    // autoClear·렌더 타깃은 부르는 쪽(post-fx.js)이 되돌린다.
    render(sceneTexture, target, { face = null, seed = 0 } = {}) {
      if (coverage.supported) pollCoverage();
      renderer.autoClear = false;
      const fw = targets.sst.width;
      const fh = targets.sst.height;
      gradeMaterial.uniforms.tScene.value = sceneTexture;
      gradeMaterial.uniforms.uAmt.value = params.grade;
      pass(gradeMaterial, targets.grade);
      sstMaterial.uniforms.uTex.value = targets.grade.texture;
      sstMaterial.uniforms.uTexel.value.set(1 / fw, 1 / fh);
      pass(sstMaterial, targets.sst);
      blurMaterial.uniforms.uSigma.value = Math.min(6, config.flowSigma * ratio);
      blurMaterial.uniforms.uTex.value = targets.sst.texture;
      blurMaterial.uniforms.uDir.value.set(1 / fw, 0);
      pass(blurMaterial, targets.sst2);
      blurMaterial.uniforms.uTex.value = targets.sst2.texture;
      blurMaterial.uniforms.uDir.value.set(0, 1 / fh);
      pass(blurMaterial, targets.sst);
      tfmMaterial.uniforms.uTex.value = targets.sst.texture;
      pass(tfmMaterial, targets.tfm);
      underMaterial.uniforms.uGrade.value = targets.grade.texture;
      underMaterial.uniforms.uLodBias.value = Math.log2(ratio);
      pass(underMaterial, targets.paint);
      strokeCount = 0;
      lastStrokeMs = 0;
      lastSeed = seed;
      layerStats = [];
      config.layers.forEach((layer, li) => {
        strokeCount += drawLayer(li, layer, layerMaterial, seed, 0);
      });
      if (params.refine) {
        copyMaterial.uniforms.uSrc.value = targets.paint.textures[0];
        pass(copyMaterial, targets.paintCopy);
        strokeCount += drawLayer(config.layers.length, config.refine, refineMaterial, seed, params.refineThreshold);
      }
      const f = finishMaterial.uniforms;
      f.uPaint.value = targets.paint.textures[0];
      f.uHgt.value = targets.paint.textures[1];
      f.uGrade.value = targets.grade.texture;
      f.uRes.value.set(size.width, size.height);
      f.uTexel.value.set(1 / size.width, 1 / size.height);
      f.uStr.value = params.strength;
      f.uFaceProtect.value = params.faceProtect;
      f.uSrc.value = sceneTexture;
      f.uSplit.value = params.split ?? 0;
      f.uAspect.value = size.width / size.height;
      if (face === null) f.uFace.value.set(0, 0, 0, 0);
      else f.uFace.value.set(face.x, face.y, face.radius, 0);
      // 화면(null)은 sRGB로, 렌더 타깃은 선형으로 내보낸다(보관 타깃은 sRGB 텍스처라 하드웨어가 부호화한다).
      f.uOutputSrgb.value = target === null ? 1 : 0;
      pass(finishMaterial, target);
    },
    dispose() {
      if (coverage.supported) disposeCoverage();
      disposeTargets();
      disposeGeometry();
      quadGeometry.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
