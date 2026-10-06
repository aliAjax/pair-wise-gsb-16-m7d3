// 纯逻辑冒烟：分频规则 / 排期门控 / 断网合并（复核优先）
import { assert } from "console";
import {
  abGapExceedances,
  binauralDiffExceedances,
  earPta,
  evaluateTriggers,
  needsReview,
  suggestSchedule,
} from "../src/domain/audiology";
import {
  canConfirmTrial,
  checkSlot,
  invalidateStaleTrials,
  reschedule,
  ROOMS,
} from "../src/domain/scheduling";
import { mergeOrder } from "../src/domain/merge";
import {
  Appointment,
  Audiogram,
  EarAudiogram,
  FittingOrder,
} from "../src/domain/types";

let passed = 0;
function ok(name: string, cond: boolean) {
  assert(cond, "FAIL: " + name);
  passed++;
  console.log("✓", name);
}

function mkEar(ear: "L" | "R", air: Record<number, number>, bone: Record<number, number>, at: number): EarAudiogram {
  return { ear, air: air as EarAudiogram["air"], bone: bone as EarAudiogram["bone"], recordedAt: at };
}
function mkOrder(id: string, ag: Audiogram, enteredAt: number, rev = 1): FittingOrder {
  return {
    id,
    customerId: id,
    customerName: id,
    category: "初配",
    deviceModel: "X",
    notes: "",
    audiogram: ag,
    enteredAt,
    rev,
    dirty: false,
  };
}

// 1. 分频：PTA、气骨导差、两耳差
const normalL = mkEar("L", { 500: 20, 1000: 25, 2000: 30, 4000: 35 }, { 500: 18, 1000: 23, 2000: 28, 4000: 33 }, 1000);
const conductiveR = mkEar("R", { 250: 55, 500: 58, 1000: 55, 2000: 45, 4000: 40 }, { 250: 20, 500: 22, 1000: 25, 2000: 30, 4000: 35 }, 2000);
const ag: Audiogram = { L: normalL, R: conductiveR };

ok("左耳 PTA=27.5 四舍五入 28", earPta(normalL) === 28);
const gaps = abGapExceedances(conductiveR);
ok("右耳气骨导差超阈频率非空且峰值≥33dB", gaps.length > 0 && gaps[0].gap >= 30);
const diffs = binauralDiffExceedances(ag);
ok("两耳同频差超阈", diffs.some((d) => d.diff >= 25));
ok("evaluateTriggers 命中两类规则", evaluateTriggers(ag).length === 2);
ok("needsReview=true", needsReview(ag));
const sug = suggestSchedule(ag, "初配");
ok("触发复核时复诊≤5天且需复核", sug.reviewRequired && sug.followupDays <= 5);

// 2. 排期：同一客户同一时段只能占一个验配间
const t0 = new Date();
t0.setHours(10, 0, 0, 0);
const baseAppt: Appointment = {
  id: "a1",
  orderId: "o1",
  customerId: "C1",
  customerName: "客户1",
  kind: "trial",
  roomId: ROOMS[0].id,
  start: t0.getTime(),
  durationMin: 30,
  status: "suggested",
  basedOnEnteredAt: 1000,
  reason: "",
  createdAt: 1,
};
ok("同客户换房间同时段被拦", checkSlot([baseAppt], { customerId: "C1", roomId: ROOMS[1].id, start: t0.getTime(), durationMin: 30 })?.kind === "customer-busy");
ok("同房间同时段另一客户被拦", checkSlot([baseAppt], { customerId: "C2", roomId: ROOMS[0].id, start: t0.getTime(), durationMin: 30 })?.kind === "room-busy");
ok("不同时段可排", checkSlot([baseAppt], { customerId: "C2", roomId: ROOMS[0].id, start: t0.getTime() + 3600000, durationMin: 30 }) === null);

// 3. 改期：原时段先释放（新时段冲突时返回失败且不破坏数据）
const occupied: Appointment[] = [
  baseAppt,
  { ...baseAppt, id: "a2", customerId: "C2", customerName: "客户2", roomId: ROOMS[1].id, createdAt: 2 },
];
const bad = reschedule(occupied, "a1", t0.getTime(), ROOMS[1].id);
ok("改期到被占时段失败", bad.ok === false);

