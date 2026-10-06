// 分频验配规则：PTA、气骨导差、两耳一致性、复核触发、复诊/试戴时段建议
import {
  Audiogram,
  EarAudiogram,
  EarSide,
  EARS,
  Frequency,
  FREQUENCIES,
  OrderCategory,
  ReviewTrigger,
  ThresholdMap,
} from "./types";

/** 气骨导差阈值（dB）：任一频率达到即转复诊助理复核 */
export const AB_GAP_THRESHOLD = 10;
/** 两耳分频差异阈值（dB）：同频气导差达到即转复核 */
export const BINAURAL_DIFF_THRESHOLD = 25;
/** PTA 四频（WHO 0.5/1/2/4k） */
export const PTA_FREQS: Frequency[] = [500, 1000, 2000, 4000];
export const SLOT_MINUTES = 30;

export function earPta(ear: EarAudiogram | undefined): number | null {
  if (!ear) return null;
  const vals = PTA_FREQS.map((f) => ear.air[f]).filter(
    (v): v is number => typeof v === "number"
  );
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** 听力损失分级（WHO，按 PTA dB HL） */
export function lossGrade(pta: number | null): string {
  if (pta === null) return "未测";
  if (pta < 25) return "正常";
  if (pta <= 40) return "轻度";
  if (pta <= 60) return "中度";
  if (pta <= 80) return "重度";
  return "极重度";
}

/** 气骨导差：逐频率 气导-骨导，返回超阈值的频率与差值 */
export function abGapExceedances(ear: EarAudiogram): {
  freq: Frequency;
  gap: number;
}[] {
  const out: { freq: Frequency; gap: number }[] = [];
  for (const f of FREQUENCIES) {
    const a = ear.air[f];
    const b = ear.bone[f];
    if (typeof a === "number" && typeof b === "number") {
      const gap = a - b;
      if (gap >= AB_GAP_THRESHOLD) out.push({ freq: f, gap });
    }
  }
  return out.sort((x, y) => y.gap - x.gap);
}

/** 两耳同频气导差异，返回达到阈值的频率 */
export function binauralDiffExceedances(
  ag: Audiogram
): { freq: Frequency; diff: number }[] {
  const out: { freq: Frequency; diff: number }[] = [];
  for (const f of FREQUENCIES) {
    const l = ag.L.air[f];
    const r = ag.R.air[f];
    if (typeof l === "number" && typeof r === "number") {
      const diff = Math.abs(l - r);
      if (diff >= BINAURAL_DIFF_THRESHOLD) out.push({ freq: f, diff });
    }
  }
  return out.sort((x, y) => y.diff - x.diff);
}

/** 复核触发条件：两耳参数不一致 或 气骨导差达到阈值 */
export function evaluateTriggers(ag: Audiogram): ReviewTrigger[] {
  const triggers: ReviewTrigger[] = [];
  const gapEars: EarSide[] = [];
  const gapDetails: string[] = [];
  for (const ear of EARS) {
    const hits = abGapExceedances(ag[ear]);
    if (hits.length) {
      gapEars.push(ear);
      gapDetails.push(
        `${ear === "L" ? "左" : "右"}耳${hits
          .slice(0, 2)
          .map((h) => `${h.freq}Hz差${h.gap}dB`)
          .join("、")}`
      );
    }
  }
  if (gapEars.length) {
    triggers.push({
      type: "ab-gap",
      ears: gapEars,
      detail: `气骨导差≥${AB_GAP_THRESHOLD}dB：${gapDetails.join("；")}`,
    });
  }

  const diffs = binauralDiffExceedances(ag);
  if (diffs.length) {
    triggers.push({
      type: "binaural-mismatch",
      ears: ["L", "R"],
      detail: `两耳同频差≥${BINAURAL_DIFF_THRESHOLD}dB：${diffs
        .slice(0, 3)
        .map((d) => `${d.freq}Hz差${d.diff}dB`)
        .join("、")}`,
    });
  }
  return triggers;
}

export function needsReview(ag: Audiogram): boolean {
  return evaluateTriggers(ag).length > 0;
}

export function fmtFreqMap(m: ThresholdMap): string {
  return FREQUENCIES.map((f) =>
    typeof m[f] === "number" ? `${f >= 1000 ? f / 1000 + "k" : f}:${m[f]}` : ""
  )
    .filter(Boolean)
    .join(" ");
}

export function earSummary(ear: EarAudiogram): string {
  const pta = earPta(ear);
  const gap = Math.max(0, ...abGapExceedances(ear).map((g) => g.gap));
  return `气导 ${fmtFreqMap(ear.air) || "—"}｜PTA ${pta ?? "—"}dB${
    gap ? `｜气骨导差峰值${gap}dB` : ""
  }`;
}

export interface ScheduleSuggestion {
  followupDays: number;
  trialDays: number;
  followupReason: string;
  trialReason: string;
  reviewRequired: boolean;
}

/**
 * 据分频结果给出下次复诊与试戴时段：
 * - 触发复核：先交复诊助理，复核结论没回来之前试戴不能确认（只给建议位，不占确认名额）
 * - 复诊间隔随更差耳 PTA / 类别浮动
 */
export function suggestSchedule(
  ag: Audiogram,
  category: OrderCategory
): ScheduleSuggestion {
  const ptaL = earPta(ag.L);
  const ptaR = earPta(ag.R);
  const worst = Math.max(ptaL ?? -1, ptaR ?? -1);
  const triggers = evaluateTriggers(ag);
  const reviewRequired = triggers.length > 0;

  let followupDays: number;
  if (category === "儿童") followupDays = 3;
  else if (worst >= 80) followupDays = 5;
  else if (worst >= 60) followupDays = 7;
  else if (worst >= 40) followupDays = 10;
  else followupDays = 14;
  if (reviewRequired) followupDays = Math.min(followupDays, 5);

  let trialDays: number;
  if (category === "儿童") trialDays = 7;
  else if (worst >= 80) trialDays = 10;
  else if (worst >= 60) trialDays = 12;
  else trialDays = 14;
  if (reviewRequired) trialDays = Math.max(trialDays, followupDays + 2);

  const gradeText =
    worst < 0
      ? "分频结果缺失"
      : `更差耳PTA ${worst}dB（${lossGrade(worst)}）`;
  const followupReason = reviewRequired
    ? `${triggers.map((t) => t.detail).join("；")}。${gradeText}，建议 ${followupDays} 天内复诊并先经助理复核`
    : `${gradeText}，建议 ${followupDays} 天后复诊校准`;
  const trialReason = reviewRequired
    ? `试戴建议排在第 ${trialDays} 天；复核结论未返回前仅占建议位，不能确认`
    : `分频稳定，试戴建议排在第 ${trialDays} 天，可直接确认`;

  return {
    followupDays,
    trialDays,
    followupReason,
    trialReason,
    reviewRequired,
  };
}
