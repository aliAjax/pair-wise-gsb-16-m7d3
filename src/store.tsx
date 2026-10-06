import React, { createContext, useContext, useEffect, useMemo, useReducer } from "react";
import {
  AppState,
  Booking,
  Conflict,
  EarSide,
  FittingRecord,
  Frequency,
  Review,
  ServerSnapshot,
  SyncLogEntry,
} from "./types";
import {
  customerSlotTaken,
  evaluate,
  fmtDate,
  recordSignature,
  roomSlotTaken,
  SLOT_HOURS,
} from "./domain";
import {
  loadServer,
  mergeServer,
  nowIso,
  pushBookingToServer,
  pushRecordToServer,
  pushReviewToServer,
  saveServer,
  settleClashes,
  uid,
} from "./sync";
import { CUSTOMERS, ROOMS, seedDerived, seedRecords } from "./seed";

const STATE_KEY = "fitting-bench-state-v1";
const DEFAULT_THRESHOLDS = { airBoneGap: 10, ptaGap: 15, perFreqGap: 20 };

// ---------- 规则联动：复核单 + 试戴失效 ----------

function log(tone: SyncLogEntry["tone"], message: string): SyncLogEntry {
  return { at: nowIso(), tone, message };
}

/** 依据最新验配单刷新复核单与试戴有效性 */
function applyRules(
  records: FittingRecord[],
  reviews: Review[],
  bookings: Booking[],
  thresholds: AppState["thresholds"],
  logs: SyncLogEntry[],
  scopedIds?: string[]
): { reviews: Review[]; bookings: Booking[]; logs: SyncLogEntry[] } {
  let nextReviews = [...reviews];
  let nextBookings = [...bookings];
  const nextLogs = [...logs];
  const scope = scopedIds ? new Set(scopedIds) : null;

  records.forEach((rec) => {
    if (scope && !scope.has(rec.id)) return;
    const ev = evaluate(rec, thresholds);
    const sig = ev.signature;

    const existingIdx = nextReviews.findIndex((rv) => rv.recordId === rec.id);
    const existing = nextReviews[existingIdx];

    if (ev.needsReview) {
      if (!existing || existing.signature !== sig) {
        // 新问题或复测导致签名变化：重开复核；
        // 结论与当前签名一致时保留结论（同步后体现"复核结论优先"）
        const rv: Review = {
          id: existing?.id ?? `rv-${rec.id}`,
          recordId: rec.id,
          customerId: rec.customerId,
          reasons: ev.reasons,
          signature: sig,
          status: "pending",
          createdAt: nowIso(),
          ears: ev.ears,
        };
        if (existingIdx >= 0) nextReviews[existingIdx] = rv;
        else nextReviews.push(rv);
        if (existing && existing.signature !== sig) {
          nextLogs.push(
            log("warn", `复测数据已变，${rec.customerId} 需重新提交复诊助理复核`)
          );
        }
      }
    } else if (existing && existing.status === "pending") {
      // 数据恢复正常，且尚无结论的复核单可撤销；已出结论的留痕保留
      nextReviews = nextReviews.filter((rv) => rv.id !== existing.id);
    }

    // 未确认试戴：依据签名失效（仅未确认单）
    nextBookings = nextBookings.map((bk) => {
      if (bk.recordId !== rec.id || bk.kind !== "trial" || bk.status !== "proposed") return bk;
      if (bk.signature !== sig) {
        return {
          ...bk,
          status: "released",
          note: "复测结果改动，未确认的试戴安排已失效，需重新确认",
          updatedAt: nowIso(),
        };
      }
      return bk;
    });
  });

  return { reviews: nextReviews, bookings: nextBookings, logs: nextLogs };
}

