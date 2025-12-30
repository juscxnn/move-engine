import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";

export default async function Home() {
  const windowKey = "1m";

  const { data, error } = await supabaseServer
    .from("moves")
    .select("platform_id, market_id, window_key, ts_end, prob_now, prob_then, delta, trust_score")
    .eq("window_key", windowKey)
    .order("ts_end", { ascending: false })
    .limit(200);

  if (error) {
    return <main className="p-6 text-red-600">DB error: {error.message}</main>;
  }

  const moves = (data ?? []).filter((r: any) => typeof r.delta === "number");

  const top = moves
    .sort((a: any, b: any) => Math.abs((b.delta ?? 0)) - Math.abs((a.delta ?? 0)))
    .slice(0, 50);

  const ids = Array.from(new Set(top.map((r: any) => r.market_id)));

  const { data: marketRows } = await supabaseServer
    .from("markets")
    .select("platform_id, market_id, title, raw")
    .eq("platform_id", "polymarket")
    .in("market_id", ids);

  const metaMap = new Map<string, { title?: string | null; slug?: string | null }>();
  for (const m of marketRows ?? []) {
    const raw: any = (m as any).raw;
    const slug = raw?.slug ?? null;
    metaMap.set((m as any).market_id, { title: (m as any).title, slug });
  }

  return (
    <main className="p-6 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Move Engine</h1>
        <div className="text-sm text-gray-600">Top Moves (window: {windowKey})</div>
        <div className="flex gap-4 text-sm">
          <Link className="underline" href="/">Moves</Link>
          <Link className="underline" href="/mismatches">Mismatches</Link>
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
            {top.map((r: any, idx: number) => {
              const meta = metaMap.get(r.market_id);
              const label = meta?.title || r.market_id;
              const pmUrl = meta?.slug ? `https://polymarket.com/market/${meta.slug}` : "https://polymarket.com";

              return (
                <tr key={idx} className="border-t">
                  <td className="p-3">{r.platform_id}</td>
                  <td className="p-3 max-w-[720px]">
                    <div className="space-y-1">
                      <a className="underline" href={pmUrl} target="_blank" rel="noreferrer">
                        {label}
                      </a>
                      <div className="text-xs text-gray-500">ID: {r.market_id}</div>
                    </div>
                  </td>
                  <td className="p-3 text-right">{fmtPct(r.prob_now)}</td>
                  <td className="p-3 text-right">{fmtPct(r.prob_then)}</td>
                  <td className="p-3 text-right">{fmtSignedPct(r.delta)}</td>
                  <td className="p-3 text-right">{r.trust_score ?? ""}</td>
                </tr>
              );
            })}
            {top.length === 0 ? (
              <tr className="border-t">
                <td className="p-3" colSpan={6}>No data yet. Engine comes next.</td>
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
