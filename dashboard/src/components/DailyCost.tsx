import Skeleton from "./Skeleton";
import { PanelHead } from "./ui";

export default function DailyCost({ rows }) {
  if (rows === undefined || rows === null) {
    return (
      <section className="panel">
        <PanelHead title="Daily Cost (14d)" />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i}>
              <Skeleton height="36px" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (rows.length === 0) {
    return (
      <section className="panel">
        <PanelHead title="Daily Cost (14d)" />
        <p className="cost-empty">No usage yet</p>
      </section>
    );
  }

  const maxCost = Math.max(...rows.map((r) => Number(r.usd || 0)), 0.000001);

  return (
    <section className="panel">
      <h3 style={{ margin: "0 0 12px" }}>Daily Cost (14d)</h3>
      <ul className="cost-list">
        {rows.map((row) => {
          const usd = Number(row.usd || 0);
          const pct = (usd / maxCost) * 100;
          return (
            <li key={row.day} className="cost-item">
              <div className="cost-bar" style={{ width: `${pct}%` }} />
              <span className="day">{row.day}</span>
              <span className="usd">${usd.toFixed(6)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
