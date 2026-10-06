import { useState } from "react";
import { FittingOrder, KIND_LABEL } from "../domain/types";
import { useStore } from "../store/store";
import { Badge, Card, Empty, fmtDateTime } from "./ui";
import { OrderForm } from "./OrderForm";
import { AB_GAP_THRESHOLD, BINAURAL_DIFF_THRESHOLD } from "../domain/audiology";

function OrderRow({ order, onEdit }: { order: FittingOrder; onEdit: (o: FittingOrder) => void }) {
  const { helpers, online, remoteEditDemo } = useStore();
  const ptaL = helpers.pta(order, "L");
  const ptaR = helpers.pta(order, "R");
  const triggers = helpers.triggersFor(order);
  const review = helpers.reviewFor(order);
  const appts = helpers.apptsForOrder(order.id);

  return (
    <article className="record-card order-card">
      <div className="record-main">
        <div className="record-head">
          <div className="record-index">{order.customerId.slice(-3)}</div>
          <div>
            <h3>
              {order.customerName}
              <span className="sub-id">
                {" "}
                {order.customerId} · {order.category} · {order.deviceModel || "未配机型"}
              </span>
            </h3>
            <p className="record-meta">
              最近录入 {fmtDateTime(order.enteredAt)}
              {order.dirty && <Badge tone="warn">本地未同步</Badge>}
              {!online && !order.dirty && <Badge tone="neutral">已同步副本</Badge>}
            </p>
          </div>
          <div className="head-actions">
            <button onClick={() => onEdit(order)}>复测 / 编辑</button>
          </div>
        </div>

        <div className="ear-summary-grid">
          <div className={`ear-chip ${triggers.length ? "ear-chip-warn" : ""}`}>
            <strong>左耳</strong>
            <span>
              PTA {ptaL ?? "—"} dB · {helpers.grade(order, "L")}
            </span>
          </div>
          <div className={`ear-chip ${triggers.length ? "ear-chip-warn" : ""}`}>
            <strong>右耳</strong>
            <span>
              PTA {ptaR ?? "—"} dB · {helpers.grade(order, "R")}
            </span>
          </div>
        </div>

        <div className="tag-row">
          {triggers.length === 0 && <Badge tone="ok">分频一致 · 无需复核</Badge>}
          {triggers.map((t) => (
            <Badge key={t.type} tone="warn">
              {t.type === "ab-gap"
                ? `气骨导差≥${AB_GAP_THRESHOLD}dB`
                : `两耳分频差≥${BINAURAL_DIFF_THRESHOLD}dB`}
            </Badge>
          ))}
          {review ? (
            <Badge tone={review.verdict === "pass" ? "ok" : "danger"}>
              复核：{review.verdict === "pass" ? "通过" : review.verdict} · {review.reviewer}
            </Badge>
          ) : (
            triggers.length > 0 && <Badge tone="info">等待复诊助理复核</Badge>
          )}
        </div>
        {triggers.length > 0 && (
          <ul className="trigger-detail">
            {triggers.map((t) => (
              <li key={t.type}>{t.detail}</li>
            ))}
          </ul>
        )}
        {review && <p className="review-comment">复核意见：{review.comment || "—"}</p>}
        {order.notes && <p className="record-notes">{order.notes}</p>}

        <div className="mini-appts">
          {appts.length === 0 && <Empty text="暂无排期" />}
          {appts.map((a) => (
            <div key={a.id} className={`mini-appt mini-appt-${a.status}`}>
              <span className="mini-kind">{KIND_LABEL[a.kind]}</span>
              <span>{fmtDateTime(a.start)}</span>
              <span>{a.roomId}</span>
              <StatusTag status={a.status} />
            </div>
          ))}
        </div>

        {online && (
          <div className="demo-row">
            <span>演示他端并发：</span>
            <button
              onClick={() =>
                remoteEditDemo({ orderId: order.id, ear: "R", freq: 4000, air: Math.round((ptaR ?? 40) + 15) })
              }
            >
              他端改右耳4k气导
            </button>
            <button
              onClick={() =>
                remoteEditDemo({ orderId: order.id, ear: "L", freq: 500, bone: Math.round((ptaL ?? 30) - 15) })
              }
            >
              他端改左耳0.5k骨导
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

export function StatusTag({ status }: { status: import("../domain/types").AppointmentStatus }) {
  const map = {
    suggested: ["info", "待确认"],
    confirmed: ["ok", "已确认"],
    invalidated: ["danger", "已失效"],
    cancelled: ["neutral", "已取消/释放"],
  } as const;
  const [tone, text] = map[status];
  return <Badge tone={tone}>{text}</Badge>;
}

export function OrdersPanel() {
  const { orders } = useStore();
  const [editing, setEditing] = useState<FittingOrder | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <Card
      title="验配单（左右耳分频结果）"
      extra={
        <button className="primary-action" onClick={() => setCreating(true)}>
          新增验配单
        </button>
      }
    >
      <p className="panel-hint">
        保存验配单即据分频结果给出下次复诊与试戴时段；气骨导差 ≥{AB_GAP_THRESHOLD}dB
        或两耳同频差 ≥{BINAURAL_DIFF_THRESHOLD}dB 自动转复诊助理。
      </p>
      <div className="record-list">
        {orders.map((o) => (
          <OrderRow key={o.id} order={o} onEdit={setEditing} />
        ))}
      </div>
      {(editing || creating) && (
        <OrderForm initial={editing} onClose={() => { setEditing(null); setCreating(false); }} />
      )}
    </Card>
  );
}
