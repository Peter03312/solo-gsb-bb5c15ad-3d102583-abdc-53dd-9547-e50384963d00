'use strict';

// 循环排演推进纯函数单元测试：
// 段内前进、段尾跳回本段起点/跳下段、多轮批量代数推算（不逐轮循环）、
// 多段依次穿过、全部完成停在末段终点、暂停/改速所需的断点固化、
// 超载边界（段内/开边界在段首/闭端点/段尾跳跃不经过的时间不拦截）、
// 已 finished 不再推进。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Program = require('../public/program.js');

const { advanceProgram } = Program;

function run(input, segments, dt, findTrip) {
  return advanceProgram(input, segments, input.time + dt, findTrip);
}

test('单段重复：段内线性前进，未到段尾不跳', () => {
  const segs = [{ start: 2, end: 5, repeat: 3 }];
  let r = run({ segIndex: 0, iteration: 0, time: 2, finished: false }, segs, 1.5);
  assert.deepEqual(r, { segIndex: 0, iteration: 0, time: 3.5, finished: false, boundary: null });
});

test('单段重复：抵达段尾立即跳回本段起点并进入下一轮', () => {
  const segs = [{ start: 2, end: 5, repeat: 3 }];
  // 恰好走完一轮（3 秒）：回到段首，轮次 1
  let r = run({ segIndex: 0, iteration: 0, time: 2, finished: false }, segs, 3);
  assert.deepEqual(r, { segIndex: 0, iteration: 1, time: 2, finished: false, boundary: null });

  // 一轮多 1 秒：段首 + 1
  r = run({ segIndex: 0, iteration: 0, time: 2, finished: false }, segs, 4);
  assert.deepEqual(r, { segIndex: 0, iteration: 1, time: 3, finished: false, boundary: null });

  // 两轮半
  r = run({ segIndex: 0, iteration: 0, time: 2, finished: false }, segs, 7.5);
  assert.deepEqual(r, { segIndex: 0, iteration: 2, time: 3.5, finished: false, boundary: null });

  // 两轮多，第三轮不足
  r = run({ segIndex: 0, iteration: 1, time: 2, finished: false }, segs, 4);
  assert.deepEqual(r, { segIndex: 0, iteration: 2, time: 3, finished: false, boundary: null });
});

test('单段重复：全部轮次完成停在段尾（末段终点）', () => {
  const segs = [{ start: 2, end: 5, repeat: 3 }];
  // 恰好 9 秒：3 轮走完
  let r = run({ segIndex: 0, iteration: 0, time: 2, finished: false }, segs, 9);
  assert.deepEqual(r, { segIndex: 0, iteration: 2, time: 5, finished: true, boundary: null });

  // 超过 9 秒也停在 5
  r = run({ segIndex: 0, iteration: 0, time: 2, finished: false }, segs, 100);
  assert.deepEqual(r, { segIndex: 0, iteration: 2, time: 5, finished: true, boundary: null });

  // 从第 3 轮起点走完
  r = run({ segIndex: 0, iteration: 2, time: 2, finished: false }, segs, 3);
  assert.deepEqual(r, { segIndex: 0, iteration: 2, time: 5, finished: true, boundary: null });

  // 从第 3 轮中段走完
  r = run({ segIndex: 0, iteration: 2, time: 4, finished: false }, segs, 1.5);
  assert.deepEqual(r, { segIndex: 0, iteration: 2, time: 5, finished: true, boundary: null });
});

test('多段：段尾跳到下段起点（瞬时），依次穿过，全部完成停在末段终点', () => {
  const segs = [
    { start: 0, end: 2, repeat: 1 },
    { start: 8, end: 9, repeat: 2 },
    { start: 3, end: 5, repeat: 1 },
  ];
  // 第一段 2 秒走完 -> 跳到第二段起点 8
  let r = run({ segIndex: 0, iteration: 0, time: 0, finished: false }, segs, 2);
  assert.deepEqual(r, { segIndex: 1, iteration: 0, time: 8, finished: false, boundary: null });

  // 第一段 + 第二轮第一段 + 进入第二轮
  r = run({ segIndex: 0, iteration: 0, time: 0, finished: false }, segs, 2 + 1 + 0.25);
  assert.deepEqual(r, { segIndex: 1, iteration: 1, time: 8.25, finished: false, boundary: null });

  // 全部：2 + 1*2 + 2 = 6 秒墙钟，停在末段终点 5
  r = run({ segIndex: 0, iteration: 0, time: 0, finished: false }, segs, 6);
  assert.deepEqual(r, { segIndex: 2, iteration: 0, time: 5, finished: true, boundary: null });

  // 超额完成仍停在末段终点
  r = run({ segIndex: 0, iteration: 0, time: 0, finished: false }, segs, 50);
  assert.deepEqual(r, { segIndex: 2, iteration: 0, time: 5, finished: true, boundary: null });
});

test('从某轮中段出发：先到本段段尾，再批量穿过多轮/多段', () => {
  const segs = [
    { start: 0, end: 10, repeat: 2 },
    { start: 10, end: 12, repeat: 1 },
  ];
  // 第一段第一轮已走到 8：余 2 秒到段尾，跳回 0；再 10 秒第二轮 -> 跳 10；再 2 秒完成
  const r = run({ segIndex: 0, iteration: 0, time: 8, finished: false }, segs, 2 + 10 + 1);
  assert.deepEqual(r, { segIndex: 1, iteration: 0, time: 11, finished: false, boundary: null });
  const r2 = run({ segIndex: 0, iteration: 0, time: 8, finished: false }, segs, 2 + 10 + 2);
  assert.deepEqual(r2, { segIndex: 1, iteration: 0, time: 12, finished: true, boundary: null });
});

