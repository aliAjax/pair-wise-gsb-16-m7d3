// 排期：验配间时段、冲突检测、改期释放、复测失效、确认门控
import { SLOT_MINUTES } from "./audiology";
import {
  Appointment,
  AppointmentStatus,
  FittingOrder,
  ReviewConclusion,
} from "./types";

export interface Room {
  id: string;
  name: string;
}

export const ROOMS: Room[] = [
  { id: "R1", name: "验配间 01" },
  { id: "R2", name: "验配间 02" },
  { id: "R3", name: "验配间 03" },
];

export const OPEN_HOUR = 9;
export const CLOSE_HOUR = 18;

export function overlaps(aStart: number, aMin: number, bStart: number, bMin: number): boolean {
  return aStart < bStart + bMin * 60000 && bStart < aStart + aMin * 60000;
}

/** 占用中的时段：已确认或待确认（建议位）都算占位，避免重复排期 */
function blocking(s: AppointmentStatus): boolean {
  return s === "confirmed" || s === "suggested";
}

export interface SlotConflict {
  kind: "customer-busy" | "room-busy";
  appointment: Appointment;
}

/**
 * 同一客户同一时段只能占一个验配间；
 * 同一验配间同一时段也只能有一个客户。
 */
export function checkSlot(
  appts: Appointment[],
  p: {
    customerId: string;
    roomId: string;
    start: number;
    durationMin: number;
    ignoreApptId?: string;
  }
): SlotConflict | null {
  for (const a of appts) {
    if (!blocking(a.status) || a.id === p.ignoreApptId) continue;
    if (!overlaps(a.start, a.durationMin, p.start, p.durationMin)) continue;
    if (a.customerId === p.customerId)
      return { kind: "customer-busy", appointment: a };
    if (a.roomId === p.roomId) return { kind: "room-busy", appointment: a };
  }
  return null;
}

/** 对齐到 30 分钟格（向下取整） */
export function alignSlot(t: number): number {
  const d = new Date(t);
  d.setMinutes(d.getMinutes() - (d.getMinutes() % SLOT_MINUTES), 0, 0);
  return d.getTime();
}

export function isOpenSlot(t: number): boolean {
  const d = new Date(t);
  const h = d.getHours();
  const day = d.getDay();
  return day >= 1 && day <= 6 && h >= OPEN_HOUR && h < CLOSE_HOUR;
}

/** 从建议日 09:00 起找第一个空档；找不到返回 null */
export function findFreeSlot(
  appts: Appointment[],
  customerId: string,
  fromDay: number,
  preferredRoom?: string
): { start: number; roomId: string } | null {
  const startDay = new Date(fromDay);
  startDay.setHours(OPEN_HOUR, 0, 0, 0);
  for (let day = 0; day < 14; day++) {
    const base = new Date(startDay);
    base.setDate(startDay.getDate() + day);
    if (base.getDay() === 0) continue; // 周日休
    for (let slot = 0; slot < (CLOSE_HOUR - OPEN_HOUR) * 2; slot++) {
      const t = base.getTime() + slot * SLOT_MINUTES * 60000;
      const roomOrder = preferredRoom
        ? [preferredRoom, ...ROOMS.map((r) => r.id).filter((id) => id !== preferredRoom)]
        : ROOMS.map((r) => r.id);
      for (const roomId of roomOrder) {
        if (
          !checkSlot(appts, {
            customerId,
            roomId,
            start: t,
            durationMin: SLOT_MINUTES,
          })
        ) {
          return { start: t, roomId };
        }
      }
    }
  }
  return null;
}

/** 从某日 09:00 起列出前 limit 个空闲（客户/验配间均不冲突）时段 */
export function listFreeSlots(
  appts: Appointment[],
  customerId: string,
  fromDay: number,
  preferredRoom?: string,
  limit = 12
): { start: number; roomId: string }[] {
  const out: { start: number; roomId: string }[] = [];
  const startDay = new Date(fromDay);
  startDay.setHours(OPEN_HOUR, 0, 0, 0);
  outer: for (let day = 0; day < 14; day++) {
    const base = new Date(startDay);
    base.setDate(startDay.getDate() + day);
    if (base.getDay() === 0) continue;
    for (let slot = 0; slot < (CLOSE_HOUR - OPEN_HOUR) * 2; slot++) {
      const t = base.getTime() + slot * SLOT_MINUTES * 60000;
      const roomOrder = preferredRoom
        ? [preferredRoom, ...ROOMS.map((r) => r.id).filter((id) => id !== preferredRoom)]
        : ROOMS.map((r) => r.id);
      for (const roomId of roomOrder) {
        if (
          !checkSlot(appts, {
            customerId,
            roomId,
            start: t,
            durationMin: SLOT_MINUTES,
          })
        ) {
          out.push({ start: t, roomId });
          if (out.length >= limit) break outer;
          break;
        }
      }
    }
  }
  return out;
}

