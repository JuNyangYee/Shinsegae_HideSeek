// [이식] ThrowSnow D:/2026-09_ShinsegaeChristmas/006_Works/003_ThrowSnow/public/display/render/oil-strokes.js (HEAD 1fa49de283a46cd8ca73da5a7d50e6b77a32e842)
// 2026-10-21 숨바꼭질에 사용자 요청(같은 유화 필터)으로 내용 그대로 복사했다 — 셰이더·획 알고리즘·기본값을 바꾸지 않는다.
// 아래 원문 주석의 작업 기호·docs 경로·SYSTEM 절은 ThrowSnow 저장소 기준이다. 숨바꼭질 쪽 설명은 docs/SYSTEM.md 7장.
//
// 유화 · 획 필터의 획 목록 (작업 N). DOM·Three.js에 의존하지 않는 순수 모듈 — 브라우저(oil-stroke-fx.js)와 Node 테스트가 같은 파일을 쓴다.
//
// 출처: 팀 동료의 「재료 필터 갤러리」(https://nau-filter-gallery.vercel.app/, 2026-10-16 배포본)의 `ihash`·`makeStrokes`를 옮겼다.
// 소스 저장소는 없고 배포된 단일 HTML의 스크립트를 읽어 같은 계산을 다시 썼다(분석: docs/logs/2026-10-16-03-oil-filter-port.md).
//
// 획 하나 = [중심 x, 중심 y (0~1), 난수 z, 난수 w] (Float32 네 개). 칸(간격 spacing px) 하나에 획 하나를 두고 칸 안에서 위치를 흔든다.
// 그리는 순서는 열쇠(난수)로 섞는다. 「획 다시 그리기」(boil) 비율만큼의 칸은 그림마다(seed마다) 새 위치·난수·순서를 쓰고,
// 나머지(고정 획)는 처음 한 번만 만들어 정렬해 둔다. 결과는 매번 전부 다시 만들어 정렬한 것과 같다(열쇠가 같으면 칸 번호 순).

