import { useState } from "react";
import { Review } from "../types";
import { EAR_LABEL } from "../types";
import { evaluate, fmtDateTime } from "../domain";
import { useStore } from "../store";

function ReviewCard({ rv }: { rv: Review }) {
  const { state, dispatch } = useStore();
  const record = state.records.find((r) => r.id === rv.recordId);
  const customer = state.customers.find((c) => c.id === rv.customerId);
  const [conclusion, setConclusion] = useState(
    rv.conclusion ?? "耳间差异为使用习惯不同，双耳参数已分别校正，可进入试戴。"
  );
  if (!record) return null;
  const ev = evaluate(record, state.thresholds);
  const stale = rv.signature !== ev.signature;

  return (
    <article className={`review-card review-${rv.status}`}>
      <div className="booking-top">
        <strong>{customer?.name}</strong>
        <span className={`tag tag-${rv.status === "approved" ? "confirmed" : rv.status === "returned" ? "released" : "proposed"}`}>
          {rv.status === "pending" ? "待复核" : rv.status === "approved" ? "复核通过" : "已退回"}
        </span>
      </div>
      <p className="small">
        触发原因：{rv.reasons.join("、")} · 耳别：{rv.ears.map((e) => EAR_LABEL[e]).join("、")}
      </p>
      <p className="small muted">
        左 PTA {ev.leftPTA ?? "—"} / 右 PTA {ev.rightPTA ?? "—"} dB
        {ev.maxAirBoneGap &&
          ` · 最大气骨导差 ${ev.maxAirBoneGap.gap} dB（${EAR_LABEL[ev.maxAirBoneGap.ear]}）`}
      </p>
      <p className="small muted">
        提交 {fmtDateTime(rv.createdAt)}
        {rv.decidedAt && ` · ${rv.decidedBy}结论 ${fmtDateTime(rv.decidedAt)}`}
      </p>
      {stale && rv.status !== "pending" && (
        <p className="inline-warn">复测结果在结论之后又发生变化，已重新生成待复核单。</p>
      )}

      {rv.status === "pending" ? (
        <>
          <textarea
            rows={2}
            value={conclusion}
            onChange={(e) => setConclusion(e.target.value)}
            placeholder="复核结论…"
          />
          <div className="booking-actions">
            <button
              className="mini primary"
              onClick={() => dispatch({ type: "review-decide", reviewId: rv.id, status: "approved", conclusion })}
            >
              结论：通过，放行试戴
            </button>
            <button
              className="mini danger"
              onClick={() =>
                dispatch({
                  type: "review-decide",
                  reviewId: rv.id,
                  status: "returned",
                  conclusion: conclusion || "参数异常，退回听力师复测",
                })
              }
            >
              退回调整
            </button>
          </div>
          <p className="small muted">结论返回前，该客户的试戴安排无法确认。</p>
        </>
      ) : (
        rv.conclusion && <p className="conclusion-text">“{rv.conclusion}”</p>
      )}
    </article>
  );
}

export function ReviewView() {
  const { state, dispatch } = useStore();
  const pending = state.reviews.filter((r) => r.status === "pending");
  const decided = state.reviews.filter((r) => r.status !== "pending");

  return (
    <div className="review-view">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p>复诊助理复核台</p>
            <h2>待复核（{pending.length}）</h2>
          </div>
          <button
            onClick={() => {
              const rv = pending[0];
              if (rv)
                dispatch({
                  type: "simulate-remote-review",
                  reviewId: rv.id,
                  status: "approved",
                  conclusion: "服务端复核通过：差异在可接受范围，同意试戴。",
                });
            }}
            disabled={pending.length === 0}
          >
            模拟助理在服务端批复
          </button>
        </div>
        <div className="review-grid">
          {pending.map((rv) => <ReviewCard key={rv.id} rv={rv} />)}
          {pending.length === 0 && <p className="muted">当前没有等待复核的验配单。</p>}
        </div>
      </section>

      {decided.length > 0 && (
        <section className="panel">
          <h3>已出结论</h3>
          <div className="review-grid">
            {decided.map((rv) => <ReviewCard key={rv.id} rv={rv} />)}
          </div>
        </section>
      )}
    </div>
  );
}
