# hxwl-01 听力验配台

门店听力师的**可排期**验配工作台：验配单保存左右耳分频结果，自动给出复诊/试戴时段，并处理复测失效、复核门控、断网合并。

## 技术栈

React 19 + Vite + TypeScript + CSS（纯前端演示；用 localStorage 双库模拟“本地 / 服务端”，无需后端）

## 本地运行

```bash
npm install
npm run dev          # http://localhost:5101
npm test:smoke       # 领域规则冒烟测试（27 项断言）
npm run build        # tsc 类型检查 + 生产构建
```

## 业务规则落地

| 需求 | 实现位置 |
| --- | --- |
| 每份验配单保存左右耳分频（气导/骨导 × 250–8kHz） | `src/domain/types.ts`、`OrderForm.tsx` |
| 据分频结果给出下次复诊、试戴时段（PTA/分级/类别决定天数，自动找空闲验配间） | `domain/audiology.ts: suggestSchedule`、`domain/scheduling.ts: findFreeSlot` |
| 同一客户同一时段只能占一个验配间（同房间同时段也互斥） | `domain/scheduling.ts: checkSlot` |
| 改期先释放原时段，再占新时段，冲突则拒绝 | `domain/scheduling.ts: reschedule` |
| 复测改动后，未确认的助听器试戴安排失效并重排；已确认的不动 | `invalidateStaleTrials` + `regenerateSuggestions` |
| 两耳分频差 ≥25dB 或任一频率气骨导差 ≥10dB，先交复诊助理复核 | `audiology.ts: evaluateTriggers`（阈值常量可改） |
| 复核结论没回来（或结论针对旧复测 / 未通过）前试戴不能确认 | `scheduling.ts: canConfirmTrial` |
| 断网先存本地（实时落盘 + outbox），恢复后合并 | `store/store.tsx` |
| 合并时复核结论优先（远端版本持匹配结论 → 自动保留服务端） | `domain/merge.ts: mergeOrder` |
| 冲突清单给出客户、耳别、两次录入时间，可人工选择保留版本 | `ConflictPanel.tsx`、`store/fakeServer.ts` |

## 推荐演示路径

1. 打开页面默认是**断网模式**。在「验配单」给某位客户点 **复测/编辑**，改几个分频值保存 → 旧的未确认试戴变「已失效」，系统重新给出复诊/试戴时段。
2. 点「模拟断网」旁的 **恢复网络并合并** → outbox 清空、数据同步。
3. 切到 **复核台**：陈雪（两耳不一致 + 气骨导差超阈）的试戴在排期台上显示「⛔ 等待复诊助理复核结论」；回复“通过”后回排期台即可确认；回复 adjust/reject 则试戴失效。
4. **断网合并冲突**：联网状态下在客户卡片上点「他端改右耳4k气导」→ 点「立即拉取合并」（此时本地未改，只拉到新版本）；再断网→本地改同一耳保存→联网前先让他端再改一次（或直接恢复网络让两端时间对撞）→ 冲突清单出现含**客户/耳别/两次录入时间**的条目；若他端版本已带复核结论则自动按结论优先裁决。
5. 排期台任意安排点「改期」：原时段立刻释放，下拉中的候选只含客户与验配间都空闲的时段。

## 目录

```
src/domain/   types / audiology(分频规则) / scheduling(排期门控) / merge(三向合并) / seed
src/store/    fakeServer(localStorage 服务端) / store.tsx(Context + outbox 编排)
src/components/ 排期台 / 验配单 / 复核台 / 冲突清单 / 录入弹窗
scripts/smoke.ts 纯逻辑断言
```