// 정수 → 0~1. 같은 입력이면 늘 같은 값(원본과 비트 단위로 같아야 한다 — 곱은 2^53 안이라 정확하고 `| 0`이 2^32로 접는다).
export function ihash(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 층 번호 li의 씨앗 기준값(원본 그대로).
export const layerBase = (li) => 1000 + li * 97;

// 그림 번호(시드)의 범위: 원본은 tick % 997.
export const SEED_PERIOD = 997;

// n번째 그림(1부터 센 그린 횟수)의 시드. 996 다음은 0으로 돈다(post-fx.js가 쓴다).
export function drawingSeed(drawCount) {
  return ((drawCount % SEED_PERIOD) + SEED_PERIOD) % SEED_PERIOD;
}

const CACHE_LIMIT = 16;

// 획 목록 캐시. 한 필터 인스턴스가 하나를 가진다(원본의 strokeCache).
export function createStrokeCache() {
  return new Map();
}

// li: 층 번호(보완 층은 층 수), spacing: 칸 간격(px, 소수 가능), W·H: 그림 크기(px), boil: 0~1, seed: 그림 번호(0~996).
// 반환: { data: Float32Array(n × 4), n, changing } — changing은 boil > 0이라 seed마다 내용이 바뀌는가(아니면 같은 배열을 계속 돌려준다).
export function makeStrokes(cache, { li, spacing, W, H, boil, seed }) {
  const gw = Math.ceil(W / spacing);
  const gh = Math.ceil(H / spacing);
  const n = gw * gh;
  const base = layerBase(li);
  const put = (i, sd, d, o) => {
    d[o] = ((i % gw) + ihash(i, sd, 2)) * spacing / W;
    d[o + 1] = (Math.floor(i / gw) + ihash(i, sd, 3)) * spacing / H;
    d[o + 2] = ihash(i, sd, 4);
    d[o + 3] = ihash(i, sd, 5);
    return Math.fround(ihash(i, sd, 6));
  };
  const key = `${li}|${spacing}|${W}|${H}|${boil}`;
  let entry = cache.get(key);
  if (!entry) {
    const fixed = [];
    const vary = [];
    for (let i = 0; i < n; i += 1) (ihash(i, base, 1) >= boil ? fixed : vary).push(i);
    const m = fixed.length;
    const d = new Float32Array(m * 4);
    const k = new Float32Array(m);
    const ord = new Uint32Array(m);
    for (let j = 0; j < m; j += 1) {
      k[j] = put(fixed[j], base, d, j * 4);
      ord[j] = j;
    }
    ord.sort((a, b) => k[a] - k[b] || a - b);
    const F = { data: new Float32Array(m * 4), key: new Float32Array(m), id: new Uint32Array(m) };
    for (let j = 0; j < m; j += 1) {
      const s = ord[j];
      F.key[j] = k[s];
      F.id[j] = fixed[s];
      for (let c = 0; c < 4; c += 1) F.data[j * 4 + c] = d[s * 4 + c];
    }
    // 그림마다 쓰는 작업 배열(다시 그리는 획의 값·열쇠·순서)도 항목에 두고 재사용한다(검수 반영, 기준 a5c33f6 권장 8 — 그림마다 수백 KB 할당 없음).
    const mv = vary.length;
    entry = { F, vary: Uint32Array.from(vary), out: new Float32Array(n * 4), vd: new Float32Array(mv * 4), vk: new Float32Array(mv), vo: new Uint32Array(mv) };
    cache.set(key, entry);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  const { F, vary, out, vd, vk, vo } = entry;
  const m = vary.length;
  if (m === 0) return { data: F.data, n, changing: false };
  const sd = base + (seed + 1) * 7919;
  // 값·열쇠는 매번 모두 다시 쓰고, 순서는 처음 번호로 되돌린 뒤 정렬한다(비교가 열쇠·번호로 완전히 정해져 결과는 이전 순서와 무관).
  for (let j = 0; j < m; j += 1) {
    vk[j] = put(vary[j], sd, vd, j * 4);
    vo[j] = j;
  }
  vo.sort((a, b) => vk[a] - vk[b] || a - b);
  // 정렬된 두 목록을 열쇠(같으면 칸 번호) 순으로 합친다.
  for (let a = 0, b = 0, o = 0; o < n; o += 1) {
    const useF = b >= m || (a < F.key.length && (F.key[a] < vk[vo[b]] || (F.key[a] === vk[vo[b]] && F.id[a] < vary[vo[b]])));
    if (useF) {
      for (let c = 0; c < 4; c += 1) out[o * 4 + c] = F.data[a * 4 + c];
      a += 1;
    } else {
      const s = vo[b];
      for (let c = 0; c < 4; c += 1) out[o * 4 + c] = vd[s * 4 + c];
      b += 1;
    }
  }
  return { data: out, n, changing: true };
}

// 비교·테스트용: 캐시 없이 모든 칸을 그 seed로 만들어 한꺼번에 정렬한 목록(원본 주석의 "전부 다시 만든 것"). 느리다.
export function makeStrokesNaive({ li, spacing, W, H, boil, seed }) {
  const gw = Math.ceil(W / spacing);
  const gh = Math.ceil(H / spacing);
  const n = gw * gh;
  const base = layerBase(li);
  const sdVary = base + (seed + 1) * 7919;
  const items = [];
  for (let i = 0; i < n; i += 1) {
    const sd = ihash(i, base, 1) >= boil ? base : sdVary;
    items.push({
      i,
      v: [((i % gw) + ihash(i, sd, 2)) * spacing / W, (Math.floor(i / gw) + ihash(i, sd, 3)) * spacing / H, ihash(i, sd, 4), ihash(i, sd, 5)],
      k: Math.fround(ihash(i, sd, 6)),
    });
  }
  items.sort((a, b) => a.k - b.k || a.i - b.i);
  const data = new Float32Array(n * 4);
  items.forEach((item, o) => data.set(item.v, o * 4));
  return { data, n };
}
