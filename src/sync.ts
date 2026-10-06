import {
  Booking,
  Conflict,
  EarResult,
  EarSide,
  FittingRecord,
  Review,
  ServerSnapshot,
  SyncLogEntry,
} from "./types";

const SERVER_KEY = "fitting-bench-server-v1";

export function nowIso(): string {
  return new Date().toISOString();
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------- 结构比较（不含录入时间戳） ----------

export function earData(e: EarResult): Omit<EarResult, "recordedAt"> {
  const { recordedAt: _ignored, ...data } = e;
  return data;
}

export function sameEar(a?: EarResult, b?: EarResult): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(earData(a)) === JSON.stringify(earData(b));
}

// ---------- 模拟服务端 ----------

export function loadServer(): ServerSnapshot {
  try {
    const raw = localStorage.getItem(SERVER_KEY);
    if (raw) return JSON.parse(raw) as ServerSnapshot;
  } catch {
    /* ignore */
  }
  // 首次访问：无服务端数据
  return { records: [], reviews: [], bookings: [], serverTime: nowIso() };
}

export function saveServer(s: ServerSnapshot) {
  s.serverTime = nowIso();
  localStorage.setItem(SERVER_KEY, JSON.stringify(s));
}

export function serverExists(): boolean {
  return localStorage.getItem(SERVER_KEY) !== null;
}

// ---------- 推送到服务端（耳级三向，冲突时服务端保留己版） ----------

export function pushRecordToServer(
  server: ServerSnapshot,
  incoming: FittingRecord,
  base: ServerSnapshot | null
): { conflicts: Omit<Conflict, "id" | "customerName">[] } {
  const conflicts: Omit<Conflict, "id" | "customerName">[] = [];
  const remote = server.records.find((r) => r.id === incoming.id);
  const baseRec = base?.records.find((r) => r.id === incoming.id);

  if (!remote) {
    server.records.push(structuredClone(incoming));
    return { conflicts };
  }

  (["left", "right"] as EarSide[]).forEach((ear) => {
    const le = incoming[ear];
    const re = remote[ear];
    const be = baseRec?.[ear];
    if (sameEar(le, re)) return;
    if (!be || sameEar(be, le) || sameEar(be, re)) {
      // 单边改动，直接快进
      if (!be || sameEar(be, re)) remote[ear] = structuredClone(le);
      return;
    }
    // 两端都改且不一致：服务端保留己版，登记冲突待人工裁决
    conflicts.push({
      recordId: incoming.id,
      customerId: incoming.customerId,
      ear,
      reason: "同一耳别两端均有复测录入",
      localRecordedAt: le.recordedAt,
      remoteRecordedAt: re.recordedAt,
      localEar: structuredClone(le),
      remoteEar: structuredClone(re),
    });
  });

  remote.stage = incoming.updatedAt >= remote.updatedAt ? incoming.stage : remote.stage;
  remote.updatedAt = incoming.updatedAt >= remote.updatedAt ? incoming.updatedAt : remote.updatedAt;
  return { conflicts };
}

/** 复核结论优先：服务端已有的复核单不可被本地覆盖，仅补传新单 */
export function pushReviewToServer(server: ServerSnapshot, incoming: Review): "inserted" | "kept" {
  if (server.reviews.some((r) => r.id === incoming.id)) return "kept";
  server.reviews.push(structuredClone(incoming));
  return "inserted";
}

export function pushBookingToServer(
  server: ServerSnapshot,
  incoming: Booking
): "inserted" | "kept" {
  if (server.bookings.some((b) => b.id === incoming.id)) return "kept";
  server.bookings.push(structuredClone(incoming));
  return "inserted";
}

// ---------- 排期碰撞裁决（同步后双占处理） ----------

export function settleClashes(bookings: Booking[]): Booking[] {
  const active = bookings.filter((b) => b.status !== "released");
  const losers = new Set<string>();

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.slot !== b.slot) continue;
      const clash =
        a.roomId === b.roomId || a.customerId === b.customerId;
      if (!clash) continue;
      // 已确认优先；同级别则创建早的保留
      const rank = (x: Booking) => (x.status === "confirmed" ? 1 : 0);
      const keep =
        rank(a) === rank(b)
          ? a.createdAt <= b.createdAt
            ? a
            : b
          : rank(a) > rank(b)
            ? a
            : b;
      const drop = keep === a ? b : a;
      losers.add(drop.id);
    }
  }

  return bookings.map((b) =>
    losers.has(b.id)
      ? {
          ...b,
          status: "released",
          note: "同步发现验配间/客户时段撞单，已自动释放，请重新排期",
          updatedAt: nowIso(),
        }
      : b
  );
}

