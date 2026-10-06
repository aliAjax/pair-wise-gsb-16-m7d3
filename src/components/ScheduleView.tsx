import { useMemo, useState } from "react";
import { Booking } from "../types";
import { fmtSlot, nextDates, recordSignature, SLOT_HOURS } from "../domain";
import { useStore } from "../store";

const KIND_LABEL: Record<Booking["kind"], string> = { followup: "复诊", trial: "试戴" };

function BookingCard({ b }: { b: Booking }) {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState(false);
  const customer = state.customers.find((c) => c.id === b.customerId);
  const record = state.records.find((r) => r.id === b.recordId);
  const review = state.reviews.find((rv) => rv.recordId === b.recordId);
  const hasConflict = state.conflicts.some((c) => c.recordId === b.recordId);
  const stale =
    b.kind === "trial" && b.status === "proposed" && record && b.signature !== recordSignature(record);

  const dates = useMemo(() => nextDates(1, 7), []);
  const [date, setDate] = useState(dates[0]);
  const [hour, setHour] = useState(9);
  const [roomId, setRoomId] = useState(b.roomId);
  const slot = `${date}T${String(hour).padStart(2, "0")}`;

  const blockedReason =
    b.kind === "trial" && b.status === "proposed"
      ? hasConflict
        ? "存在未裁决冲突"
        : review && review.status === "pending"
          ? "等待复核结论"
          : review && review.status === "returned"
            ? "复核已退回"
            : stale
              ? "依据已过期"
              : null
      : null;

  if (b.status === "released") {
    return (
      <article className="booking booking-released">
        <div className="booking-top">
          <span className="tag tag-released">已释放</span>
          <span className="tag tag-kind">{KIND_LABEL[b.kind]}</span>
        </div>
        <strong>{customer?.name}</strong>
        <p className="muted small">{fmtSlot(b.slot)} · {b.note ?? "时段已释放"}</p>
      </article>
    );
  }

  return (
    <article className={`booking booking-${b.status} ${b.kind === "trial" ? "trial" : ""}`}>
      <div className="booking-top">
        <span className={`tag tag-${b.status}`}>{b.status === "confirmed" ? "已确认" : "待确认"}</span>
        <span className="tag tag-kind">{KIND_LABEL[b.kind]}</span>
      </div>
      <strong>{customer?.name}</strong>
      <p className="small muted">
        {fmtSlot(b.slot)} · {state.rooms.find((r) => r.id === b.roomId)?.name}
      </p>
      {b.note && <p className="small note-line">{b.note}</p>}
      {blockedReason && <p className="small block-line">⛔ {blockedReason}</p>}

      {!editing ? (
        <div className="booking-actions">
          {b.status === "proposed" && (
            <button
              className="mini primary"
              disabled={!!blockedReason}
              title={blockedReason ?? ""}
              onClick={() => dispatch({ type: "confirm-booking", bookingId: b.id })}
            >
              确认
            </button>
          )}
          <button className="mini" onClick={() => setEditing(true)}>
            改期
          </button>
          <button
            className="mini danger"
            onClick={() =>
              dispatch({ type: "release-booking", bookingId: b.id, reason: "人工取消，时段已释放" })
            }
          >
            释放
          </button>
        </div>
      ) : (
        <div className="reschedule">
          <select value={date} onChange={(e) => setDate(e.target.value)}>
            {dates.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <select value={hour} onChange={(e) => setHour(Number(e.target.value))}>
            {SLOT_HOURS.map((h) => (
              <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
            ))}
          </select>
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            {state.rooms.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <div className="booking-actions">
            <button
              className="mini primary"
              onClick={() => {
                dispatch({ type: "reschedule", bookingId: b.id, roomId, slot });
                setEditing(false);
              }}
            >
              确认改期
            </button>
            <button className="mini" onClick={() => setEditing(false)}>取消</button>
          </div>
          <p className="small muted">改期将先释放原时段，新时段需重新确认</p>
        </div>
      )}
    </article>
  );
}

export function ScheduleView() {
  const { state, dispatch } = useStore();
  const dates = useMemo(() => nextDates(1, 5), []);
  const [date, setDate] = useState(dates[0]);
  const [recordId, setRecordId] = useState(state.records[0]?.id ?? "");
  const [kind, setKind] = useState<Booking["kind"]>("followup");
  const [hour, setHour] = useState(9);
  const [roomId, setRoomId] = useState(state.rooms[0]?.id ?? "");

  const active = state.bookings.filter((b) => b.slot.startsWith(date));
  const released = state.bookings.filter((b) => b.status === "released");

  return (
    <div className="schedule-view">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p>可排期验配台</p>
            <h2>验配间时段占用</h2>
          </div>
          <div className="day-tabs">
            {dates.map((d) => (
              <button key={d} className={date === d ? "seg active" : "seg"} onClick={() => setDate(d)}>
                {d.slice(5)}
              </button>
            ))}
          </div>
        </div>

        <div className="grid-scroll">
          <table className="room-grid">
            <thead>
              <tr>
                <th>时段</th>
                {state.rooms.map((r) => (
                  <th key={r.id}>{r.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SLOT_HOURS.map((h) => {
                const slot = `${date}T${String(h).padStart(2, "0")}`;
                return (
                  <tr key={h}>
                    <td className="hour-cell">{String(h).padStart(2, "0")}:00</td>
                    {state.rooms.map((room) => {
                      const bk = active.find((b) => b.roomId === room.id && b.slot === slot);
                      if (!bk) return <td key={room.id} className="cell-free">空闲</td>;
                      const c = state.customers.find((x) => x.id === bk.customerId);
                      return (
                        <td
                          key={room.id}
                          className={`cell-booked ${bk.status} ${bk.kind === "trial" ? "is-trial" : ""}`}
                        >
                          <b>{c?.name}</b>
                          <span>
                            {KIND_LABEL[bk.kind]} · {bk.status === "confirmed" ? "已确认" : "待确认"}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          同一客户同一时段只能占一个验配间；跨间撞单在同步合并时按"已确认优先"自动释放。
        </p>
      </section>

      <div className="schedule-side">
        <section className="panel">
          <h3>新建排期</h3>
          <label>
            <span>验配单 / 客户</span>
            <select value={recordId} onChange={(e) => setRecordId(e.target.value)}>
              {state.records.map((r) => (
                <option key={r.id} value={r.id}>
                  {state.customers.find((c) => c.id === r.customerId)?.name}（{r.stage}）
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>类型</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as Booking["kind"])}>
              <option value="followup">复诊</option>
              <option value="trial">助听器试戴</option>
            </select>
          </label>
          <label>
            <span>时段</span>
            <div className="two-col">
              <select value={date} onChange={(e) => setDate(e.target.value)}>
                {dates.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <select value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                {SLOT_HOURS.map((h) => (
                  <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
                ))}
              </select>
            </div>
          </label>
          <label>
            <span>验配间</span>
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {state.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <button
            className="primary-action full"
            onClick={() =>
              dispatch({
                type: "schedule",
                booking: {
                  customerId: state.records.find((r) => r.id === recordId)!.customerId,
                  recordId,
                  kind,
                  roomId,
                  slot: `${date}T${String(hour).padStart(2, "0")}`,
                },
              })
            }
          >
            排入时段
          </button>
        </section>

        <section className="panel">
          <h3>待办（{state.bookings.filter((b) => b.status === "proposed").length}）</h3>
          <div className="booking-stack">
            {state.bookings
              .filter((b) => b.status === "proposed")
              .map((b) => <BookingCard key={b.id} b={b} />)}
            {state.bookings.every((b) => b.status !== "proposed") && (
              <p className="muted small">暂无待确认安排</p>
            )}
          </div>
        </section>

        {released.length > 0 && (
          <section className="panel">
            <h3>已释放留痕（{released.length}）</h3>
            <div className="booking-stack">
              {released.slice(-4).map((b) => <BookingCard key={b.id} b={b} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
