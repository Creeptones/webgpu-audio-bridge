import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = parseInt(process.env.BENCH_PORT ?? "5174", 10);
const URL = `http://localhost:${PORT}/`;

async function waitForServer(url, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok) return true;
    } catch {}
    await delay(250);
  }
  throw new Error(`bench server did not start in ${timeoutMs}ms`);
}

function splitList(value, fallback, cast) {
  if (typeof value !== "string") return fallback;
  const parsed = value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const out = parsed.map((v) => {
    const c = cast ? cast(v) : v;
    return c;
  });
  return out.length ? out : fallback;
}

function parseNum(v, fallback, min = -Infinity, max = Infinity) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseNumList(value, fallback, min, max) {
  return splitList(
    value,
    fallback,
    (v) => parseNum(v, Number.NaN, min, max),
  ).filter((v) => Number.isFinite(v));
}

const env = process.env;

const runConfig = {
  modes: splitList(
    env.BENCH_MODES,
    [
      "rawPullLatest",
      "rawPullLatestNoNotify",
      "rawPull",
      "bridgePullLatestNoNotify",
      "bridgePullLatest",
      "bridgePull",
    ],
    (v) => v,
  ),
  notifyModes: splitList(env.BENCH_NOTIFY_MODES, ["always", "waiter-flag"], (v) => v),
  producerPushModes: splitList(env.BENCH_PUSH_MODES, ["push", "beginCommit", "pushRaw"], (v) => v),
  producerTickHz: parseNumList(env.BENCH_TICK_HZ, [60, 120], 1, 2_000),
  nValues: parseNumList(env.BENCH_N, [1000], 1, 4096),
  capacities: parseNumList(env.BENCH_CAPACITY, [16], 1, 8192),
  backends: splitList(env.BENCH_BACKENDS, ["cpu"], (v) => v),
  loads: splitList(env.BENCH_LOADS, ["idle"], (v) => v),
  durationMs: parseNum(env.BENCH_DURATION_MS, 1000, 250, 30_000),
  warmupMs: parseNum(env.BENCH_WARMUP_MS, 200, 0, 10_000),
  minSamples: parseNum(env.BENCH_MIN_SAMPLES, 20, 1, 10_000),
  randomize: env.BENCH_RANDOMIZE === "1" || env.BENCH_RANDOMIZE === "true",
  rounds: parseNum(env.BENCH_ROUNDS, 1, 1, 10),
};

