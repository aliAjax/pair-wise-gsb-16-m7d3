// 听力验配台领域模型

export type EarSide = "L" | "R";
export const EARS: EarSide[] = ["L", "R"];
export const EAR_LABEL: Record<EarSide, string> = { L: "左耳", R: "右耳" };

/** 标准测听频率 Hz */
export const FREQUENCIES = [250, 500, 1000, 2000, 4000, 8000] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** 各频率听阈 dB HL，缺测即缺键 */
export type ThresholdMap = Partial<Record<Frequency, number>>;

export interface EarAudiogram {
  ear: EarSide;
  /** 气导分频结果 */
  air: ThresholdMap;
  /** 骨导分频结果 */
  bone: ThresholdMap;
  /** 该耳本次录入时间（冲突清单里的“录入时间”按耳取） */
  recordedAt: number;
}

export type Audiogram = Record<EarSide, EarAudiogram>;

export type OrderCategory = "初配" | "复调" | "儿童" | "老人";

/** 验配单：一份单子保存左右耳分频结果 */
export interface FittingOrder {
  id: string;
  customerId: string;
  customerName: string;
  category: OrderCategory;
  deviceModel: string;
  notes: string;
  audiogram: Audiogram;
  /** 最近一次复测录入时间（两耳最新） */
  enteredAt: number;
  /** 最近已同步的服务端版本号，0 表示本地新建 */
  rev: number;
  dirty: boolean;
}

export type ReviewVerdict = "pass" | "adjust" | "reject";

export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  pass: "复核通过，可以试戴",
  adjust: "需调整参数后重测",
  reject: "暂不予试戴",
};

export interface ReviewTrigger {
  type: "binaural-mismatch" | "ab-gap";
  ears: EarSide[];
  detail: string;
}

/** 复诊助理的复核结论 */
export interface ReviewConclusion {
  id: string;
  orderId: string;
  /** 针对哪一次验配单录入（复测后旧结论自动失效） */
  orderEnteredAt: number;
  verdict: ReviewVerdict;
  reviewer: string;
  comment: string;
  triggers: ReviewTrigger[];
  createdAt: number;
  rev: number;
  dirty: boolean;
}

export type AppointmentKind = "trial" | "followup";
export const KIND_LABEL: Record<AppointmentKind, string> = {
  trial: "助听器试戴",
  followup: "复诊",
};

export type AppointmentStatus =
  | "suggested"
  | "confirmed"
  | "invalidated"
  | "cancelled";

export interface Appointment {
  id: string;
  orderId: string;
  customerId: string;
  customerName: string;
  kind: AppointmentKind;
  roomId: string;
  start: number;
  durationMin: number;
  status: AppointmentStatus;
  /** 排期依据的那次验配录入时间，用于复测后标记失效 */
  basedOnEnteredAt: number;
  reason: string;
  createdAt: number;
}

/** 断网合并冲突：给出客户、耳别和两次录入时间 */
export interface ConflictEntry {
  id: string;
  customerId: string;
  customerName: string;
  ear: EarSide | "both";
  localEnteredAt: number;
  remoteEnteredAt: number;
  localSummary: string;
  remoteSummary: string;
  reason: string;
  status: "pending" | "resolved-local" | "resolved-remote";
  /** 复核结论优先的自动裁决不需要人工再点 */
  auto: boolean;
  orderId: string;
  /** 待人工裁决时保留的本地版本 */
  localOrder?: FittingOrder;
  /** 待人工裁决时的服务端版本 */
  remoteOrder?: FittingOrder;
  createdAt: number;
}

export interface LogEntry {
  id: string;
  at: number;
  level: "info" | "warn" | "ok";
  text: string;
}

/** 离线期间的本地变更，网络恢复后按序上送合并 */
export type OutboxEntry =
  | {
      id: string;
      type: "upsertOrder";
      at: number;
      order: FittingOrder;
      /** 编辑所基于的服务端版本（三向合并的 base） */
      base: FittingOrder | null;
      /** 本机当时已知的最新复核结论 ID，用于识别“他端新回结论” */
      baseReviewId: string | null;
    }
  | {
      id: string;
      type: "submitReview";
      at: number;
      review: ReviewConclusion;
    };
