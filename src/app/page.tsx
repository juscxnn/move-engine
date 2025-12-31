import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const WINDOWS = ["1m", "5m", "1h", "6h", "24h"] as const;
const PAGE_SIZE = 50;

type WindowKey = (typeof WINDOWS)[number];

type SearchParamsShape = {
  w?: string;
  page?: string;
  d?: string;
};

async function unwrapSearchParams(input: any): Promise<SearchParamsShape> {
  if (input && typeof input.then === "function") return (await input) ?? {};
  return input ?? {};
}

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function pickWindowKey(raw: string | undefined): WindowKey {
  const w = (raw ?? "").trim();
  return (WINDOWS as readonly string[]).includes(w) ? (w as WindowKey) : "5m";
}

function isValidDDMMYYYY(s: string) {
  return /^[0-3][0-9][0-1][0-9][0-9]{4}$/.test(s);
}

function todaySgDDMMYYYY() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());
  const dd = parts.find(p => p.type === "day")?.value ?? "01";
  const mm = parts.find(p => p.type === "month")?.value ?? "01";
  const yyyy = parts.find(p => p.type === "year")?.value ?? "1970";
  return `${dd}${mm}${yyyy}`;
}

function sgDayToUtcRange(ddmmyyyy: string) {
  const dd = Number(ddmmyyyy.slice(0, 2));
  const mm = Number(ddmmyyyy.slice(2, 4));
  const yyyy = Number(ddmmyyyy.slice(4, 8));

  const sgMidnightAsUtcMs = Date.UTC(yyyy, mm - 1, dd, 0, 0, 0) - 8 * 60 * 60 * 1000;
  const start = new Date(sgMidnightAsUtcMs);
  const end = new Date(sgMidnightAsUtcMs + 24 * 60 * 60 * 1000);

  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function formatSgDDMMYYYY_HHMM(iso: string) {
  const dt = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dt);

  const dd = parts.find(p => p.type === "day")?.value ?? "01";
  const mm = parts.find(p => p.type === "month")?.value ?? "01";
  const yyyy = parts.find(p => p.type === "year")?.value ?? "1970";
  const hh = parts.find(p => p.type === "hour")?.value ?? "00";
  const min = parts.find(p => p.type === "minute")?.value ?? "00";

  return `${dd}${mm}${yyyy} ${hh}:${min}`;
}

function fmtPct(x: any) {
  if (typeof x !== "number") return "";
  return `${(x * 100).toFixed(1)}%`;
}

function fmtSignedPct(x: any) {
  if (typeof x !== "number") return "";
  const s = x >= 0 ? "+" : "";
  return `${s}${(x * 100).toFixed(1)}%`;
}

function buildHref(base: string, q: Record<string, string | number | undefined>) {
  const u = new URL(base, "http://localhost");
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    u.searchParams.set(k, String(v));
  }
  return `${u.pathname}?${u.searchParams.toString()}`;
}