test('超大重复次数按批量代数推算（不逐轮循环），结果与轮次一致', () => {
  const N = 1_000_000_000;
  const segs = [{ start: 0, end: 1, repeat: N }];
  // 走 12345.75 秒：12345 轮 + 0.75
  const r = run({ segIndex: 0, iteration: 0, time: 0, finished: false }, segs, 12345.75);
  assert.equal(r.finished, false);
  assert.equal(r.segIndex, 0);
  assert.equal(r.iteration, 12345);
  assert.ok(Math.abs(r.time - 0.75) < 1e-9);

  // 全部 N 轮完成
  const r2 = run({ segIndex: 0, iteration: 0, time: 0, finished: false }, segs, N + 0.5);
  assert.equal(r2.finished, true);
  assert.equal(r2.iteration, N - 1);
  assert.equal(r2.time, 1);
});

test('finished 状态：不再推进，恒停在末段终点', () => {
  const segs = [{ start: 0, end: 4, repeat: 2 }];
  const r = run({ segIndex: 0, iteration: 1, time: 4, finished: true }, segs, 99);
  assert.deepEqual(r, { segIndex: 0, iteration: 1, time: 4, finished: true, boundary: null });
});

test('目标未超过当前时码：状态不变', () => {
  const segs = [{ start: 0, end: 4, repeat: 2 }];
  const r = run({ segIndex: 0, iteration: 1, time: 2.2, finished: false }, segs, 0);
  assert.deepEqual(r, { segIndex: 0, iteration: 1, time: 2.2, finished: false, boundary: null });
});

test('超载保护：段内前方边界被命中即冻结，不越过', () => {
  const segs = [{ start: 0, end: 10, repeat: 3 }];
  const boundary = { start: 3, circuit: { id: 1 } };
  const findTrip = (si, from, to) => (from < 3 - 1e-9 && to >= 3 - 1e-9 ? boundary : null);

  // 时间足以越过：冻结在 3，轮次仍 0
  const r = run({ segIndex: 0, iteration: 0, time: 0, finished: false }, segs, 5, findTrip);
  assert.equal(r.time, 3);
  assert.equal(r.finished, false);
  assert.equal(r.boundary, boundary);
  assert.equal(r.iteration, 0);

  // 时间够不到边界：正常前进
  const r2 = run({ segIndex: 0, iteration: 0, time: 0, finished: false }, segs, 2, findTrip);
  assert.equal(r2.time, 2);
  assert.equal(r2.boundary, null);
});

test('超载保护：开边界恰在段起点——时间推进即冻结在起点（与单段 trip 语义一致）', () => {
  const segs = [{ start: 0, end: 10, repeat: 3 }];
  const boundary = { start: 0, open: true, circuit: { id: 1 } };
  // 第一轮起点 0 本身不拦，但一推进就截停
  const findTrip = () => boundary;
  const r = run({ segIndex: 0, iteration: 0, time: 0, finished: false }, segs, 0.5, findTrip);
  assert.equal(r.time, 0);
  assert.equal(r.boundary, boundary);
});

test('超载保护：段尾跳跃不经过的时间不拦截；每轮重复检查', () => {
  const segs = [
    { start: 0, end: 2, repeat: 2 },
    { start: 8, end: 9, repeat: 1 },
  ];
  // 边界 5 落在第一段段尾(2) 与第二段起点(8) 之间——跳跃越过，任何轮次都不应撞上
  const findJumpOver = (si, from, to) => (from <= 5 && to >= 5 ? { start: 5 } : null);
  // 注意：段内连续推进的范围只有 [0,2]，[8,9]，故回调按实际范围不会命中 5
  const realistic = (si, from, to) => {
    const seg = segs[si];
    return 5 >= from - 1e-9 && 5 <= to + 1e-9 && 5 >= seg.start && 5 <= seg.end
      ? { start: 5 }
      : null;
  };
  const r = run({ segIndex: 0, iteration: 0, time: 0, finished: false }, segs, 4.5, realistic);
  assert.equal(r.finished, false);
  assert.equal(r.segIndex, 1);
  assert.equal(r.time, 8.5);
  assert.equal(r.boundary, null);
  assert.equal(typeof findJumpOver, 'function'); // 防御性回调不参与判定

  // 第二段每轮的边界 8.5：第一轮（seg0 第二轮之后）命中
  const find85 = (si, from, to) => (si === 1 && from <= 8.5 && to >= 8.5 ? { start: 8.5 } : null);
  const r2 = run({ segIndex: 0, iteration: 0, time: 0, finished: false }, segs, 4.5, find85);
  assert.equal(r2.segIndex, 1);
  assert.equal(r2.time, 8.5);
  assert.ok(r2.boundary);
});

test('超载保护：某一轮中途段内命中后，整次推进停在该边界（不跨轮）', () => {
  const segs = [{ start: 0, end: 4, repeat: 5 }];
  const boundary = { start: 3 };
  const findTrip = (si, from, to) => (from < 3 - 1e-9 && to >= 3 - 1e-9 ? boundary : null);
  // 已经第 4 轮（iteration=3），走到段中 1，剩余时间很长：仍冻结在本轮的 3
  const r = run({ segIndex: 0, iteration: 3, time: 1, finished: false }, segs, 50, findTrip);
  assert.equal(r.iteration, 3);
  assert.equal(r.time, 3);
  assert.ok(r.boundary);
  assert.equal(r.finished, false);
});
