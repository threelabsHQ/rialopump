interface TokenAvatarProps {
  imageUrl?: string;
  symbol: string;
  size?: number;
  className?: string;
}

// Deterministic color from symbol
function symbolColor(symbol: string): string {
  const colors = [
    "#5fbeff", "#af8ff4", "#f05c6b", "#ffcd83", "#7ef1b3",
    "#ff9f7f", "#b5d8ff", "#c8b5ff", "#ffd6de", "#b5f5e0",
  ];
  let hash = 0;
  for (const c of symbol) hash = (hash * 31 + c.charCodeAt(0)) % colors.length;
  return colors[hash];
}

export function TokenAvatar({ imageUrl, symbol, size = 48, className }: TokenAvatarProps) {
  const color = symbolColor(symbol);
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={symbol}
        width={size}
        height={size}
        className={className}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `radial-gradient(circle at 35% 35%, white 0%, ${color} 100%)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Space Grotesk', sans-serif",
        fontWeight: 700,
        fontSize: size * 0.36,
        color: "#122d45",
        flexShrink: 0,
      }}
    >
      {symbol.slice(0, 2)}
    </div>
  );
}
