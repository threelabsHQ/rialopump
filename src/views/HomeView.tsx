import { useState, useEffect, useCallback } from "react";
import { TokenCard } from "../components/TokenCard";
import { api } from "../api";
import type { Token } from "../types";
import { Loader2, Search, TrendingUp, Clock, BarChart2, Zap } from "lucide-react";

interface HomeViewProps {
  onSelectToken: (id: string) => void;
  refreshTick: number;
}

type SortKey = "hot" | "new" | "marketcap" | "graduated";

export function HomeView({ onSelectToken, refreshTick }: HomeViewProps) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("hot");

  const load = useCallback(async () => {
    try {
      const list = await api.tokens();
      setTokens(list);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void load(); }, [refreshTick, load]);
  useEffect(() => {
    const id = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(id);
  }, [load]);

  const filtered = tokens
    .filter((t) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q);
    })
    .filter((t) => sort === "graduated" ? t.graduated : true)
    .sort((a, b) => {
      if (sort === "new")       return b.createdAt - a.createdAt;
      if (sort === "marketcap") return b.marketCapUsd - a.marketCapUsd;
      if (sort === "hot")       return b.tradeCount - a.tradeCount;
      return b.marketCapUsd - a.marketCapUsd;
    });

  const sorts: { key: SortKey; label: string; icon: React.ReactNode }[] = [
    { key: "hot",       label: "Hot",       icon: <TrendingUp size={12} /> },
    { key: "new",       label: "New",       icon: <Clock size={12} /> },
    { key: "marketcap", label: "Mkt Cap",   icon: <BarChart2 size={12} /> },
    { key: "graduated", label: "Graduated", icon: <Zap size={12} /> },
  ];

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="flex items-center gap-3 rounded-2xl px-4 py-3"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <Search size={15} style={{ color: "var(--muted)" }} />
        <input
          type="text"
          placeholder="Search tokens by name or ticker…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-transparent outline-none text-sm"
          style={{ color: "var(--ink)" }}
        />
        {search && (
          <button onClick={() => setSearch("")} className="text-xs px-2 py-0.5 rounded-md"
            style={{ color: "var(--muted)", background: "var(--surface-strong)" }}>
            Clear
          </button>
        )}
      </div>

      {/* Sort tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {sorts.map((s) => (
          <button
            key={s.key}
            onClick={() => setSort(s.key)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all shrink-0"
            style={sort === s.key
              ? { background: "var(--accent)", color: "white", boxShadow: "0 0 12px rgba(79,158,255,0.35)" }
              : { background: "var(--surface)", border: "1px solid var(--border)", color: "var(--ink-2)" }}
          >
            {s.icon} {s.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Loader2 size={22} className="animate-spin" style={{ color: "var(--accent)" }} />
          <p className="text-sm" style={{ color: "var(--muted)" }}>Loading tokens…</p>
        </div>
      ) : error ? (
        <div className="rounded-2xl p-6 text-center" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <p className="text-sm font-semibold" style={{ color: "var(--danger)" }}>Failed to load</p>
          <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>{error}</p>
          <button onClick={() => { void load(); }} className="mt-3 text-xs px-4 py-2 rounded-xl"
            style={{ background: "var(--accent)", color: "white" }}>
            Retry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl p-10 text-center space-y-2"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <div className="w-12 h-12 rounded-2xl mx-auto flex items-center justify-center mb-3"
            style={{ background: "rgba(79,158,255,0.12)" }}>
            <Search size={22} style={{ color: "var(--accent)" }} />
          </div>
          <p className="text-base font-bold" style={{ color: "var(--ink)" }}>
            {search ? "No tokens match" : "No tokens launched yet"}
          </p>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            {search ? "Try a different search term" : "Be the first to launch a meme token on Rialo"}
          </p>
        </div>
      ) : (
        /* 1 col on mobile, 2 col on md+, 3 col on xl+ */
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((t) => (
            <TokenCard key={t.id} token={t} onClick={() => onSelectToken(t.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
