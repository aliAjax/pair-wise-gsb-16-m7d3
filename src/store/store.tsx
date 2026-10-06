// 验配台全局状态：离线优先 + outbox + 网络恢复合并
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  canConfirmTrial,
  checkSlot,
  findFreeSlot,
  invalidateStaleTrials,
  reschedule as rescheduleSlot,
} from "../domain/scheduling";
import {
  earPta,
  evaluateTriggers,
  lossGrade,
  needsReview,
  suggestSchedule,
} from "../domain/audiology";
import { latestReview, uid } from "../domain/merge";
import {
  fetchAll,
  pushEntry,
  resolveConflictOnServer,
  resetServer,
  saveAppointments,
  simulateRemoteEdit,
  simulateRemoteReview,
} from "./fakeServer";
import { buildSeed } from "../domain/seed";
import {
  Appointment,
  ConflictEntry,
  FittingOrder,
  LogEntry,
  OutboxEntry,
  ReviewConclusion,
  ReviewVerdict,
} from "../domain/types";

const CLIENT_KEY = "fitting-desk-client-v1";
const DAY = 86400000;

export interface SyncReport {
  pushed: number;
  pulled: number;
  conflicts: number;
  autoResolved: number;
  note?: string;
}

interface ClientPersist {
  orders: FittingOrder[];
  reviews: ReviewConclusion[];
  appts: Appointment[];
  conflicts: ConflictEntry[];
  outbox: OutboxEntry[];
  logs: LogEntry[];
  online: boolean;
  /** 各订单最近一次同步所基于的服务端版本 */
  bases: Record<string, FittingOrder>;
}

export interface SaveOrderInput {
  id?: string;
  customerId: string;
  customerName: string;
  category: FittingOrder["category"];
  deviceModel: string;
  notes: string;
  audiogram: FittingOrder["audiogram"];
}

interface StoreHelpers {
  reviewFor: (order: FittingOrder) => ReviewConclusion | undefined;
  triggersFor: (order: FittingOrder) => ReturnType<typeof evaluateTriggers>;
  gateFor: (appt: Appointment) => ReturnType<typeof canConfirmTrial>;
  pta: (order: FittingOrder, ear: "L" | "R") => number | null;
  grade: (order: FittingOrder, ear: "L" | "R") => string;
  apptsForOrder: (orderId: string) => Appointment[];
}

export interface StoreValue extends ClientPersist {
  lastSyncAt: number | null;
  lastSyncReport: SyncReport | null;
  setOnline: (v: boolean) => Promise<SyncReport | null>;
  sync: () => Promise<SyncReport>;
  saveOrder: (input: SaveOrderInput) => { ok: boolean; error?: string };
  confirmTrial: (apptId: string) => { ok: boolean; error?: string };
  reschedule: (
    apptId: string,
    start: number,
    roomId: string
  ) => { ok: boolean; error?: string };
  cancelAppt: (apptId: string) => void;
  submitReview: (
    orderId: string,
    verdict: ReviewVerdict,
    comment: string
  ) => { ok: boolean; error?: string };
  remoteEditDemo: (p: {
    orderId: string;
    ear: "L" | "R";
    freq: 250 | 500 | 1000 | 2000 | 4000 | 8000;
    air?: number;
    bone?: number;
  }) => void;
  remoteReviewDemo: (
    orderId: string,
    verdict: ReviewVerdict,
    comment: string
  ) => void;
  resolveConflict: (
    conflictId: string,
    pick: "local" | "remote"
  ) => { ok: boolean };
  resetAll: () => void;
  helpers: StoreHelpers;
}

const StoreContext = createContext<StoreValue | null>(null);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function mkLog(
  level: LogEntry["level"],
  text: string,
  at = Date.now()
): LogEntry {
  return { id: uid("log"), at, level, text };
}

function freshClient(): ClientPersist {
  const seed = buildSeed();
  return {
    orders: seed.orders,
    reviews: seed.reviews,
    appts: seed.appointments,
    conflicts: [],
    outbox: [],
    logs: seed.logs,
    online: false, // 进入页面默认离线，演示“断网先存本地”
    bases: Object.fromEntries(seed.orders.map((o) => [o.id, clone(o)])),
  };
}

