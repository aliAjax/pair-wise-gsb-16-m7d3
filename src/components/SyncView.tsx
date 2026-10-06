import { useState } from "react";
import { Conflict, FREQUENCIES } from "../types";
import { fmtDateTime } from "../domain";
import { useStore } from "../store";

function ConflictCard({ c }: { c: Conflict }) {
  const { dispatch } = useStore();
  const earName = c.ear === "left" ? "左耳" : "右耳";
  return (
    <article className="conflict-card">
      <div className="booking-top">
        <strong>{c.customerName} · {earName}</strong>
        <span className="tag tag-proposed">待裁决</span>
      </div>
      <p className="small muted">{c.reason}</p>
      <table className="conflict-table">
        <thead>
          <tr>
            <th>频率</th>
            <th>本机录入 {fmtDateTime(c.localRecordedAt)}</th>
            <th>服务端录入 {fmtDateTime(c.remoteRecordedAt)}</th>
          </tr>
        </thead>
        <tbody>
          {FREQUENCIES.map((f) => {
            const lv = c.localEar.audiogram.air[f];
            const rv = c.remoteEar.audiogram.air[f];
            const diff = lv !== rv;
            return (
              <tr key={f} className={diff ? "row-diff" : ""}>
                <td>{f < 1 ? f * 1000 : `${f}000`} Hz</td>
                <td>气导 {lv || "—"} / 骨导 {c.localEar.audiogram.bone[f] || "—"}</td>
                <td>气导 {rv || "—"} / 骨导 {c.remoteEar.audiogram.bone[f] || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="booking-actions">
        <button className="mini primary" onClick={() => dispatch({ type: "resolve-conflict", conflictId: c.id, choice: "local" })}>
          采用本机（{fmtDateTime(c.localRecordedAt)}）
        </button>
        <button className="mini" onClick={() => dispatch({ type: "resolve-conflict", conflictId: c.id, choice: "remote" })}>
          采用服务端（{fmtDateTime(c.remoteRecordedAt)}）
        </button>
      </div>
      <p className="small muted">裁决后重新跑复核规则；未裁决前该客户试戴不能确认。</p>
    </article>
  );
}

export function SyncView() {
  const { state, dispatch } = useStore();
  const [recordId, setRecordId] = useState(state.records[0]?.id ?? "");
  const [ear, setEar] = useState<"left" | "right">("left");
  const [freq, setFreq] = useState<number>(4);
  const [value, setValue] = useState("75");

  const queueLabel: Record<string, string> = {
    "record-upsert": "验配单保存",
    "booking-upsert": "排期变更",
    "review-decide": "复核结论",
  };

  return (
    <div className="sync-view">
      <section className="panel net-panel">
        <div className="net-status">
          <span className={`net-dot ${state.online ? "on" : "off"}`} />
          <div>
            <h2>{state.online ? "网络在线" : "已断网（本地模式）"}</h2>
            <p className="small muted">
              断网时所有操作先存本地队列；恢复后自动三向合并，复核结论以服务端优先。
              {state.lastSyncAt && ` 上次合并 ${fmtDateTime(state.lastSyncAt)}`}
            </p>
          </div>
        </div>
        <div className="net-actions">
          <button
            className={state.online ? "" : "primary-action"}
            onClick={() => dispatch({ type: "set-online", online: !state.online })}
          >
            {state.online ? "模拟断网" : "恢复联网"}
          </button>
          <button
            className="primary-action"
            disabled={state.online === false}
            onClick={() => dispatch({ type: "sync" })}
          >
            立即合并
          </button>
          <button onClick={() => dispatch({ type: "reset-demo" })}>重置演示数据</button>
        </div>
        <div className="queue-box">
          <h3>本地待同步队列（{state.queue.length}）</h3>
          {state.queue.length === 0 ? (
            <p className="small muted">队列已清空</p>
          ) : (
            <ul>
              {state.queue.slice(-8).map((op, i) => (
                <li key={i} className="small">
                  {queueLabel[op.type]} · {fmtDateTime(op.at)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>冲突清单</p>
            <h2>待人工裁决（{state.conflicts.length}）</h2>
          </div>
        </div>
        <p className="small muted">
          同一客户同一耳别在两台终端都有复测录入时挂起，清单给出客户、耳别和两次录入时间。
        </p>
        {state.conflicts.length === 0 ? (
          <p className="muted">暂无冲突。可先用下方"模拟另一台终端复测"制造场景：断网 → 本机改一版 → 恢复前让服务端也改一版 → 合并。</p>
        ) : (
          <div className="conflict-stack">{state.conflicts.map((c) => <ConflictCard key={c.id} c={c} />)}</div>
        )}
      </section>

      <section className="panel demo-panel">
        <h3>模拟另一台终端的服务端复测（用于制造冲突）</h3>
        <div className="demo-form">
          <label>
            <span>客户</span>
            <select value={recordId} onChange={(e) => setRecordId(e.target.value)}>
              {state.records.map((r) => (
                <option key={r.id} value={r.id}>
                  {state.customers.find((c) => c.id === r.customerId)?.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>耳别</span>
            <select value={ear} onChange={(e) => setEar(e.target.value as "left" | "right")}>
              <option value="left">左耳</option>
              <option value="right">右耳</option>
            </select>
          </label>
          <label>
            <span>频率</span>
            <select value={freq} onChange={(e) => setFreq(Number(e.target.value))}>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>{f < 1 ? f * 1000 : `${f}000`} Hz</option>
              ))}
            </select>
          </label>
          <label>
            <span>气导 dB</span>
            <input value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d-]/g, ""))} />
          </label>
          <button
            onClick={() =>
              dispatch({
                type: "simulate-remote-record",
                recordId,
                ear,
                airPatch: { [freq]: value },
              })
            }
          >
            写入服务端
          </button>
        </div>
      </section>

      <section className="panel log-panel">
        <div className="section-heading">
          <h3>规则与同步日志</h3>
          <button className="mini" onClick={() => dispatch({ type: "dismiss-log" })}>清空</button>
        </div>
        <ul className="log-list">
          {[...state.logs].reverse().map((l, i) => (
            <li key={i} className={`log-${l.tone}`}>
              <span className="log-time">{fmtDateTime(l.at)}</span>
              {l.message}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
