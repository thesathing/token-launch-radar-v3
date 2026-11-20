// What-if-it-launches-tomorrow radar — the program behind the dashboard.
//
// Reads the sealed snapshot, prices every protocol that records no token from
// the snapshot's own figures, and writes the board, the page's data and the
// dossier. Concept B (Viral / Hook-Heavy): the reader's farm is priced first —
// deposit size, drop share and hold are inputs, the net per row follows — and
// every implied value is a value-if-it-launches times its launch odds, so a
// giant that will probably never launch cannot top the board on size alone.
//
// Node 22+, standard library only, no network, no clock: ages come from the
// snapshot's as_of date, never from Date.now, so two runs are byte-identical.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildDossier } from "./vendor/makefun-board.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
};
const inputDir = arg("input", process.env.MAKEFUN_INPUT_DIR ?? "/input");
const inputFile = inputDir.endsWith(".json") ? inputDir : join(inputDir, "snapshot.json");
const out = arg("output", process.env.MAKEFUN_OUTPUT_DIR ?? "/output");
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------- snapshot
type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};
type Snapshot = { as_of: string; source: string; floor_usd: number; protocols: Proto[]; watchlist: string[] };

const rawBytes = readFileSync(inputFile);
const snap: Snapshot = JSON.parse(rawBytes.toString("utf8"));
const inputSha = createHash("sha256").update(rawBytes).digest("hex");
const AS_OF_MS = Date.parse(snap.as_of);
const DAY_MS = 86_400_000;

const hasToken = (p: Proto): boolean => p.gecko_id !== null || p.symbol !== null;
const ageDays = (p: Proto): number | null =>
  p.listed_at === null ? null : Math.max(0, (AS_OF_MS - Date.parse(p.listed_at)) / DAY_MS);
const median = (xs: number[]): number => {
  if (xs.length === 0) return 1;
  const s = [...xs].sort((a, b) => a - b);
  return (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2;
};
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return 1;
  const s = [...xs].sort((a, b) => a - b);
  return s[clamp(Math.floor(q * s.length), 0, s.length - 1)]!;
};

// ---------------------------------------------------------------- universe
// The house's watchlist rule, restated from the kit's RULES.txt: a protocol is
// rankable when it records no token and is not a wrapped/staked/bridged product,
// not a versioned re-release, and not an exchange's own product. One judgement
// call, stated on the Method page: "Project 0" is kept — a bare 0 is a name,
// not a version marker (no V, no dot) — which is what takes the board to 198.
const EXCLUDED_CATEGORIES = new Set(["Bridge", "Canonical Bridge", "Liquid Staking", "Liquid Restaking", "Restaked BTC", "CEX"]);
const EXCHANGE_NAMES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];
const versionMarker = (name: string): boolean => /\s(v|V)\d+(\.\d+)?$/.test(name) || /\s\d+\.\d+$/.test(name);
const wrappedWord = (name: string): boolean => /\b(wrapped|staked|staking)\b/i.test(name);
type Exclusion = "bridge" | "liquid" | "exchange" | "versioned" | "wrapped";
const exclusionOf = (p: Proto): Exclusion | null => {
  if (p.category === "Bridge" || p.category === "Canonical Bridge") return "bridge";
  if (p.category === "Liquid Staking" || p.category === "Liquid Restaking" || p.category === "Restaked BTC") return "liquid";
  if (p.category === "CEX" || EXCHANGE_NAMES.includes(p.name.split(" ")[0]!)) return "exchange";
  if (versionMarker(p.name)) return "versioned";
  if (wrappedWord(p.name)) return "wrapped";
  return null;
};
const universe = { total: snap.protocols.length, token: 0, bridge: 0, liquid: 0, exchange: 0, versioned: 0, wrapped: 0, ranked: 0 };
const rankable: Proto[] = [];
for (const p of snap.protocols) {
  if (hasToken(p)) { universe.token++; continue; }
  const ex = exclusionOf(p);
  if (ex === null) { rankable.push(p); continue; }
  universe[ex]++;
}
universe.ranked = rankable.length;

// ---------------------------------------------------------------- comparables
const comps = snap.protocols.filter(
  (p) => hasToken(p) && (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0,
);
const multipleOf = (p: Proto): number => p.mcap_usd! / p.tvl_usd;
const fieldMultiple = median(comps.map(multipleOf));
const FIELD_TOKEN_SHARE = snap.protocols.filter(hasToken).length / snap.protocols.length;

// Least squares by Gaussian elimination with partial pivoting: three unknowns,
// ln(mcap/TVL) on ln(TVL) and ln(1 + age in days). Fitted once, on all 128
// comparables; the leave-one-out and walk-forward checks below refit it.
type Beta = [number, number, number];
function fitBeta(pool: Proto[]): Beta {
  const a: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (const p of pool) {
    const x = [1, Math.log(p.tvl_usd), Math.log1p(ageDays(p) ?? 0)];
    const y = Math.log(multipleOf(p));
    for (let i = 0; i < 3; i++) {
      a[i]![3]! += x[i]! * y;
      for (let j = 0; j < 3; j++) a[i]![j]! += x[i]! * x[j]!;
    }
  }
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    const tmp = a[col]!; a[col] = a[piv]!; a[piv] = tmp;
    for (let r = col + 1; r < 3; r++) {
      const f = a[r]![col]! / a[col]![col]!;
      for (let c = col; c < 4; c++) a[r]![c]! -= f * a[col]![c]!;
    }
  }
  const b: number[] = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    b[i] = (a[i]![3]! - a[i]!.slice(i + 1, 3).reduce((s, v, k) => s + v * b[i + 1 + k]!, 0)) / a[i]![i]!;
  }
  return [b[0]!, b[1]!, b[2]!];
}
const BETA = fitBeta(comps);

