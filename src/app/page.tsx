import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ALLOWED = new Set(["5m", "1h", "6h", "24h"]);

function pickWindowKey(v?: string) {
  if (!v) return "5m";
  if (ALLOWED.has(v)) return v;
  return "5m";
}

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<{ w?: string }>;
}) {
  const sp = searchParams ? await searchParams : {};
  const windowKey = pickWindowKey(sp?.w);

  const { data, error } = await supabaseServer
    .from("moves")
    .select("platform_id, market_id, window_key, ts_end, prob_now, prob_then, delta, trust_score")
    .eq("window_key", windowKey)
    .order("ts_end", { ascending: false })
    .limit(500);

  if (error) {
    return <main className="p-6 text-red-600">DB error: {error.message}</main>;
  }

  const rowsRaw = (data ?? []).filter(r => typeof r.delta === "number");
  const latestTsEnd = rowsRaw[0]?.ts_end ?? null;

  const rows = rowsRaw
    .sort((a, b) => Math.abs((b.delta ?? 0)) - Math.abs((a.delta ?? 0)))
    .slice(0, 50);

  const ids = Array.from(new Set(rows.map(r => r.market_id).filter(Boolean)));

  const meta = new Map<string, { title: string | null; slug: string | null }>();
  if (ids.length > 0) {
    const { data: mdata } = await supabaseServer
      .from("markets")
      .select("market_id, title, raw")
      .eq("platform_id", "polymarket")
      .in("market_id", ids);

    for (const m of mdata ?? []) {
      const slug = (m as any)?.raw?.slug ?? null;
      meta.set(m.market_id, { title: m.title ?? null, slug });
    }
  }

  return (
    <main className="p-6 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Move Engine</h1>

        <div className="text-sm text-gray-600 flex flex-wrap items-center gap-3">
          <div>Window: {windowKey}</div>
          <div className="flex gap-2">
            <Link className="underline" href="/?w=5m">5m</Link>
            <Link className="underline" href="/?w=1h">1h</Link>
            <Link className="underline" href="/?w=6h">6h</Link>
            <Link className="underline" href="/?w=24h">24h</Link>
          </div>
          <Link className="underline" href="/mismatches">Mismatches</Link>
        </div>

        <div className="text-xs text-gray-500">
          Latest ts_end: {latestTsEnd ? new Date(latestTsEnd).toISOString() : "n/a"}
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
              <th className="text-right p-3">Trust</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const m = meta.get(r.market_id);
              const title = m?.title ?? r.market_id;
              const slug = m?.slug ?? null;
              const href = slug ? `https://polymarket.com/event/${slug}` : null;

              return (
                <tr key={idx} className="border-t">
                  <td className="p-3">{r.platform_id}</td>
                  <td className="p-3">
                    <div className="truncate max-w-[720px]">
                      {href ? (
                        <a className="underline" href={href} target="_blank" rel="noreferrer">
                          {title}
                        </a>
                      ) : (
                        title
                      )}
                    </div>
                    <div className="text-xs text-gray-500">{r.market_id}</div>
                  </td>
                  <td className="p-3 text-right">{fmtPct(r.prob_now)}</td>
                  <td className="p-3 text-right">{fmtPct(r.prob_then)}</td>
                  <td className="p-3 text-right">{fmtSignedPct(r.delta)}</td>
                  <td className="p-3 text-right">{r.trust_score ?? ""}</td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr className="border-t">
                <td className="p-3" colSpan={6}>No data yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </main>
  );
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
