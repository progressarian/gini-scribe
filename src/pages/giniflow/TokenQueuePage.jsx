import TokenQueue from "../../components/giniflow/TokenQueue";
import LiveBadge from "../../components/giniflow/LiveBadge";
import { useGiniflowLive } from "../../queries/hooks/useGiniflowLive";
import "../../styles/giniflow-station.css";
import "./TokenQueuePage.css";

export default function TokenQueuePage() {
  const live = useGiniflowLive();
  return (
    <div className="gf">
      <div className="top-rail">
        <div className="tr-logo">Gini Flow</div>
        <div className="tr-role" style={{ background: "var(--blu-l)", color: "var(--blu)" }}>
          Tokens
        </div>
        <div className="rail-right">
          <LiveBadge live={live} />
          <a className="tr-back" href="/giniflow/manager">
            ← Flow board
          </a>
        </div>
      </div>
      <main className="tq-page">
        <header>
          <h1 className="tq-page__title">Chief Endocrinologist tokens</h1>
          <p className="tq-page__sub">
            Give each patient a token number. The Chief Endocrinologist column and station follow
            this order.
          </p>
        </header>
        <TokenQueue />
      </main>
    </div>
  );
}
