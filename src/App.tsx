import { useState, useEffect, useCallback } from "react";
import { useWallet } from "./hooks/useWallet";
import { WalletPanel } from "./components/WalletPanel";
import { HomeView } from "./views/HomeView";
import { TokenView } from "./views/TokenView";
import { CreateTokenForm } from "./components/CreateTokenForm";
import { PortfolioView } from "./views/PortfolioView";
import type { View } from "./types";
import {
  Home, Rocket, Briefcase, Zap, Menu, X, ChevronUp
} from "lucide-react";

import { Toaster } from "sonner";

const spectral = "linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b, #ffcd83, #7ef1b3)";

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return isMobile;
}

// Chain status indicator
function ChainStatus() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [blockHeight, setBlockHeight] = useState<string | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("/api/chain");
        const data = (await res.json()) as { blockHeight: string };
        setConnected(true);
        setBlockHeight(parseInt(data.blockHeight).toLocaleString());
      } catch {
        setConnected(false);
      }
    };
    void check();
    const id = setInterval(() => { void check(); }, 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-1.5">
      <div
        className="w-2 h-2 rounded-full"
        style={{ background: connected === null ? "var(--subtle)" : connected ? "var(--success)" : "var(--danger)" }}
      />
      <span className="text-xs font-medium mono" style={{ color: "var(--muted)" }}>
        {connected === null ? "Connecting…" : connected ? `Rialo Devnet` : "Disconnected"}
        {blockHeight && ` · ${blockHeight}`}
      </span>
    </div>
  );
}