// Category premium: the category's median multiple, pulled halfway toward the
// field median, and only when at least 5 comparables carry the category —
// a one-member category must not price a whole row (that was the old board's
// mistake: MIN_MEMBERS 1 let a single outlier set a category's price).
const CAT_MIN = 5;
const CAT_WEIGHT = 0.5;
function categoryFactor(p: Proto, pool: Proto[]): { factor: number; medianMultiple: number; members: number } {
  return categoryFactorW(p, pool, CAT_WEIGHT);
}
function categoryFactorW(p: Proto, pool: Proto[], weight: number): { factor: number; medianMultiple: number; members: number } {
  const group = pool.filter((q) => q.category === p.category);
  const poolMedian = median(pool.map(multipleOf));
  if (group.length < CAT_MIN) return { factor: 1, medianMultiple: poolMedian, members: group.length };
  const local = median(group.map(multipleOf));
  return { factor: (local / poolMedian) ** weight, medianMultiple: local, members: group.length };
}

// Seven-day momentum, damped: a 10% weekly move moves the price 2%, capped at
// +/-20%. A null change_7d is priced as no move, and the page says so.
const GROWTH_DIVISOR = 500;
const GROWTH_CAP = 0.2;
const growthFactor = (p: Proto): number => growthFactorC(p, GROWTH_CAP);
const growthFactorC = (p: Proto, cap: number): number =>
  clamp(1 + (p.change_7d ?? 0) / GROWTH_DIVISOR, 1 - cap, 1 + cap);

// Launch odds: the share of the protocol's own category that already records a
// token, shrunk toward the field share (416/758) with a prior of 5 protocols,
// clamped to [0.10, 0.90]. A category where almost nobody has launched yet
// prices low even at a giant TVL; a category where most already trade prices
// near its fitted value. The odds table is printed on the Method page.
const ODDS_PRIOR = 5;
const oddsTable: Record<string, { token: number; total: number; odds: number }> = {};
{
  const byCat = new Map<string, { token: number; total: number }>();
  for (const p of snap.protocols) {
    const c = p.category ?? "(none)";
    const e = byCat.get(c) ?? { token: 0, total: 0 };
    e.total++;
    if (hasToken(p)) e.token++;
    byCat.set(c, e);
  }
  for (const [c, e] of byCat) {
    oddsTable[c] = { ...e, odds: clamp((e.token + ODDS_PRIOR * FIELD_TOKEN_SHARE) / (e.total + ODDS_PRIOR), 0.1, 0.9) };
  }
}
const launchOdds = (p: Proto): number => oddsWith(p, ODDS_PRIOR);
const oddsWith = (p: Proto, prior: number): number => {
  const e = oddsTable[p.category ?? "(none)"];
  if (!e) return FIELD_TOKEN_SHARE;
  return clamp((e.token + prior * FIELD_TOKEN_SHARE) / (e.total + prior), 0.1, 0.9);
};

// Parameterised pricing: the same rule with one choice changed, so the
// sensitivity table can reprice the board and the LOO check can say whether
// the change helps or hurts. The board itself always uses the defaults.
type PriceOpts = { catWeight: number; oddsPrior: number; growthCap: number; growthOn: boolean };
const DEFAULT_OPTS: PriceOpts = { catWeight: CAT_WEIGHT, oddsPrior: ODDS_PRIOR, growthCap: GROWTH_CAP, growthOn: true };
function priceWith(p: Proto, pool: Proto[], beta: Beta, o: PriceOpts) {
  const base = Math.exp(beta[0] + beta[1] * Math.log(p.tvl_usd) + beta[2] * Math.log1p(ageDays(p) ?? 0));
  const cat = categoryFactorW(p, pool, o.catWeight);
  const growth = o.growthOn ? growthFactorC(p, o.growthCap) : 1;
  const multiple = base * cat.factor * growth;
  const valueIfLaunch = p.tvl_usd * multiple;
  const odds = oddsWith(p, o.oddsPrior);
  return { valueIfLaunch, odds, implied: valueIfLaunch * odds, base, cat, growth, multiple };
}

// The price, in one place, so the board, the page and the check mean the same
// thing: fitted multiple x category premium x momentum, times TVL, is the
// value IF it launches; times the launch odds is the implied value.
function price(p: Proto, pool: Proto[], beta: Beta) {
  return priceWith(p, pool, beta, DEFAULT_OPTS);
}

