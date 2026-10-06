import { useMemo, useState } from "react";
import { EarSide, FittingRecord, FREQUENCIES } from "../types";
import { evaluate, fmtDateTime, pta } from "../domain";
import { useStore } from "../store";

function freqLabel(f: number) {
  return f < 1 ? `${f * 1000}` : `${f}k`;
}

function EarEditor({
  title,
  record,
  ear,
  onChange,
}: {
  title: string;
  record: FittingRecord;
  ear: EarSide;
  onChange: (next: FittingRecord) => void;
}) {
  const e = record[ear];
  const setCell = (kind: "air" | "bone", f: (typeof FREQUENCIES)[number], v: string) => {
    onChange({
      ...record,
      [ear]: {
        ...e,
        audiogram: { ...e.audiogram, [kind]: { ...e.audiogram[kind], [f]: v } },
        recordedAt: new Date().toISOString(),
      },
    });
  };
  const setField = (k: "speechScore" | "aidModel" | "gainAdjust" | "feedback", v: string) =>
    onChange({ ...record, [ear]: { ...e, [k]: v, recordedAt: new Date().toISOString() } });

  const { state } = useStore();
  const rule = useMemo(() => evaluate(record, state.thresholds), [record, state.thresholds]);
  const gapMax = rule.maxAirBoneGap?.ear === ear ? rule.maxAirBoneGap : null;

  return (
    <div className={`ear-block ${gapMax ? "flag" : ""}`}>
      <div className="ear-head">
        <h4>{title}</h4>
        <span className="muted">PTA {pta(e) ?? "—"} dB HL · 录入 {fmtDateTime(e.recordedAt)}</span>
      </div>
      <table className="audi-table">
        <thead>
          <tr>
            <th>频率 Hz</th>
            {FREQUENCIES.map((f) => (
              <th key={f}>{f < 1 ? f * 1000 : `${f}000`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>气导 AC</td>
            {FREQUENCIES.map((f) => (
              <td key={f}>
                <input
                  value={e.audiogram.air[f]}
                  inputMode="numeric"
                  placeholder="—"
                  onChange={(ev) => setCell("air", f, ev.target.value.replace(/[^\d-]/g, ""))}
                />
              </td>
            ))}
          </tr>
          <tr>
            <td>骨导 BC</td>
            {FREQUENCIES.map((f) => (
              <td key={f}>
                <input
                  value={e.audiogram.bone[f]}
                  inputMode="numeric"
                  placeholder="—"
                  onChange={(ev) => setCell("bone", f, ev.target.value.replace(/[^\d-]/g, ""))}
                />
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      {gapMax && (
        <p className="inline-warn">
          气骨导差 {gapMax.gap} dB @ {freqLabel(gapMax.freq)} kHz ≥ 10 dB，需复诊助理复核
        </p>
      )}
      <div className="ear-fields">
        <label>
          <span>言语识别率 %</span>
          <input value={e.speechScore} onChange={(ev) => setField("speechScore", ev.target.value)} />
        </label>
        <label>
          <span>助听器型号</span>
          <input value={e.aidModel} onChange={(ev) => setField("aidModel", ev.target.value)} />
        </label>
        <label>
          <span>增益调整</span>
          <input value={e.gainAdjust} onChange={(ev) => setField("gainAdjust", ev.target.value)} />
        </label>
        <label>
          <span>用户反馈</span>
          <input value={e.feedback} onChange={(ev) => setField("feedback", ev.target.value)} />
        </label>
      </div>
    </div>
  );
}

export function RecordsView() {
  const { state, dispatch } = useStore();
  const [selectedId, setSelectedId] = useState(state.records[0]?.id);
  const selected = state.records.find((r) => r.id === selectedId) ?? state.records[0];
  const [draft, setDraft] = useState<FittingRecord | null>(null);

  const editing = draft && selected && draft.id === selected.id ? draft : selected;
  const live = editing ? evaluate(editing, state.thresholds) : null;
  const dirty = draft !== null;

  return (
    <div className="records-view">
      <aside className="panel record-index-panel">
        <h2>验配单</h2>
        {state.records.map((r) => {
          const ev = evaluate(r, state.thresholds);
          const customer = state.customers.find((c) => c.id === r.customerId);
          return (
            <button
              key={r.id}
              className={`record-pick ${selected?.id === r.id ? "active" : ""}`}
              onClick={() => {
                setSelectedId(r.id);
                setDraft(null);
              }}
            >
              <div>
                <strong>{customer?.name ?? r.customerId}</strong>
                <span className="muted">
                  {r.stage} · 更新 {fmtDateTime(r.updatedAt)}
                </span>
              </div>
              <span className={`dot ${ev.needsReview ? "dot-warn" : "dot-ok"}`} title={ev.reasons.join("、")} />
            </button>
          );
        })}
      </aside>

      {editing && (
        <section className="panel editor-panel">
          <div className="section-heading">
            <div>
              <p>分频验配结果</p>
              <h2>{state.customers.find((c) => c.id === editing.customerId)?.name}</h2>
            </div>
            <div className="stage-select">
              {(["初配", "复调", "复诊"] as const).map((s) => (
                <button
                  key={s}
                  className={editing.stage === s ? "seg active" : "seg"}
                  onClick={() => setDraft({ ...editing, stage: s })}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {live && (
            <div className={`verdict ${live.needsReview ? "verdict-warn" : "verdict-ok"}`}>
              <div>
                <strong>
                  {live.needsReview ? "触发复核闸口：" + live.reasons.join("、") : "两耳参数一致，无需复核"}
                </strong>
                <span className="muted">
                  左 PTA {live.leftPTA ?? "—"} / 右 PTA {live.rightPTA ?? "—"}
                  {live.ptaGap !== null && ` · 耳间差 ${live.ptaGap} dB`}
                </span>
              </div>
              <div className="verdict-days">建议复诊间隔 <b>{live.followUpDays}</b> 天</div>
            </div>
          )}

          <EarEditor title="左耳" record={editing} ear="left" onChange={setDraft} />
          <EarEditor title="右耳" record={editing} ear="right" onChange={setDraft} />

          <div className="editor-actions">
            <button
              className="primary-action"
              disabled={!dirty}
              onClick={() => {
                dispatch({ type: "save-record", record: editing });
                setDraft(null);
              }}
            >
              保存复测并联动排期
            </button>
            <button disabled={!dirty} onClick={() => setDraft(null)}>
              放弃改动
            </button>
            <span className="muted">
              保存后：未确认试戴若依据变化即失效；命中阈值自动提交复诊助理复核
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
