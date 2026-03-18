import { useEffect, useState } from "react";

export default function StaleIndicator({ lastSuccess }: { lastSuccess: number | null }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  if (!lastSuccess) return null;
  const ago = Math.floor((now - lastSuccess) / 1000);
  if (ago < 15) return null;

  const label = ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`;

  return (
    <div className="stale-indicator" role="status">
      Updated {label}
    </div>
  );
}
