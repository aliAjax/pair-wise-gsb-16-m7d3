import { useMemo, useState } from "react";
import "./styles.css";
import { StoreProvider, useStore } from "./store";
import { RecordsView } from "./components/RecordsView";
import { ScheduleView } from "./components/ScheduleView";
import { ReviewView } from "./components/ReviewView";
import { SyncView } from "./components/SyncView";
import { evaluate } from "./domain";

type Tab = "records" | "schedule" | "review" | "sync";

const TABS: { id: Tab; label: string }[] = [
  { id: "records", label: "分频验配单" },
  { id: "schedule", label: "验配排期台" },
  { id: "review", label: "复核台" },
  { id: "sync", label: "断网与冲突" },
];

function Header({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const { state } = useStore();

  const metrics = useMemo(() => {
    let needReview = 0;
    let blockedTrials = 0;
    state.records.forEach((r) => {
      if (evaluate(r, state.thresholds).needsReview) needReview++;
    });
    state.bookings.forEach((b) => {
      if (b.kind !== "trial" || b.status !== "proposed") return;
      const blocked =
        state.conflicts.some((c) => c.recordId === b.recordId) ||
        state.reviews.some((rv) => rv.recordId === b.recordId && rv.status !== "approved");
      if (blocked) blockedTrials++;
    });
    return [
      { label: "验配单", value: state.records.length, tone: "" },
      { label: "待复核客户", value: needReview, tone: needReview > 0 ? "warn" : "" },
      { label: "闸口拦截试戴", value: blockedTrials, tone: blockedTrials > 0 ? "danger" : "" },
      { label: "未裁决冲突", value: state.conflicts.length, tone: state.conflicts.length ? "danger" : "" },
      { label: "本地待同步", value: state.queue.length, tone: state.queue.length ? "warn" : "" },
    ];
  }, [state]);

  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">
            hxwl-01 · 可排期听力验配台
            <span className={`net-chip ${state.online ? "on" : "off"}`}>
              {state.online ? "● 在线" : "○ 断网本地模式"}
            </span>
          </p>
          <h1>听力验配 · 排期 · 复核闸口</h1>
          <p className="subtitle">
            每份验配单保存左右耳分频气骨导结果，自动给出复诊与试戴时段；
            同一客户同一时段只占一个验配间，改期先释放原时段；
            复测改动使未确认试戴失效重确；两耳不一致或气骨导差达阈值须先复核；
            断网本地暂存，恢复后耳级三向合并、复核结论优先。
          </p>
        </div>
        <div className="stack-card">
          <span>规则阈值（可在代码中调整）</span>
          <strong>
            气骨导差 ≥ {state.thresholds.airBoneGap} dB 复核
          </strong>
          <strong>
            两耳 PTA 差 ≥ {state.thresholds.ptaGap} dB / 单频 ≥ {state.thresholds.perFreqGap} dB 复核
          </strong>
        </div>
      </section>

      <section className="metrics-grid metrics-5">
        {metrics.map((m) => (
          <article key={m.label} className={`metric-card ${m.tone ? "metric-" + m.tone : ""}`}>
            <span>{m.label}</span>
            <strong>{m.value}</strong>
            <i className={m.tone === "danger" ? "status-danger" : m.tone === "warn" ? "status-watch" : "status-ok"} />
          </article>
        ))}
      </section>

      <nav className="tab-bar panel">
        {TABS.map((t) => {
          const badge =
            t.id === "review"
              ? state.reviews.filter((r) => r.status === "pending").length
              : t.id === "sync"
                ? state.conflicts.length + state.queue.length
                : 0;
          return (
            <button key={t.id} className={tab === t.id ? "tab active" : "tab"} onClick={() => setTab(t.id)}>
              {t.label}
              {badge > 0 && <span className="tab-badge">{badge}</span>}
            </button>
          );
        })}
      </nav>
    </>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>("records");
  return (
    <main className="app-shell">
      <Header tab={tab} setTab={setTab} />
      {tab === "records" && <RecordsView />}
      {tab === "schedule" && <ScheduleView />}
      {tab === "review" && <ReviewView />}
      {tab === "sync" && <SyncView />}
    </main>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