// ---------- 服务端 → 本地三向合并 ----------

export type MergeResult = {
  records: FittingRecord[];
  reviews: Review[];
  bookings: Booking[];
  conflicts: Conflict[];
  logs: SyncLogEntry[];
};

export function mergeServer(
  localRecords: FittingRecord[],
  localReviews: Review[],
  localBookings: Booking[],
  server: ServerSnapshot,
  base: ServerSnapshot | null,
  thresholds: { airBoneGap: number; ptaGap: number; perFreqGap: number },
  customerName: (id: string) => string
): MergeResult {
  const logs: SyncLogEntry[] = [];
  const conflicts: Conflict[] = [];
  const recordIds = new Set([
    ...localRecords.map((r) => r.id),
    ...server.records.map((r) => r.id),
  ]);

  const records: FittingRecord[] = [];
  recordIds.forEach((id) => {
    const l = localRecords.find((r) => r.id === id);
    const r = server.records.find((x) => x.id === id);
    const b = base?.records.find((x) => x.id === id);
    if (l && !r) {
      records.push(structuredClone(l));
      return;
    }
    if (r && !l) {
      records.push(structuredClone(r));
      return;
    }
    if (!l || !r) return;

    const merged = structuredClone(l);
    (["left", "right"] as EarSide[]).forEach((ear) => {
      const le = l[ear];
      const re = r[ear];
      const be = b?.[ear];
      if (sameEar(le, re)) return;
      if (!be || sameEar(be, le)) {
        merged[ear] = structuredClone(re);
      } else if (sameEar(be, re)) {
        // 仅本地改动，保留本地
      } else {
        // 两端同耳都改且不一致：挂冲突，暂留本地版
        conflicts.push({
          id: `${id}:${ear}`,
          recordId: id,
          customerId: merged.customerId,
          customerName: customerName(merged.customerId),
          ear,
          reason: "同一耳别两端均有复测录入，待人工裁决",
          localRecordedAt: le.recordedAt,
          remoteRecordedAt: re.recordedAt,
          localEar: structuredClone(le),
          remoteEar: structuredClone(re),
        });
      }
    });
    merged.stage = r.updatedAt >= l.updatedAt ? r.stage : l.stage;
    merged.updatedAt = r.updatedAt >= l.updatedAt ? r.updatedAt : l.updatedAt;
    records.push(merged);
  });

  // 复核单：同 id 一律以服务端为准（复核结论优先）
  const reviewMap = new Map<string, Review>();
  localReviews.forEach((rv) => reviewMap.set(rv.id, rv));
  server.reviews.forEach((rv) => {
    const local = reviewMap.get(rv.id);
    if (
      local &&
      (local.status === "approved" || local.status === "returned") &&
      local.status !== rv.status
    ) {
      logs.push({
        at: nowIso(),
        tone: "warn",
        message: `复核结论优先：${customerName(rv.customerId)} 的本地复核意见已被服务端结论覆盖（${rv.status === "approved" ? "通过" : "退回"}）`,
      });
    }
    reviewMap.set(rv.id, structuredClone(rv));
  });
  const reviews = Array.from(reviewMap.values());

  // 排期单：同 id 服务端为准，本地新建补入
  const bookingMap = new Map<string, Booking>();
  localBookings.forEach((bk) => bookingMap.set(bk.id, bk));
  server.bookings.forEach((bk) => bookingMap.set(bk.id, structuredClone(bk)));
  let bookings = Array.from(bookingMap.values());

  const beforeActive = bookings.filter((b) => b.status !== "released").length;
  bookings = settleClashes(bookings);
  const released = beforeActive - bookings.filter((b) => b.status !== "released").length;
  if (released > 0) {
    logs.push({
      at: nowIso(),
      tone: "warn",
      message: `合并后发现 ${released} 张排期单时段撞单，已按"已确认优先"自动释放`,
    });
  }

  if (conflicts.length > 0) {
    logs.push({
      at: nowIso(),
      tone: "warn",
      message: `发现 ${conflicts.length} 条耳级复测冲突，已列入冲突清单，裁决后试戴方可确认`,
    });
  } else {
    logs.push({
      at: nowIso(),
      tone: "ok",
      message: `合并完成：验配单 ${records.length} 份、复核单 ${reviews.length} 条、排期单 ${bookings.length} 张`,
    });
  }

  // 阈值参数由调用方在合并后重跑规则，这里不再重复评估
  void thresholds;

  return { records, reviews, bookings, conflicts, logs };
}
