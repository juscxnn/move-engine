import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in web/.env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

function nowIso() {
  return new Date().toISOString();
}

function hoursAgoIso(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function clamp01(x) {
  if (typeof x !== "number") return null;
  if (!Number.isFinite(x)) return null;
  if (x > 1) x = x / 100;
  if (x < 0 || x > 1) return null;
  return x;
}

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p;
    } catch {}
  }
  return null;
}

function parseProb(m) {
  const directKeys = ["probability", "probabilityYes", "pYes", "yesProbability", "yesPrice"];
  for (const k of directKeys) {
    const v = m?.[k];
    if (typeof v === "number") return clamp01(v);
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return clamp01(n);
    }
  }

  const outcomes = toArray(m?.outcomes);
  const prices = toArray(m?.outcomePrices ?? m?.outcome_prices);

  if (outcomes && prices && outcomes.length === prices.length) {
    const idxYes = outcomes.findIndex((o) => String(o).toLowerCase() === "yes");
    if (idxYes >= 0) {
      const v = Number(prices[idxYes]);
      if (Number.isFinite(v)) return clamp01(v);
    }
  }

  if (prices && prices.length > 0) {
    const v = Number(prices[0]);
    if (Number.isFinite(v)) return clamp01(v);
  }

  return null;
}

function windowToMs(windowKey) {
  if (windowKey === "1m") return 1 * 60 * 1000;
  if (windowKey === "5m") return 5 * 60 * 1000;
  if (windowKey === "1h") return 60 * 60 * 1000;
  if (windowKey === "6h") return 6 * 60 * 60 * 1000;
  if (windowKey === "24h") return 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

async function fetchPolymarketMarkets(limit = 300) {
  const url = "https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=200&offset=0";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Polymarket fetch failed: ${r.status} ${r.statusText}`);
  const data = await r.json();
  if (!Array.isArray(data)) return [];
  return data.slice(0, limit);
}

async function upsertPlatforms() {
  const { error } = await supabase
    .from("platforms")
    .upsert(
      [
        { id: "polymarket", name: "Polymarket" },
        { id: "kalshi", name: "Kalshi" },
      ],
      { onConflict: "id" }
    );
  if (error) throw error;
}

async function ingestPolymarket() {
  const ts = nowIso();
  const markets = await fetchPolymarketMarkets(300);

  const marketRows = [];
  const snapshotRows = [];

  let probNonNull = 0;

  for (const m of markets) {
    const market_id = String(m.id ?? m.market_id ?? m.slug ?? "");
    if (!market_id) continue;

    const title = m.question ?? m.title ?? m.name ?? null;
    const rules = m.rules ?? m.description ?? null;
    const close_time = m.endDate ?? m.end_date ?? m.closeTime ?? null;
    const status = String(m.active ?? m.status ?? "");

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

  console.log(`ok ingest polymarket markets=${marketRows.length} snapshots=${snapshotRows.length} prob_nonnull=${probNonNull} ts=${ts}`);
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
  const since = hoursAgoIso(48);

  const { data, error } = await supabase
    .from("snapshots")
    .select("platform_id, market_id, ts, prob_yes")
    .eq("platform_id", "polymarket")
    .gte("ts", since)
    .order("ts", { ascending: true })
    .limit(50000);

  if (error) throw error;

  const byMarket = new Map();
  for (const row of data ?? []) {
    if (row.prob_yes === null || typeof row.prob_yes !== "number") continue;
    const key = row.market_id;
    if (!byMarket.has(key)) byMarket.set(key, []);
    byMarket.get(key).push(row);
  }

  const moves = [];
  const deltaMs = windowToMs(windowKey);
  const tsNow = nowIso();

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

  console.log(`ok compute moves_written=${moves.length} window=${windowKey} ts=${tsNow}`);
}

async function main() {
  await upsertPlatforms();
  await ingestPolymarket();
  await computeMoves("1m");
  await computeMoves("5m");
  await computeMoves("1h");
  await computeMoves("6h");
  await computeMoves("24h");
}

main().catch((e) => {
  console.error("engine_run failed:", e?.message ?? e);
  process.exit(1);
});
