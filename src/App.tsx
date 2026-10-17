import { useState, useCallback } from "react";
import { FrostProvider } from "@rialo/frost";
import { frostConfig } from "./frost.config";
import { useMultiWallet } from "./hooks/useMultiWallet";
import { useChain } from "./hooks/useChain";
import { WalletPanel } from "./components/WalletPanel";
import { HomeView } from "./views/HomeView";
import { TokenView } from "./views/TokenView";
import { CreateTokenForm } from "./components/CreateTokenForm";
import { PortfolioView } from "./views/PortfolioView";
import type { View, WalletState } from "./types";
import { Home, Rocket, Briefcase, Zap, Menu, X, ChevronUp, Sun, Moon } from "lucide-react";
import { useTheme } from "./hooks/useTheme";
import { useIsMobile } from "./hooks/useIsMobile";
import { Toaster } from "sonner";

const spectral = "linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b, #ffcd83, #7ef1b3)";

function ChainStatus() {
  const chain = useChain();
  const dot = chain.connected === false
    ? "var(--danger)"
    : chain.connected
    ? "var(--success)"
    : "var(--subtle)";
  const label = !chain.lastCheckedAt
    ? "Connecting…"
    : chain.connected
    ? `Rialo Devnet · ${chain.blockHeight?.toLocaleString() ?? "…"}`
    : "Disconnected";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-2 h-2 rounded-full" style={{ background: dot }} />
      <span className="text-xs font-medium mono" style={{ color: "var(--muted)" }}>{label}</span>
      {chain.latencyMs !== null && chain.connected && (
        <span className="text-[10px]" style={{ color: "var(--subtle)" }}>{chain.latencyMs}ms</span>
      )}
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      className="w-8 h-8 rounded-xl flex items-center justify-center transition-all hover:opacity-80"
      style={{ background: "var(--surface-strong)", border: "1px solid var(--border)" }}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark"
        ? <Sun  size={14} style={{ color: "var(--warn)" }} />
        : <Moon size={14} style={{ color: "var(--accent)" }} />}
    </button>
  );
}

