import Link from "next/link";
import { supabaseServer } from "@/lib/supabaseServer";

export default async function Mismatches() {
  const { data, error } = await supabaseServer
    .from("mismatches")
    .select("event_id, window_key, ts_end, prob_polymarket, prob_kalshi, gap")
    .eq("window_key", "24h")
    .order("ts_end", { ascending: false })
    .limit(200);

  if (error) {
    return <main className="p-6 text-red-600">DB error: {error.message}</main>;
  }

  const rows = (data ?? [])
    .filter(r => typeof r.gap === "number")
    .sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0))
    .slice(0, 50);

  return (
    <main className="p-6 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Mismatches</h1>
        <div className="text-sm text-gray-600">Top gaps for linked events (window: 24h)</div>
        <div className="flex gap-4 text-sm">
          <Link className="underline" href="/">Moves</Link>
          <Link className="underline" href="/mismatches">Mismatches</Link>
        </div>
      </header>

      <div className="overflow-x-auto border rounded-lg">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-3">Event</th>
              <th className="text-right p-3">Polymarket</th>
              <th className="text-right p-3">Kalshi</th>
              <th className="text-right p-3">Gap</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={idx} className="border-t">
                <td className="p-3 font-mono text-xs">{r.event_id}</td>
                <td className="p-3 text-right">{fmtPct(r.prob_polymarket)}</td>
                <td className="p-3 text-right">{fmtPct(r.prob_kalshi)}</td>
                <td className="p-3 text-right">{fmtPct(r.gap)}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr className="border-t">
                <td className="p-3" colSpan={4}>No mismatches yet. Links come later.</td>
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