/** 无活跃排期时按规则自动给建议时段 */
function autoPropose(
  record: FittingRecord,
  records: FittingRecord[],
  reviews: Review[],
  bookings: Booking[],
  thresholds: AppState["thresholds"]
): Booking[] {
  const ev = evaluate(record, thresholds);
  const out = [...bookings];
  const hasActive = (kind: Booking["kind"]) =>
    out.some(
      (b) => b.recordId === record.id && b.kind === kind && b.status !== "released"
    );

  const findFree = (date: string, hourPref: number[], createdAt: string): Booking | null => {
    for (let offset = 0; offset < 5; offset++) {
      const d = new Date(date);
      d.setDate(d.getDate() + offset);
      const ds = fmtDate(d);
      const hours = [...hourPref, ...SLOT_HOURS.filter((h) => !hourPref.includes(h))];
      for (const h of hours) {
        const slot = `${ds}T${String(h).padStart(2, "0")}`;
        if (customerSlotTaken(out, record.customerId, slot)) continue;
        for (const room of ROOMS) {
          if (!roomSlotTaken(out, room.id, slot)) {
            return {
              id: uid("bk"),
              customerId: record.customerId,
              recordId: record.id,
              kind: "followup",
              roomId: room.id,
              slot,
              status: "proposed",
              createdAt,
              updatedAt: nowIso(),
            };
          }
        }
      }
    }
    return null;
  };

  const ts0 = nowIso();
  if (!hasActive("followup")) {
    const date = new Date();
    date.setDate(date.getDate() + ev.followUpDays);
    const b = findFree(fmtDate(date), [9], ts0);
    if (b) {
      b.note = `系统建议：${ev.followUpDays} 天后复诊`;
      out.push(b);
    }
  }
  if (!hasActive("trial")) {
    const date = new Date();
    date.setDate(date.getDate() + ev.followUpDays + 1);
    const b = findFree(fmtDate(date), [10, 14], ts0);
    if (b) {
      b.kind = "trial";
      b.note = ev.needsReview ? "待复核结论返回后确认" : "助听器试戴";
      b.signature = ev.signature;
      out.push(b);
    }
  }
  return out;
}

// ---------- 初始状态 ----------

function buildInitial(): AppState {
  const records = seedRecords();
  const { reviews, bookings } = seedDerived(records, DEFAULT_THRESHOLDS);
  const state: AppState = {
    online: navigator.onLine,
    customers: CUSTOMERS,
    records,
    reviews,
    rooms: ROOMS,
    bookings,
    conflicts: [],
    queue: [],
    base: null,
    lastSyncAt: null,
    syncing: false,
    logs: [log("info", "验配台已就绪：分频验配、复核闸口、排期与断网合并已启用")],
    thresholds: DEFAULT_THRESHOLDS,
  };

  const server = loadServer();
  if (server.records.length === 0) {
    const seed: ServerSnapshot = {
      records: structuredClone(records),
      reviews: structuredClone(reviews),
      bookings: structuredClone(bookings),
      serverTime: nowIso(),
    };
    saveServer(seed);
    state.base = structuredClone(seed);
    state.lastSyncAt = nowIso();
  } else {
    const merged = mergeServer(
      state.records,
      state.reviews,
      state.bookings,
      server,
      null,
      state.thresholds,
      (id) => state.customers.find((c) => c.id === id)?.name ?? id
    );
    state.records = merged.records;
    state.reviews = merged.reviews;
    state.bookings = settleClashes(merged.bookings);
    state.conflicts = merged.conflicts;
    state.base = structuredClone(server);
    state.lastSyncAt = nowIso();
  }
  return state;
}

function init(): AppState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppState;
      parsed.syncing = false;
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return buildInitial();
}

// ---------- Actions ----------

type Action =
  | { type: "set-online"; online: boolean }
  | { type: "save-record"; record: FittingRecord }
  | {
      type: "schedule";
      booking: Omit<Booking, "id" | "createdAt" | "updatedAt" | "status"> & { id?: string };
    }
  | { type: "reschedule"; bookingId: string; roomId: string; slot: string }
  | { type: "confirm-booking"; bookingId: string }
  | { type: "release-booking"; bookingId: string; reason: string }
  | { type: "review-decide"; reviewId: string; status: "approved" | "returned"; conclusion: string }
  | { type: "resolve-conflict"; conflictId: string; choice: "local" | "remote" }
  | { type: "sync" }
  | { type: "simulate-remote-record"; recordId: string; ear: EarSide; airPatch: Partial<Record<string, string>> }
  | { type: "simulate-remote-review"; reviewId: string; status: "approved" | "returned"; conclusion: string }
  | { type: "dismiss-log" }
  | { type: "reset-demo" };