function AppInner() {
  const isMobile = useIsMobile();
  const multi = useMultiWallet();

  // Bridge activeWallet → WalletState shape for downstream components
  // secretHex is empty string for non-generated wallets — components must use
  // buildAndSignTxBytes (passed as signTx prop) instead of reading secretHex directly.
  const wallet: WalletState | null = multi.activeWallet ? {
    pubkey: multi.activeWallet.pubkey,
    secretHex: multi.activeWallet.secretHex ?? "",
    balance: multi.activeWallet.balance,
    balanceKelvin: multi.activeWallet.balanceKelvin,
  } : null;

  const signTx = multi.buildAndSignTxBytes;

  const [view, setView] = useState<View>("home");
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const selectToken = useCallback((id: string) => {
    setSelectedToken(id);
    setView("token");
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const goBack = useCallback(() => { setView("home"); setSelectedToken(null); }, []);

  const onTokenCreated = useCallback((id: string) => {
    setRefreshTick((t) => t + 1);
    selectToken(id);
  }, [selectToken]);

  const tabs: { key: View; label: string; icon: React.ReactNode }[] = [
    { key: "home",      label: "Home",      icon: <Home size={18} /> },
    { key: "create",    label: "Launch",    icon: <Rocket size={18} /> },
    { key: "portfolio", label: "Portfolio", icon: <Briefcase size={18} /> },
  ];

  const blobs = (
    <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
      <div style={{ position: "absolute", top: "6%",  left: "3%",  width: 420, height: 420, borderRadius: "50%", background: "radial-gradient(circle, color-mix(in srgb, var(--accent) 12%, transparent) 0%, transparent 70%)", filter: "blur(80px)" }} />
      <div style={{ position: "absolute", bottom: "8%", right: "4%", width: 360, height: 360, borderRadius: "50%", background: "radial-gradient(circle, rgba(175,143,244,0.10) 0%, transparent 70%)", filter: "blur(75px)" }} />
      <div style={{ position: "absolute", top: "42%", right: "18%", width: 280, height: 280, borderRadius: "50%", background: "radial-gradient(circle, rgba(52,210,122,0.07) 0%, transparent 70%)", filter: "blur(60px)" }} />
    </div>
  );

  if (isMobile) {
    return (
      <div className="min-h-dvh" style={{ background: "var(--bg-gradient)" }}>
        {blobs}
        <header className="fixed top-0 left-0 right-0 z-30 flex items-center justify-between px-4 py-3"
          style={{ background: "var(--card-bg)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", borderBottom: "1px solid var(--card-border)" }}>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: spectral }}>
              <Zap size={14} color="white" />
            </div>
            <span className="display text-base font-bold" style={{ color: "var(--ink)", letterSpacing: "-0.02em" }}>RialoPump</span>
          </div>
          <div className="flex items-center gap-2">
            <ChainStatus />
            <ThemeToggle />
            <button onClick={() => setSidebarOpen(!sidebarOpen)}
              className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: "var(--surface)" }}>
              {sidebarOpen ? <X size={16} style={{ color: "var(--ink)" }} /> : <Menu size={16} style={{ color: "var(--ink)" }} />}
            </button>
          </div>
        </header>

        {sidebarOpen && (
          <div className="fixed inset-0 z-20" style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(6px)" }}
            onClick={() => setSidebarOpen(false)}>
            <div className="absolute top-16 right-0 left-0 p-4" onClick={(e) => e.stopPropagation()}>
              <WalletPanel
                activeWallet={multi.activeWallet}
                loading={multi.loading}
                onGenerate={() => { void multi.generateWallet(); }}
                onImport={(s) => { void multi.importWallet(s); }}
                onConnectPlayground={multi.connectPlayground}
                onDisconnect={() => { void multi.disconnect(); }}
                onRefreshBalance={() => { void multi.refreshBalance(); }}
              />
            </div>
          </div>
        )}

        <main className="relative z-10 px-4 pb-24 pt-16">
          <div className="pt-4">
            {view === "home"      && <HomeView onSelectToken={selectToken} refreshTick={refreshTick} />}
            {view === "token"     && selectedToken && <TokenView tokenId={selectedToken} wallet={wallet} signTx={signTx} onBack={goBack} isMobile={true} />}
            {view === "create"    && <CreateTokenForm wallet={wallet} signTx={signTx} onCreated={onTokenCreated} />}
            {view === "portfolio" && <PortfolioView wallet={wallet} onSelectToken={selectToken} />}
          </div>
        </main>

        <nav className="fixed bottom-0 left-0 right-0 z-30 flex"
          style={{ background: "var(--card-bg)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", borderTop: "1px solid var(--card-border)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
          {tabs.map((t) => (
            <button key={t.key} onClick={() => { setView(t.key); if (t.key !== "token") setSelectedToken(null); }}
              className="relative flex-1 flex flex-col items-center justify-center gap-1 py-3 transition-all"
              style={{ color: view === t.key ? "var(--accent)" : "var(--muted)" }}>
              {view === t.key && (
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full"
                  style={{ background: "var(--accent)" }} />
              )}
              {t.icon}
              <span className="text-xs font-semibold">{t.label}</span>
            </button>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex" style={{ background: "var(--bg-gradient)" }}>
      {blobs}
      <aside className="fixed left-0 top-0 bottom-0 z-20 flex flex-col w-72"
        style={{ background: "var(--card-bg)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", borderRight: "1px solid var(--card-border)" }}>
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: spectral }}>
              <Zap size={18} color="white" />
            </div>
            <span className="display text-xl font-bold" style={{ color: "var(--ink)", letterSpacing: "-0.03em" }}>RialoPump</span>
          </div>
          <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>Meme launchpad on Rialo devnet</p>
        </div>
        <div className="px-6 pb-4"><ChainStatus /></div>
        <nav className="px-3 flex-1">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => { setView(t.key); if (t.key !== "token") setSelectedToken(null); }}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-xl mb-1 transition-all text-left"
              style={view === t.key ? { background: "var(--surface-strong)", color: "var(--accent)" } : { color: "var(--muted)" }}>
              {t.icon}
              <span className="text-sm font-semibold">{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="p-4">
          <WalletPanel
            activeWallet={multi.activeWallet}
            loading={multi.loading}
            onGenerate={() => { void multi.generateWallet(); }}
            onImport={(s) => { void multi.importWallet(s); }}
            onConnectPlayground={multi.connectPlayground}
            onDisconnect={() => { void multi.disconnect(); }}
            onRefreshBalance={() => { void multi.refreshBalance(); }}
          />
        </div>
        <div className="px-6 pb-4">
          <div className="h-0.5 rounded-full mb-3" style={{ background: spectral }} />
          <p className="text-xs" style={{ color: "var(--subtle)" }}>Powered by Rialo devnet · RLO gas</p>
        </div>
      </aside>

      <main className="flex-1 ml-72 relative z-10 min-h-dvh">
        <header className="sticky top-0 z-10 flex items-center justify-between px-8 py-4"
          style={{ background: "var(--card-bg)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", borderBottom: "1px solid var(--card-border)" }}>
          <div>
            {view === "home"      && <h1 className="display text-xl font-bold" style={{ color: "var(--ink)", letterSpacing: "-0.02em" }}>Token Feed</h1>}
            {view === "create"    && <h1 className="display text-xl font-bold" style={{ color: "var(--ink)", letterSpacing: "-0.02em" }}>Launch Token</h1>}
            {view === "portfolio" && <h1 className="display text-xl font-bold" style={{ color: "var(--ink)", letterSpacing: "-0.02em" }}>Portfolio</h1>}
            {view === "token"     && (
              <button onClick={goBack} className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--muted)" }}>
                <ChevronUp size={14} style={{ transform: "rotate(-90deg)" }} /> Back to Feed
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {multi.activeWallet && (
              <span className="px-3 py-1.5 rounded-full text-xs font-bold tabular-nums"
                style={{ background: "var(--surface-strong)", border: "1px solid var(--border)", color: "var(--ink)" }}>
                {multi.activeWallet.balance.toFixed(4)} RLO
              </span>
            )}
            <ThemeToggle />
          </div>
        </header>
        <div className="px-8 py-6">
          {view === "home"      && <HomeView onSelectToken={selectToken} refreshTick={refreshTick} />}
          {view === "token"     && selectedToken && <TokenView tokenId={selectedToken} wallet={wallet} signTx={signTx} onBack={goBack} isMobile={false} />}
          {view === "create"    && <div className="max-w-lg"><CreateTokenForm wallet={wallet} signTx={signTx} onCreated={onTokenCreated} /></div>}
          {view === "portfolio" && <div className="max-w-2xl"><PortfolioView wallet={wallet} onSelectToken={selectToken} /></div>}
        </div>
      </main>
      <Toaster position="top-right" richColors />
    </div>
  );
}

export default function App() {
  return (
    <FrostProvider config={frostConfig}>
      <AppInner />
    </FrostProvider>
  );
}
