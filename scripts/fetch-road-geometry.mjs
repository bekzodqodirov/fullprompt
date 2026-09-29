// Fetch the corridor's REAL road geometry ONCE and write
// src/modules/wms/tracking/road-geometry.ts (round 109, the owner's «B»).
//
// Run: pnpm fetch-road-geometry                  (every leg)
//      pnpm fetch-road-geometry --only yw_hor,nzl_yal   (just those)
//
// Why a script and not a runtime call: the corridors are FIXED, so the roads
// need computing exactly once. Nothing in the running app ever calls a
// routing service — the map draws stored points, at zero server cost, with
// no key, no quota and no dependency on anybody's uptime. Re-run this only
// when a road really changes.
//
// The border legs are fetched SEPARATELY on purpose (KA→Irkeshtam, then
// Irkeshtam→Osh; the Horgos road's Nur Zholy→Yallama, then Yallama→Tashkent):
// a routing engine will not drive a lorry through a closed customs post, and
// the schedule has always modelled the wait as its own stationary leg anyway.
//
// The output MERGES (the Horgos round): a run fetches only what it was asked
// for and every other stored leg stays byte-identical. This container cannot
// reach OSRM and the CI runner can (.github/workflows/road-geometry.yml), so
// a partial run is the normal case — and the old whole-file rewrite from one
// run's `out` would have erased every leg a failed request left out.
//
// The corridor's endpoints, copied EXACTLY from map-data.ts's `P` block —
// `tests/unit/route-shape.test.ts` pins every stored leg against those same
// constants AND pins this block against map-data's, because a hand-typed
// coordinate is how the first run of this script fetched Kashgar → a point
// 80 km short of the Irkeshtam post and started the Kyrgyz leg inside China.
const P = {
  YW: [120.07, 29.31], GZ: [113.26, 23.13], KA: [75.98, 39.47], UCH: [87.62, 43.83],
  IRK: [73.91, 39.68], OSH: [72.8, 40.53], AND: [72.34, 40.78], TAS: [69.24, 41.31],
  HOR: [80.459135, 44.154112], NZL: [80.3958, 44.1577], YAL: [69.3587, 41.479],
};
const LEGS = [
  ['yw_ka', P.YW, P.KA], ['gz_ka', P.GZ, P.KA], ['uch_ka', P.UCH, P.KA],
  ['ka_irk', P.KA, P.IRK], ['irk_osh', P.IRK, P.OSH],
  ['osh_and', P.OSH, P.AND], ['and_tas', P.AND, P.TAS], ['osh_tas', P.OSH, P.TAS],
  // The Horgos road (2026-09-29): China to the Horgos warehouse, then
  // through Kazakhstan to the Yallama post and on to Tashkent.
  ['yw_hor', P.YW, P.HOR], ['gz_hor', P.GZ, P.HOR], ['uch_hor', P.UCH, P.HOR],
  ['nzl_yal', P.NZL, P.YAL], ['yal_tas', P.YAL, P.TAS],
];

const onlyArg = (() => {
  const i = process.argv.indexOf('--only');
  if (i < 0) return null;
  const raw = (process.argv[i + 1] ?? '').trim();
  return raw ? new Set(raw.split(',').map((k) => k.trim()).filter(Boolean)) : null;
})();
if (onlyArg) {
  const known = new Set(LEGS.map(([key]) => key));
  const unknown = [...onlyArg].filter((k) => !known.has(k));
  if (unknown.length) {
    console.error(`unknown leg(s): ${unknown.join(', ')} — known: ${[...known].join(', ')}`);
    process.exit(1);
  }
}

const perp = (p, a, b) => {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
function dp(points, tol) {
  if (points.length < 3) return points;
  let idx = 0, max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perp(points[i], points[0], points[points.length - 1]);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= tol) return [points[0], points[points.length - 1]];
  return [...dp(points.slice(0, idx + 1), tol).slice(0, -1), ...dp(points.slice(idx), tol)];
}
const fetched = new Map();
for (const [key, a, b] of LEGS) {
  if (onlyArg && !onlyArg.has(key)) continue;
  const url = `https://router.project-osrm.org/route/v1/driving/${a[0]},${a[1]};${b[0]},${b[1]}?overview=full&geometries=geojson`;
  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch (err) {
    // One unreachable leg must not cost the others (or the stored file).
    console.log(`${key}: FETCH FAILED (${err?.cause?.code ?? err?.message ?? err}) — the stored leg, if any, is kept`);
    continue;
  }
  const r = data.routes?.[0];
  if (!r) { console.log(`${key}: NO ROUTE (${data.code}) — the stored leg, if any, is kept`); continue; }
  const raw = r.geometry.coordinates;
  // Tolerance ~0.02° ≈ 2 km: finer than the map can draw at corridor zoom.
  const simp = dp(raw, 0.02).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
  const pts = simp.filter((c, i) => i === 0 || c[0] !== simp[i-1][0] || c[1] !== simp[i-1][1]);
  const km = Math.round(r.distance / 1000);
  fetched.set(
    key,
    `  // ${key} — ${km} km by road, ${pts.length} points\n` +
      `  ${key}: [${pts.map((p) => `[${p[0]},${p[1]}]`).join(',')}],\n`,
  );
  console.log(`${key}: ${km} km · raw ${raw.length} → ${pts.length} points`);
  await new Promise((r) => setTimeout(r, 1500));
}

const fs = await import('node:fs');
const target = 'src/modules/wms/tracking/road-geometry.ts';
const existing = fs.readFileSync(target, 'utf8');
const at = existing.indexOf('export const ROAD_LEG_POINTS');
const header = existing.slice(0, at);
// Every stored leg, its comment line with it, byte for byte.
const stored = new Map();
for (const m of existing.slice(at).matchAll(/^(?:  \/\/ (\w+) — [^\n]*\n)?  (\w+): (\[.*\]),\n/gm)) {
  stored.set(m[2], m[0]);
}
let body = '';
const order = [...LEGS.map(([key]) => key), ...[...stored.keys()].filter((k) => !LEGS.some(([l]) => l === k))];
for (const key of order) {
  const leg = fetched.get(key) ?? stored.get(key);
  if (leg) body += leg;
}
fs.writeFileSync(target, `${header}export const ROAD_LEG_POINTS: Record<string, [number, number][]> = {\n${body}};\n`);
console.log(
  'wrote', target, Math.round(body.length / 1024), 'KB of points;',
  `fetched ${fetched.size} (${[...fetched.keys()].join(', ') || 'none'}), kept ${[...stored.keys()].filter((k) => !fetched.has(k)).length}`,
);