function mean(values) {
  if (!values.length) return Number.NaN;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function median(values) {
  const sorted = values
    .map((v) => v)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function confidenceInterval95(values) {
  const n = values.length;
  if (!n) return {
    n: 0,
    mean: Number.NaN,
    halfWidth: Number.NaN,
    lower: Number.NaN,
    upper: Number.NaN,
  };
  const mu = mean(values);
  if (!Number.isFinite(mu) || n === 1) return {
    n,
    mean: mu,
    halfWidth: Number.NaN,
    lower: Number.NaN,
    upper: Number.NaN,
  };
  let variance = 0;
  for (const v of values) {
    variance += (v - mu) * (v - mu);
  }
  variance /= (n - 1);
  const sd = Math.sqrt(variance);
  const halfWidth = 1.96 * sd / Math.sqrt(n);
  return {
    n,
    mean: mu,
    halfWidth,
    lower: mu - halfWidth,
    upper: mu + halfWidth,
  };
}

function summarizeRuns(runs) {
  const totals = { count: 0, p99: 0, spread: 0, skipped: 0, missRate: 0, samples: 0 };
  for (const run of runs) {
    if (!Number.isFinite(run.p99Ns) || !Number.isFinite(run.spreadNs)) continue;
    totals.count += 1;
    totals.p99 += run.p99Ns;
    totals.spread += run.spreadNs;
    totals.skipped += Number.isFinite(run.meanSkipped) ? run.meanSkipped : 0;
    totals.missRate += Number.isFinite(run.missRate) ? run.missRate : 0;
    totals.samples += Number.isFinite(run.samples) ? run.samples : 0;
  }
  const denom = totals.count || 1;
  return {
    count: totals.count,
    p99MeanNs: totals.p99 / denom,
    spreadMeanNs: totals.spread / denom,
    meanSkipped: totals.skipped / denom,
    missRateMean: totals.missRate / denom,
    sampleMean: totals.samples / denom,
  };
}

function axisSummary(results, key, label) {
  const buckets = new Map();
  for (const run of results) {
    const cfg = run.runConfig ?? {};
    const raw = cfg[key] ?? run[key];
    if (raw == null) continue;
    const axisKey = String(raw);
    const bucket = buckets.get(axisKey) ?? {
      [label ?? key]: axisKey,
      total: 0,
      invalid: 0,
      p99: [],
      spread: [],
      skipped: [],
      missRate: [],
      samples: [],
    };
    bucket.total += 1;
    if (run.invalid) {
      bucket.invalid += 1;
    } else {
      if (Number.isFinite(run.p99Ns)) bucket.p99.push(run.p99Ns);
      if (Number.isFinite(run.spreadNs)) bucket.spread.push(run.spreadNs);
      if (Number.isFinite(run.meanSkipped)) bucket.skipped.push(run.meanSkipped);
      if (Number.isFinite(run.missRate)) bucket.missRate.push(run.missRate);
      if (Number.isFinite(run.samples)) bucket.samples.push(run.samples);
    }
    buckets.set(axisKey, bucket);
  }
  const out = [];
  for (const bucket of buckets.values()) {
    out.push({
      ...bucket,
      valid: bucket.total - bucket.invalid,
      invalidRate: bucket.total > 0 ? bucket.invalid / bucket.total : 0,
      p99MeanMs: mean(bucket.p99) / 1e6,
      p99MedianMs: median(bucket.p99) / 1e6,
      spreadMeanMs: mean(bucket.spread) / 1e6,
      meanSkipped: mean(bucket.skipped),
      missRateMean: mean(bucket.missRate),
      sampleMean: mean(bucket.samples),
    });
  }
  return out.sort((a, b) => {
    const aV = Number.isFinite(a.p99MeanMs) ? a.p99MeanMs : Number.POSITIVE_INFINITY;
    const bV = Number.isFinite(b.p99MeanMs) ? b.p99MeanMs : Number.POSITIVE_INFINITY;
    return aV - bV;
  });
}

function axisConfidenceSummaries(results, key, label) {
  return axisSummary(results, key, label).map((row) => {
    const p99Ci = confidenceInterval95(row.p99.map((value) => value / 1e6));
    const spreadCi = confidenceInterval95(row.spread.map((value) => value / 1e6));
    return {
      [label]: row[label],
      sampleCount: row.valid,
      p99MeanMs: row.p99MeanMs,
      p99Ci: {
        lower: p99Ci.lower,
        upper: p99Ci.upper,
        halfWidth: p99Ci.halfWidth,
      },
      spreadMeanMs: row.spreadMeanMs,
      spreadCi: {
        lower: spreadCi.lower,
        upper: spreadCi.upper,
        halfWidth: spreadCi.halfWidth,
      },
      invalidRate: row.invalidRate,
    };
  });
}

function bestConfigByArea(results, axisDefs, globalP99MedianMs) {
  const out = [];
  for (const { key, label } of axisDefs) {
    const rows = axisSummary(results, key, label).filter((row) =>
      Number.isFinite(row.p99MeanMs),
    );
    if (!rows.length) continue;
    const best = rows[0];
    const deltaMs = Number.isFinite(best.p99MeanMs) && Number.isFinite(globalP99MedianMs)
      ? best.p99MeanMs - globalP99MedianMs
      : Number.NaN;
    out.push({
      area: key,
      key: best[label],
      bestP99MeanMs: best.p99MeanMs,
      p99MedianMs: best.p99MedianMs,
      spreadMeanMs: best.spreadMeanMs,
      valid: best.valid,
      invalidRate: best.invalidRate,
      deltaToGlobalMedianMs: deltaMs,
      deltaToGlobalMedianPct: Number.isFinite(deltaMs) && Number.isFinite(globalP99MedianMs) && globalP99MedianMs !== 0
        ? (deltaMs / globalP99MedianMs) * 100
        : Number.NaN,
      sampleMean: best.sampleMean,
    });
  }
  return out;
}

function topByCombo(validRuns, keys, count) {
  const buckets = new Map();
  for (const run of validRuns) {
    const cfg = run.runConfig ?? {};
    const sig = keys.map((k) => String(cfg[k] ?? run[k])).join("|");
    const bucket = buckets.get(sig) ?? { count: 0, p99: [], spread: [], skipped: [], samples: [] };
    bucket.count += 1;
    if (Number.isFinite(run.p99Ns)) bucket.p99.push(run.p99Ns);
    if (Number.isFinite(run.spreadNs)) bucket.spread.push(run.spreadNs);
    if (Number.isFinite(run.meanSkipped)) bucket.skipped.push(run.meanSkipped);
    if (Number.isFinite(run.samples)) bucket.samples.push(run.samples);
    buckets.set(sig, bucket);
  }
  return [...buckets.entries()]
    .map(([signature, bucket]) => ({
      signature,
      count: bucket.count,
      p99MeanMs: mean(bucket.p99) / 1e6,
      spreadMeanMs: mean(bucket.spread) / 1e6,
      meanSkipped: mean(bucket.skipped),
      sampleMean: mean(bucket.samples),
    }))
    .sort((a, b) => (a.p99MeanMs ?? Number.POSITIVE_INFINITY) - (b.p99MeanMs ?? Number.POSITIVE_INFINITY))
    .slice(0, count);
}

function runAxis(name, summary, key) {
  console.log(`${name}=${JSON.stringify(summary.map((row) => ({ [key]: row[key], p99MeanMs: row.p99MeanMs, spreadMeanMs: row.spreadMeanMs, meanSkipped: row.meanSkipped, valid: row.valid, invalidRate: row.invalidRate })))}`);
}

async function main() {
  const server = spawn("node", ["bench/e2e-latency/serve.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", (chunk) => {
    if (process.env.DEBUG_BENCH_SERVER) {
      process.stdout.write(`[server] ${String(chunk)}`);
    }
  });
  server.stderr.on("data", (chunk) => {
    process.stderr.write(`[server] ${String(chunk)}`);
  });

  try {
    await waitForServer(URL);
    const browser = await chromium.launch({
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    const page = await browser.newPage();

    const consoleMessages = [];
    page.on("pageerror", (err) => {
      consoleMessages.push({ type: "pageerror", text: String(err?.message ?? err) });
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleMessages.push({ type: "console", text: msg.text() });
      }
    });

    await page.goto(URL, { waitUntil: "load" });
    const isolated = await page.evaluate(() => crossOriginIsolated);
    if (!isolated) {
      throw new Error("page is not crossOriginIsolated");
    }

    const results = await page.evaluate(async (cfg) => {
      if (typeof window === "undefined" || !window.__bench) {
        throw new Error("bench helpers missing");
      }
      return await window.__bench.runSweep(cfg);
    }, runConfig);

    const valid = (results ?? []).filter((run) => !run.invalid && Number.isFinite(run.p99Ns));
    const total = Array.isArray(results) ? results.length : 0;
    const invalid = total - (valid?.length ?? 0);

    console.log(`SWEEP_RUNS=${total}`);
    const modeSummaries = axisSummary(results ?? [], "consumerMode", "consumerMode");
    const notifySummaries = axisSummary(results ?? [], "notifyMode", "notifyMode");
    const pushSummaries = axisSummary(results ?? [], "producerPushMode", "producerPushMode");
    const tickSummaries = axisSummary(results ?? [], "producerTickHz", "producerTickHz");
    const backendSummaries = axisSummary(results ?? [], "backend", "backend");
    const loadSummaries = axisSummary(results ?? [], "load", "load");
    const nSummaries = axisSummary(results ?? [], "n", "n");
    const capacitySummaries = axisSummary(results ?? [], "capacity", "capacity");

    const modeStats = summarizeRuns(valid);
    const topCombos = topByCombo(valid, [
      "consumerMode",
      "notifyMode",
      "producerPushMode",
      "producerTickHz",
      "backend",
      "load",
      "n",
      "capacity",
    ], 30);
    const p99Values = valid.map((run) => run.p99Ns).filter(Number.isFinite);
    const globalP99MedianMs = median(p99Values) / 1_000_000;
    const bestByArea = bestConfigByArea(valid, [
      { key: "consumerMode", label: "consumerMode" },
      { key: "notifyMode", label: "notifyMode" },
      { key: "producerPushMode", label: "producerPushMode" },
      { key: "producerTickHz", label: "producerTickHz" },
      { key: "backend", label: "backend" },
      { key: "load", label: "load" },
      { key: "n", label: "n" },
      { key: "capacity", label: "capacity" },
    ], globalP99MedianMs);

    runAxis("MODE_SUMMARY", modeSummaries, "consumerMode");
    runAxis("NOTIFY_SUMMARY", notifySummaries, "notifyMode");
    runAxis("PUSH_SUMMARY", pushSummaries, "producerPushMode");
    runAxis("TICK_SUMMARY", tickSummaries, "producerTickHz");
    runAxis("BACKEND_SUMMARY", backendSummaries, "backend");
    runAxis("LOAD_SUMMARY", loadSummaries, "load");
    runAxis("N_SUMMARY", nSummaries, "n");
    runAxis("CAPACITY_SUMMARY", capacitySummaries, "capacity");

    const modeCi = axisConfidenceSummaries(results ?? [], "consumerMode", "consumerMode");
    const notifyCi = axisConfidenceSummaries(results ?? [], "notifyMode", "notifyMode");
    const pushCi = axisConfidenceSummaries(results ?? [], "producerPushMode", "producerPushMode");
    const tickCi = axisConfidenceSummaries(results ?? [], "producerTickHz", "producerTickHz");
    const backendCi = axisConfidenceSummaries(results ?? [], "backend", "backend");
    const loadCi = axisConfidenceSummaries(results ?? [], "load", "load");
    const nCi = axisConfidenceSummaries(results ?? [], "n", "n");
    const capacityCi = axisConfidenceSummaries(results ?? [], "capacity", "capacity");

    console.log("AREA_P99_CI_MODE=" + JSON.stringify(modeCi));
    console.log("AREA_P99_CI_NOTIFY=" + JSON.stringify(notifyCi));
    console.log("AREA_P99_CI_PUSH=" + JSON.stringify(pushCi));
    console.log("AREA_P99_CI_TICK=" + JSON.stringify(tickCi));
    console.log("AREA_P99_CI_BACKEND=" + JSON.stringify(backendCi));
    console.log("AREA_P99_CI_LOAD=" + JSON.stringify(loadCi));
    console.log("AREA_P99_CI_N=" + JSON.stringify(nCi));
    console.log("AREA_P99_CI_CAPACITY=" + JSON.stringify(capacityCi));

    console.log("BEST_AGGREGATE=" + JSON.stringify(modeStats));
    console.log("BEST_P99_MEDIAN_MS=" + JSON.stringify(globalP99MedianMs));
    console.log("BEST_CONFIG_BY_AREA=" + JSON.stringify(bestByArea));
    console.log("BEST_MODE=" + JSON.stringify(modeSummaries[0] || null));
    console.log("TOP20_COMBOS_BY_P99=" + JSON.stringify(topCombos));
    console.log("COUNTS=" + JSON.stringify({ all: total, valid: valid.length, invalid }));

    if (consoleMessages.length) {
      console.log("CONSOLE_ERRORS=" + JSON.stringify(consoleMessages));
    }

    console.log("RUN_CONFIG=" + JSON.stringify(runConfig));
    await browser.close();
    return results;
  } finally {
    server.kill();
  }
}

await main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
