import { useMemo, useState } from "react";
import {
  CLOSE_HOUR,
  OPEN_HOUR,
  ROOMS,
  formatSlot,
  listFreeSlots,
  roomName,
} from "../domain/scheduling";
import { SLOT_MINUTES } from "../domain/audiology";
import { KIND_LABEL, Appointment } from "../domain/types";
import { useStore } from "../store/store";
import { Badge, Card, Empty, shortTime } from "./ui";
import { StatusTag } from "./OrdersPanel";

function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const SLOT_COUNT = (CLOSE_HOUR - OPEN_HOUR) * (60 / SLOT_MINUTES);

function ApptCard({ appt, dayKey }: { appt: Appointment; dayKey: number }) {
  const { confirmTrial, reschedule, cancelAppt, helpers, orders, appts } =
    useStore();
  const [picked, setPicked] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const gate = helpers.gateFor(appt);
  const order = orders.find((o) => o.id === appt.orderId);

  // 改期候选：排除自身后找客户与验配间都空闲的时段
  const freeSlots = useMemo(
    () =>
      listFreeSlots(
        appts.filter((a) => a.id !== appt.id),
        appt.customerId,
        dayKey + OPEN_HOUR * 3600000,
        appt.roomId,
        14
      ).filter((s) => !(s.start === appt.start && s.roomId === appt.roomId)),
    [appts, appt, dayKey]
  );

  const live = appt.status === "suggested" || appt.status === "confirmed";

  return (
    <div className={`appt-card appt-${appt.status} appt-kind-${appt.kind}`}>
      <div className="appt-head">
        <strong>{appt.customerName}</strong>
        <StatusTag status={appt.status} />
      </div>
      <div className="appt-line">
        <Badge tone={appt.kind === "trial" ? "warn" : "info"}>
          {KIND_LABEL[appt.kind]}
        </Badge>
        <span>{shortTime(appt.start)}</span>
      </div>
      <p className="appt-reason" title={appt.reason}>
        {appt.reason}
      </p>

      {live && (
        <div className="appt-actions">
          {appt.kind === "trial" && appt.status === "suggested" && (
            <button
              className="primary-action tiny"
              onClick={() => {
                const r = confirmTrial(appt.id);
                setMsg(r.ok ? { ok: true, text: "试戴已确认" } : { ok: false, text: r.error ?? "无法确认" });
              }}
            >
              确认试戴
            </button>
          )}
          {appt.kind === "followup" && appt.status === "suggested" && (
            <button
              className="tiny"
              onClick={() => {
                // 复诊确认同样需要占用时段，门控比试戴宽：无复核门槛，直接置 confirmed
                const r = confirmTrial(appt.id);
                setMsg(r.ok ? { ok: true, text: "复诊已确认" } : { ok: false, text: r.error ?? "无法确认" });
              }}
            >
              确认复诊
            </button>
          )}
          <button className="tiny" onClick={() => cancelAppt(appt.id)}>
            取消释放
          </button>
        </div>
      )}

      {live && (
        <div className="reschedule-row">
          <select value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">改期到…（先释放原时段）</option>
            {freeSlots.slice(0, 10).map((s) => (
              <option key={`${s.start}-${s.roomId}`} value={`${s.start}|${s.roomId}`}>
                {formatSlot(s.start)} · {roomName(s.roomId)}
              </option>
            ))}
          </select>
          <button
            className="tiny"
            disabled={!picked}
            onClick={() => {
              const [startStr, roomId] = picked.split("|");
              const r = reschedule(appt.id, Number(startStr), roomId);
              if (r.ok) {
                setPicked("");
                setMsg({ ok: true, text: "已改期，原时段已释放" });
              } else {
                setMsg({ ok: false, text: r.error ?? "改期失败" });
              }
            }}
          >
            改期
          </button>
        </div>
      )}

      {appt.kind === "trial" && appt.status === "suggested" && order && !gate.ok && (
        <p className="gate-hint">⛔ {gate.reason}</p>
      )}
      {msg && (
        <p className={msg.ok ? "gate-ok" : "gate-hint"}>
          {msg.ok ? "✓ " : "⛔ "}
          {msg.text}
        </p>
      )}
    </div>
  );
}

export function SchedulePanel() {
  const { appts } = useStore();
  const [day, setDay] = useState(() => dayStart(Date.now()));

  const dayAppts = useMemo(
    () =>
      appts.filter((a) => {
        const d = new Date(a.start);
        d.setHours(0, 0, 0, 0);
        return d.getTime() === day;
      }),
    [appts, day]
  );

  const grid: (Appointment | null)[][] = ROOMS.map(() => Array(SLOT_COUNT).fill(null));
  for (const a of dayAppts) {
    const d = new Date(a.start);
    const idx =
      (d.getHours() - OPEN_HOUR) * (60 / SLOT_MINUTES) +
      Math.floor(d.getMinutes() / SLOT_MINUTES);
    const roomIdx = ROOMS.findIndex((r) => r.id === a.roomId);
    if (roomIdx >= 0 && idx >= 0 && idx < SLOT_COUNT) grid[roomIdx][idx] = a;
  }

  const moveDay = (n: number) => setDay((d) => d + n * 86400000);

  return (
    <Card
      title={
        <>
          验配间排期台
          <span className="title-date">
            {new Date(day).toLocaleDateString("zh-CN", {
              month: "long",
              day: "numeric",
              weekday: "long",
            })}
          </span>
        </>
      }
      extra={
        <div className="day-nav">
          <button onClick={() => moveDay(-1)}>前一天</button>
          <button onClick={() => setDay(dayStart(Date.now()))}>今天</button>
          <button onClick={() => moveDay(1)}>后一天</button>
        </div>
      }
    >
      <p className="panel-hint">
        同一客户同一时段只能占一个验配间；改期先释放原时段。失效安排（复测改动/复核未通过）需重新排期确认。
      </p>
      <div className="schedule-grid">
        <div className="schedule-corner" />
        {ROOMS.map((r) => (
          <div key={r.id} className="room-head">
            {r.name}
          </div>
        ))}
        {Array.from({ length: SLOT_COUNT }).map((_, slot) => {
          const t = day + (OPEN_HOUR * 60 + slot * SLOT_MINUTES) * 60000;
          return (
            <RowFragment key={slot} t={t}>
              {ROOMS.map((r, ri) => {
                const a = grid[ri][slot];
                return (
                  <div key={r.id} className="slot-cell">
                    {a ? <ApptCard appt={a} dayKey={day} /> : <span className="slot-free">空闲</span>}
                  </div>
                );
              })}
            </RowFragment>
          );
        })}
      </div>
      {dayAppts.length === 0 && <Empty text="当天无安排，换一天看看" />}
    </Card>
  );
}

function RowFragment({ t, children }: { t: number; children: React.ReactNode }) {
  return (
    <>
      <div className="time-cell">{shortTime(t)}</div>
      {children}
    </>
  );
}
