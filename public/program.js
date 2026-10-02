/*
 * 共享房间「循环排演」推进引擎（纯函数，无依赖）
 * 浏览器与 Node 共用：浏览器挂到 window.LightingProgram，Node 通过 module.exports 引入。
 *
 * 编排模型：
 *  - segments：1～8 段，按数组顺序依次播放；每段 { start, end, repeat }：
 *    非负起止时码、start < end、end 不超过版本末尾；repeat 为正整数重复次数。
 *  - 播放按墙钟连续穿过一段：到达段尾的瞬间立即跳回本段起点（同一轮语义）
 *    或跳到下段起点；跳跃不消耗墙钟时间；全部段全部轮次完成后停在末段终点。
 *  - 状态 { segIndex, iteration, time, finished }：当前段（0 基）、本段已完成的
 *    重复轮次（0 基）、当前演出时码；finished 表示整次编排已全部走完。
 *
 * findTrip（可选，仅启用回路超载保护时提供）：
 *   findTrip(segIndex, fromTime, toTime) -> 边界对象 { start, ... } | null
 *   返回播放从 fromTime 连续推进到 toTime（含抵达端点）时撞上的首个超载区间
 *   左边界；段尾跳回/跳段是瞬时跳转，跳转落点之间未连续经过的时间不参与查找。
 *   命中后播放冻结在边界时码上（不越过危险段），边界对象原样带回（由调用方
 *   附加回路信息）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LightingProgram = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9;

  /**
   * 由编排中的锚点状态，求墙钟目标时码 targetTime 对应的最新编排状态。
   * 不修改入参。返回 { segIndex, iteration, time, finished, boundary }：
   *  - 普通推进：boundary=null、finished=false，time 为当前演出时码；
   *  - 撞上超载边界：boundary 为 findTrip 命中的边界对象，time 冻结在 boundary.start；
   *  - 全部走完：finished=true，time 为末段终点，segIndex/iteration 停在末段末轮。
   * 对“整轮重复”做批量代数推算（不逐轮循环），重复次数极大时复杂度仍为 O(段数)。
   */
  function advanceProgram(input, segments, targetTime, findTrip) {
    let segIndex = Number(input.segIndex) || 0;
    let iteration = Number(input.iteration) || 0;
    let time = Number(input.time);

    if (input.finished) {
      return { segIndex, iteration, time, finished: true, boundary: null };
    }
    let remaining = targetTime - time;
    if (!(remaining > EPS)) {
      return { segIndex, iteration, time, finished: false, boundary: null };
    }

    const hit = (boundary) => ({ segIndex, iteration, time: boundary.start, finished: false, boundary });

    // 一、锚点位于某一轮的中段：先连续推进到本段段尾（或中途停住/触发）
    const firstSeg = segments[segIndex];
    if (Math.abs(time - firstSeg.start) > EPS) {
      const toEnd = firstSeg.end - time;
      if (findTrip) {
        const b = findTrip(segIndex, time, firstSeg.end);
        if (b && b.start <= time + remaining + EPS) return hit(b);
      }
      if (remaining + EPS < toEnd) {
        // 尚未到段尾：线性前进
        return { segIndex, iteration, time: time + remaining, finished: false, boundary: null };
      }
      // 恰好（或超额）抵达段尾：跳跃不耗时间，扣掉本段这一轮的连续时长
      remaining = Math.max(0, remaining - toEnd);
      if (iteration + 1 < firstSeg.repeat) {
        iteration += 1;
        time = firstSeg.start; // 段尾立即跳回本段起点
      } else if (segIndex + 1 < segments.length) {
        segIndex += 1;
        iteration = 0;
        time = segments[segIndex].start; // 段尾立即跳到下段起点
      } else {
        return { segIndex, iteration, time: firstSeg.end, finished: true, boundary: null };
      }
    }

    // 二、此刻正位于 segIndex 段第 iteration 轮的起点：整轮批量推算
    for (;;) {
      const seg = segments[segIndex];
      const segLen = seg.end - seg.start;
      const roundsLeft = seg.repeat - iteration;

      // 一轮之内的首个超载边界（每轮相同）；剩余时间够不到则不触发
      if (findTrip && remaining > EPS) {
        const b = findTrip(segIndex, seg.start, seg.end);
        if (b) {
          const into = Math.abs(b.start - seg.start) <= EPS ? 0 : b.start - seg.start;
          if (remaining + EPS >= into) return hit(b);
        }
      }

      // 剩余时间够完整走完的轮数（瞬时跳回不耗时间）
      const n = Math.min(roundsLeft, Math.floor((remaining + EPS) / segLen));
      if (n < 1) {
        // 不足一整轮：在本轮中线性前进
        return { segIndex, iteration, time: seg.start + remaining, finished: false, boundary: null };
      }
      remaining = Math.max(0, remaining - n * segLen);

      if (n >= roundsLeft) {
        // 本段全部轮次走完：进入下段或整次编排完成
        if (segIndex + 1 < segments.length) {
          segIndex += 1;
          iteration = 0;
          time = segments[segIndex].start;
          if (!(remaining > EPS)) {
            return { segIndex, iteration, time, finished: false, boundary: null };
          }
          continue;
        }
        return { segIndex, iteration: seg.repeat - 1, time: seg.end, finished: true, boundary: null };
      }

      // 走完 n 轮但本段还有轮次：已瞬时跳回段首
      iteration += n;
      time = seg.start;
      if (!(remaining > EPS)) {
        return { segIndex, iteration, time, finished: false, boundary: null };
      }
    }
  }

  return { advanceProgram, EPS };
});
