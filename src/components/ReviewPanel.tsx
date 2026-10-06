import { useState } from "react";
import { ReviewVerdict, VERDICT_LABEL } from "../domain/types";
import { useStore } from "../store/store";
import { Badge, Card, Empty, fmtDateTime } from "./ui";

const VERDICTS: ReviewVerdict[] = ["pass", "adjust", "reject"];

export function ReviewPanel() {
  const { orders, helpers, submitReview, online, remoteReviewDemo } = useStore();
  const [comment, setComment] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const pending = orders.filter((o) => helpers.triggersFor(o).length > 0);

  return (
    <Card title="复诊助理复核台">
      <p className="panel-hint">
        两耳分频不一致或气骨导差达到阈值的验配单先转这里；复核结论没回来之前，助听器试戴不能确认。
        {online ? " 当前联网，提交结论立即同步。" : " 当前断网，结论先存本地，恢复后合并。"}
      </p>
      {pending.length === 0 && <Empty text="暂无待复核验配单" />}
      <div className="review-list">
        {pending.map((o) => {
          const triggers = helpers.triggersFor(o);
          const review = helpers.reviewFor(o);
          const stale = review && review.orderEnteredAt !== o.enteredAt;
          return (
            <article key={o.id} className="review-card">
              <div className="review-head">
                <h3>
                  {o.customerName} <span className="sub-id">{o.customerId}</span>
                </h3>
                {review && !stale ? (
                  <Badge tone={review.verdict === "pass" ? "ok" : "danger"}>
                    已复核：{VERDICT_LABEL[review.verdict]}
                  </Badge>
                ) : stale ? (
                  <Badge tone="warn">复测后旧结论已失效，需重新复核</Badge>
                ) : (
                  <Badge tone="warn">待复核 · 试戴锁定</Badge>
                )}
              </div>
              <ul className="trigger-detail">
                {triggers.map((t) => (
                  <li key={t.type}>{t.detail}</li>
                ))}
              </ul>
              {review && (
                <p className="review-comment">
                  最近结论（{fmtDateTime(review.createdAt)} · {review.reviewer}）：
                  {review.comment || VERDICT_LABEL[review.verdict]}
                </p>
              )}
              <textarea
                rows={2}
                placeholder="复核意见，如：气骨导差系陈旧性中耳炎，准予试戴…"
                value={comment[o.id] ?? ""}
                onChange={(e) =>
                  setComment((c) => ({ ...c, [o.id]: e.target.value }))
                }
              />
              <div className="review-actions">
                {VERDICTS.map((v) => (
                  <button
                    key={v}
                    className={
                      v === "pass"
                        ? "primary-action tiny"
                        : v === "reject"
                          ? "danger-action tiny"
                          : "tiny"
                    }
                    onClick={() => {
                      const r = submitReview(o.id, v, comment[o.id] ?? "");
                      setMsg(r.ok ? null : r.error ?? "提交失败");
                    }}
                  >
                    {VERDICT_LABEL[v]}
                  </button>
                ))}
                {online && (
                  <button
                    className="tiny ghost"
                    onClick={() =>
                      remoteReviewDemo(
                        o.id,
                        "pass",
                        "他端助理复核：参数可接受，准予试戴"
                      )
                    }
                  >
                    模拟他端回复通过
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {msg && <p className="error-text">{msg}</p>}
    </Card>
  );
}
