import React from "react";
import { clsx } from "clsx";

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  hover?: boolean;
}

export function GlassCard({ children, className, style, onClick, hover }: GlassCardProps) {
  return (
    <div
      onClick={onClick}
      className={clsx(
        "rounded-2xl transition-all duration-200",
        hover && "cursor-pointer hover:scale-[1.01] active:scale-[0.99]",
        className
      )}
      style={{
        background: "var(--surface)",
        backdropFilter: "blur(24px) saturate(160%)",
        WebkitBackdropFilter: "blur(24px) saturate(160%)",
        border: "1px solid var(--border)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.06)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function InnerField({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div
      className={clsx("rounded-xl", className)}
      style={{
        background: "var(--surface-muted)",
        border: "1px solid var(--border)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
