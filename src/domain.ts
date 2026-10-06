import {
  Booking,
  EarResult,
  EarSide,
  FittingRecord,
  FREQUENCIES,
  Frequency,
  RuleEvaluation,
} from "./types";

// ---------- 基础计算 ----------

export function toNum(v: string): number | null {
  if (v === "" || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function emptyEar(recordedAt: string): EarResult {
  const blank = () =>
    Object.fromEntries(FREQUENCIES.map((f) => [f, ""])) as Record<Frequency, string>;
  return {
    audiogram: { air: blank(), bone: blank() },
    speechScore: "",
    aidModel: "",
    gainAdjust: "",
    feedback: "",
    recordedAt,
  };
}

/** PTA：0.5 / 1 / 2 / 4 kHz 气导平均 */
export function pta(ear: EarResult): number | null {
  const keys: Frequency[] = [0.5, 1, 2, 4];
  const vals = keys.map((f) => toNum(ear.audiogram.air[f])).filter((v): v is number => v !== null);
  if (vals.length < 3) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** 分频签名：任一耳结果变化都会改变签名，用于判断试戴依据是否过期 */
export function recordSignature(record: FittingRecord): string {
  const ear = (e: EarResult) =>
    [
      ...FREQUENCIES.map((f) => `${f}:A${e.audiogram.air[f] ?? ""}/B${e.audiogram.bone[f] ?? ""}`),
      `S${e.speechScore}`,
      `M${e.aidModel}`,
      `G${e.gainAdjust}`,
    ].join("|");
  return `L[${ear(record.left)}]#R[${ear(record.right)}]`;
}

// ---------- 复核规则 ----------

export function evaluate(
  record: FittingRecord,
  thresholds: { airBoneGap: number; ptaGap: number; perFreqGap: number }
): RuleEvaluation {
  const leftPTA = pta(record.left);
  const rightPTA = pta(record.right);
  const ptaGap =
    leftPTA !== null && rightPTA !== null ? Math.abs(leftPTA - rightPTA) : null;

  // 气骨导差：逐耳逐频（骨导有值时）
  let maxAirBoneGap: RuleEvaluation["maxAirBoneGap"] = null;
  const gapEars = new Set<EarSide>();
  (["left", "right"] as EarSide[]).forEach((side) => {
    const e = record[side];
    FREQUENCIES.forEach((f) => {
      const a = toNum(e.audiogram.air[f]);
      const b = toNum(e.audiogram.bone[f]);
      if (a === null || b === null) return;
      const gap = a - b;
      if (gap >= thresholds.airBoneGap) {
        gapEars.add(side);
        if (!maxAirBoneGap || gap > maxAirBoneGap.gap) maxAirBoneGap = { ear: side, freq: f, gap };
      }
    });
  });

  // 两耳参数不一致：PTA 差或任一分频气导差达到阈值
  let perFreqMax = 0;
  FREQUENCIES.forEach((f) => {
    const a = toNum(record.left.audiogram.air[f]);
    const b = toNum(record.right.audiogram.air[f]);
    if (a !== null && b !== null) perFreqMax = Math.max(perFreqMax, Math.abs(a - b));
  });
  const inconsistent =
    (ptaGap !== null && ptaGap >= thresholds.ptaGap) || perFreqMax >= thresholds.perFreqGap;
  const inconsistentEars: EarSide[] =
    inconsistent && (leftPTA !== null || rightPTA !== null) ? ["left", "right"] : [];

  const reasons: RuleEvaluation["reasons"] = [];
  if (inconsistent) reasons.push("两耳参数不一致");
  if (gapEars.size > 0) reasons.push("气骨导差超阈值");

  const ears = Array.from(new Set<EarSide>([...inconsistentEars, ...gapEars]));

  // 复诊建议：损失越重/存在复核问题，复诊间隔越短
  const worse = Math.max(leftPTA ?? -1, rightPTA ?? -1);
  let followUpDays: number;
  if (gapEars.size > 0 || inconsistent) followUpDays = 3;
  else if (worse >= 70) followUpDays = 7;
  else if (worse >= 40) followUpDays = 14;
  else if (worse >= 0) followUpDays = 30;
  else followUpDays = 7; // 数据不足时默认一周

  return {
    leftPTA,
    rightPTA,
    ptaGap,
    maxAirBoneGap,
    inconsistent,
    airBoneGapFlag: gapEars.size > 0,
    reasons,
    ears,
    needsReview: reasons.length > 0,
    followUpDays,
    signature: recordSignature(record),
  };
}

// ---------- 排期 ----------

export const SLOT_HOURS = [9, 10, 11, 14, 15, 16];

export function nextDates(days: number, count: number): string[] {
  const out: string[] = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  for (let i = 1; out.length < count; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) out.push(fmtDate(d));
    if (i > 60) break;
  }
  return out;
}

export function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${fmtDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtSlot(slot: string): string {
  return slot.replace("T", " ") + ":00";
}

/** 同一客户同一时段只能占一个验配间 */
export function customerSlotTaken(
  bookings: Booking[],
  customerId: string,
  slot: string,
  ignoreBookingId?: string
): Booking | undefined {
  return bookings.find(
    (b) =>
      b.customerId === customerId &&
      b.slot === slot &&
      b.status !== "released" &&
      b.id !== ignoreBookingId
  );
}

/** 验配间在同一时段是否已被占用（同一客户的复诊+试戴也不能撞） */
export function roomSlotTaken(
  bookings: Booking[],
  roomId: string,
  slot: string,
  ignoreBookingId?: string
): Booking | undefined {
  return bookings.find(
    (b) =>
      b.roomId === roomId &&
      b.slot === slot &&
      b.status !== "released" &&
      b.id !== ignoreBookingId
  );
}

export function addDays(slot: string, days: number): string {
  const d = new Date(slot);
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