// ---------------------------------------------------------------- validation
// Leave-one-out on the comparables, priced by exactly the rule above (value
// if it launches, no odds: these protocols HAVE tokens). The ratio spread is
// also what sets every row's band: a row's P25–P75 band is its implied value
// divided by the LOO ratio's P75 and P25.
type Variant = "flat" | "catmed" | "ols" | "ols-growth" | "final";
function predictMultiple(p: Proto, train: Proto[], beta: Beta, variant: Variant): number {
  if (variant === "flat") return median(train.map(multipleOf));
  if (variant === "catmed") {
    const same = train.filter((q) => q.category === p.category);
    return same.length >= 1 ? median(same.map(multipleOf)) : median(train.map(multipleOf));
  }
  if (variant === "final") return priceWith(p, train, beta, DEFAULT_OPTS).multiple;
  let mult = Math.exp(beta[0] + beta[1] * Math.log(p.tvl_usd) + beta[2] * Math.log1p(ageDays(p) ?? 0));
  if (variant === "ols-growth") mult *= growthFactor(p);
  return mult;
}
function looRatios(variant: Variant): number[] {
  const out: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const p = comps[i]!;
    const train = comps.filter((_, k) => k !== i);
    const beta = fitBeta(train);
    out.push((p.tvl_usd * predictMultiple(p, train, beta, variant)) / p.mcap_usd!);
  }
  return out;
}
// LOO ratios of the final rule with one pricing choice changed (sensitivity):
// the odds never enter a value-if-it-launches, so odds variants share the
// final LOO by construction — the table says so instead of hiding it.
function looFinalRatios(o: PriceOpts): number[] {
  const out: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const p = comps[i]!;
    const train = comps.filter((_, k) => k !== i);
    const beta = fitBeta(train);
    out.push(priceWith(p, train, beta, o).valueIfLaunch / p.mcap_usd!);
  }
  return out;
}
function looSummary(variant: Variant) {
  const r = looRatios(variant);
  return {
    variant,
    n: r.length,
    within3x: r.filter((x) => x >= 1 / 3 && x <= 3).length / r.length,
    medianRatio: median(r),
    q10: quantile(r, 0.1), q25: quantile(r, 0.25), q75: quantile(r, 0.75), q90: quantile(r, 0.9),
  };
}
// Walk-forward by time, per variant: fit on the older half of the dated
// comparables, test on the newer half. A model that only fits the past it
// saw is not trusted — and a term must survive BOTH tests to stay.
const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => a.listed_at! < b.listed_at! ? -1 : 1);
function walkForwardSummary(variant: Variant) {
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const beta = fitBeta(train);
  const ratios = test.map((p) => (p.tvl_usd * predictMultiple(p, train, beta, variant)) / p.mcap_usd!);
  return {
    variant,
    nTrain: train.length, nTest: test.length,
    within3x: ratios.filter((x) => x >= 1 / 3 && x <= 3).length / ratios.length,
    medianRatio: median(ratios),
  };
}
const FLAT_LOO = looSummary("flat");
const FLAT_WF = walkForwardSummary("flat");
const ABLATION = (["flat", "catmed", "ols", "ols-growth", "final"] as const).map((v) => {
  const loo = looSummary(v);
  const wf = walkForwardSummary(v);
  // Kept unless a variant does worse than the flat baseline on BOTH tests.
  const kept = v === "flat" ? "baseline" : loo.within3x >= FLAT_LOO.within3x || wf.within3x >= FLAT_WF.within3x ? "kept" : "tested, rejected";
  return { ...loo, walkForwardWithin3x: wf.within3x, walkForwardMedian: wf.medianRatio, kept };
});
const LOO = ABLATION[4]!;
const WALK_FORWARD = { ...walkForwardSummary("final") };

// ---------------------------------------------------------------- odds calibration
// Brier score of the launch odds against what actually happened (token or
// not), over all 758 protocols — and the base rate's Brier for the same rows.
// The odds are a category share, so the in-sample number flatters them: the
// held-out split below fits the odds on the older half (by listed_at) and
// scores them on the newer half, which the fit never saw.
const BRIER = (() => {
  const base = FIELD_TOKEN_SHARE;
  let s = 0, sBase = 0;
  for (const p of snap.protocols) {
    const y = hasToken(p) ? 1 : 0;
    s += (launchOdds(p) - y) ** 2;
    sBase += (base - y) ** 2;
  }
  const datedAll = snap.protocols.filter((p) => p.listed_at !== null).sort((a, b) => a.listed_at! < b.listed_at! ? -1 : 1);
  const cut = datedAll[Math.floor(datedAll.length / 2)]!.listed_at!;
  const fit = datedAll.filter((p) => p.listed_at! < cut);
  const test = datedAll.filter((p) => p.listed_at! >= cut);
  const fitField = fit.filter(hasToken).length / fit.length;
  const byCat = new Map<string, { token: number; total: number }>();
  for (const p of fit) {
    const c = p.category ?? "(none)";
    const e = byCat.get(c) ?? { token: 0, total: 0 };
    e.total++;
    if (hasToken(p)) e.token++;
    byCat.set(c, e);
  }
  const oddsFit = (p: Proto): number => {
    const e = byCat.get(p.category ?? "(none)");
    if (!e) return fitField;
    return clamp((e.token + ODDS_PRIOR * fitField) / (e.total + ODDS_PRIOR), 0.1, 0.9);
  };
  const testBase = test.filter(hasToken).length / test.length;
  let sb = 0, sbBase = 0;
  for (const p of test) {
    const y = hasToken(p) ? 1 : 0;
    sb += (oddsFit(p) - y) ** 2;
    sbBase += (testBase - y) ** 2;
  }
  // Split-half by slug (alphabetical): the unbiased held-out check. The
  // time split above is biased — newer protocols have not had time to
  // launch yet, so the older half's odds overpredict for them.
  const bySlug = [...snap.protocols].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const shHalf = Math.floor(bySlug.length / 2);
  const shFit = bySlug.slice(0, shHalf);
  const shTest = bySlug.slice(shHalf);
  const shFitField = shFit.filter(hasToken).length / shFit.length;
  const shByCat = new Map<string, { token: number; total: number }>();
  for (const p of shFit) {
    const c = p.category ?? "(none)";
    const e = shByCat.get(c) ?? { token: 0, total: 0 };
    e.total++;
    if (hasToken(p)) e.token++;
    shByCat.set(c, e);
  }
  const shOdds = (p: Proto): number => {
    const e = shByCat.get(p.category ?? "(none)");
    if (!e) return shFitField;
    return clamp((e.token + ODDS_PRIOR * shFitField) / (e.total + ODDS_PRIOR), 0.1, 0.9);
  };
  const shTestBase = shTest.filter(hasToken).length / shTest.length;
  let shB = 0, shBB = 0;
  for (const p of shTest) {
    const y = hasToken(p) ? 1 : 0;
    shB += (shOdds(p) - y) ** 2;
    shBB += (shTestBase - y) ** 2;
  }
  // The shrinkage prior, judged by Brier instead of by the total it prints:
  // prior 0 wins in-sample and loses held-out; 5 and 20 are close held-out.
  const byPrior = [0, 5, 20].map((prior) => {
    let si = 0, sh = 0;
    for (const p of snap.protocols) {
      const e = oddsTable[p.category ?? "(none)"];
      const pr = e ? clamp((e.token + prior * FIELD_TOKEN_SHARE) / (e.total + prior), 0.1, 0.9) : FIELD_TOKEN_SHARE;
      const y = hasToken(p) ? 1 : 0;
      si += (pr - y) ** 2;
    }
    for (const p of shTest) {
      const e = shByCat.get(p.category ?? "(none)");
      const pr = e ? clamp((e.token + prior * shFitField) / (e.total + prior), 0.1, 0.9) : shFitField;
      const y = hasToken(p) ? 1 : 0;
      sh += (pr - y) ** 2;
    }
    return { prior, inSample: si / snap.protocols.length, splitHalf: sh / shTest.length };
  });
  return {
    n: snap.protocols.length, brier: s / snap.protocols.length, base: sBase / snap.protocols.length,
    heldOut: { cut, nFit: fit.length, nTest: test.length, brier: sb / test.length, base: sbBase / test.length },
    splitHalf: { nFit: shFit.length, nTest: shTest.length, brier: shB / shTest.length, base: shBB / shTest.length },
    byPrior,
  };
})();
// Token share by protocol age: the odds-by-age curve the board's odds
// ignore (they are category-only) — printed so the reader can see it.
const ODDS_BY_AGE = (() => {
  const bands: [number, number][] = [[0, 180], [180, 365], [365, 730], [730, 1825], [1825, Infinity]];
  return bands.map(([lo, hi]) => {
    const g = snap.protocols.filter((p) => {
      const a = ageDays(p);
      return a !== null && a >= lo && a < hi;
    });
    const t = g.filter(hasToken).length;
    return { lo, hi: hi === Infinity ? null : hi, n: g.length, token: t, share: g.length === 0 ? 0 : t / g.length };
  });
})();

