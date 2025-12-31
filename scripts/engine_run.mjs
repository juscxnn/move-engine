import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in web/.env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const runTs =
  process.env.RUN_TS ??
  new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();

function nowIso() {
  return new Date().toISOString();
}

function hoursAgoIso(h) {
  return new Date(Date.now() - h * 3600 * 1000).toISOString();
}

function windowToMs(windowKey) {
  if (windowKey === "5m") return 5 * 60 * 1000;
  if (windowKey === "1h") return 60 * 60 * 1000;
  if (windowKey === "6h") return 6 * 60 * 60 * 1000;
  if (windowKey === "24h") return 24 * 60 * 60 * 1000;
  return 5 * 60 * 1000;
}

function parseProb(m) {
  const prices = m?.outcomePrices;
  const outcomes = m?.outcomes;

  if (typeof prices === "string") {
    try {
      const arr = JSON.parse(prices);
      if (Array.isArray(arr) && arr.length >= 2) {
        const pYes = Number(arr[0]);
        if (Number.isFinite(pYes)) return pYes;
      }
    } catch {}
  }

  if (Array.isArray(prices) && prices.length >= 2) {
    const pYes = Number(prices[0]);
    if (Number.isFinite(pYes)) return pYes;
  }

  if (typeof m?.probability === "number") return m.probability;
  if (typeof m?.pYes === "number") return m.pYes;
  if (typeof m?.yesPrice === "number") return m.yesPrice;

  if (typeof outcomes === "string" && typeof prices === "string") {
    try {
      const outs = JSON.parse(outcomes);
      const pr = JSON.parse(prices);
      if (Array.isArray(outs) && Array.isArray(pr) && outs.length === pr.length) {
        const yesIdx = outs.findIndex(x => String(x).toLowerCase() === "yes");
        if (yesIdx >= 0) {
          const pYes = Number(pr[yesIdx]);
          if (Number.isFinite(pYes)) return pYes;
        }
      }
    } catch {}
  }

  return null;
}

async function fetchPolymarketMarkets(maxCount = 1000) {
  const pageSize = Number(process.env.POLY_PAGE_SIZE ?? 200);
  const pages = Number(process.env.POLY_PAGES ?? 5);

  const all = [];
  for (let i = 0; i < pages; i++) {
    const offset = i * pageSize;
    const url = `https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=${pageSize}&offset=${offset}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Polymarket fetch failed: ${r.status} ${r.statusText}`);
    const data = await r.json();
    if (Array.isArray(data)) all.push(...data);
    if (!Array.isArray(data) || data.length < pageSize) break;
  }

  const seen = new Set();
  const dedup = [];
  for (const m of all) {
    const id = String(m?.id ?? m?.market_id ?? m?.slug ?? "");
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    dedup.push(m);
    if (dedup.length >= maxCount) break;
  }

  return dedup;
}

async function upsertPlatforms() {
  const { error } = await supabase
    .from("platforms")
    .upsert([{ id: "polymarket", name: "Polymarket" }], { onConflict: "id" });

  if (error) throw error;
}

async function ingestPolymarket() {
  const ts = runTs;
  const max = Number(process.env.POLY_MAX ?? 1000);
  const markets = await fetchPolymarketMarkets(max);

  const marketRows = [];
  const snapshotRows = [];
  let probNonNull = 0;

  for (const m of markets) {
    const market_id = String(m?.id ?? m?.market_id ?? m?.slug ?? "");
    if (!market_id) continue;

    const title = m?.question ?? m?.title ?? m?.name ?? null;
    const rules = m?.rules ?? m?.description ?? null;
    const close_time = m?.endDate ?? m?.end_date ?? m?.closeTime ?? null;
    const status = String(m?.active ?? m?.status ?? "");

    marketRows.push({
      platform_id: "polymarket",
      market_id,
      title,
      rules,
      close_time,
      status,
      raw: m,
      updated_at: ts,
    });

    const p = parseProb(m);
    if (p !== null) probNonNull += 1;

    snapshotRows.push({
      platform_id: "polymarket",
      market_id,
      ts,
      prob_yes: p,
      raw: { source: "polymarket" },
    });
  }

  const { error: mErr } = await supabase
    .from("markets")
    .upsert(marketRows, { onConflict: "platform_id,market_id" });
  if (mErr) throw mErr;

  const { error: sErr } = await supabase
    .from("snapshots")
    .upsert(snapshotRows, { onConflict: "platform_id,market_id,ts" });
  if (sErr) throw sErr;

  console.log(
    `ok ingest polymarket markets=${marketRows.length} snapshots=${snapshotRows.length} prob_nonnull=${probNonNull} ts=${ts}`
  );

  return ts;
}

function pickProbAtOrBefore(points, tMs) {
  let best = null;
  for (const p of points) {
    const ms = new Date(p.ts).getTime();
    if (ms <= tMs) best = p;
    else break;
  }
  return best;
}

async function computeMoves(windowKey) {
  const deltaMs = windowToMs(windowKey);
  const sinceHours = Math.min(72, Math.ceil(deltaMs / 3600000) + 6);
  const since = hoursAgoIso(sinceHours);

  const { data, error } = await supabase
    .from("snapshots")
    .select("platform_id, market_id, ts, prob_yes")
    .eq("platform_id", "polymarket")
    .gte("ts", since)
    .order("ts", { ascending: true })
    .limit(200000);

  if (error) throw error;

  const byMarket = new Map();
  for (const row of data ?? []) {
    if (row.prob_yes === null || typeof row.prob_yes !== "number") continue;
    const key = row.market_id;
    if (!byMarket.has(key)) byMarket.set(key, []);
    byMarket.get(key).push(row);
  }

  const moves = [];

  for (const [market_id, points] of byMarket.entries()) {
    if (points.length < 2) continue;

    const latest = points[points.length - 1];
    const tsEnd = latest.ts;
    const tsEndMs = new Date(tsEnd).getTime();

    const then = pickProbAtOrBefore(points, tsEndMs - deltaMs);
    if (!then) continue;

    const prob_now = latest.prob_yes;
    const prob_then = then.prob_yes;
    const delta = prob_now - prob_then;

    moves.push({
      platform_id: "polymarket",
      market_id,
      window_key: windowKey,
      ts_end: tsEnd,
      prob_now,
      prob_then,
      delta,
      trust_score: 100,
    });
  }

  const { error: upErr } = await supabase
    .from("moves")
    .upsert(moves, { onConflict: "platform_id,market_id,window_key,ts_end" });

  if (upErr) throw upErr;

  console.log(`ok compute moves_written=${moves.length} window=${windowKey} ts=${nowIso()}`);
}

async function main() {
  await upsertPlatforms();
  await ingestPolymarket();
  await computeMoves("5m");
  await computeMoves("1h");
  await computeMoves("6h");
  await computeMoves("24h");
}

main().catch((e) => {
  console.error("engine failed", e);
  process.exit(1);
});
