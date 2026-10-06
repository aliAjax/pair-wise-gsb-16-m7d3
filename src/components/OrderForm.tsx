import { useMemo, useState } from "react";
import { FREQUENCIES, FittingOrder, OrderCategory, ThresholdMap } from "../domain/types";
import { useStore } from "../store/store";
import { Badge } from "./ui";

const CATEGORIES: OrderCategory[] = ["初配", "复调", "儿童", "老人"];

type EarGrid = Record<
  "L" | "R",
  { air: Record<number, string>; bone: Record<number, string> }
>;

function fromOrder(o: FittingOrder | null): EarGrid {
  const grid: EarGrid = {
    L: { air: {}, bone: {} },
    R: { air: {}, bone: {} },
  };
  if (o) {
    for (const e of ["L", "R"] as const) {
      for (const f of FREQUENCIES) {
        grid[e].air[f] = o.audiogram[e].air[f]?.toString() ?? "";
        grid[e].bone[f] = o.audiogram[e].bone[f]?.toString() ?? "";
      }
    }
  }
  return grid;
}

function parseMap(m: Record<number, string>): ThresholdMap {
  const out: ThresholdMap = {};
  for (const f of FREQUENCIES) {
    const raw = m[f];
    if (raw !== undefined && raw.trim() !== "") {
      const v = Number(raw);
      if (Number.isFinite(v)) out[f] = v;
    }
  }
  return out;
}

export function OrderForm({
  initial,
  onClose,
}: {
  initial: FittingOrder | null;
  onClose: () => void;
}) {
  const { saveOrder } = useStore();
  const [customerId, setCustomerId] = useState(initial?.customerId ?? "");
  const [customerName, setCustomerName] = useState(initial?.customerName ?? "");
  const [category, setCategory] = useState<OrderCategory>(initial?.category ?? "初配");
  const [deviceModel, setDeviceModel] = useState(initial?.deviceModel ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [grid, setGrid] = useState<EarGrid>(() => fromOrder(initial));
  const [error, setError] = useState<string | null>(null);

  const changed = useMemo(() => {
    if (!initial) return true;
    // 简单标记：任意值与原单不同即视为复测改动
    return JSON.stringify(grid) !== JSON.stringify(fromOrder(initial));
  }, [grid, initial]);

  const setCell = (
    ear: "L" | "R",
    kind: "air" | "bone",
    freq: number,
    value: string
  ) => {
    setGrid((g) => ({
      ...g,
      [ear]: { ...g[ear], [kind]: { ...g[ear][kind], [freq]: value } },
    }));
  };

  const submit = () => {
    const ts = Date.now();
    const audiogram = {
      L: { ear: "L" as const, air: parseMap(grid.L.air), bone: parseMap(grid.L.bone), recordedAt: ts },
      R: { ear: "R" as const, air: parseMap(grid.R.air), bone: parseMap(grid.R.bone), recordedAt: ts + 60000 },
    };
    const r = saveOrder({
      id: initial?.id,
      customerId,
      customerName,
      category,
      deviceModel,
      notes,
      audiogram,
    });
    if (!r.ok) {
      setError(r.error ?? "保存失败");
      return;
    }
    onClose();
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="section-heading">
          <h2>{initial ? "复测 / 调整验配单" : "新增验配单"}</h2>
          <button onClick={onClose}>关闭</button>
        </div>
        {initial && (
          <p className="form-hint">
            <Badge tone="warn">复测改动</Badge>
            保存后旧的未确认试戴安排立即失效并重新排期；触发复核时试戴需等结论。
          </p>
        )}

        <div className="field-grid">
          <label>
            <span>客户编号</span>
            <input
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="如 Liu-024"
            />
          </label>
          <label>
            <span>客户姓名</span>
            <input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="客户姓名"
            />
          </label>
          <label>
            <span>分类</span>
            <select value={category} onChange={(e) => setCategory(e.target.value as OrderCategory)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>助听器型号</span>
            <input
              value={deviceModel}
              onChange={(e) => setDeviceModel(e.target.value)}
              placeholder="如 RIC 受话器外置式"
            />
          </label>
        </div>

        {(["L", "R"] as const).map((ear) => (
          <div key={ear} className="ear-block">
            <h3>{ear === "L" ? "左耳" : "右耳"}分频结果（dB HL，留空=未测）</h3>
            <table className="audiogram-table">
              <thead>
                <tr>
                  <th></th>
                  {FREQUENCIES.map((f) => (
                    <th key={f}>{f >= 1000 ? `${f / 1000}k` : f}Hz</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>气导</td>
                  {FREQUENCIES.map((f) => (
                    <td key={f}>
                      <input
                        inputMode="numeric"
                        value={grid[ear].air[f] ?? ""}
                        onChange={(e) => setCell(ear, "air", f, e.target.value)}
                      />
                    </td>
                  ))}
                </tr>
                <tr>
                  <td>骨导</td>
                  {FREQUENCIES.map((f) => (
                    <td key={f}>
                      <input
                        inputMode="numeric"
                        value={grid[ear].bone[f] ?? ""}
                        onChange={(e) => setCell(ear, "bone", f, e.target.value)}
                      />
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        ))}

        <label className="full-label">
          <span>备注 / 用户反馈</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </label>

        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary-action" onClick={submit}>
            {initial ? (changed ? "保存复测并重排" : "保存") : "保存并给出排期"}
          </button>
        </div>
      </div>
    </div>
  );
}
