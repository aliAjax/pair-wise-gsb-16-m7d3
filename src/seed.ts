import { AppState, Booking, FittingRecord, Review, Room, Customer, FREQUENCIES } from "./types";
import { emptyEar, evaluate, fmtDate } from "./domain";

export const ROOMS: Room[] = [
  { id: "room-1", name: "验配间 A" },
  { id: "room-2", name: "验配间 B" },
  { id: "room-3", name: "验配间 C" },
];

export const CUSTOMERS: Customer[] = [
  { id: "Liu-024", name: "刘女士 024", tags: ["初配"] },
  { id: "Chen-118", name: "陈先生 118", tags: ["复调"] },
  { id: "Zhao-077", name: "赵老伯 077", tags: ["复诊", "老人"] },
];

function mkEar(
  air: number[],
  bone: (number | null)[],
  recordedAt: string,
  extra: Partial<FittingRecord["left"]> = {}
): FittingRecord["left"] {
  const e = emptyEar(recordedAt);
  FREQUENCIES.forEach((f, i) => {
    e.audiogram.air[f] = air[i] === -1 ? "" : String(air[i]);
    e.audiogram.bone[f] = bone[i] === null ? "" : String(bone[i]);
  });
  return { ...e, ...extra };
}

const ts = (daysAgo: number, h = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, 15, 0, 0);
  return d.toISOString();
};

export function seedRecords(): FittingRecord[] {
  const r1: FittingRecord = {
    id: "rec-liu",
    customerId: "Liu-024",
    stage: "初配",
    left: mkEar([30, 35, 40, 45, 60, 70], [null, 30, 35, 40, 55, null], ts(2, 9), {
      speechScore: "82",
      aidModel: "RIC-Mini",
      gainAdjust: "2kHz后+4dB",
      feedback: "安静环境清晰",
    }),
    right: mkEar([30, 35, 42, 48, 62, 72], [null, 31, 36, 42, 56, null], ts(2, 9), {
      speechScore: "80",
      aidModel: "RIC-Mini",
      gainAdjust: "2kHz后+4dB",
      feedback: "—",
    }),
    updatedAt: ts(2, 9),
  };

  // 单侧传导性损失：左耳气骨导差超阈值 → 必须复核
  const r2: FittingRecord = {
    id: "rec-chen",
    customerId: "Chen-118",
    stage: "复调",
    left: mkEar([45, 50, 55, 50, 45, 40], [null, 32, 38, 36, 34, null], ts(1, 14), {
      speechScore: "70",
      aidModel: "BTE-Power",
      gainAdjust: "低频压缩-2dB",
      feedback: "啸叫已消失",
    }),
    right: mkEar([15, 18, 20, 20, 22, 25], [null, 15, 18, 18, 20, null], ts(1, 14), {
      speechScore: "96",
      aidModel: "—",
      gainAdjust: "—",
      feedback: "—",
    }),
    updatedAt: ts(1, 14),
  };

  const r3: FittingRecord = {
    id: "rec-zhao",
    customerId: "Zhao-077",
    stage: "复诊",
    left: mkEar([35, 40, 45, 48, 52, 58], [null, 36, 41, 44, 48, null], ts(4, 10), {
      speechScore: "76",
      aidModel: "RIC-Comfort",
      gainAdjust: "语频+3dB",
      feedback: "言语识别率64%→76%",
    }),
    right: mkEar([38, 42, 46, 50, 54, 60], [null, 38, 42, 46, 50, null], ts(4, 10), {
      speechScore: "74",
      aidModel: "RIC-Comfort",
      gainAdjust: "语频+3dB",
      feedback: "—",
    }),
    updatedAt: ts(4, 10),
  };

  return [r1, r2, r3];
}

export function seedDerived(
  records: FittingRecord[],
  thresholds: AppState["thresholds"]
): { reviews: Review[]; bookings: Booking[] } {
  const reviews: Review[] = [];
  const bookings: Booking[] = [];

  records.forEach((rec) => {
    const ev = evaluate(rec, thresholds);
    if (ev.needsReview) {
      reviews.push({
        id: `rv-${rec.id}`,
        recordId: rec.id,
        customerId: rec.customerId,
        reasons: ev.reasons,
        signature: ev.signature,
        status: "pending",
        createdAt: rec.updatedAt,
        ears: ev.ears,
      });
    }

    const followDate = new Date();
    followDate.setDate(followDate.getDate() + Math.min(ev.followUpDays, 6));
    followDate.setHours(9, 0, 0, 0);
    bookings.push({
      id: `bk-fu-${rec.id}`,
      customerId: rec.customerId,
      recordId: rec.id,
      kind: "followup",
      roomId: ROOMS[records.indexOf(rec) % ROOMS.length].id,
      slot: `${fmtDate(followDate)}T09`,
      status: "confirmed",
      createdAt: rec.updatedAt,
      updatedAt: rec.updatedAt,
      note: `系统建议复诊间隔 ${ev.followUpDays} 天`,
    });

    // 试戴单：陈先生因待复核只能处于待确认
    const trialDate = new Date(followDate);
    trialDate.setDate(trialDate.getDate() + 1);
    bookings.push({
      id: `bk-tr-${rec.id}`,
      customerId: rec.customerId,
      recordId: rec.id,
      kind: "trial",
      roomId: ROOMS[(records.indexOf(rec) + 1) % ROOMS.length].id,
      slot: `${fmtDate(trialDate)}T10`,
      status: ev.needsReview ? "proposed" : "confirmed",
      signature: ev.signature,
      createdAt: rec.updatedAt,
      updatedAt: rec.updatedAt,
      note: ev.needsReview ? "等待复诊助理复核结论" : "助听器试戴",
    });
  });

  return { reviews, bookings };
}
