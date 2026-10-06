import { useMemo, useState } from "react";
import { StoreProvider, useStore } from "./store/store";
import { OrdersPanel } from "./components/OrdersPanel";
import { SchedulePanel } from "./components/SchedulePanel";
import { ReviewPanel } from "./components/ReviewPanel";
import { ConflictPanel } from "./components/ConflictPanel";
import { Badge, fmtDateTime } from "./components/ui";
import { needsReview } from "./domain/audiology";
import "./styles.css";

type Tab = "schedule" | "orders" | "review" | "conflicts";

const TABS: { key: Tab; label: string }[] = [
  { key: "schedule", label: "验配间排期" },
  { key: "orders", label: "验配单" },
  { key: "review", label: "复核台" },
  { key: "conflicts", label: "冲突清单" },
];

function Metrics() {
  const { orders, appts, conflicts } = useStore();
  const stats = useMemo(() => {
    const waitingReview = orders.filter((o) => needsReview(o.audiogram)).length;
    const trials = appts.filter((a) => a.kind === "trial");
    const confirmedTrials = trials.filter((a) => a.status === "confirmed").length;
    const invalidTrials = trials.filter((a) => a.status === "invalidated").length;
    const pendingConflicts = conflicts.filter((c) => c.status === "pending").length;
    return { waitingReview, confirmedTrials, invalidTrials, pendingConflicts };
  }, [orders, appts, conflicts]);

  const cards = [
    { label: "待复核验配单", value: stats.waitingReview, tone: "warn" as const },
    { label: "已确认试戴", value: stats.confirmedTrials, tone: "ok" as const },
    { label: "失效待重排", value: stats.invalidTrials, tone: "danger" as const },
    { label: "待裁决冲突", value: stats.pendingConflicts, tone: "neutral" as const },
  ];
  return (
    <section className="metrics-grid">
      {cards.map((c) => (
        <article key={c.label} className="metric-card">
          <span>{c.label}</span>
          <strong>{c.value}</strong>
          <i className={`status-bar bar-${c.tone}`} />
        </article>
      ))}
    </section>
  );
}

function NetworkBar() {
  const {
    online,
    setOnline,
    sync,
    outbox,
    lastSyncAt,
    conflicts,
    resetAll,
  } = useStore();
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const pendingConflicts = conflicts.filter((c) => c.status === "pending").length;

  const toggle = async () => {
    setBusy(true);
    setFlash(null);
    if (online) {
      await setOnline(false);
    } else {
      const r = await setOnline(true);
      if (r)
        setFlash(
          `上送 ${r.pushed} 项 · 拉取 ${r.pulled} 项` +
            (r.autoResolved ? ` · 复核优先自动裁决 ${r.autoResolved}` : "") +
            (r.conflicts ? ` · ${r.conflicts} 处需人工裁决` : "")
        );
    }
    setBusy(false);
  };

  return (
    <div className="network-bar">
      <div className={`net-dot ${online ? "net-on" : "net-off"}`} />
      <strong>{online ? "网络在线" : "断网 · 本地模式"}</strong>
      <span className="net-sub">
        {online
          ? "保存与复核直接同步"
          : `待合并队列 ${outbox.length} 项（验配单/复核结论）`}
      </span>
      {pendingConflicts > 0 && <Badge tone="danger">{pendingConflicts} 处冲突待裁决</Badge>}
      <div className="net-spacer" />
      {lastSyncAt && (
        <span className="net-sub">上次同步 {fmtDateTime(lastSyncAt)}</span>
      )}
      {online && (
        <button
          className="tiny"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await sync();
            setFlash(`已拉取合并：${r.pulled} 项`);
            setBusy(false);
          }}
        >
          立即拉取合并
        </button>
      )}
      <button className={online ? "danger-action" : "primary-action"} disabled={busy} onClick={toggle}>
        {busy ? "合并中…" : online ? "模拟断网" : "恢复网络并合并"}
      </button>
      <button
        className="tiny ghost"
        onClick={() => {
          if (confirm("重置为初始演示数据？本地与服务端缓存都会清空。")) resetAll();
        }}
      >
        重置演示
      </button>
      {flash && <span className="sync-flash">{flash}</span>}
    </div>
  );
}

function LogTicker() {
  const { logs } = useStore();
  return (
    <section className="panel log-panel">
      <div className="section-heading">
        <h2>操作与规则日志</h2>
      </div>
      <ul className="log-list">
        {logs.slice(0, 10).map((l) => (
          <li key={l.id} className={`log-level-${l.level}`}>
            <span className="log-time">{fmtDateTime(l.at)}</span>
            <span>{l.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Workspace() {
  const [tab, setTab] = useState<Tab>("schedule");
  const { conflicts } = useStore();
  const pending = conflicts.filter((c) => c.status === "pending").length;

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-01 · 听力验配台</p>
          <h1>可排期的听力验配工作台</h1>
          <p className="subtitle">
            每份验配单保存左右耳分频结果并自动给出复诊、试戴时段；复测改动后未确认试戴失效重排；
            两耳不一致或气骨导差达阈值先经复诊助理复核；断网先存本地，恢复后按“复核结论优先”合并。
          </p>
        </div>
        <div className="stack-card">
          <span>运行模式</span>
          <strong>离线优先 · outbox 合并 · localStorage 双库</strong>
          <span className="net-sub">纯前端演示，无需后端</span>
        </div>
      </section>

      <NetworkBar />
      <Metrics />

      <nav className="tab-bar">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "tab tab-active" : "tab"}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === "conflicts" && pending > 0 && (
              <span className="tab-dot">{pending}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === "schedule" && <SchedulePanel />}
      {tab === "orders" && <OrdersPanel />}
      {tab === "review" && <ReviewPanel />}
      {tab === "conflicts" && <ConflictPanel />}

      <LogTicker />
    </main>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Workspace />
    </StoreProvider>
  );
}
