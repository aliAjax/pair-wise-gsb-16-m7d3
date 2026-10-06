import { ConflictEntry } from "../domain/types";
import { useStore } from "../store/store";
import { Badge, Card, Empty, fmtDateTime } from "./ui";

function ConflictRow({ c }: { c: ConflictEntry }) {
  const { resolveConflict } = useStore();
  const earText = c.ear === "both" ? "双耳" : c.ear === "L" ? "左耳" : "右耳";
  const pending = c.status === "pending";

  return (
    <article className={`conflict-card ${pending ? "" : "conflict-done"}`}>
      <div className="conflict-head">
        <h3>
          {c.customerName} <span className="sub-id">{c.customerId}</span>
        </h3>
        <Badge tone={pending ? "danger" : "neutral"}>
          {earText} ·{" "}
          {pending
            ? c.auto
              ? "已按复核优先自动保留服务端"
              : "待人工裁决"
            : c.status === "resolved-local"
              ? "已保留本地录入"
              : "已保留服务端录入"}
        </Badge>
      </div>
      <div className="conflict-times">
        <div className="conflict-side">
          <Badge tone="info">本地录入</Badge>
          <strong>{fmtDateTime(c.localEnteredAt)}</strong>
          <p>{c.localSummary}</p>
        </div>
        <div className="conflict-arrow">⇄</div>
        <div className="conflict-side">
          <Badge tone="warn">服务端录入</Badge>
          <strong>{fmtDateTime(c.remoteEnteredAt)}</strong>
          <p>{c.remoteSummary}</p>
        </div>
      </div>
      <p className="conflict-reason">{c.reason}</p>
      {pending && (
        <div className="review-actions">
          <button
            className="tiny"
            onClick={() => resolveConflict(c.id, "local")}
          >
            保留本地版本
          </button>
          <button
            className="tiny primary-action"
            onClick={() => resolveConflict(c.id, "remote")}
          >
            采用服务端版本
          </button>
        </div>
      )}
    </article>
  );
}

export function ConflictPanel() {
  const { conflicts } = useStore();
  const pending = conflicts.filter((c) => c.status === "pending");
  const done = conflicts.filter((c) => c.status !== "pending");

  return (
    <Card
      title={
        <>
          合并冲突清单
          {pending.length > 0 && <span className="title-count">{pending.length} 待裁决</span>}
        </>
      }
    >
      <p className="panel-hint">
        断网期间两端分别录入同一客户时产生；每条给出客户、耳别和两次录入时间。服务端版本若已带复诊助理复核结论，按“复核结论优先”自动保留。
      </p>
      {conflicts.length === 0 && <Empty text="暂无冲突。可断网复测后，再让“他端”改同一耳并恢复网络来演示。" />}
      <div className="review-list">
        {[...pending, ...done].map((c) => (
          <ConflictRow key={c.id} c={c} />
        ))}
      </div>
    </Card>
  );
}