function loadClient(): ClientPersist {
  try {
    const raw = localStorage.getItem(CLIENT_KEY);
    if (raw) {
      const p = JSON.parse(raw) as ClientPersist;
      return { ...p, online: false };
    }
  } catch {
    /* 缓存损坏则回落种子 */
  }
  return freshClient();
}

function statusRank(s: Appointment["status"]): number {
  return { cancelled: 0, invalidated: 1, suggested: 2, confirmed: 3 }[s];
}

/** 安排并集；撞单（同客户或同房间时段重叠）时后建的一条降级失效 */
function mergeAppointments(
  local: Appointment[],
  remote: Appointment[]
): Appointment[] {
  const byId = new Map<string, Appointment>();
  for (const a of local) byId.set(a.id, a);
  for (const a of remote) {
    const ex = byId.get(a.id);
    if (!ex || statusRank(a.status) > statusRank(ex.status)) byId.set(a.id, a);
  }
  const all = [...byId.values()];
  const blocking = all.filter(
    (a) => a.status === "confirmed" || a.status === "suggested"
  );
  const killed = new Set<string>();
  for (let i = 0; i < blocking.length; i++) {
    for (let j = i + 1; j < blocking.length; j++) {
      const a = blocking[i];
      const b = blocking[j];
      const overlap =
        a.start < b.start + b.durationMin * 60000 &&
        b.start < a.start + a.durationMin * 60000;
      if (overlap && (a.customerId === b.customerId || a.roomId === b.roomId)) {
        const loser = a.createdAt > b.createdAt ? a : b;
        killed.add(loser.id);
      }
    }
  }
  return all.map((a) =>
    killed.has(a.id)
      ? {
          ...a,
          status: "invalidated",
          reason: "合并后与另一终端排期撞单，需重新确认时段",
        }
      : a
  );
}