const good = reschedule(occupied, "a1", t0.getTime() + 7200000, ROOMS[1].id);
ok("改期成功", good.ok === true);
if (good.ok) {
  const old = good.appts.find((a) => a.id === "a1")!;
  ok("改期后占用新时间", old.start === t0.getTime() + 7200000);
  ok("改期释放后原房间原时段空闲", checkSlot(good.appts, { customerId: "CX", roomId: ROOMS[0].id, start: t0.getTime(), durationMin: 30 }) === null);
}

// 4. 复测改动：未确认试戴失效；已确认的不动
const oldEntered = 1000;
const newOrder = mkOrder("o1", ag, 5000);
const before: Appointment[] = [
  { ...baseAppt, id: "t1", status: "suggested", basedOnEnteredAt: oldEntered },
  { ...baseAppt, id: "t2", status: "confirmed", basedOnEnteredAt: oldEntered, roomId: ROOMS[1].id },
  { ...baseAppt, id: "f1", kind: "followup", status: "suggested", basedOnEnteredAt: oldEntered, roomId: ROOMS[2].id },
];
const after = invalidateStaleTrials(before, newOrder);
ok("未确认试戴失效", after.find((a) => a.id === "t1")!.status === "invalidated");
ok("已确认试戴保留", after.find((a) => a.id === "t2")!.status === "confirmed");
ok("复诊建议不被动", after.find((a) => a.id === "f1")!.status === "suggested");

// 5. 门控：复核结论没回来不能确认；旧结论不算数；非通过不放行
const trialSuggested: Appointment = { ...baseAppt, basedOnEnteredAt: newOrder.enteredAt };
ok("无复核结论 → 不能确认", canConfirmTrial(trialSuggested, newOrder, undefined, true).ok === false);
const reviewPass = {
  id: "rv1", orderId: "o1", orderEnteredAt: newOrder.enteredAt, verdict: "pass" as const,
  reviewer: "r", comment: "", triggers: [], createdAt: 9, rev: 1, dirty: false,
};
ok("匹配的通过结论 → 可确认", canConfirmTrial(trialSuggested, newOrder, reviewPass, true).ok === true);
const staleReview = { ...reviewPass, orderEnteredAt: oldEntered };
ok("旧结论（复测后）→ 不能确认", canConfirmTrial(trialSuggested, newOrder, staleReview, true).ok === false);
const rejectReview = { ...reviewPass, verdict: "reject" as const };
ok("reject 结论 → 不能确认", canConfirmTrial(trialSuggested, newOrder, rejectReview, true).ok === false);
ok("无需复核 → 直接可确认", canConfirmTrial(trialSuggested, newOrder, undefined, false).ok === true);

// 6. 断网合并：两端都改 → 冲突含耳别与两次录入时间；远端持复核结论时结论优先自动裁决
const sameAg: Audiogram = {
  L: mkEar("L", { 500: 30 }, {}, 100),
  R: mkEar("R", { 500: 30 }, {}, 100),
};
const baseOrder = mkOrder("o9", sameAg, 100, 3);
const localOrder = mkOrder(
  "o9",
  { L: mkEar("L", { 500: 45 }, {}, 200), R: mkEar("R", { 500: 30 }, {}, 100) },
  200,
  3
);
const remoteOrder = mkOrder(
  "o9",
  { L: mkEar("L", { 500: 40 }, {}, 300), R: mkEar("R", { 500: 30 }, {}, 100) },
  300,
  4
);
const m1 = mergeOrder(localOrder, baseOrder, remoteOrder, [], 999);
ok("双端改动产生左耳冲突", m1.conflicts.length === 1 && m1.conflicts[0].ear === "L");
ok("冲突含两次录入时间", m1.conflicts[0].localEnteredAt === 200 && m1.conflicts[0].remoteEnteredAt === 300);
ok("无复核结论且远端较新 → 待人工裁决", m1.conflicts[0].status === "pending");
ok("远端较新 → 采用远端", m1.winner.enteredAt === 300 && m1.adoptRemote === true);

const reviewedRemote = {
  ...remoteOrder,
};
const remoteReview = {
  id: "rvx", orderId: "o9", orderEnteredAt: 300, verdict: "pass" as const,
  reviewer: "助理", comment: "结论优先测试", triggers: [], createdAt: 350, rev: 1, dirty: false,
};
const m2 = mergeOrder(localOrder, baseOrder, reviewedRemote, [remoteReview], 999);
ok("远端持复核结论 → 自动保留服务端", m2.conflicts[0].auto === true && m2.conflicts[0].status === "resolved-remote");
ok("自动裁决采用远端版本", m2.adoptRemote === true);

console.log(`\n全部 ${passed} 项断言通过`);
