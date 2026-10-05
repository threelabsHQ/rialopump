import { useState, useEffect, useCallback } from "react";
import { TokenCard } from "../components/TokenCard";
import { api } from "../api";
import type { Token } from "../types";
import { Loader2, Search, TrendingUp, Clock, Star, Zap } from "lucide-react";
import { GlassCard } from "../components/ui/GlassCard";

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

  // eslint-disable-next-line react/set-state-in-effect -- load() updates state only after async fetch
  useEffect(() => { void load(); }, [refreshTick, load]);

  // Auto-refresh every 10s
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
      if (sort === "new") return b.createdAt - a.createdAt;
      if (sort === "marketcap") return b.marketCap - a.marketCap;
      if (sort === "hot") return b.tradeCount - a.tradeCount;
      return b.marketCap - a.marketCap;
    });

  const sorts: { key: SortKey; label: string; icon: React.ReactNode }[] = [
    { key: "hot", label: "Hot", icon: <TrendingUp size={12} /> },
    { key: "new", label: "New", icon: <Clock size={12} /> },
    { key: "marketcap", label: "Mkt Cap", icon: <Star size={12} /> },
    { key: "graduated", label: "Graduated", icon: <Zap size={12} /> },
  ];

  return (
    <div className="space-y-4">
      {/* Search */}
      <GlassCard className="flex items-center gap-3 px-4 py-3">
        <Search size={16} style={{ color: "var(--muted)" }} />
        <input
          type="text"
          placeholder="Search tokens…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-transparent outline-none text-sm"
          style={{ color: "var(--ink)" }}
        />
      </GlassCard>

      {/* Sort tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {sorts.map((s) => (
          <button
            key={s.key}
            onClick={() => setSort(s.key)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all shrink-0"
            style={sort === s.key
              ? { background: "var(--accent)", color: "white" }
              : { background: "rgba(255,255,255,0.64)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,0.68)", color: "var(--ink-2)" }}
          >
            {s.icon} {s.label}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Loader2 size={24} className="animate-spin" style={{ color: "var(--muted)" }} />
          <p className="text-sm" style={{ color: "var(--muted)" }}>Loading tokens…</p>
        </div>
      ) : error ? (
        <GlassCard className="p-6 text-center">
          <p className="text-sm font-semibold" style={{ color: "var(--danger)" }}>Failed to load</p>
          <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>{error}</p>
          <button onClick={() => { void load(); }} className="mt-3 text-xs px-4 py-2 rounded-xl" style={{ background: "var(--accent)", color: "white" }}>
            Retry
          </button>
        </GlassCard>
      ) : filtered.length === 0 ? (
        <GlassCard className="p-8 text-center">
          <p className="text-2xl mb-2">🔍</p>
          <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
            {search ? "No tokens match" : "No tokens launched yet"}
          </p>
          <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
            {search ? "Try a different search" : "Be the first to launch a meme token"}
          </p>
        </GlassCard>
      ) : (
        <div className="space-y-3">
          {filtered.map((t) => (
            <TokenCard key={t.id} token={t} onClick={() => onSelectToken(t.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
