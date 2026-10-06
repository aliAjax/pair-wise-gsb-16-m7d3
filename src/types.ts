// 验配台领域模型

export type EarSide = "left" | "right";
export const EAR_LABEL: Record<EarSide, string> = { left: "左耳", right: "右耳" };

// 分频点：0.25 / 0.5 / 1 / 2 / 4 / 8 kHz
export const FREQUENCIES = [0.25, 0.5, 1, 2, 4, 8] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export type EarAudiogram = {
  /** 各频率气导听阈 dB HL，空串表示未测 */
  air: Record<Frequency, string>;
  /** 各频率骨导听阈 dB HL */
  bone: Record<Frequency, string>;
};

export type EarResult = {
  audiogram: EarAudiogram;
  /** 言语识别率 0-100% */
  speechScore: string;
  aidModel: string;
  gainAdjust: string;
  feedback: string;
  /** 该耳最近一次录入/复测时间 */
  recordedAt: string;
};

export type Customer = {
  id: string;
  name: string;
  tags: string[];
};

export type FittingRecord = {
  id: string;
  customerId: string;
  stage: "初配" | "复调" | "复诊";
  left: EarResult;
  right: EarResult;
  updatedAt: string;
};

export type ReviewReason = "两耳参数不一致" | "气骨导差超阈值";

export type Review = {
  id: string;
  recordId: string;
  customerId: string;
  reasons: ReviewReason[];
  /** 触发复核时的分频签名，用于判断复核是否仍对应当前数据 */
  signature: string;
  status: "pending" | "approved" | "returned";
  conclusion?: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** 复核结论对应的耳别 */
  ears: EarSide[];
};

export type BookingKind = "followup" | "trial";
export type BookingStatus =
  | "proposed" // 已排期待确认（试戴在等复核/重确认）
  | "confirmed" // 已确认
  | "released"; // 已释放（改期或失效），仅作留痕

export type Booking = {
  id: string;
  customerId: string;
  recordId: string;
  kind: BookingKind;
  roomId: string;
  slot: string; // yyyy-mm-ddTHH:00
  status: BookingStatus;
  /** 试戴所依据的分频签名；复测后签名变化即失效 */
  signature?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type Room = {
  id: string;
  name: string;
};

export type RuleEvaluation = {
  leftPTA: number | null;
  rightPTA: number | null;
  ptaGap: number | null;
  maxAirBoneGap: { ear: EarSide; freq: Frequency; gap: number } | null;
  inconsistent: boolean;
  airBoneGapFlag: boolean;
  reasons: ReviewReason[];
  ears: EarSide[];
  needsReview: boolean;
  followUpDays: number;
  signature: string;
};

export type Conflict = {
  id: string; // `${recordId}:${ear}`
  recordId: string;
  customerId: string;
  customerName: string;
  ear: EarSide;
  reason: string;
  /** 本地两次录入时间：本地录入时间 / 服务端录入时间 */
  localRecordedAt: string;
  remoteRecordedAt: string;
  localEar: EarResult;
  remoteEar: EarResult;
};

export type SyncLogEntry = {
  at: string;
  message: string;
  tone: "ok" | "warn" | "info";
};

export type QueueOp =
  | { type: "record-upsert"; recordId: string; at: string }
  | { type: "booking-upsert"; bookingId: string; at: string }
  | { type: "review-decide"; reviewId: string; at: string };

export type AppState = {
  online: boolean;
  customers: Customer[];
  records: FittingRecord[];
  reviews: Review[];
  rooms: Room[];
  bookings: Booking[];
  /** 待人工裁决的冲突清单 */
  conflicts: Conflict[];
  /** 待同步本地操作（断网时累积） */
  queue: QueueOp[];
  /** 最近一次成功合并后的服务端基线 */
  base: ServerSnapshot | null;
  lastSyncAt: string | null;
  syncing: boolean;
  logs: SyncLogEntry[];
  /** 配置阈值 */
  thresholds: {
    airBoneGap: number; // dB，达到即复核
    ptaGap: number; // 两耳 PTA 差 dB，达到即不一致
    perFreqGap: number; // 单频两耳差 dB
  };
};

export type ServerSnapshot = {
  records: FittingRecord[];
  reviews: Review[];
  bookings: Booking[];
  serverTime: string;
};