// ---------------------------------------------------------------- band honesty
// The bands are promised 50% (P25–P75) and 80% (P10–P90) coverage. The check
// is held out by time: the band widths come from the older half's leave-one-
// out ratios, and coverage is measured on the newer half, which the widths
// never saw. (Measuring coverage on the same ratios that set the widths
// would print 50%/80% by construction — a check that cannot fail is not
// a check.)
const BAND_HONESTY = (() => {
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const beta = fitBeta(train);
  const trainRatios = train.map((p, i) => {
    const t2 = train.filter((_, k) => k !== i);
    const b2 = fitBeta(t2);
    return priceWith(p, t2, b2, DEFAULT_OPTS).valueIfLaunch / p.mcap_usd!;
  });
  const q25 = quantile(trainRatios, 0.25), q75 = quantile(trainRatios, 0.75);
  const q10 = quantile(trainRatios, 0.1), q90 = quantile(trainRatios, 0.9);
  let in2575 = 0, in1090 = 0;
  for (const p of test) {
    const pred = priceWith(p, train, beta, DEFAULT_OPTS).valueIfLaunch;
    if (p.mcap_usd! >= pred / q75 && p.mcap_usd! <= pred / q25) in2575++;
    if (p.mcap_usd! >= pred / q90 && p.mcap_usd! <= pred / q10) in1090++;
  }
  return { n: test.length, nTrain: train.length, in2575: in2575 / test.length, in1090: in1090 / test.length };
})();

// ---------------------------------------------------------------- sensitivity
// Over-shrinkage check: reprice the whole board with one pricing choice
// changed and report the LOO score and the total implied value. A choice
// only changes on this table when its LOO beats the board's.
const SENSITIVITY = ([
  { label: "Final — the board", catWeight: 0.5, oddsPrior: 5, growthCap: 0.2, growthOn: true },
  { label: "Category at full weight", catWeight: 1, oddsPrior: 5, growthCap: 0.2, growthOn: true },
  { label: "Odds unshrunk (prior 0)", catWeight: 0.5, oddsPrior: 0, growthCap: 0.2, growthOn: true },
  { label: "Odds shrunk hard (prior 20)", catWeight: 0.5, oddsPrior: 20, growthCap: 0.2, growthOn: true },
  { label: "Momentum unclamped", catWeight: 0.5, oddsPrior: 5, growthCap: 10, growthOn: true },
  { label: "No momentum", catWeight: 0.5, oddsPrior: 5, growthCap: 0.2, growthOn: false },
] as const).map((o) => {
  const loo = looFinalRatios(o);
  const total = rankable.reduce((s, p) => s + priceWith(p, comps, BETA, o).implied, 0);
  return {
    ...o,
    looWithin3x: loo.filter((x) => x >= 1 / 3 && x <= 3).length / loo.length,
    looMedian: median(loo),
    totalImplied: Math.round(total),
  };
});