/** 订单/复核集合变化后，对试戴建议位统一走确认门控 */
function reconcileAppointments(
  appts: Appointment[],
  reviews: ReviewConclusion[],
  orders: FittingOrder[]
): Appointment[] {
  const orderMap = new Map(orders.map((o) => [o.id, o]));
  return appts.map((a) => {
    const o = orderMap.get(a.orderId);
    if (!o || a.kind !== "trial" || a.status !== "suggested") return a;
    if (a.basedOnEnteredAt !== o.enteredAt) {
      return {
        ...a,
        status: "invalidated",
        reason: "验配单已更新，试戴安排需按最新分频重新排期",
      };
    }
    if (!needsReview(o.audiogram)) return a;
    const rv = latestReview(reviews, o.id, o.enteredAt);
    if (rv && rv.verdict !== "pass") {
      return {
        ...a,
        status: "invalidated",
        reason: `复核结论 ${rv.verdict}：${rv.comment}，试戴暂不可确认`,
      };
    }
    return a;
  });
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ClientPersist>(loadClient);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [lastSyncReport, setLastSyncReport] = useState<SyncReport | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const syncingRef = useRef(false);

  // 断网时也实时落本地
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(CLIENT_KEY, JSON.stringify(state));
      } catch {
        /* 存储满等忽略 */
      }
    }, 120);
    return () => clearTimeout(t);
  }, [state]);

  const pushLog = useCallback((level: LogEntry["level"], text: string) => {
    setState((s) => ({
      ...s,
      logs: [mkLog(level, text), ...s.logs].slice(
        0,
        80
      ),
    }));
  }, []);

  /** 复测改动后：失效旧的未确认试戴，并按新分频重新给出复诊/试戴时段 */
  const regenerateSuggestions = useCallback(
    (
      prev: ClientPersist,
      order: FittingOrder
    ): Appointment[] => {
      let appts = invalidateStaleTrials(prev.appts, order);
      const sug = suggestSchedule(order.audiogram, order.category);

      for (const kind of ["followup", "trial"] as const) {
        const days = kind === "followup" ? sug.followupDays : sug.trialDays;
        const live = appts.filter(
          (a) =>
            a.orderId === order.id &&
            a.kind === kind &&
            a.status === "confirmed"
        );
        if (live.length) continue; // 已确认安排不因复测自动挪动
        const current = appts.filter(
          (a) =>
            a.orderId === order.id &&
            a.kind === kind &&
            a.status === "suggested" &&
            a.basedOnEnteredAt === order.enteredAt
        );
        if (current.length) continue; // 已是本次录入的建议位

        appts = appts.map((a) =>
          a.orderId === order.id &&
          a.kind === kind &&
          (a.status === "suggested" || a.status === "invalidated")
            ? {
                ...a,
                status: "cancelled",
                reason:
                  kind === "trial"
                    ? "复测改动，原试戴建议位释放，等待重新排期"
                    : "重新给出复诊时段，原建议位释放",
              }
            : a
        );

        const found = findFreeSlot(
          appts,
          order.customerId,
          order.enteredAt + days * DAY
        );
        if (found) {
          appts.push({
            id: uid("apt"),
            orderId: order.id,
            customerId: order.customerId,
            customerName: order.customerName,
            kind,
            roomId: found.roomId,
            start: found.start,
            durationMin: 30,
            status: "suggested",
            basedOnEnteredAt: order.enteredAt,
            reason:
              kind === "followup" ? sug.followupReason : sug.trialReason,
            createdAt: Date.now(),
          });
        }
      }
      return appts;
    },
    []
  );

  const saveOrder = useCallback(
    (input: SaveOrderInput): { ok: boolean; error?: string } => {
      const s = stateRef.current;
      if (!input.customerId.trim() || !input.customerName.trim())
        return { ok: false, error: "客户编号和姓名必填" };

      const old = input.id ? s.orders.find((o) => o.id === input.id) : undefined;
      const enteredAt = Math.max(
        ...(["L", "R"] as const).map((e) => input.audiogram[e].recordedAt)
      );
      const order: FittingOrder = {
        id: old?.id ?? uid("ord"),
        customerId: input.customerId.trim(),
        customerName: input.customerName.trim(),
        category: input.category,
        deviceModel: input.deviceModel,
        notes: input.notes,
        audiogram: input.audiogram,
        enteredAt,
        rev: old?.rev ?? 0,
        dirty: !s.online,
      };
      const base = old ? s.bases[old.id] ?? clone(old) : null;

      let appts = regenerateSuggestions(s, order);
      const triggers = evaluateTriggers(order.audiogram);
      const log = (
        level: LogEntry["level"],
        text: string,
        at = Date.now()
      ): LogEntry => ({ id: uid("log"), at, level, text });
      const newLogs: LogEntry[] = [];
      newLogs.push(
        log(
          "info",
          s.online
            ? `${order.customerName} 验配单已保存`
            : `断网：${order.customerName} 的${
                old ? "复测改动" : "新验配单"
              }已存本地，网络恢复后合并`
        )
      );
      if (triggers.length) {
        newLogs.push(
          log(
            "warn",
            `${order.customerName} 分频触发复核（${triggers
              .map((t) => t.detail)
              .join("；")}），复核结论回来前试戴不能确认`,
            Date.now() + 1
          )
        );
      }
      for (const a of appts) {
        if (
          a.orderId === order.id &&
          (a.status === "suggested") &&
          a.createdAt > (old?.enteredAt ?? 0)
        ) {
          newLogs.push(
            log(
              "info",
              `${order.customerName} 建议${a.kind === "trial" ? "试戴" : "复诊"}：${new Date(
                a.start
              ).toLocaleString()} / ${a.roomId}`,
              Date.now() + 2
            )
          );
        }
      }

      if (s.online) {
        const entry: OutboxEntry = {
          id: uid("ob"),
          type: "upsertOrder",
          at: Date.now(),
          order: { ...order, dirty: false },
          base,
          baseReviewId: null,
        };
        const res = pushEntry(entry, base);
        const kept = res.adoptRemoteOrder ? clone(res.adoptRemoteOrder) : res.order ?? order;
        appts = reconcileAppointments(
          appts,
          s.reviews,
          [...s.orders.filter((o) => o.id !== order.id), kept]
        );
        saveAppointments(appts);
        setState((cur) => ({
          ...cur,
          orders: [...cur.orders.filter((o) => o.id !== order.id), kept],
          appts,
          conflicts: mergeConflictLists(cur.conflicts, res.conflicts),
          bases: { ...cur.bases, [order.id]: clone(kept) },
          logs: [
            ...(res.adoptRemoteOrder
              ? [
                  log(
                    "warn",
                    `${order.customerName} 保存时服务端版本优先（含复核结论或远端更新），已按服务端展示，见冲突清单`
                  ),
                ]
              : [log("ok", `${order.customerName} 验配单已同步到服务端`)]),
            ...newLogs,
            ...cur.logs,
          ].slice(0, 80),
        }));
        return { ok: true };
      }

      // 断网：本地保存并入队；同订单多次编辑只留最后一条，base 保持首次编辑前版本
      const entry: OutboxEntry = {
        id: uid("ob"),
        type: "upsertOrder",
        at: Date.now(),
        order: { ...order, dirty: true },
        base,
        baseReviewId:
          latestReview(s.reviews, order.id, old?.enteredAt)?.id ?? null,
      };
      setState((cur) => ({
        ...cur,
        orders: [...cur.orders.filter((o) => o.id !== order.id), order],
        appts,
        outbox: [
          ...cur.outbox.filter(
            (e) => !(e.type === "upsertOrder" && e.order.id === order.id)
          ),
          entry,
        ],
        logs: [...newLogs, ...cur.logs].slice(0, 80),
      }));
      return { ok: true };
    },
    [regenerateSuggestions]
  );

  const confirmTrial = useCallback(
    (apptId: string): { ok: boolean; error?: string } => {
      const s = stateRef.current;
      const appt = s.appts.find((a) => a.id === apptId);
      if (!appt) return { ok: false, error: "安排不存在" };
      const order = s.orders.find((o) => o.id === appt.orderId);
      if (!order) return { ok: false, error: "验配单不存在" };
      // 试戴需要过复核门控；复诊只校验状态与依据版本
      const gate =
        appt.kind === "trial"
          ? canConfirmTrial(
              appt,
              order,
              latestReview(s.reviews, order.id, order.enteredAt),
              needsReview(order.audiogram)
            )
          : appt.status === "suggested"
            ? { ok: true as const }
            : { ok: false as const, reason: "当前状态不可确认" };
      if (!gate.ok) return { ok: false, error: gate.reason };
      const clash = checkSlot(s.appts, {
        customerId: appt.customerId,
        roomId: appt.roomId,
        start: appt.start,
        durationMin: appt.durationMin,
        ignoreApptId: appt.id,
      });
      if (clash)
        return {
          ok: false,
          error:
            clash.kind === "customer-busy"
              ? "该客户此时段已另有安排，同一时段只能占一个验配间"
              : "该验配间此时段已被占用，请先改期",
        };

      const newAppts = stateRef.current.appts.map((a) =>
        a.id === apptId
          ? {
              ...a,
              status: "confirmed" as const,
              reason: `已确认${appt.kind === "trial" ? "试戴" : "复诊"}：` + a.reason,
            }
          : a
      );
      if (s.online) saveAppointments(newAppts);
      setState((cur) => ({
        ...cur,
        appts: newAppts,
        logs: [
          mkLog(
            "ok",
            `${appt.customerName}${
              appt.kind === "trial" ? "试戴" : "复诊"
            }已确认：${new Date(appt.start).toLocaleString()} / ${appt.roomId}`
          ),
          ...cur.logs,
        ].slice(0, 80),
      }));
      return { ok: true };
    },
    []
  );

  const reschedule = useCallback(
    (apptId: string, start: number, roomId: string) => {
      const s = stateRef.current;
      const r = rescheduleSlot(s.appts, apptId, start, roomId);
      if (!r.ok) return { ok: false, error: r.error };
      const moved = r.appts.find((a) => a.id === apptId)!;
      if (s.online) saveAppointments(r.appts);
      setState((cur) => ({
        ...cur,
        appts: r.appts,
        logs: [
          mkLog(
            "info",
            `${moved.customerName}${
              moved.kind === "trial" ? "试戴" : "复诊"
            }改期：原时段已释放，新时段 ${new Date(start).toLocaleString()} / ${roomId}`
          ),
          ...cur.logs,
        ].slice(0, 80),
      }));
      return { ok: true };
    },
    []
  );

  const cancelAppt = useCallback((apptId: string) => {
    const s = stateRef.current;
    const a0 = s.appts.find((x) => x.id === apptId);
    if (!a0) return;
    const newAppts = s.appts.map((x) =>
      x.id === apptId
        ? { ...x, status: "cancelled" as const, reason: "人工取消，时段已释放" }
        : x
    );
    if (s.online) saveAppointments(newAppts);
    setState((cur) => {
      return {
        ...cur,
        appts: newAppts,
        logs: [
          mkLog(
            "warn",
            `${a0.customerName}${
              a0.kind === "trial" ? "试戴" : "复诊"
            }已取消，时段释放`
          ),
          ...cur.logs,
        ].slice(0, 80),
      };
    });
  }, []);

  const submitReview = useCallback(
    (orderId: string, verdict: ReviewVerdict, comment: string) => {
      const s = stateRef.current;
      const order = s.orders.find((o) => o.id === orderId);
      if (!order) return { ok: false, error: "验配单不存在" };
      const review: ReviewConclusion = {
        id: uid("rev"),
        orderId,
        orderEnteredAt: order.enteredAt,
        verdict,
        reviewer: "复诊助理 · 当前门店",
        comment,
        triggers: evaluateTriggers(order.audiogram),
        createdAt: Date.now(),
        rev: 1,
        dirty: !s.online,
      };

      setState((cur) => {
        if (cur.online) {
          pushEntry(
            { id: uid("ob"), type: "submitReview", at: Date.now(), review },
            null
          );
        }
        const appts = reconcileAppointments(
          cur.appts,
          [...cur.reviews, review],
          cur.orders
        );
        return {
          ...cur,
          reviews: [...cur.reviews, review],
          outbox: cur.online
            ? cur.outbox
            : [
                ...cur.outbox,
                {
                  id: uid("ob"),
                  type: "submitReview" as const,
                  at: Date.now(),
                  review: { ...review, dirty: true },
                },
              ],
          appts,
          logs: [
            mkLog(
              verdict === "pass" ? "ok" : "warn",
              `${order.customerName} 复核结论：${verdict}${
                comment ? "（" + comment + "）" : ""
              }${cur.online ? "，已同步" : "，断网暂存本地，恢复后合并"}`
            ),
            ...cur.logs,
          ].slice(0, 80),
        };
      });
      return { ok: true };
    },
    []
  );

  /** 网络恢复后：先推送 outbox（三向合并），再拉取服务端并集 */
  const sync = useCallback(async (): Promise<SyncReport> => {
    if (syncingRef.current)
      return { pushed: 0, pulled: 0, conflicts: 0, autoResolved: 0, note: "同步进行中" };
    syncingRef.current = true;
    const s = stateRef.current;
    let pushed = 0;
    let autoResolved = 0;
    let manualConflicts = 0;
    try {
      let orders = [...s.orders];
      let reviews = [...s.reviews];
      let conflicts = [...s.conflicts];

      for (const entry of s.outbox) {
        if (entry.type === "submitReview") {
          const r = pushEntry(entry, null);
          if (r.review) {
            reviews = [...reviews.filter((x) => x.id !== r.review!.id), r.review];
            pushed++;
          }
          continue;
        }
        const base = s.bases[entry.order.id] ?? entry.base;
        const r = pushEntry(entry, base);
        if (r.order) {
          const kept = r.adoptRemoteOrder
            ? clone(r.adoptRemoteOrder)
            : r.order;
          orders = [...orders.filter((o) => o.id !== kept.id), kept];
          for (const c of r.conflicts) {
            if (c.auto) autoResolved++;
            else manualConflicts++;
          }
          conflicts = mergeConflictLists(conflicts, r.conflicts);
        }
        pushed++;
      }

      const remote = fetchAll();
      const remoteIds = new Set(remote.orders.map((o) => o.id));
      const pendingOrderIds = new Set(
        conflicts.filter((c) => c.status === "pending").map((c) => c.orderId)
      );
      // 待人工裁决的订单暂保留本地版本，远端版本挂在冲突项上
      orders = [
        ...orders.filter((o) => !remoteIds.has(o.id) || pendingOrderIds.has(o.id)),
        ...remote.orders.filter((o) => !pendingOrderIds.has(o.id)),
      ];

      const reviewIds = new Set(reviews.map((r) => r.id));
      const newRemoteReviews = remote.reviews.filter((r) => !reviewIds.has(r.id));
      reviews = [...reviews, ...newRemoteReviews];

      const cfIds = new Set(conflicts.map((c) => c.id));
      conflicts = [
        ...conflicts,
        ...remote.conflicts.filter((c) => !cfIds.has(c.id)),
      ].map((c) =>
        c.remoteOrder
          ? c
          : { ...c, remoteOrder: remote.orders.find((o) => o.id === c.orderId) }
      );

      let appts = mergeAppointments(s.appts, remote.appointments);
      appts = reconcileAppointments(appts, reviews, orders);

      const bases: Record<string, FittingOrder> = { ...s.bases };
      for (const o of remote.orders) bases[o.id] = clone(o);

      const logs: LogEntry[] = [];
      for (const rv of newRemoteReviews) {
        const o = orders.find((x) => x.id === rv.orderId);
        logs.push(
          mkLog(
            rv.verdict === "pass" ? "ok" : "warn",
            `${o?.customerName ?? rv.orderId} 复诊助理复核结论已同步：${
              rv.verdict
            }${rv.comment ? "（" + rv.comment + "）" : ""}`,
            rv.createdAt
          )
        );
      }

      const report: SyncReport = {
        pushed,
        pulled: remote.orders.length + remote.reviews.length,
        conflicts: manualConflicts,
        autoResolved,
      };
      setState((cur) => ({
        ...cur,
        orders,
        reviews,
        appts,
        conflicts,
        outbox: [],
        bases,
        logs: [...logs, ...cur.logs].slice(0, 80),
      }));
      saveAppointments(appts);
      setLastSyncAt(Date.now());
      setLastSyncReport(report);
      return report;
    } finally {
      syncingRef.current = false;
    }
  }, []);

  const setOnline = useCallback(
    async (v: boolean): Promise<SyncReport | null> => {
      if (!v) {
        setState((cur) => ({ ...cur, online: false }));
        pushLog("warn", "网络已断开：变更先存本地，进入待合并队列");
        return null;
      }
      setState((cur) => ({ ...cur, online: true }));
      pushLog("ok", "网络已恢复，开始合并本地队列…");
      const report = await sync();
      pushLog(
        report.conflicts
          ? "warn"
          : "ok",
        `合并完成：上送 ${report.pushed} 项，拉取 ${report.pulled} 项` +
          (report.autoResolved
            ? `，复核优先自动裁决 ${report.autoResolved} 处`
            : "") +
          (report.conflicts ? `，待人工裁决冲突 ${report.conflicts} 处` : "")
      );
      return report;
    },
    [pushLog, sync]
  );

  const remoteEditDemo = useCallback(
    (p: {
      orderId: string;
      ear: "L" | "R";
      freq: 250 | 500 | 1000 | 2000 | 4000 | 8000;
      air?: number;
      bone?: number;
    }) => {
      if (!stateRef.current.online) {
        pushLog("warn", "当前离线，他端变更演示需要先联网");
        return;
      }
      simulateRemoteEdit(p.orderId, p.ear, p.freq, p.air, p.bone);
      pushLog("info", "已模拟门店另一终端写入服务端复测结果，点击“立即拉取合并”查看冲突");
    },
    [pushLog]
  );

  const remoteReviewDemo = useCallback(
    (orderId: string, verdict: ReviewVerdict, comment: string) => {
      if (!stateRef.current.online) {
        pushLog("warn", "当前离线，他端复核演示需要先联网");
        return;
      }
      simulateRemoteReview(orderId, verdict, comment, "复诊助理 · 孙敏（他端）");
      pushLog("ok", "已模拟复诊助理在另一终端回复核结论，点击“立即拉取合并”解锁试戴");
    },
    [pushLog]
  );

  const resolveConflict = useCallback(
    (conflictId: string, pick: "local" | "remote") => {
      const s = stateRef.current;
      const c = s.conflicts.find((x) => x.id === conflictId);
      if (!c || c.status !== "pending") return { ok: false };
      const resolution = pick === "local" ? "resolved-local" : "resolved-remote";
      if (s.online)
        resolveConflictOnServer(conflictId, resolution, c.localOrder);
      setState((cur) => {
        let orders = cur.orders;
        if (pick === "remote" && c.remoteOrder) {
          orders = [
            ...orders.filter((o) => o.id !== c.remoteOrder!.id),
            c.remoteOrder!,
          ];
        } else if (pick === "local" && c.localOrder) {
          orders = [
            ...orders.filter((o) => o.id !== c.localOrder!.id),
            { ...c.localOrder, dirty: !cur.online },
          ];
        }
        return {
          ...cur,
          orders,
          conflicts: cur.conflicts.map((x) =>
            x.id === conflictId ? { ...x, status: resolution } : x
          ),
          logs: [
            mkLog(
              "ok",
              `冲突已裁决（${c.customerName} · ${
                c.ear === "both" ? "双耳" : c.ear === "L" ? "左耳" : "右耳"
              }）：保留${pick === "local" ? "本地" : "服务端"}录入`
            ),
            ...cur.logs,
          ].slice(0, 80),
        };
      });
      return { ok: true };
    },
    []
  );

  const resetAll = useCallback(() => {
    resetServer();
    localStorage.removeItem(CLIENT_KEY);
    setState(freshClient());
    setLastSyncAt(null);
    setLastSyncReport(null);
  }, []);

  const helpers = useMemo<StoreHelpers>(
    () => ({
      reviewFor: (order) => {
        const s = stateRef.current;
        return latestReview(s.reviews, order.id, order.enteredAt);
      },
      triggersFor: (order) => evaluateTriggers(order.audiogram),
      gateFor: (appt) => {
        const s = stateRef.current;
        const order = s.orders.find((o) => o.id === appt.orderId);
        if (!order) return { ok: false, reason: "验配单不存在" };
        return canConfirmTrial(
          appt,
          order,
          latestReview(s.reviews, order.id, order.enteredAt),
          needsReview(order.audiogram)
        );
      },
      pta: (order, ear) => earPta(order.audiogram[ear]),
      grade: (order, ear) => lossGrade(earPta(order.audiogram[ear])),
      apptsForOrder: (orderId) =>
        stateRef.current.appts
          .filter((a) => a.orderId === orderId)
          .sort((a, b) => a.start - b.start),
    }),
    []
  );

  const value: StoreValue = {
    ...state,
    lastSyncAt,
    lastSyncReport,
    setOnline,
    sync,
    saveOrder,
    confirmTrial,
    reschedule,
    cancelAppt,
    submitReview,
    remoteEditDemo,
    remoteReviewDemo,
    resolveConflict,
    resetAll,
    helpers,
  };

  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore 必须在 StoreProvider 内使用");
  return ctx;
}

function mergeConflictLists(
  a: ConflictEntry[],
  b: ConflictEntry[]
): ConflictEntry[] {
  const map = new Map(a.map((c) => [c.id, c]));
  for (const c of b) {
    const dup = [...map.values()].find(
      (x) =>
        x.orderId === c.orderId &&
        x.ear === c.ear &&
        x.localEnteredAt === c.localEnteredAt &&
        x.remoteEnteredAt === c.remoteEnteredAt
    );
    if (!dup) map.set(c.id, c);
  }
  return [...map.values()];
}