export default function App() {
  const isMobile = useIsMobile();
  const {
    wallet, loading: walletLoading, error: _walletError,
    generateWallet, importWallet, requestAirdrop, disconnect, refreshWalletBalance
  } = useWallet();

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

  const goBack = useCallback(() => {
    setView("home");
    setSelectedToken(null);
  }, []);

  const onTokenCreated = useCallback((id: string) => {
    setRefreshTick((t) => t + 1);
    selectToken(id);
  }, [selectToken]);

  const tabs: { key: View; label: string; icon: React.ReactNode }[] = [
    { key: "home", label: "Home", icon: <Home size={18} /> },
    { key: "create", label: "Launch", icon: <Rocket size={18} /> },
    { key: "portfolio", label: "Portfolio", icon: <Briefcase size={18} /> },
  ];

  // Background blobs
  const blobs = (
    <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
      <div style={{ position: "absolute", top: "6%", left: "3%", width: 320, height: 320, borderRadius: "50%", background: "radial-gradient(circle, rgba(133,177,237,0.20) 0%, transparent 70%)", filter: "blur(70px)" }} />
      <div style={{ position: "absolute", bottom: "5%", right: "5%", width: 300, height: 300, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,205,131,0.18) 0%, transparent 70%)", filter: "blur(65px)" }} />
      <div style={{ position: "absolute", top: "45%", right: "15%", width: 200, height: 200, borderRadius: "50%", background: "radial-gradient(circle, rgba(175,143,244,0.14) 0%, transparent 70%)", filter: "blur(55px)" }} />
    </div>
  );

  // Mobile layout
  if (isMobile) {
    return (
      <div className="min-h-dvh" style={{ background: "linear-gradient(180deg, #f9f9fc 0%, #fffcf7 52%, #fbf7f2 100%)" }}>
        {blobs}

        {/* Mobile Header */}
        <header
          className="fixed top-0 left-0 right-0 z-30 flex items-center justify-between px-4 py-3"
          style={{
            background: "rgba(255,255,255,0.82)",
            backdropFilter: "blur(20px) saturate(180%)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            borderBottom: "1px solid rgba(18,45,69,0.08)",
          }}
        >
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: spectral }}>
              <Zap size={14} color="white" />
            </div>
            <span className="display text-base font-bold" style={{ color: "var(--ink)", letterSpacing: "-0.02em" }}>
              RialoPump
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ChainStatus />
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: "rgba(18,45,69,0.06)" }}
            >
              {sidebarOpen ? <X size={16} style={{ color: "var(--ink)" }} /> : <Menu size={16} style={{ color: "var(--ink)" }} />}
            </button>
          </div>
        </header>

        {/* Mobile Wallet Sidebar */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-20"
            style={{ background: "rgba(18,45,69,0.4)", backdropFilter: "blur(4px)" }}
            onClick={() => setSidebarOpen(false)}
          >
            <div
              className="absolute top-16 right-0 left-0 p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <WalletPanel
                wallet={wallet}
                loading={walletLoading}
                onGenerate={() => { void generateWallet(); }}
                onImport={(s) => { void importWallet(s); }}
                onAirdrop={() => { void requestAirdrop(); }}
                onDisconnect={disconnect}
                onRefreshBalance={() => { void refreshWalletBalance(); }}
              />
            </div>
          </div>
        )}

        {/* Main scroll area */}
        <main className="relative z-10 px-4 pb-24 pt-16">
          <div className="pt-4">
            {view === "home" && (
              <HomeView onSelectToken={selectToken} refreshTick={refreshTick} />
            )}
            {view === "token" && selectedToken && (
              <TokenView
                tokenId={selectedToken}
                wallet={wallet}
                onBack={goBack}
                isMobile={true}
              />
            )}
            {view === "create" && (
              <CreateTokenForm wallet={wallet} onCreated={onTokenCreated} />
            )}
            {view === "portfolio" && (
              <PortfolioView wallet={wallet} onSelectToken={selectToken} />
            )}
          </div>
        </main>

        {/* Mobile bottom nav */}
        <nav
          className="fixed bottom-0 left-0 right-0 z-30 flex"
          style={{
            background: "rgba(255,255,255,0.88)",
            backdropFilter: "blur(24px) saturate(180%)",
            WebkitBackdropFilter: "blur(24px) saturate(180%)",
            borderTop: "1px solid rgba(18,45,69,0.08)",
            paddingBottom: "env(safe-area-inset-bottom, 0px)",
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => { setView(t.key); if (t.key !== "token") setSelectedToken(null); }}
              className="flex-1 flex flex-col items-center justify-center gap-1 py-3 transition-all"
              style={{ color: view === t.key ? "var(--accent)" : "var(--muted)" }}
            >
              {t.icon}
              <span className="text-xs font-semibold">{t.label}</span>
              {view === t.key && (
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-6 h-0.5 rounded-full" style={{ background: "var(--accent)" }} />
              )}
            </button>
          ))}
        </nav>
      </div>
    );
  }

  // Desktop layout: full sidebar + main content
  return (
    <div className="min-h-dvh flex" style={{ background: "linear-gradient(180deg, #f9f9fc 0%, #fffcf7 52%, #fbf7f2 100%)" }}>
      {blobs}

      {/* Desktop Sidebar */}
      <aside
        className="fixed left-0 top-0 bottom-0 z-20 flex flex-col w-72"
        style={{
          background: "rgba(255,255,255,0.72)",
          backdropFilter: "blur(24px) saturate(180%)",
          WebkitBackdropFilter: "blur(24px) saturate(180%)",
          borderRight: "1px solid rgba(18,45,69,0.10)",
        }}
      >
        {/* Logo */}
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: spectral }}>
              <Zap size={18} color="white" />
            </div>
            <div>
              <span className="display text-xl font-bold" style={{ color: "var(--ink)", letterSpacing: "-0.03em" }}>
                RialoPump
              </span>
            </div>
          </div>
          <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>Meme launchpad on Rialo devnet</p>
        </div>

        {/* Chain status */}
        <div className="px-6 pb-4">
          <ChainStatus />
        </div>

        {/* Nav */}
        <nav className="px-3 flex-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => { setView(t.key); if (t.key !== "token") setSelectedToken(null); }}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-xl mb-1 transition-all text-left"
              style={view === t.key
                ? { background: "rgba(18,45,69,0.08)", color: "var(--accent)" }
                : { color: "var(--muted)" }}
            >
              {t.icon}
              <span className="text-sm font-semibold">{t.label}</span>
            </button>
          ))}
        </nav>

        {/* Wallet */}
        <div className="p-4">
          <WalletPanel
            wallet={wallet}
            loading={walletLoading}
            onGenerate={() => { void generateWallet(); }}
            onImport={(s) => { void importWallet(s); }}
            onAirdrop={() => { void requestAirdrop(); }}
            onDisconnect={disconnect}
            onRefreshBalance={() => { void refreshWalletBalance(); }}
          />
        </div>

        {/* Footer */}
        <div className="px-6 pb-4">
          <div className="h-0.5 rounded-full mb-3" style={{ background: spectral }} />
          <p className="text-xs" style={{ color: "var(--subtle)" }}>
            Powered by Rialo devnet · RLO gas
          </p>
        </div>
      </aside>

      {/* Main content area */}
      <main className="flex-1 ml-72 relative z-10 min-h-dvh">
        {/* Desktop header */}
        <header
          className="sticky top-0 z-10 flex items-center justify-between px-8 py-4"
          style={{
            background: "rgba(249,249,252,0.85)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            borderBottom: "1px solid rgba(18,45,69,0.06)",
          }}
        >
          <div>
            {view === "home" && <h1 className="display text-xl font-bold" style={{ color: "var(--ink)", letterSpacing: "-0.02em" }}>Token Feed</h1>}
            {view === "create" && <h1 className="display text-xl font-bold" style={{ color: "var(--ink)", letterSpacing: "-0.02em" }}>Launch Token</h1>}
            {view === "portfolio" && <h1 className="display text-xl font-bold" style={{ color: "var(--ink)", letterSpacing: "-0.02em" }}>Portfolio</h1>}
            {view === "token" && (
              <button
                onClick={goBack}
                className="flex items-center gap-2 text-sm font-medium"
                style={{ color: "var(--muted)" }}
              >
                <ChevronUp size={14} style={{ transform: "rotate(-90deg)" }} />
                Back to Feed
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {wallet && (
              <span
                className="px-3 py-1.5 rounded-full text-xs font-bold tabular-nums"
                style={{ background: "rgba(18,45,69,0.06)", color: "var(--ink)" }}
              >
                {wallet.balance.toFixed(4)} RLO
              </span>
            )}
          </div>
        </header>

        <div className="px-8 py-6">
          {view === "home" && (
            <HomeView onSelectToken={selectToken} refreshTick={refreshTick} />
          )}
          {view === "token" && selectedToken && (
            <TokenView
              tokenId={selectedToken}
              wallet={wallet}
              onBack={goBack}
              isMobile={false}
            />
          )}
          {view === "create" && (
            <div className="max-w-lg">
              <CreateTokenForm wallet={wallet} onCreated={onTokenCreated} />
            </div>
          )}
          {view === "portfolio" && (
            <div className="max-w-2xl">
              <PortfolioView wallet={wallet} onSelectToken={selectToken} />
            </div>
          )}
        </div>
      </main>

      <Toaster position="top-right" richColors />
    </div>
  );
}