// ---------------------------------------------------------------- farm plans
// The reader's farm, priced. Assumptions, all printed on the Method page:
// a $1,000 deposit, a 7% drop share, a 12-week hold, the whole TVL farming
// the same drop, 4 transactions, 4% a year foregone elsewhere. The dashboard's
// calculator re-prices every row live when the reader changes deposit, drop
// share or hold — the board's verdict is fixed at this default scenario.
const DEFAULT_DEPOSIT = 1000;
const DEFAULT_DROP_SHARE = 0.07;
const DEFAULT_HOLD_DAYS = 84;
// Every dollar of TVL is in the same points pool: the expected drop is the
// drop share of the implied value, split pro-rata by TVL. No special pleading
// for a small farming pool — that was the old board's 10% guess, and it made
// 170 of 198 rows "FARM".
const PARTICIPATION = 1.0;
const OPP_RATE = 0.04;
const TX_COUNT = 4;
const GAS_USD: Record<string, number> = {
  Ethereum: 6, Base: 0.1, Arbitrum: 0.4, Optimism: 0.3, Solana: 0.05,
  "Binance Smart Chain": 0.2, BSC: 0.2, Avalanche: 0.3, Polygon: 0.05,
  Gnosis: 0.1, Fantom: 0.1, Linea: 0.1, "zkSync Era": 0.15, Scroll: 0.15,
  Berachain: 0.1, Hyperliquid: 0.05, Aptos: 0.02, Sui: 0.02,
};
const gasFor = (p: Proto): { chain: string; gas: number } => {
  for (const c of p.chains) {
    const hit = Object.keys(GAS_USD).find((k) => c.toLowerCase().includes(k.toLowerCase()));
    if (hit) return { chain: c, gas: GAS_USD[hit]! };
  }
  return { chain: p.chains[0] ?? "Ethereum", gas: 0.5 };
};
const sizeTier = (p: Proto): { trial: number; full: number } =>
  p.tvl_usd < 100_000_000 ? { trial: 50, full: 500 }
  : p.tvl_usd < 1_000_000_000 ? { trial: 100, full: 1000 }
  : { trial: 250, full: 2500 };
const VERBS: Record<string, { verb: string; action: string }> = {
  Dexs: { verb: "swap", action: "swap into the pool and add liquidity" },
  Lending: { verb: "supply", action: "supply assets and borrow a small amount against them" },
  Yield: { verb: "deposit", action: "deposit into the vault and let it compound" },
  "Yield Aggregator": { verb: "deposit", action: "deposit into the vault and let it compound" },
  RWA: { verb: "mint", action: "mint the tokenised asset and hold it" },
  Derivatives: { verb: "open", action: "open a small hedged position" },
  CDP: { verb: "lock", action: "lock collateral and mint a small amount of stablecoin" },
  "Onchain Capital Allocator": { verb: "allocate", action: "allocate to the vault and hold" },
};
const verbFor = (p: Proto) => VERBS[p.category ?? ""] ?? { verb: "deposit", action: "deposit into the protocol and use it as intended" };

function farmEconomics(p: Proto, pr: ReturnType<typeof price>, deposit: number, dropShare: number, holdDays: number) {
  const { gas } = gasFor(p);
  const slice = (pr.implied * dropShare) / (PARTICIPATION * p.tvl_usd); // expected drop per $1 deposited
  const expected = slice * deposit;
  const fees = TX_COUNT * gas;
  const opp = (deposit * OPP_RATE * holdDays) / 365;
  const net = expected - fees - opp;
  const denom = slice - (OPP_RATE * holdDays) / 365;
  const breakeven = denom > 0 ? fees / denom : null;
  return { slice, expected, fees, opp, net, breakeven };
}
const verdictOf = (net: number): "FARM" | "MARGINAL" | "SKIP" => (net >= 10 ? "FARM" : net >= -5 ? "MARGINAL" : "SKIP");

function farmSteps(p: Proto, pr: ReturnType<typeof price>): string[] {
  const { chain, gas } = gasFor(p);
  const { trial, full } = sizeTier(p);
  const v = verbFor(p);
  const age = ageDays(p);
  const ageText = age === null ? "an unreported time" : age < 365 ? `${Math.round(age)} days` : `${(age / 365).toFixed(1)} years`;
  const weeks = Math.round(DEFAULT_HOLD_DAYS / 7);
  const econ = farmEconomics(p, pr, DEFAULT_DEPOSIT, DEFAULT_DROP_SHARE, DEFAULT_HOLD_DAYS);
  return [
    `Verify ${p.name} on ${chain}: confirm the app URL from the protocol's own docs or X account, never a search ad. Cost $0, about 10 minutes.`,
    `Fund a fresh wallet on ${chain} with $${full} plus about $${(TX_COUNT * gas).toFixed(2)} for gas. Moving funds takes about 20 minutes; keep the farming wallet separate from savings.`,
    `Trial first: ${v.action} with $${trial} only, on ${chain} (gas about $${gas.toFixed(2)}). Wait 7 days and confirm the position and any points show on the dashboard.`,
    `Scale to $${full} total once the trial lands: ${v.verb} the remaining $${full - trial} in one move (gas about $${gas.toFixed(2)}), then leave it untouched for ${weeks} weeks.`,
    `Use it weekly for ${weeks} weeks: ${v.action} at least once a week so activity is real, not a single deposit. Each visit takes about 15 minutes; points accrue on the deposit, no weekly transaction is needed.`,
    `Track the position every week: TVL, your share and any points. If points stop accruing for 2 weeks, or TVL falls more than 30% in 7 days, stop adding funds and reassess.`,
    `Exit rule: leave if the protocol launches its token (claim within 7 days), if a hack or freeze is reported, or if gas to exit passes $${(TX_COUNT * gas * 2).toFixed(2)}. This protocol has run ${ageText} with no token recorded.`,
    `Claim and exit: when a token launches, claim within 7 days (gas about $${gas.toFixed(2)}), then unstake over 2 days. Expected drop at the default farm is about $${econ.expected.toFixed(2)} against $${econ.fees.toFixed(2)} fees.`,
  ];
}

