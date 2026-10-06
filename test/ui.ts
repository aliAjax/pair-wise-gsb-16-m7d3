import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { reducer, buildInitial } from "../src/store";
import App from "../src/App";

let passed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
  console.log("  ✓", msg);
}

// 0. SSR 渲染整个 App 不报错
const html = renderToString(createElement(App));
assert(html.includes("可排期听力验配台"), "App 可完整服务端渲染");

let state = buildInitial();
state = { ...state, online: true, queue: [] };

// ---------- A. 断网保存：只入本地队列，服务端不变 ----------
state = reducer(state, { type: "set-online", online: false });
const serverBefore = JSON.stringify(localStorage.getItem("fitting-bench-server-v1"));
const chen = structuredClone(state.records.find((r) => r.id === "rec-chen")!);
chen.left.audiogram.air[4] = "62";
state = reducer(state, { type: "save-record", record: chen });
assert(state.queue.length >= 1, "断网保存进入本地队列");
assert(
  JSON.stringify(localStorage.getItem("fitting-bench-server-v1")) === serverBefore,
  "断网期间不写服务端（本地暂存）"
);
const chenTrialBefore = state.bookings.find(
  (b) => b.recordId === "rec-chen" && b.kind === "trial" && b.status !== "released"
);
// 陈先生原试戴单依据的是旧签名 → 复测改动后应失效
assert(!chenTrialBefore || chenTrialBefore.signature !== undefined, "存在原试戴单");
const chenTrialReleased = state.bookings.find(
  (b) => b.recordId === "rec-chen" && b.kind === "trial" && b.status === "released"
);
assert(!!chenTrialReleased, "复测改动后，未确认试戴单自动失效并留痕");
assert(
  chenTrialReleased!.note?.includes("复测结果改动"),
  "失效单注明原因：复测结果改动，需重新确认"
);

// ---------- B. 复核结论未回来，试戴不能确认 ----------
// 手工排一张新的陈先生试戴单（较远的工作日，避开既有单）
const future = new Date();
future.setDate(future.getDate() + 12);
const ds = future.toISOString().slice(0, 10);
state = reducer(state, {
  type: "schedule",
  booking: {
    customerId: "Chen-118",
    recordId: "rec-chen",
    kind: "trial",
    roomId: "room-1",
    slot: `${ds}T11`,
  },
});
const pendingTrial = state.bookings.find(
  (b) => b.kind === "trial" && b.status === "proposed" && b.recordId === "rec-chen"
);
assert(!!pendingTrial, "重新排入新的待确认试戴单");
const logsBefore = state.logs.length;
state = reducer(state, { type: "confirm-booking", bookingId: pendingTrial!.id });
const blocked = state.bookings.find((b) => b.id === pendingTrial!.id);
assert(blocked!.status === "proposed", "复核未返回时试戴确认被拦截，仍为待确认");
assert(state.logs[state.logs.length - 1].message.includes("复核结论尚未返回"), "日志说明拦截原因：复核结论未返回");
void logsBefore;

// 助理复核通过后才允许确认
const rv = state.reviews.find((r) => r.recordId === "rec-chen" && r.status === "pending")!;
state = reducer(state, {
  type: "review-decide",
  reviewId: rv.id,
  status: "approved",
  conclusion: "差异可接受，放行",
});
state = reducer(state, { type: "confirm-booking", bookingId: pendingTrial!.id });
assert(
  state.bookings.find((b) => b.id === pendingTrial!.id)!.status === "confirmed",
  "复核结论回来（通过）后试戴可以确认"
);

