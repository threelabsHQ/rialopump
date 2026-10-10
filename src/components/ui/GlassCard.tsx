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
        background: "var(--card-bg)",
        backdropFilter: "var(--glass-blur)",
        WebkitBackdropFilter: "var(--glass-blur)",
        border: "1px solid var(--card-border)",
        boxShadow: "var(--shadow-panel)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function InnerField({ children, className, style }: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
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