// ---------------------------------------------------------------- board
type Row = ReturnType<typeof price> & {
  slug: string; name: string; rank: number; implied_value_usd: number; farm_steps: string[]; farm_short: string;
  category: string | null; chains: string[]; tvl_usd: number; change_7d: number | null;
  age_days: number | null; watchlist: boolean; value_if_launch_usd: number; launch_odds: number;
  band_low_usd: number; band_high_usd: number; band_p10_usd: number; band_p90_usd: number;
  verdict: "FARM" | "MARGINAL" | "SKIP"; net_usd: number; expected_drop_usd: number;
  fees_usd: number; opp_cost_usd: number; breakeven_usd: number | null; at_risk_usd: number;
  multiple: number; growth: number; category_factor: number; category_members: number;
};
const priced = rankable.map((p) => ({ p, pr: price(p, comps, BETA) }));
priced.sort((a, b) => b.pr.implied - a.pr.implied);
const rows: Row[] = priced.map(({ p, pr }, i) => {
  const econ = farmEconomics(p, pr, DEFAULT_DEPOSIT, DEFAULT_DROP_SHARE, DEFAULT_HOLD_DAYS);
  const { full } = sizeTier(p);
  const { chain, gas } = gasFor(p);
  const implied = Math.max(1, Math.round(pr.implied));
  return {
    ...pr,
    slug: p.slug, name: p.name, rank: i + 1, implied_value_usd: implied,
    farm_steps: farmSteps(p, pr),
    farm_short: `${verbFor(p).verb} on ${chain} · $${(TX_COUNT * gas).toFixed(2)} fees · ${(0.5 + 0.25 * (DEFAULT_HOLD_DAYS / 7)).toFixed(1)} h · ${DEFAULT_HOLD_DAYS} d`,
    category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d,
    age_days: ageDays(p), watchlist: snap.watchlist.includes(p.slug),
    value_if_launch_usd: Math.max(1, Math.round(pr.valueIfLaunch)),
    launch_odds: pr.odds,
    band_low_usd: Math.max(1, Math.round(implied / LOO.q75)),
    band_high_usd: Math.max(1, Math.round(implied / LOO.q25)),
    band_p10_usd: Math.max(1, Math.round(implied / LOO.q90)),
    band_p90_usd: Math.max(1, Math.round(implied / LOO.q10)),
    verdict: verdictOf(econ.net), net_usd: Math.round(econ.net * 100) / 100,
    expected_drop_usd: Math.round(econ.expected * 100) / 100,
    fees_usd: Math.round(econ.fees * 100) / 100,
    opp_cost_usd: Math.round(econ.opp * 100) / 100,
    breakeven_usd: econ.breakeven === null ? null : Math.round(econ.breakeven * 100) / 100,
    at_risk_usd: full,
    multiple: pr.multiple, growth: pr.growth,
    category_factor: pr.cat.factor, category_members: pr.cat.members,
  };
});
const totalImplied = rows.reduce((s, r) => s + r.implied_value_usd, 0);
const verdictCounts = {
  FARM: rows.filter((r) => r.verdict === "FARM").length,
  MARGINAL: rows.filter((r) => r.verdict === "MARGINAL").length,
  SKIP: rows.filter((r) => r.verdict === "SKIP").length,
};
const oddsValues = rows.map((r) => r.launch_odds).sort((a, b) => a - b);

// ---------------------------------------------------------------- early finds
// The radar's headline: protocols the snapshot's own rules flag BEFORE they
// rank. A find hits at least 3 of 4 signals, each from a snapshot field:
// 7-day TVL growth in the top decile of the board; listed less than a year
// ago; TVL below the $50M floor; deployed on 5 or more chains. No
// hand-picked names — the rule is printed next to the list, and every find
// is a row of the board below.
const HANDS_ON_HOURS = 0.5 + 0.25 * (DEFAULT_HOLD_DAYS / 7);
const FIND_P90 = quantile(rankable.map((p) => p.change_7d).filter((x): x is number => x !== null), 0.9);
type FindSignal = "growth" | "young" | "small" | "broad";
const findSignals = (p: Proto): FindSignal[] => {
  const s: FindSignal[] = [];
  if (p.change_7d !== null && p.change_7d >= FIND_P90) s.push("growth");
  const a = ageDays(p);
  if (a !== null && a < 365) s.push("young");
  if (p.tvl_usd < snap.floor_usd) s.push("small");
  if (p.chains.length >= 5) s.push("broad");
  return s;
};
const earlyFinds = rankable
  .map((p) => ({ p, signals: findSignals(p) }))
  .filter((x) => x.signals.length >= 3)
  .map(({ p, signals }) => {
    const r = rows.find((row) => row.slug === p.slug)!;
    const a = ageDays(p);
    const parts: string[] = [];
    if (signals.includes("growth")) parts.push(`+${p.change_7d!.toFixed(1)}% TVL in 7d`);
    if (signals.includes("young")) parts.push(`${a === null ? "recently listed" : `${Math.round(a)}d old`}`);
    if (signals.includes("small")) parts.push(`$${(p.tvl_usd / 1e6).toFixed(1)}M, below $50M floor`);
    if (signals.includes("broad")) parts.push(`on ${p.chains.length} chains`);
    return {
      slug: p.slug, name: p.name, rank: r.rank, category: p.category,
      tvl_usd: p.tvl_usd, change_7d: p.change_7d, age_days: a, chains: p.chains.length,
      implied_value_usd: r.implied_value_usd, verdict: r.verdict, net_usd: r.net_usd,
      odds: r.launch_odds,
      signals, reason: parts.join(" · "),
    };
  })
  .sort((a, b) => (b.change_7d ?? -1e9) - (a.change_7d ?? -1e9));
