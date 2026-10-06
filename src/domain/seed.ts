// 初始示例数据：覆盖 直接可确认 / 待复核锁定 / 复核通过已确认 三种情形
import { suggestSchedule } from "./audiology";
import { findFreeSlot, ROOMS } from "./scheduling";
import { uid } from "./merge";
import {
  Appointment,
  Audiogram,
  ConflictEntry,
  EarSide,
  FittingOrder,
  LogEntry,
  OrderCategory,
  OutboxEntry,
  ReviewConclusion,
  ThresholdMap,
} from "./types";

const DAY = 86400000;
const now = Date.now();

function ear(
  side: EarSide,
  air: ThresholdMap,
  bone: ThresholdMap,
  recordedAt: number
) {
  return { ear: side, air, bone, recordedAt };
}

function makeOrder(
  customerId: string,
  customerName: string,
  category: OrderCategory,
  deviceModel: string,
  notes: string,
  audiogram: Audiogram,
  enteredDaysAgo: number
): FittingOrder {
  const enteredAt = now - enteredDaysAgo * DAY;
  return {
    id: uid("ord"),
    customerId,
    customerName,
    category,
    deviceModel,
    notes,
    audiogram: {
      L: { ...audiogram.L, recordedAt: enteredAt + 60000 },
      R: { ...audiogram.R, recordedAt: enteredAt + 120000 },
    },
    enteredAt: enteredAt + 120000,
    rev: 1,
    dirty: false,
  };
}

export function buildSeed(): {
  orders: FittingOrder[];
  reviews: ReviewConclusion[];
  appointments: Appointment[];
  conflicts: ConflictEntry[];
  outbox: OutboxEntry[];
  logs: LogEntry[];
} {
  // 1) Liu-024：双耳高频下降，分频一致、无气骨导差 → 试戴可直接确认
  const liu = makeOrder(
    "Liu-024",
    "刘建国",
    "初配",
    "RIC 受话器外置式",
    "双耳高频下降，2kHz 后增益提高 4dB",
    {
      L: ear("L", { 250: 25, 500: 30, 1000: 40, 2000: 50, 4000: 65, 8000: 75 }, { 500: 28, 1000: 38, 2000: 48, 4000: 62 }, 0),
      R: ear("R", { 250: 25, 500: 30, 1000: 42, 2000: 52, 4000: 68, 8000: 78 }, { 500: 28, 1000: 40, 2000: 50, 4000: 65 }, 0),
    },
    2
  );

  // 2) Chen-118：右耳传导性，气骨导差超阈 + 两耳严重不一致 → 必须复核，试戴锁定
  const chen = makeOrder(
    "Chen-118",
    "陈雪",
    "复调",
    "BTE 耳背式（左耳关闭）",
    "单侧传导性损失，低频压缩略降，反馈啸叫已消失",
    {
      L: ear("L", { 250: 15, 500: 18, 1000: 20, 2000: 20, 4000: 25, 8000: 30 }, { 500: 15, 1000: 18, 2000: 18, 4000: 22 }, 0),
      R: ear("R", { 250: 55, 500: 58, 1000: 55, 2000: 45, 4000: 40, 8000: 42 }, { 250: 20, 500: 22, 1000: 25, 2000: 30, 4000: 35 }, 0),
    },
    1
  );

  // 3) Zhao-077：老人语频下降 + 左耳气骨导差超阈，复核已通过 → 试戴已确认
  const zhao = makeOrder(
    "Zhao-077",
    "赵慧兰",
    "老人",
    "ITE 耳内式",
    "语频区下降，言语识别率 64% → 76%",
    {
      L: ear("L", { 250: 40, 500: 45, 1000: 52, 2000: 48, 4000: 50, 8000: 55 }, { 250: 28, 500: 33, 1000: 42, 2000: 44, 4000: 47 }, 0),
      R: ear("R", { 250: 38, 500: 42, 1000: 48, 2000: 46, 4000: 48, 8000: 52 }, { 500: 40, 1000: 46, 2000: 44, 4000: 46 }, 0),
    },
    4
  );

  const orders = [liu, chen, zhao];
  const appointments: Appointment[] = [];

  function autoSlots(order: FittingOrder, trialStatus: Appointment["status"], followStatus: Appointment["status"]) {
    const s = suggestSchedule(order.audiogram, order.category);
    let cursor = order.enteredAt + s.followupDays * DAY;
    const f = findFreeSlot(appointments, order.customerId, cursor, ROOMS[0].id);
    if (f) {
      appointments.push({
        id: uid("apt"),
        orderId: order.id,
        customerId: order.customerId,
        customerName: order.customerName,
        kind: "followup",
        roomId: f.roomId,
        start: f.start,
        durationMin: 30,
        status: followStatus,
        basedOnEnteredAt: order.enteredAt,
        reason: s.followupReason,
        createdAt: now,
      });
    }
    cursor = order.enteredAt + s.trialDays * DAY;
    const t = findFreeSlot(appointments, order.customerId, cursor, ROOMS[0].id);
    if (t) {
      appointments.push({
        id: uid("apt"),
        orderId: order.id,
        customerId: order.customerId,
        customerName: order.customerName,
        kind: "trial",
        roomId: t.roomId,
        start: t.start,
        durationMin: 30,
        status: trialStatus,
        basedOnEnteredAt: order.enteredAt,
        reason: s.trialReason,
        createdAt: now,
      });
    }
  }

  autoSlots(liu, "suggested", "confirmed");
  autoSlots(chen, "suggested", "suggested");
  autoSlots(zhao, "confirmed", "confirmed");

  const zhaoTrial = appointments.find((a) => a.orderId === zhao.id && a.kind === "trial");
  const reviews: ReviewConclusion[] = [
    {
      id: uid("rev"),
      orderId: zhao.id,
      orderEnteredAt: zhao.enteredAt,
      verdict: "pass",
      reviewer: "复诊助理 · 孙敏",
      comment: "左耳气骨导差 12dB 系陈旧性中耳炎，当前气导稳定，准予试戴；复测差值扩大随诊。",
      triggers: [],
      createdAt: zhao.enteredAt + 3600000,
      rev: 1,
      dirty: false,
    },
  ];
  if (zhaoTrial) {
    zhaoTrial.reason = "复核通过后确认：" + zhaoTrial.reason;
  }

  const logs: LogEntry[] = [
    {
      id: uid("log"),
      at: now - 2 * DAY,
      level: "ok",
      text: "刘建国 验配单已建档，系统给出复诊/试戴建议时段",
    },
    {
      id: uid("log"),
      at: now - DAY,
      level: "warn",
      text: "陈雪 触发复核：右耳气骨导差≥10dB 且两耳分频不一致，试戴待复核",
    },
    {
      id: uid("log"),
      at: now - 3 * DAY,
      level: "ok",
      text: "赵慧兰 复核结论已返回（通过），试戴已确认",
    },
  ];

  return { orders, reviews, appointments, conflicts: [], outbox: [], logs };
}
