import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";

export default async function Home() {
  const windowKey = "24h";

  const { data, error } = await supabaseServer
    .from("moves")
    .select("platform_id, market_id, window_key, ts_end, prob_now, prob_then, delta, trust_score")
    .eq("window_key", windowKey)
    .order("ts_end", { ascending: false })
    .limit(200);

  if (error) {
    return <main className="p-6 text-red-600">DB error: {error.message}</main>;
  }

  const rows = (data ?? [])
    .filter(r => typeof r.delta === "number")
    .sort((a, b) => Math.abs((b.delta ?? 0)) - Math.abs((a.delta ?? 0)))
    .slice(0, 50);

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
            {rows.map((r, idx) => (
              <tr key={idx} className="border-t">
                <td className="p-3">{r.platform_id}</td>
                <td className="p-3 truncate max-w-[560px]">{r.market_id}</td>
                <td className="p-3 text-right">{fmtPct(r.prob_now)}</td>
                <td className="p-3 text-right">{fmtPct(r.prob_then)}</td>
                <td className="p-3 text-right">{fmtSignedPct(r.delta)}</td>
                <td className="p-3 text-right">{r.trust_score ?? ""}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
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