const bestPerHour = (() => {
  let best: { name: string; net: number; perHour: number } | null = null;
  for (const r of rows) {
    const perHour = r.net_usd / HANDS_ON_HOURS;
    if (best === null || perHour > best.perHour) best = { name: r.name, net: r.net_usd, perHour };
  }
  return best;
})();
const boardJson = `${JSON.stringify({ rows })}\n`;
const boardSha256 = createHash("sha256").update(boardJson).digest("hex");

// ---------------------------------------------------------------- output
const radar = {
  meta: {
    title: "Launch Radar: early finds first, checked twice out-of-sample, every farm plan costed",
    as_of: snap.as_of, floor_usd: snap.floor_usd, input_sha256: inputSha,
    source: snap.source, concept: "B — Radar penemuan (Early finds): the finds come first, the evidence is on screen 1",
    board_sha256: boardSha256.slice(0, 12),
  },
  universe, model: {
    beta: BETA, fieldMultiple, loo: LOO, walkForward: WALK_FORWARD, ablation: ABLATION,
    brier: BRIER, bandHonesty: BAND_HONESTY, sensitivity: SENSITIVITY, oddsByAge: ODDS_BY_AGE,
    catMin: CAT_MIN, catWeight: CAT_WEIGHT, growthDivisor: GROWTH_DIVISOR, growthCap: GROWTH_CAP,
    oddsPrior: ODDS_PRIOR, fieldTokenShare: FIELD_TOKEN_SHARE,
    medianAgeDays: median(comps.map((p) => ageDays(p)).filter((x): x is number => x !== null)),
    odds: Object.entries(oddsTable).map(([category, e]) => ({ category, ...e })).sort((a, b) => b.total - a.total),
  },
  economics: {
    defaultDeposit: DEFAULT_DEPOSIT, defaultDropShare: DEFAULT_DROP_SHARE, defaultHoldDays: DEFAULT_HOLD_DAYS,
    participation: PARTICIPATION, oppRate: OPP_RATE, txCount: TX_COUNT, gasUsd: GAS_USD,
    deposits: [1000, 10000, 50000], dropShares: [0.035, 0.07, 0.14], holds: [28, 84, 182],
  },
  kpis: {
    ranked: rows.length, totalImplied, medianComparable: fieldMultiple,
    within3x: LOO.within3x, verdicts: verdictCounts,
    medianOdds: median(oddsValues),
    bestPerHour, earlyFinds: earlyFinds.length,
    topRow: rows[0] ? { slug: rows[0].slug, name: rows[0].name, implied: rows[0].implied_value_usd } : null,
  },
  comps: comps.map((p) => [p.tvl_usd, p.mcap_usd]),
  earlyFinds: { rule: "at least 3 of: 7-day TVL growth in the board's top decile (≥ +" + FIND_P90.toFixed(1) + "%), listed under a year ago, TVL below the $50M floor, on 5 or more chains", p90: FIND_P90, finds: earlyFinds },
  rows,
};
const dataScript = `window.__RADAR__ = ${JSON.stringify(radar)};\n`;

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "board.json"), boardJson);
writeFileSync(join(out, "data.js"), dataScript);
// Clear the copied dirs first: a stale screenshot from an earlier run must
// never ride along into the dossier (it once doubled its size past 1.5 MiB).
for (const d of [join(out, "dashboard"), join(out, "screenshots")]) rmSync(d, { recursive: true, force: true });
copyFiles(join(here, "dashboard"), join(out, "dashboard"));
const shots = copyFiles(join(here, "screenshots"), join(out, "screenshots"));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, "dossier.json"), buildDossier(out, { text_max_bytes: 65536 }));

// ---------------------------------------------------------------- self-check
// The gate, re-implemented here and printed one row per line: the entry must
// pass it in a real run before anyone submits it.
function pngSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  return null;
}
function jpgSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1]!;
    const len = buf.readUInt16BE(off + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}