export default async function Home({ searchParams }: { searchParams?: any }) {
  const sp = await unwrapSearchParams(searchParams);

  const windowKey = pickWindowKey(sp.w);
  const page = clampInt(Number(sp.page ?? "1") || 1, 1, 100000);

  const defaultDay = todaySgDDMMYYYY();
  const dayRaw = (sp.d ?? defaultDay).trim();
  const day = dayRaw === "all" ? "all" : isValidDDMMYYYY(dayRaw) ? dayRaw : defaultDay;

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabaseServer
    .from("moves")
    .select("platform_id, market_id, window_key, ts_end, prob_now, prob_then, delta", { count: "exact" })
    .eq("window_key", windowKey)
    .order("ts_end", { ascending: false })
    .range(from, to);

  if (day !== "all") {
    const { startIso, endIso } = sgDayToUtcRange(day);
    query = query.gte("ts_end", startIso).lt("ts_end", endIso);
  }

  const { data, error, count } = await query;

  if (error) {
    return <main className="p-6 text-red-600">DB error: {error.message}</main>;
  }

  const rows = (data ?? []).filter(r => typeof r.delta === "number");

  const latestTsEnd = rows[0]?.ts_end ?? null;

  const marketIds = Array.from(new Set(rows.map(r => String(r.market_id)).filter(Boolean)));
  const marketMeta = new Map<string, { title: string | null; slug: string | null }>();

  if (marketIds.length > 0) {
    const { data: mData } = await supabaseServer
      .from("markets")
      .select("market_id, title, raw")
      .eq("platform_id", "polymarket")
      .in("market_id", marketIds);

    for (const m of mData ?? []) {
      const id = String(m.market_id);
      const raw = (m as any).raw ?? null;
      const slug = raw && typeof raw.slug === "string" ? raw.slug : null;
      marketMeta.set(id, { title: (m as any).title ?? null, slug });
    }
  }

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const uniqueMarkets = marketIds.length;

  const navQueryBase = { w: windowKey, d: day };

  return (
    <main className="p-6 space-y-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Move Engine</h1>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <div className="text-gray-700">
            Window:
            {WINDOWS.map(w => (
              <Link
                key={w}
                className={`ml-2 underline ${w === windowKey ? "font-semibold" : ""}`}
                href={buildHref("/", { ...navQueryBase, w, page: 1 })}
              >
                {w}
              </Link>
            ))}
          </div>

          <div className="text-gray-700">
            Date:
            <Link className={`ml-2 underline ${day === defaultDay ? "font-semibold" : ""}`} href={buildHref("/", { w: windowKey, d: defaultDay, page: 1 })}>
              Today
            </Link>
            <Link className={`ml-2 underline ${day === "all" ? "font-semibold" : ""}`} href={buildHref("/", { w: windowKey, d: "all", page: 1 })}>
              All
            </Link>
          </div>

          <Link className="underline text-gray-700" href="/mismatches">
            Mismatches
          </Link>
        </div>

        <div className="text-xs text-gray-600 flex flex-wrap items-center gap-3">
          <div>Rows: {rows.length} (page {page} of {totalPages})</div>
          <div>Unique markets: {uniqueMarkets}</div>
          <div>Total rows in DB (this filter): {total}</div>
          <div>Latest ts_end (SG): {latestTsEnd ? formatSgDDMMYYYY_HHMM(String(latestTsEnd)) : "n/a"}</div>
        </div>
      </header>

      <div className="overflow-x-auto border rounded-lg">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-3">Platform</th>
              <th className="text-left p-3">Market</th>
              <th className="text-right p-3">Now</th>
              <th className="text-right p-3">Then</th>
              <th className="text-right p-3">Move</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const id = String(r.market_id);
              const meta = marketMeta.get(id) ?? { title: null, slug: null };
              const title = meta.title ?? id;
              const href = meta.slug ? `https://polymarket.com/market/${meta.slug}` : null;

              return (
                <tr key={`${id}:${idx}`} className="border-t align-top">
                  <td className="p-3">{r.platform_id}</td>
                  <td className="p-3">
                    <div className="max-w-[720px]">
                      {href ? (
                        <a className="underline" href={href} target="_blank" rel="noreferrer">
                          {title}
                        </a>
                      ) : (
                        <span>{title}</span>
                      )}
                      <div className="text-xs text-gray-500">{id}</div>
                    </div>
                  </td>
                  <td className="p-3 text-right">{fmtPct(r.prob_now)}</td>
                  <td className="p-3 text-right">{fmtPct(r.prob_then)}</td>
                  <td className="p-3 text-right">{fmtSignedPct(r.delta)}</td>
                </tr>
              );
            })}

            {rows.length === 0 ? (
              <tr className="border-t">
                <td className="p-3" colSpan={5}>
                  No data for this window/date yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <div className="text-gray-600">
          Showing {from + 1}-{Math.min(to + 1, total)} of {total}
        </div>

        <div className="flex gap-3">
          <Link
            className={`underline ${page <= 1 ? "pointer-events-none text-gray-400" : ""}`}
            href={buildHref("/", { ...navQueryBase, page: Math.max(1, page - 1) })}
          >
            Prev
          </Link>

          <Link
            className={`underline ${page >= totalPages ? "pointer-events-none text-gray-400" : ""}`}
            href={buildHref("/", { ...navQueryBase, page: Math.min(totalPages, page + 1) })}
          >
            Next
          </Link>
        </div>
      </div>

      <div className="text-xs text-gray-500">
        Trust is intentionally not shown yet. Your pipeline currently sets trust_score=100 for all rows, which is not a real metric.
      </div>
    </main>
  );
}