function enqueue(state: AppState, op: AppState["queue"][number]): AppState["queue"] {
  return [...state.queue, op];
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "set-online":
      return { ...state, online: action.online };

    case "save-record": {
      const record: FittingRecord = { ...action.record, updatedAt: nowIso() };
      const records = state.records.map((r) => (r.id === record.id ? record : r));
      let bookings = state.bookings;
      const ev0 = evaluate(record, state.thresholds);
      // 自动补建议时段（若此前没有活跃单）
      bookings = autoPropose(record, records, state.reviews, bookings, state.thresholds);
      let logs = [...state.logs];
      const old = state.records.find((r) => r.id === record.id);
      if (old && recordSignature(old) !== ev0.signature) {
        logs.push(
          log("info", `${state.customers.find((c) => c.id === record.customerId)?.name}: 复测结果已保存`)
        );
      }
      const ruled = applyRules(records, state.reviews, bookings, state.thresholds, logs, [record.id]);
      return {
        ...state,
        records,
        reviews: ruled.reviews,
        bookings: ruled.bookings,
        logs: ruled.logs.slice(-40),
        queue: enqueue(state, { type: "record-upsert", recordId: record.id, at: nowIso() }),
      };
    }

    case "schedule": {
      const clashC = customerSlotTaken(
        state.bookings,
        action.booking.customerId,
        action.booking.slot
      );
      if (clashC) {
        return {
          ...state,
          logs: [
            ...state.logs,
            log("warn", `排期被拒：该客户此时段已有安排（${clashC.slot.replace("T", " ")}），同一时段只能占一个验配间`),
          ].slice(-40),
        };
      }
      const clashR = roomSlotTaken(state.bookings, action.booking.roomId, action.booking.slot);
      if (clashR) {
        return {
          ...state,
          logs: [
            ...state.logs,
            log("warn", `排期被拒：${state.rooms.find((r) => r.id === action.booking.roomId)?.name} 该时段已被占用`),
          ].slice(-40),
        };
      }
      const record = state.records.find((r) => r.id === action.booking.recordId);
      const ev = record ? evaluate(record, state.thresholds) : null;
      const bk: Booking = {
        ...action.booking,
        id: action.booking.id ?? uid("bk"),
        status: "proposed",
        signature: action.booking.kind === "trial" ? ev?.signature : undefined,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      return {
        ...state,
        bookings: [...state.bookings, bk],
        logs: [...state.logs, log("info", `已排入${bk.kind === "trial" ? "试戴" : "复诊"}：${bk.slot.replace("T", " ")} · ${state.rooms.find((r) => r.id === bk.roomId)?.name}`)].slice(-40),
        queue: enqueue(state, { type: "booking-upsert", bookingId: bk.id, at: nowIso() }),
      };
    }

    case "reschedule": {
      // 改期先释放原时段，再以新时段新建待确认单
      const old = state.bookings.find((b) => b.id === action.bookingId);
      if (!old) return state;
      if (customerSlotTaken(state.bookings, old.customerId, action.slot, old.id)) {
        return {
          ...state,
          logs: [...state.logs, log("warn", "改期被拒：该客户新时段已有其他安排")].slice(-40),
        };
      }
      if (roomSlotTaken(state.bookings, action.roomId, action.slot, old.id)) {
        return {
          ...state,
          logs: [...state.logs, log("warn", "改期被拒：新验配间该时段已被占用")].slice(-40),
        };
      }
      const released: Booking = {
        ...old,
        status: "released",
        note: `改期：原时段 ${old.slot.replace("T", " ")} 已释放`,
        updatedAt: nowIso(),
      };
      const fresh: Booking = {
        ...old,
        id: uid("bk"),
        roomId: action.roomId,
        slot: action.slot,
        status: "proposed",
        note: `由 ${old.slot.replace("T", " ")} 改期而来`,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      return {
        ...state,
        bookings: [...state.bookings.map((b) => (b.id === old.id ? released : b)), fresh],
        logs: [
          ...state.logs,
          log("info", `改期完成：原时段已释放，新时段待确认（${fresh.slot.replace("T", " ")}）`),
        ].slice(-40),
        queue: enqueue(state, { type: "booking-upsert", bookingId: fresh.id, at: nowIso() }),
      };
    }

    case "confirm-booking": {
      const bk = state.bookings.find((b) => b.id === action.bookingId);
      if (!bk || bk.status !== "proposed") return state;

      if (bk.kind === "trial") {
        // 闸口 1：存在未裁决冲突
        if (state.conflicts.some((c) => c.recordId === bk.recordId)) {
          return {
            ...state,
            logs: [...state.logs, log("warn", "试戴确认被拦：该验配单存在未裁决的复测冲突")].slice(-40),
          };
        }
        // 闸口 2：复核结论未回来 / 已退回
        const pending = state.reviews.find(
          (rv) => rv.recordId === bk.recordId && rv.status !== "approved"
        );
        if (pending) {
          return {
            ...state,
            logs: [
              ...state.logs,
              log(
                "warn",
                pending.status === "returned"
                  ? "试戴确认被拦：复核结论为退回，须先处理验配问题"
                  : "试戴确认被拦：两耳参数不一致/气骨导差达阈值，复核结论尚未返回"
              ),
            ].slice(-40),
          };
        }
        // 闸口 3：签名过期（理论上已失效，双保险）
        const record = state.records.find((r) => r.id === bk.recordId);
        if (record && bk.signature !== recordSignature(record)) {
          return {
            ...state,
            logs: [...state.logs, log("warn", "试戴确认被拦：依据的复测结果已过期，请重新排期")].slice(-40),
          };
        }
      }

      return {
        ...state,
        bookings: state.bookings.map((b) =>
          b.id === bk.id ? { ...b, status: "confirmed", updatedAt: nowIso() } : b
        ),
        logs: [
          ...state.logs,
          log("ok", `${bk.kind === "trial" ? "试戴" : "复诊"}已确认：${bk.slot.replace("T", " ")}`),
        ].slice(-40),
        queue: enqueue(state, { type: "booking-upsert", bookingId: bk.id, at: nowIso() }),
      };
    }

    case "release-booking": {
      return {
        ...state,
        bookings: state.bookings.map((b) =>
          b.id === action.bookingId
            ? { ...b, status: "released", note: action.reason, updatedAt: nowIso() }
            : b
        ),
        queue: enqueue(state, { type: "booking-upsert", bookingId: action.bookingId, at: nowIso() }),
      };
    }

    case "review-decide": {
      const reviews = state.reviews.map((rv) =>
        rv.id === action.reviewId
          ? {
              ...rv,
              status: action.status,
              conclusion: action.conclusion,
              decidedAt: nowIso(),
              decidedBy: "复诊助理",
            }
          : rv
      );
      const rv = reviews.find((x) => x.id === action.reviewId)!;
      return {
        ...state,
        reviews,
        logs: [
          ...state.logs,
          log(
            action.status === "approved" ? "ok" : "warn",
            `复核结论已返回（${rv.reasons.join("、")}）：${action.status === "approved" ? "通过，试戴可以确认" : "退回调整"}`
          ),
        ].slice(-40),
        queue: enqueue(state, { type: "review-decide", reviewId: action.reviewId, at: nowIso() }),
      };
    }

    case "resolve-conflict": {
      const conflict = state.conflicts.find((c) => c.id === action.conflictId);
      if (!conflict) return state;
      const chosen = action.choice === "local" ? conflict.localEar : conflict.remoteEar;
      const records = state.records.map((r) =>
        r.id === conflict.recordId ? { ...r, [conflict.ear]: structuredClone(chosen) } : r
      );
      const conflicts = state.conflicts.filter((c) => c.id !== conflict.id);
      let logs = [
        ...state.logs,
        log(
          "ok",
          `冲突已裁决：${conflict.customerName} ${conflict.ear === "left" ? "左耳" : "右耳"}采用${action.choice === "local" ? "本机录入" : "服务端录入"}（${conflict.localRecordedAt.slice(0, 16).replace("T", " ")} / ${conflict.remoteRecordedAt.slice(0, 16).replace("T", " ")}）`
        ),
      ];
      const ruled = applyRules(records, state.reviews, state.bookings, state.thresholds, logs, [
        conflict.recordId,
      ]);
      return {
        ...state,
        records,
        conflicts,
        reviews: ruled.reviews,
        bookings: ruled.bookings,
        logs: ruled.logs.slice(-40),
        queue: enqueue(state, { type: "record-upsert", recordId: conflict.recordId, at: nowIso() }),
      };
    }

    case "sync": {
      if (!state.online || state.syncing) return state;
      const server = loadServer();

      // 1. 本地操作推送（复核结论在服务端优先：pushReview 不覆盖已有结论）
      const pushLogs: SyncLogEntry[] = [];
      let pushConflicts: Omit<Conflict, "id" | "customerName">[] = [];
      state.queue.forEach((op) => {
        if (op.type === "record-upsert") {
          const rec = state.records.find((r) => r.id === op.recordId);
          if (rec) {
            const { conflicts } = pushRecordToServer(server, rec, state.base);
            pushConflicts.push(...conflicts);
          }
        } else if (op.type === "booking-upsert") {
          const bk = state.bookings.find((b) => b.id === op.bookingId);
          if (bk) pushBookingToServer(server, bk);
        } else if (op.type === "review-decide") {
          const rv = state.reviews.find((r) => r.id === op.reviewId);
          if (rv) {
            const res = pushReviewToServer(server, rv);
            if (res === "kept") {
              pushLogs.push(
                log("warn", "服务端已存在该复核结论，按复核结论优先规则保留服务端版本")
              );
            }
          }
        }
      });
      saveServer(server);

      // 2. 三向合并到本地
      const merged = mergeServer(
        state.records,
        state.reviews,
        state.bookings,
        server,
        state.base,
        state.thresholds,
        (id) => state.customers.find((c) => c.id === id)?.name ?? id
      );

      // 3. 合并后跑规则：新复核需求、未确认试戴失效
      const ruled = applyRules(
        merged.records,
        merged.reviews,
        merged.bookings,
        state.thresholds,
        [...pushLogs, ...merged.logs]
      );

      // 推送阶段产生的冲突（服务端保留己版）并入冲突清单
      const conflictMap = new Map(merged.conflicts.map((c) => [c.id, c]));
      pushConflicts.forEach((c) => {
        const id = `${c.recordId}:${c.ear}`;
        if (!conflictMap.has(id)) {
          conflictMap.set(id, {
            ...c,
            id,
            customerName: state.customers.find((x) => x.id === c.customerId)?.name ?? c.customerId,
          });
        }
      });

      return {
        ...state,
        records: merged.records,
        reviews: ruled.reviews,
        bookings: ruled.bookings,
        conflicts: Array.from(conflictMap.values()),
        base: structuredClone(server),
        queue: [],
        lastSyncAt: nowIso(),
        logs: [
          log("ok", `已完成合并（${state.queue.length} 项本地操作已同步）`),
          ...ruled.logs,
        ].slice(-40),
      };
    }

    case "simulate-remote-record": {
      // 模拟另一台终端在服务端直接复测录入
      const server = loadServer();
      const rec = server.records.find((r) => r.id === action.recordId);
      if (!rec) return state;
      Object.entries(action.airPatch).forEach(([f, v]) => {
        if (v !== undefined) rec[action.ear].audiogram.air[Number(f) as Frequency] = v;
      });
      rec[action.ear].recordedAt = nowIso();
      rec.updatedAt = nowIso();
      saveServer(server);
      return {
        ...state,
        logs: [
          ...state.logs,
          log("info", "【模拟】另一台终端已在服务端写入复测数据，可执行同步查看冲突"),
        ].slice(-40),
      };
    }

    case "simulate-remote-review": {
      const server = loadServer();
      const rv = server.reviews.find((r) => r.id === action.reviewId);
      if (!rv) return state;
      // 助理在服务端看到的是服务端最新验配数据，结论签名随之更新
      const rec = server.records.find((r) => r.id === rv.recordId);
      if (rec) rv.signature = recordSignature(rec);
      rv.status = action.status;
      rv.conclusion = action.conclusion;
      rv.decidedAt = nowIso();
      rv.decidedBy = "复诊助理（服务端）";
      saveServer(server);
      return {
        ...state,
        logs: [
          ...state.logs,
          log("info", "【模拟】复诊助理已在服务端给出复核结论，同步后将以服务端为准"),
        ].slice(-40),
      };
    }

    case "dismiss-log":
      return { ...state, logs: [] };

    case "reset-demo": {
      localStorage.removeItem(STATE_KEY);
      localStorage.removeItem("fitting-bench-server-v1");
      return buildInitial();
    }

    default:
      return state;
  }
}

// ---------- Context ----------

type Store = {
  state: AppState;
  dispatch: React.Dispatch<Action>;
};

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, init);

  // 持久化
  useEffect(() => {
    const { syncing: _s, ...persist } = state;
    void _s;
    localStorage.setItem(STATE_KEY, JSON.stringify(persist));
  }, [state]);

  // 浏览器在线/断网事件
  useEffect(() => {
    const on = () => dispatch({ type: "set-online", online: true });
    const off = () => dispatch({ type: "set-online", online: false });
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // 联网且有待同步操作时自动合并
  useEffect(() => {
    if (state.online && state.queue.length > 0) {
      const t = setTimeout(() => dispatch({ type: "sync" }), 500);
      return () => clearTimeout(t);
    }
  }, [state.online, state.queue.length]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}

// 供 UI 复用的选择器
export { buildInitial };
export type { Action };

export function useRule(recordId: string) {
  const { state } = useStore();
  const record = state.records.find((r) => r.id === recordId);
  if (!record) return null;
  return evaluate(record, state.thresholds);
}