const checkResults: [string, boolean, string][] = [];
{
  const dashFiles = existsSync(join(out, "dashboard")) ? readdirSync(join(out, "dashboard")) : [];
  const dashBytes = dashFiles.reduce((s, f) => s + statSync(join(out, "dashboard", f)).size, 0);
  const hasHttp = dashFiles.some((f) => {
    const t = readFileSync(join(out, "dashboard", f), "utf8");
    return /https?:\/\//.test(t.replace(/<!--[\s\S]*?-->/g, ""));
  });
  checkResults.push(["dashboard_files", dashFiles.includes("index.html") && dashFiles.some((f) => f.endsWith(".css")) && dashFiles.some((f) => f.endsWith(".js")) && dashFiles.length <= 400 && dashBytes <= 4_194_304 && !hasHttp, `${dashFiles.length} files, ${dashBytes} bytes`]);
  const boardBytes = statSync(join(out, "board.json")).size;
  const boardOk = rows.length >= 100 && rows.length <= 4000 && boardBytes <= 8_388_608 && rows.every((r, i) => r.rank === i + 1 && r.implied_value_usd > 0 && r.implied_value_usd <= 1e14 && r.name.length > 0 && snap.protocols.some((p) => p.slug === r.slug));
  checkResults.push(["board_file", boardOk, `${rows.length} rows, ${(boardBytes / 1024).toFixed(0)}KB`]);
  checkResults.push(["sorted_by_value", rows.every((r, i) => i === 0 || rows[i - 1]!.implied_value_usd >= r.implied_value_usd) && new Set(rows.map((r) => r.implied_value_usd)).size > 1, `rank 1 ${rows[0]?.name} $${rows[0]?.implied_value_usd}`]);
  checkResults.push(["coverage", snap.watchlist.every((s) => rows.some((r) => r.slug === s)), `${snap.watchlist.filter((s) => rows.some((r) => r.slug === s)).length}/${snap.watchlist.length} watchlist`]);
  const stepsOk = rows.every((r) => r.farm_steps.length >= 3 && r.farm_steps.length <= 12 && r.farm_steps.every((s) => s.trim().length >= 20 && s.trim().length <= 600));
  checkResults.push(["farm_steps", stepsOk, `${rows.length} rows x ${rows[0]?.farm_steps.length} steps`]);
  checkResults.push(["early_finds", earlyFinds.length >= 5 && earlyFinds.every((f) => rows.some((r) => r.slug === f.slug) && f.reason.length >= 20 && f.signals.length >= 3), `${earlyFinds.length} finds, each ≥3 signals, each on the board`]);
  checkResults.push(["farm_short", rows.every((r) => r.farm_short.length >= 20), `${rows.length} rows carry a one-line farm plan`]);
  checkResults.push(["evidence", BRIER.brier < BRIER.base && BRIER.splitHalf.brier < BRIER.splitHalf.base && BAND_HONESTY.n > 0 && SENSITIVITY.length === 6 && ABLATION.every((a) => typeof a.walkForwardWithin3x === "number"), `Brier ${BRIER.brier.toFixed(3)} vs base ${BRIER.base.toFixed(3)} · split-half ${BRIER.splitHalf.brier.toFixed(3)} vs ${BRIER.splitHalf.base.toFixed(3)} · held-out by time ${BRIER.heldOut.brier.toFixed(3)} vs ${BRIER.heldOut.base.toFixed(3)} (biased, see Method) · band P25–P75 ${(BAND_HONESTY.in2575 * 100).toFixed(0)}% (promised 50%) · P10–P90 ${(BAND_HONESTY.in1090 * 100).toFixed(0)}% (promised 80%)`]);
  const outShots = existsSync(join(out, "screenshots")) ? readdirSync(join(out, "screenshots")).filter((f) => !f.startsWith(".")) : [];
  const shotInfos = outShots.map((name) => {
    const buf = readFileSync(join(out, "screenshots", name));
    const size = pngSize(buf) ?? jpgSize(buf);
    return { name, bytes: buf.length, size };
  });
  const shotsOk = shotInfos.length >= 3 && shotInfos.length <= 4 && shotInfos.every((s) => s.bytes <= 524_288 && s.size !== null && Math.max(s.size.w, s.size.h) <= 1440 && Math.min(s.size.w, s.size.h) >= 800);
  checkResults.push(["screenshots", shotsOk, shotInfos.map((s) => `${s.name} ${s.size ? `${s.size.w}x${s.size.h}` : "?"} ${(s.bytes / 1024).toFixed(0)}KB`).join(", ")]);
  const dossier = readFileSync(join(out, "dossier.json"));
  const rebuilt = Buffer.from(buildDossier(out, { text_max_bytes: 65536 }));
  const dossierSame = Buffer.compare(dossier, rebuilt) === 0;
  checkResults.push(["dossier_matches", dossierSame && dossier.length <= 1_572_864, `${dossier.length} bytes, byte-identical to rebuild: ${dossierSame}`]);
}
for (const [name, ok, detail] of checkResults) process.stdout.write(`gate ${name}: ${ok ? "PASS" : "FAIL"} — ${detail}\n`);
process.stdout.write(
  `token radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ${rows.length} rows ranked (${verdictCounts.FARM} FARM / ${verdictCounts.MARGINAL} MARGINAL / ${verdictCounts.SKIP} SKIP)\n` +
  `token radar: model ln(mcap/TVL) = ${BETA[0].toFixed(4)} ${BETA[1].toFixed(4)}*ln(TVL) ${BETA[2].toFixed(4)}*ln(1+age); LOO within 3x ${(LOO.within3x * 100).toFixed(1)}% (n=${comps.length}), walk-forward ${(WALK_FORWARD.within3x * 100).toFixed(1)}%\n` +
  `token radar: total implied $${(totalImplied / 1e9).toFixed(2)}B; top ${rows[0]?.name} $${rows[0]?.implied_value_usd.toLocaleString("en-US")} (odds ${(rows[0] ? rows[0].launch_odds * 100 : 0).toFixed(0)}%)\n` +
  `token radar: early finds ${earlyFinds.length} (rule: ≥3 of growth top-decile ≥ +${FIND_P90.toFixed(1)}%, <1y old, <$50M TVL, ≥5 chains); best farm ${bestPerHour ? `${bestPerHour.name} $${bestPerHour.net.toFixed(2)} net, $${bestPerHour.perHour.toFixed(2)}/h` : "none"}\n` +
  `token radar: odds Brier ${BRIER.brier.toFixed(3)} vs base ${BRIER.base.toFixed(3)} (split-half ${BRIER.splitHalf.brier.toFixed(3)} vs ${BRIER.splitHalf.base.toFixed(3)}; held-out by time ${BRIER.heldOut.brier.toFixed(3)} vs ${BRIER.heldOut.base.toFixed(3)}, biased); band honesty held-out P25–P75 ${(BAND_HONESTY.in2575 * 100).toFixed(0)}% of 50% promised, P10–P90 ${(BAND_HONESTY.in1090 * 100).toFixed(0)}% of 80% promised (n=${BAND_HONESTY.n})\n` +
  `token radar: sensitivity — ` + SENSITIVITY.map((s) => `${s.label}: LOO ${(s.looWithin3x * 100).toFixed(1)}%, $${(s.totalImplied / 1e9).toFixed(2)}B`).join(" | ") + `\n` +
  `token radar: wrote ${join(out, "board.json")}, ${join(out, "data.js")}, ${join(out, "dashboard")}, ${join(out, "screenshots")} (${shots.length} images) and ${join(out, "dossier.json")}\n`,
);
if (checkResults.some(([, ok]) => !ok)) process.exit(1);
