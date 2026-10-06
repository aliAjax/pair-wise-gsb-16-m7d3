// 模拟“门店服务端”：localStorage 分库持久化，断网时不可访问
import { latestReview, mergeOrder } from "../domain/merge";
import { buildSeed } from "../domain/seed";
import {
  Appointment,
  ConflictEntry,
  FittingOrder,
  OutboxEntry,
  ReviewConclusion,
} from "../domain/types";

interface ServerState {
  orders: FittingOrder[];
  reviews: ReviewConclusion[];
  appointments: Appointment[];
  conflicts: ConflictEntry[];
  baseRevs: Record<string, number>;
}

const SERVER_KEY = "fitting-desk-server-v1";

function loadServer(): ServerState {
  try {
    const raw = localStorage.getItem(SERVER_KEY);
    if (raw) return JSON.parse(raw) as ServerState;
  } catch {
    /* 忽略损坏缓存 */
  }
  const seed = buildSeed();
  const state: ServerState = {
    orders: seed.orders,
    reviews: seed.reviews,
    appointments: seed.appointments,
    conflicts: [],
    baseRevs: Object.fromEntries(seed.orders.map((o) => [o.id, o.rev])),
  };
  persist(state);
  return state;
}

function persist(state: ServerState) {
  try {
    localStorage.setItem(SERVER_KEY, JSON.stringify(state));
  } catch {
    /* 存储满等情况忽略 */
  }
}

export interface PushResult {
  order: FittingOrder | null;
  review: ReviewConclusion | null;
  conflicts: ConflictEntry[];
  /** 自动裁决为远端胜时，本地应覆盖的订单 */
  adoptRemoteOrder: FittingOrder | null;
}

/** 演示用：模拟门店另一终端在“服务端”改了某只耳朵的复测结果 */
export function simulateRemoteEdit(
  orderId: string,
  ear: "L" | "R",
  freq: 250 | 500 | 1000 | 2000 | 4000 | 8000,
  air: number | undefined,
  bone: number | undefined
): FittingOrder {
  const s = loadServer();
  const order = s.orders.find((o) => o.id === orderId);
  if (!order) throw new Error("订单不存在");
  const enteredAt = Date.now();
  const updated: FittingOrder = {
    ...order,
    rev: order.rev + 1,
    enteredAt,
    dirty: false,
    audiogram: {
      ...order.audiogram,
      [ear]: {
        ...order.audiogram[ear],
        air: { ...order.audiogram[ear].air, ...(air === undefined ? {} : { [freq]: air }) },
        bone: { ...order.audiogram[ear].bone, ...(bone === undefined ? {} : { [freq]: bone }) },
        recordedAt: enteredAt,
      },
    },
  };
  s.orders = s.orders.map((o) => (o.id === orderId ? updated : o));
  s.baseRevs[orderId] = updated.rev;
  persist(s);
  return updated;
}

/** 演示用：复诊助理在另一终端回复核结论（此时本地若有待确认试戴，同步后即解锁） */
export function simulateRemoteReview(
  orderId: string,
  verdict: ReviewConclusion["verdict"],
  comment: string,
  reviewer: string
): ReviewConclusion {
  const s = loadServer();
  const order = s.orders.find((o) => o.id === orderId);
  if (!order) throw new Error("订单不存在");
  const review: ReviewConclusion = {
    id: `rev_${Math.random().toString(36).slice(2, 9)}`,
    orderId,
    orderEnteredAt: order.enteredAt,
    verdict,
    reviewer,
    comment,
    triggers: [],
    createdAt: Date.now(),
    rev: 1,
    dirty: false,
  };
  s.reviews = [...s.reviews, review];
  persist(s);
  return review;
}

export function pushEntry(
  entry: OutboxEntry,
  base: FittingOrder | null
): PushResult {
  const s = loadServer();
  if (entry.type === "submitReview") {
    const review = { ...entry.review, dirty: false };
    s.reviews = [...s.reviews, review];
    persist(s);
    return { order: null, review, conflicts: [], adoptRemoteOrder: null };
  }

  const remote = s.orders.find((o) => o.id === entry.order.id) ?? null;
  const result = mergeOrder(entry.order, base, remote, s.reviews, Date.now());
  s.orders = [
    ...s.orders.filter((o) => o.id !== result.winner.id),
    result.winner,
  ];
  s.baseRevs[entry.order.id] = result.winner.rev;
  if (result.conflicts.length) {
    const exists = new Set(
      s.conflicts
        .filter((c) => c.status === "pending")
        .map((c) => `${c.orderId}|${c.ear}|${c.localEnteredAt}|${c.remoteEnteredAt}`)
    );
    const fresh = result.conflicts.filter(
      (c) =>
        !exists.has(
          `${c.orderId}|${c.ear}|${c.localEnteredAt}|${c.remoteEnteredAt}`
        )
    );
    s.conflicts = [...s.conflicts, ...fresh];
  }
  persist(s);
  return {
    order: result.winner,
    review: null,
    conflicts: result.conflicts,
    adoptRemoteOrder: result.adoptRemote ? result.winner : null,
  };
}

export function fetchAll(): {
  orders: FittingOrder[];
  reviews: ReviewConclusion[];
  appointments: Appointment[];
  conflicts: ConflictEntry[];
} {
  const s = loadServer();
  return {
    orders: s.orders.map((o) => ({ ...o, dirty: false })),
    reviews: s.reviews.map((r) => ({ ...r, dirty: false })),
    appointments: s.appointments.map((a) => ({ ...a })),
    conflicts: s.conflicts.map((c) => ({ ...c })),
  };
}

/** 服务端合并试戴/复诊安排（按 id 取状态优先方），不整表覆盖他端变更 */
export function saveAppointments(appts: Appointment[]): void {
  const s = loadServer();
  const rank: Record<Appointment["status"], number> = {
    cancelled: 0,
    invalidated: 1,
    suggested: 2,
    confirmed: 3,
  };
  const byId = new Map(s.appointments.map((a) => [a.id, a]));
  for (const a of appts) {
    const ex = byId.get(a.id);
    if (!ex || rank[a.status] > rank[ex.status]) byId.set(a.id, { ...a });
  }
  s.appointments = [...byId.values()];
  persist(s);
}

export function resolveConflictOnServer(
  conflictId: string,
  resolution: "resolved-local" | "resolved-remote",
  localOrder?: FittingOrder
): void {
  const s = loadServer();
  const c = s.conflicts.find((x) => x.id === conflictId);
  if (!c) return;
  c.status = resolution;
  if (resolution === "resolved-local" && localOrder) {
    const remote = s.orders.find((o) => o.id === localOrder.id);
    const bumped: FittingOrder = {
      ...localOrder,
      rev: (remote?.rev ?? 0) + 1,
      dirty: false,
    };
    s.orders = [...s.orders.filter((o) => o.id !== bumped.id), bumped];
    s.baseRevs[bumped.id] = bumped.rev;
  }
  persist(s);
}

export function latestRemoteReview(
  orderId: string,
  enteredAt: number
): ReviewConclusion | undefined {
  const s = loadServer();
  return latestReview(s.reviews, orderId, enteredAt);
}

export function resetServer(): void {
  localStorage.removeItem(SERVER_KEY);
  loadServer();
}
