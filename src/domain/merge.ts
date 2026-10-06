// 断网合并：三向合并（base 本地编辑所基于的服务端版本 / incoming 本地 / remote 服务端）
// 规则：复核结论优先；冲突按耳给出客户、耳别与两次录入时间
import { earSummary } from "./audiology";
import {
  ConflictEntry,
  EarSide,
  EARS,
  FittingOrder,
  FREQUENCIES,
  ReviewConclusion,
} from "./types";

export function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now()
    .toString(36)
    .slice(-4)}`;
}

/** 分频结果内容签名（忽略录入时间戳与元数据） */
export function audiogramSignature(o: FittingOrder): string {
  return EARS.map((e) =>
    FREQUENCIES.map(
      (f) => `${f}:${o.audiogram[e].air[f] ?? "x"}/${o.audiogram[e].bone[f] ?? "x"}`
    ).join(",")
  ).join("|");
}

export function orderSignature(o: FittingOrder): string {
  return [
    o.customerId,
    o.customerName,
    o.category,
    o.deviceModel,
    o.notes,
    audiogramSignature(o),
  ].join("#");
}

export function latestReview(
  reviews: ReviewConclusion[],
  orderId: string,
  enteredAt?: number
): ReviewConclusion | undefined {
  const list = reviews
    .filter((r) => r.orderId === orderId)
    .filter((r) => enteredAt === undefined || r.orderEnteredAt === enteredAt)
    .sort((a, b) => b.createdAt - a.createdAt);
  return list[0];
}

function earChanged(local: FittingOrder, remote: FittingOrder, ear: EarSide): boolean {
  for (const f of FREQUENCIES) {
    if ((local.audiogram[ear].air[f] ?? null) !== (remote.audiogram[ear].air[f] ?? null))
      return true;
    if ((local.audiogram[ear].bone[f] ?? null) !== (remote.audiogram[ear].bone[f] ?? null))
      return true;
  }
  return false;
}

export interface MergeResult {
  winner: FittingOrder;
  /** 本地是否需要用服务端版本覆盖 */
  adoptRemote: boolean;
  conflicts: ConflictEntry[];
}

/**
 * 合并一份上送的验配单。
 * - 远端无版本 / 远端未变：本地快进
 * - 两端都改了：按录入时间取新；若远端版本持有复核结论，结论优先（远端胜，自动裁决）
 */
export function mergeOrder(
  incoming: FittingOrder,
  base: FittingOrder | null,
  remote: FittingOrder | null,
  remoteReviews: ReviewConclusion[],
  now: number
): MergeResult {
  if (!remote) {
    return { winner: { ...incoming, rev: 1, dirty: false }, adoptRemote: false, conflicts: [] };
  }
  if (orderSignature(incoming) === orderSignature(remote)) {
    return { winner: { ...remote, dirty: false }, adoptRemote: true, conflicts: [] };
  }
  if (base && base.rev === remote.rev) {
    // 本地基于最新服务端版本编辑，快进
    return {
      winner: { ...incoming, rev: remote.rev + 1, dirty: false },
      adoptRemote: false,
      conflicts: [],
    };
  }

  const remoteReviewed = !!latestReview(
    remoteReviews,
    remote.id,
    remote.enteredAt
  );
  const sameTimestamp = incoming.enteredAt === remote.enteredAt;
  const reviewWins = remoteReviewed && !sameTimestamp;

  const localNewer = incoming.enteredAt > remote.enteredAt;
  const winner: FittingOrder = reviewWins
    ? remote
    : sameTimestamp
      ? remote // 时间戳相同无法按时间裁决，先保留服务端，交人工
      : localNewer
        ? incoming
        : remote;

  const diffEars = EARS.filter((e) => earChanged(incoming, remote, e));
  const conflicts: ConflictEntry[] = diffEars.map((ear) => ({
    id: uid("cf"),
    orderId: incoming.id,
    customerId: incoming.customerId,
    customerName: incoming.customerName,
    ear,
    localEnteredAt: incoming.audiogram[ear].recordedAt || incoming.enteredAt,
    remoteEnteredAt: remote.audiogram[ear].recordedAt || remote.enteredAt,
    localSummary: earSummary(incoming.audiogram[ear]),
    remoteSummary: earSummary(remote.audiogram[ear]),
    reason: reviewWins
      ? "离线期间两端均有录入；服务端版本已有复诊助理复核结论，按“复核结论优先”自动保留服务端"
      : sameTimestamp
        ? "两端录入时间相同但分频结果不同，需人工裁决"
        : "离线期间两端分别复测，按最新录入时间暂存" +
          (localNewer ? "本地" : "服务端") +
          "版本",
    status: reviewWins ? "resolved-remote" : "pending",
    auto: reviewWins,
    localOrder: incoming,
    remoteOrder: remote,
    createdAt: now,
  }));

  return {
    winner: { ...winner, rev: remote.rev + 1, dirty: false },
    // 远端胜出（含复核优先的自动裁决）时本地覆盖为服务端版本；本地胜出则待人工冲突保留本地版本
    adoptRemote: winner === remote,
    conflicts,
  };
}