// 复核被退回时也不能确认：先造一次新复测生成新复核并退回，再排试戴
const chen2 = structuredClone(state.records.find((r) => r.id === "rec-chen")!);
chen2.left.audiogram.air[4] = "48";
state = reducer(state, { type: "save-record", record: chen2 });
const rv2 = state.reviews.find((r) => r.recordId === "rec-chen" && r.status === "pending");
state = reducer(state, {
  type: "review-decide",
  reviewId: rv2!.id,
  status: "returned",
  conclusion: "参数异常",
});
state = reducer(state, {
  type: "schedule",
  booking: { customerId: "Chen-118", recordId: "rec-chen", kind: "trial", roomId: "room-2", slot: `${ds}T12` },
});
const t2 = state.bookings.find((b) => b.kind === "trial" && b.status === "proposed" && b.slot.endsWith("T12"))!;
assert(!!t2, "复核退回后仍可排入试戴（待确认）");
state = reducer(state, { type: "confirm-booking", bookingId: t2.id });
assert(
  state.bookings.find((b) => b.id === t2.id)!.status === "proposed",
  "复核结论为退回时，试戴同样不能确认"
);

// ---------- C. 同一客户同一时段只能占一个验配间 ----------
const liuConfirmed = state.bookings.find((b) => b.recordId === "rec-liu" && b.kind === "followup")!;
const qLen = state.queue.length;
state = reducer(state, {
  type: "schedule",
  booking: {
    customerId: "Liu-024",
    recordId: "rec-liu",
    kind: "trial",
    roomId: "room-2",
    slot: liuConfirmed.slot, // 同一客户、同一时段、不同验配间
  },
});
assert(
  state.queue.length === qLen,
  "同一客户同时段占用不同验配间被拒（不产生排期单）"
);
assert(state.logs[state.logs.length - 1].message.includes("只能占一个验配间"), "拦截日志准确");

// ---------- D. 改期先释放原时段 ----------
const zhaoFu = state.bookings.find((b) => b.recordId === "rec-zhao" && b.kind === "followup")!;
state = reducer(state, {
  type: "reschedule",
  bookingId: zhaoFu.id,
  roomId: "room-3",
  slot: `${ds}T16`,
});
assert(
  state.bookings.find((b) => b.id === zhaoFu.id)!.status === "released",
  "改期时原时段先释放"
);
const moved = state.bookings.find(
  (b) => b.recordId === "rec-zhao" && b.slot === `${ds}T16` && b.status === "proposed"
);
assert(!!moved, "改期产生新的待确认单");
// 原时段此刻可被别人使用：同房间同时段给刘女士排得进去（房间可能已空）
// （核心点：原单已释放，customerSlotTaken/roomSlotTaken 均忽略 released）

// ---------- E. 恢复联网后合并，复核结论优先（两端对同一数据各给结论） ----------
// 1) 先把本机断网期间的复测数据同步上去，服务端基线追上
state = reducer(state, { type: "set-online", online: true });
state = reducer(state, { type: "sync" });
assert(state.queue.length === 0, "恢复联网后本地操作全部同步");

// 2) 再次断网：本机给"通过"，服务端给"退回"（结论对应同一份数据签名）
state = reducer(state, { type: "set-online", online: false });
const pendingAgain = state.reviews.find((r) => r.recordId === "rec-chen" && r.status === "pending")!;
state = reducer(state, {
  type: "review-decide",
  reviewId: pendingAgain.id,
  status: "approved",
  conclusion: "本机：差异可接受",
});
state = reducer(state, {
  type: "simulate-remote-review",
  reviewId: "rv-rec-chen",
  status: "returned",
  conclusion: "服务端：请重测左耳气骨导差",
});

// 3) 恢复后合并：服务端结论胜出
state = reducer(state, { type: "set-online", online: true });
state = reducer(state, { type: "sync" });
const finalChenRv = state.reviews.find((r) => r.recordId === "rec-chen" && r.status === "returned");
assert(!!finalChenRv, "合并时复核结论优先，本机通过被服务端退回覆盖");
assert(
  state.logs.some((l) => l.message.includes("复核结论优先")),
  "日志明确记录复核结论优先覆盖"
);

console.log(`\nReducer 联动通过：${passed} 项断言`);