/** 改期：先释放原时段，再尝试占用新时段 */
export function reschedule(
  appts: Appointment[],
  apptId: string,
  newStart: number,
  newRoomId: string
): { ok: true; appts: Appointment[]; releasedId: string } | { ok: false; error: string } {
  const target = appts.find((a) => a.id === apptId);
  if (!target) return { ok: false, error: "安排不存在" };
  const released: Appointment = {
    ...target,
    status: "cancelled",
    reason: `改期释放：原 ${formatSlot(target.start)} / ${roomName(target.roomId)}`,
  };
  const withoutOld = appts.map((a) => (a.id === apptId ? released : a));
  const conflict = checkSlot(withoutOld, {
    customerId: target.customerId,
    roomId: newRoomId,
    start: newStart,
    durationMin: target.durationMin,
  });
  if (conflict) {
    return {
      ok: false,
      error:
        conflict.kind === "customer-busy"
          ? `该客户此时段已有安排（${
              conflict.appointment.kind === "trial" ? "试戴" : "复诊"
            }）`
          : `${roomName(newRoomId)} 此时段已被占用`,
    };
  }
  const moved: Appointment = {
    ...target,
    start: newStart,
    roomId: newRoomId,
    status: target.status === "invalidated" ? "suggested" : target.status,
    reason: `改期自 ${formatSlot(target.start)} / ${roomName(target.roomId)}`,
  };
  return {
    ok: true,
    appts: withoutOld.map((a) => (a.id === apptId ? moved : a)),
    releasedId: released.id,
  };
}

/**
 * 复测结果改动后：未确认的助听器试戴安排失效（需重新确认）；
 * 已确认的不动，未确认的复诊建议位保留（复诊本身就是要重看）。
 */
export function invalidateStaleTrials(
  appts: Appointment[],
  order: FittingOrder
): Appointment[] {
  return appts.map((a) => {
    if (
      a.orderId === order.id &&
      a.kind === "trial" &&
      a.status === "suggested" &&
      a.basedOnEnteredAt !== order.enteredAt
    ) {
      return {
        ...a,
        status: "invalidated",
        reason: `复测结果已改动（${new Date(
          order.enteredAt
        ).toLocaleString()}），试戴安排失效，需重新确认`,
      };
    }
    return a;
  });
}

/**
 * 试戴确认门控：
 * 1) 安排未失效/未取消
 * 2) 排期依据与最新验配单一致（否则要求重新排）
 * 3) 需要复核时，必须有匹配本次录入的“通过”结论
 */
export function canConfirmTrial(
  appt: Appointment,
  order: FittingOrder | undefined,
  review: ReviewConclusion | undefined,
  reviewRequired: boolean
): { ok: boolean; reason?: string } {
  if (appt.status !== "suggested")
    return { ok: false, reason: "当前状态不可确认" };
  if (!order) return { ok: false, reason: "验配单不存在" };
  if (appt.basedOnEnteredAt !== order.enteredAt)
    return {
      ok: false,
      reason: "排期依据的分频结果已过期，请按最新复测重新排期",
    };
  if (reviewRequired) {
    if (!review)
      return { ok: false, reason: "等待复诊助理复核结论，试戴暂不能确认" };
    if (review.orderEnteredAt !== order.enteredAt)
      return { ok: false, reason: "复核结论针对的是旧结果，复测后需重新复核" };
    if (review.verdict !== "pass")
      return { ok: false, reason: `复核未通过：${review.comment || review.verdict}` };
  }
  return { ok: true };
}

export function roomName(id: string): string {
  return ROOMS.find((r) => r.id === id)?.name ?? id;
}

export function formatSlot(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

export function slotKey(t: number): string {
  return String(new Date(t).getTime());
}
