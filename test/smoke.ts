import {
  pushRecordToServer,
  pushReviewToServer,
  loadServer,
  saveServer,
  mergeServer,
  sameEar,
  settleClashes,
} from "../src/sync";
import { evaluate, recordSignature, customerSlotTaken, roomSlotTaken } from "../src/domain";
import { seedRecords, seedDerived, ROOMS } from "../src/seed";
import { FittingRecord, ServerSnapshot, Review } from "../src/types";

const TH = { airBoneGap: 10, ptaGap: 15, perFreqGap: 20 };
let passed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
  console.log("  ✓", msg);
}

const nameOf = (id: string) => id;

// ---------- 1. 规则：气骨导差 / 两耳不一致 ----------
const records = seedRecords();
const liu = records.find((r) => r.id === "rec-liu")!;
const chen = records.find((r) => r.id === "rec-chen")!;
const liuEv = evaluate(liu, TH);
const chenEv = evaluate(chen, TH);
assert(!liuEv.needsReview, "刘女士双耳对称，无需复核");
assert(chenEv.needsReview, "陈先生左耳气骨导差+两耳不一致，需复核");
assert(chenEv.reasons.includes("气骨导差超阈值"), "命中气骨导差阈值原因");
assert(chenEv.reasons.includes("两耳参数不一致"), "命中两耳参数不一致原因");
assert(chenEv.followUpDays === 3, "命中复核规则时复诊间隔为 3 天");

// 签名随数据变化
const sigBefore = recordSignature(chen);
const chenChanged: FittingRecord = structuredClone(chen);
chenChanged.left.audiogram.air[4] = "65";
assert(recordSignature(chenChanged) !== sigBefore, "复测改动后签名变化");

// ---------- 2. 排期约束 ----------
const derived = seedDerived(records, TH);
const allBookings = derived.bookings;
assert(
  !!customerSlotTaken(allBookings, "Chen-118", allBookings.find((b) => b.customerId === "Chen-118")!.slot),
  "能检出同一客户同时段占用"
);
assert(
  !customerSlotTaken(allBookings, "Chen-118", "2099-01-01T09"),
  "空闲时段不拦截"
);

// 撞单裁决：同房间同时段，confirmed 优先于 proposed
const clashSet = settleClashes([
  ...allBookings,
  {
    ...allBookings[0],
    id: "bk-clash",
    customerId: "Liu-024",
    roomId: allBookings[0].roomId,
    slot: allBookings[0].slot,
    status: "proposed",
  },
]);
const clashLoser = clashSet.find((b) => b.id === "bk-clash");
assert(clashLoser?.status === "released", "同步撞单时弱势单自动释放");
assert(allBookings[0].status === "confirmed", "原已确认单保留");

// ---------- 3. 断网→双端改动→合并冲突 ----------
localStorage.clear();
const base: ServerSnapshot = {
  records: structuredClone(records),
  reviews: structuredClone(derived.reviews),
  bookings: structuredClone(derived.bookings),
  serverTime: new Date().toISOString(),
};
saveServer(base);

// 本机断网期间改陈先生左耳 4k
const localChen: FittingRecord = structuredClone(chen);
localChen.left.audiogram.air[4] = "60";
localChen.left.recordedAt = "2026-10-06T09:00:00.000Z";
localChen.updatedAt = "2026-10-06T09:00:00.000Z";

// 另一终端把同一耳 4k 改成 70 并直接写服务端
const server1 = loadServer();
const sChen = server1.records.find((r) => r.id === "rec-chen")!;
sChen.left.audiogram.air[4] = "70";
sChen.left.recordedAt = "2026-10-06T10:30:00.000Z";
sChen.updatedAt = "2026-10-06T10:30:00.000Z";
saveServer(server1);

// 本机恢复后推送：服务端保留己版并产生冲突
const server2 = loadServer();
const { conflicts: pushConflicts } = pushRecordToServer(server2, localChen, base);
assert(pushConflicts.length === 1, "推送检出 1 条耳级冲突");
assert(pushConflicts[0].ear === "left", "冲突耳别为左耳");
assert(pushConflicts[0].remoteRecordedAt === "2026-10-06T10:30:00.000Z", "冲突记录服务端录入时间");
assert(pushConflicts[0].localRecordedAt === "2026-10-06T09:00:00.000Z", "冲突记录本机录入时间");
assert(
  server2.records.find((r) => r.id === "rec-chen")!.left.audiogram.air[4] === "70",
  "推送冲突时服务端保留自己的版本"
);

// 拉取合并：本地版暂存、冲突清单含客户/耳别/两次时间
const merged = mergeServer(
  [localChen, liu, records.find((r) => r.id === "rec-zhao")!],
  derived.reviews,
  derived.bookings,
  server2,
  base,
  TH,
  nameOf
);
assert(merged.conflicts.length === 1, "合并后冲突清单 1 条");
assert(merged.conflicts[0].customerId === "Chen-118", "冲突清单给出客户");
assert(
  merged.conflicts[0].localEar.audiogram.air[4] === "60" &&
    merged.conflicts[0].remoteEar.audiogram.air[4] === "70",
  "冲突清单保留两次录入的数据"
);

// 右耳未被双端修改时无冲突
const untouchedEarConflict = merged.conflicts.some((c) => c.ear === "right");
assert(!untouchedEarConflict, "右耳仅单端改动，不产生冲突");

// ---------- 4. 复核结论优先 ----------
const localReview: Review = structuredClone(derived.reviews.find((r) => r.recordId === "rec-chen")!);
localReview.status = "approved";
localReview.conclusion = "本机先行给出的通过结论";
// 服务端已有不同结论
const server3 = loadServer();
const srvRv = server3.reviews.find((r) => r.recordId === "rec-chen")!;
srvRv.status = "returned";
srvRv.conclusion = "服务端复核：请重新复测气导";
saveServer(server3);

const res = pushReviewToServer(loadServer(), localReview);
assert(res === "kept", "推送复核结论时不覆盖服务端已有结论（复核结论优先）");
const merged2 = mergeServer(
  merged.records,
  [localReview],
  merged.bookings,
  loadServer(),
  base,
  TH,
  nameOf
);
const finalRv = merged2.reviews.find((r) => r.recordId === "rec-chen")!;
assert(finalRv.status === "returned", "合并后以服务端复核结论为准（退回）");
assert(merged2.logs.some((l) => l.message.includes("复核结论优先")), "合并日志声明复核结论优先");

// ---------- 5. sameEar 忽略录入时间戳 ----------
const a = localChen.left;
const b = structuredClone(a);
b.recordedAt = "2030-01-01T00:00:00.000Z";
assert(sameEar(a, b), "结构相同但时间戳不同不视为数据冲突");

console.log(`\n全部通过：${passed} 项断言`);
