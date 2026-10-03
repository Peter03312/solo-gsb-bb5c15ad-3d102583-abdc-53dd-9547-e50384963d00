'use strict';

// 共享房间「讨论停点」HTTP 单元测试：
// 提交鉴权（密钥/修订号）、停点组校验（非负、不超末尾、不重复、整组原子替换、空组清除）、
// 播放连续经过停点准确暂停并显示原因（自动暂停不加修订号）、继续播放越过刚触发的停点、
// 手动跳转跳到停点不立即触发、循环排演每次重新经过仍暂停、段尾瞬时跳转不触发跳过的停点、
// 超载边界与停点取先抵达者（同一时码优先超载）、观看者只读、交接后延续、重启恢复。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-room-stops-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const { app } = require('../server.js');

let server;

function request(method, urlPath, body) {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(async () => {
  await new Promise((r) => server.close(r));
});

async function resetDraft() {
  const cues = await getJson('/api/cues');
  for (const c of cues) await request('DELETE', `/api/cues/${c.id}`);
  const lights = await getJson('/api/lights');
  for (const l of lights) await request('DELETE', `/api/lights/${l.id}`);
  const circuits = await getJson('/api/circuits');
  for (const c of circuits) await request('DELETE', `/api/circuits/${c.id}`);
}

// 普通版本：灯 L，t=0 渐变到 100、duration 10 → 末尾 10 秒
async function seedPlainVersion() {
  await resetDraft();
  const l = (await request('POST', '/api/lights', { name: '停点大灯' })).json.id;
  await request('POST', '/api/cues', [{ cue_no: 9301, light_id: l, time: 0, target: 100, duration: 10 }]);
  return (await request('POST', '/api/versions', { label: '停点版' })).json;
}

// 短版本：灯 L，t=0 瞬变 100 → 末尾 1 秒（时序测试用，墙钟开销小）
async function seedShortVersion() {
  await resetDraft();
  const l = (await request('POST', '/api/lights', { name: '停点小灯' })).json.id;
  await request('POST', '/api/cues', [{ cue_no: 9401, light_id: l, time: 0, target: 100, duration: 1 }]);
  return (await request('POST', '/api/versions', { label: '停点短版' })).json;
}

// 带超载保护的短版本（同 room-program 口径）：超载区间 [0.3, 1)，闭左边界 0.3；末尾 1 秒
async function seedProtectedVersion() {
  await resetDraft();
  const c1 = (await request('POST', '/api/circuits', { name: '超载回路S', capacity: 100 })).json.id;
  const l1 = (await request('POST', '/api/lights', { name: '大灯S' })).json.id;
  await request('PUT', `/api/lights/${l1}/wiring`, { circuit_id: c1, watts: 200 });
  await request('POST', '/api/cues', [
    { cue_no: 9501, light_id: l1, time: 0, target: 50, duration: 0 },
    { cue_no: 9502, light_id: l1, time: 0.3, target: 100, duration: 0 },
    { cue_no: 9503, light_id: l1, time: 1, target: 0, duration: 0 },
  ]);
  return { version: (await request('POST', '/api/versions', { label: '保护停点版' })).json, c1 };
}

async function createRoom(versionId, body = {}) {
  return request('POST', '/api/rooms', { version_id: versionId, ...body });
}
const stopsUrl = (code) => `/api/rooms/${code}/stops`;
const ctrlUrl = (code) => `/api/rooms/${code}/control`;

test('提交停点：缺/错密钥 403、修订号缺失非法 400、过期 409，均不改变房间', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;

  let r = await request('PUT', stopsUrl(c.code), { revision: 0, stops: [2] });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /缺少控制密钥/);

  r = await request('PUT', stopsUrl(c.code), {
    control_key: 'deadbeef'.repeat(6),
    revision: 0,
    stops: [2],
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /控制密钥无效/);

  r = await request('PUT', stopsUrl(c.code), { control_key: c.control_key, stops: [2] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /必须携带房间修订号/);

  r = await request('PUT', stopsUrl(c.code), { control_key: c.control_key, revision: -1, stops: [2] });
  assert.equal(r.status, 400);

  // 先让房间修订号前进一次，再用过时的 0 提交
  await request('POST', ctrlUrl(c.code), { control_key: c.control_key, revision: 0, action: 'pause' });
  r = await request('PUT', stopsUrl(c.code), { control_key: c.control_key, revision: 0, stops: [2] });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /修订号冲突/);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.deepEqual(g.json.stops.points, [], '拒绝提交后房间仍无停点');
  assert.equal(g.json.revision, 1);
});

test('停点校验：非数组/负数/非数字/超过末尾/重复——非法整组拒绝，不落库、不改房间', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  const submit = (stops) =>
    request('PUT', stopsUrl(c.code), { control_key: c.control_key, revision: c.revision, stops });

  let r = await submit('not-array');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /须为时码数组/);

  r = await submit([-1, 2]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /不得为负/);

  r = await submit([2, 'x']);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /须为非负数字秒数/);

  r = await submit([2, 10.01]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /不得超过版本末尾/);

  r = await submit([2, 5, 2]);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /不得重复/);

  r = await submit([null]);
  assert.equal(r.status, 400);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.deepEqual(g.json.stops.points, [], '非法停点组全部不落库');
  assert.equal(g.json.revision, 0, '房间修订号未变');
});

test('提交成功：整组原子替换、升序返回、修订号 +1；空组清除全部停点', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;

  // 乱序提交 → 升序存储返回
  let r = await request('PUT', stopsUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    stops: [5, 2, 9],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.stops.points, [2, 5, 9]);
  assert.equal(r.json.revision, 1);
  assert.equal(r.json.control_key, undefined, '响应不回显密钥');

  // 整组替换：旧组完全消失
  r = await request('PUT', stopsUrl(c.code), {
    control_key: c.control_key,
    revision: 1,
    stops: [7],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.stops.points, [7]);
  assert.equal(r.json.revision, 2);

  // 空组 = 清除
  r = await request('PUT', stopsUrl(c.code), {
    control_key: c.control_key,
    revision: 2,
    stops: [],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.stops.points, []);
  assert.equal(r.json.revision, 3);

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.deepEqual(g.json.stops.points, []);
});

test('播放连续经过停点：准确暂停在停点、显示原因、不增加修订号；刷新后状态一致', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  await request('PUT', stopsUrl(c.code), { control_key: c.control_key, revision: 0, stops: [0.4, 0.8] });
  const play = await ctrl({ revision: 1, action: 'play' });
  assert.equal(play.status, 200);
  assert.equal(play.json.revision, 2);

  await sleep(950); // 远超 0.4s 停点
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.4) < 1e-6, `time=${g.json.time} 应准确停在停点 0.4`);
  assert.equal(g.json.revision, 2, '自动暂停不增加修订号');
  assert.ok(g.json.stops.tripped, '显示停点触发原因');
  assert.equal(g.json.stops.tripped.reason, 'stop_point');
  assert.ok(Math.abs(g.json.stops.tripped.time - 0.4) < 1e-6);
  assert.match(g.json.stops.tripped.reason_text, /讨论停点已触发/);
  assert.deepEqual(g.json.stops.points, [0.4, 0.8]);

  // 已惰性落库：再查（刷新/重连）仍暂停在停点、原因仍在
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.4) < 1e-6);
  assert.ok(g.json.stops.tripped);
  assert.equal(g.json.revision, 2);
});

test('继续播放越过刚触发的停点：不在原地再停，到下一停点再次暂停', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  await request('PUT', stopsUrl(c.code), { control_key: c.control_key, revision: 0, stops: [0.3, 0.7] });
  await ctrl({ revision: 1, action: 'play' });
  await sleep(800);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.ok(Math.abs(g.json.time - 0.3) < 1e-6);
  assert.equal(g.json.playing, false);

  // 继续播放：越过刚触发的 0.3（不停在原地），停点触发标记随播放清除
  const play = await ctrl({ revision: 2, action: 'play' });
  assert.equal(play.status, 200);
  assert.equal(play.json.playing, true);
  assert.equal(play.json.stops.tripped, undefined);

  await sleep(180); // 0.3 -> 约 0.48：已越过 0.3 且未到 0.7
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, true, '越过刚触发的停点继续播放');
  assert.ok(g.json.time > 0.3 && g.json.time < 0.7, `time=${g.json.time}`);
  assert.equal(g.json.stops.tripped, undefined);

  await sleep(500); // 抵达下一停点 0.7
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.7) < 1e-6, `time=${g.json.time}`);
  assert.ok(Math.abs(g.json.stops.tripped.time - 0.7) < 1e-6);
});

test('手动跳转沿用取消编排规则：跳到停点不立即触发，播放后越过该停点', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  await request('PUT', stopsUrl(c.code), { control_key: c.control_key, revision: 0, stops: [0.5] });
  // 暂停态直接跳到停点 0.5：不触发（无自动暂停标记）
  const seek = await ctrl({ revision: 1, action: 'seek', time: 0.5 });
  assert.equal(seek.status, 200);
  assert.ok(Math.abs(seek.json.time - 0.5) < 1e-6);
  assert.equal(seek.json.stops.tripped, undefined, '跳到停点不立即触发');

  // 从停点上继续播放：锚点上的停点不再触发，直接越过
  await ctrl({ revision: 2, action: 'play' });
  await sleep(250);
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, true);
  assert.ok(g.json.time > 0.5, `time=${g.json.time} 已越过停点 0.5`);
  assert.equal(g.json.stops.tripped, undefined);
});

test('循环排演：每次重新经过段内停点仍暂停（逐轮触发），断点保留', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  await request('PUT', stopsUrl(c.code), { control_key: c.control_key, revision: 0, stops: [0.5] });
  // 段 [0.2, 0.8) 重复 3 次：每轮都会连续经过停点 0.5
  const prog = await request('POST', `/api/rooms/${c.code}/program`, {
    control_key: c.control_key,
    revision: 1,
    segments: [{ start: 0.2, end: 0.8, repeat: 3 }],
  });
  assert.equal(prog.status, 200);

  await sleep(900); // 远超第一轮抵达 0.5 的 0.3s
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.5) < 1e-6, `time=${g.json.time}`);
  assert.ok(g.json.stops.tripped);
  assert.equal(g.json.program.loop, 1, '停在第 1 轮');
  assert.equal(g.json.program.finished, false);
  assert.equal(g.json.revision, 2, '自动暂停不增加修订号');

  // 继续播放：越过 0.5 → 段尾跳回 0.2 → 第二轮重新经过 0.5 再次暂停
  await ctrl({ revision: 2, action: 'play' });
  await sleep(1100); // 0.5->0.8（0.3s）+ 0.2->0.5（0.3s），留足余量
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.5) < 1e-6, `第二轮仍停在 0.5，time=${g.json.time}`);
  assert.equal(g.json.program.loop, 2, '停在第 2 轮');
  assert.ok(g.json.stops.tripped);
});

test('循环排演：段尾瞬时跳转不触发被跳过的停点（段间空隙与落点上的停点都不触发）', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;

  // 停点 0.5 位于两段之间的空隙（0.3 → 0.7 瞬时跳过），停点 0.7 恰为第二段起点（跳转落点）
  await request('PUT', stopsUrl(c.code), {
    control_key: c.control_key,
    revision: 0,
    stops: [0.5, 0.7],
  });
  const prog = await request('POST', `/api/rooms/${c.code}/program`, {
    control_key: c.control_key,
    revision: 1,
    segments: [
      { start: 0, end: 0.3, repeat: 1 },
      { start: 0.7, end: 0.9, repeat: 1 },
    ],
  });
  assert.equal(prog.status, 200);

  await sleep(900); // 0.3s + 0.2s 足够走完全部编排
  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.program.finished, true, '编排走完：空隙与落点上的停点均未拦截');
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.9) < 1e-6, `time=${g.json.time} 停在末段终点`);
  assert.equal(g.json.stops.tripped, undefined, '被跳过的停点未触发');
});

test('超载边界与停点取先抵达者；同一时码优先超载', async () => {
  const { version } = await seedProtectedVersion();

  // A：停点 0.2 在超载边界 0.3 之前 → 停点先触发
  const a = (await createRoom(version.id, { overload_protection: true })).json;
  await request('PUT', stopsUrl(a.code), { control_key: a.control_key, revision: 0, stops: [0.2] });
  await request('POST', ctrlUrl(a.code), { control_key: a.control_key, revision: 1, action: 'play' });
  await sleep(700);
  let g = await request('GET', `/api/rooms/${a.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.2) < 1e-6, `先到停点 0.2，time=${g.json.time}`);
  assert.ok(g.json.stops.tripped, '停点触发');
  assert.equal(g.json.protection.tripped, undefined, '超载未触发');

  // B：停点 0.5 在超载边界 0.3 之后 → 超载边界先触发
  const b = (await createRoom(version.id, { overload_protection: true })).json;
  await request('PUT', stopsUrl(b.code), { control_key: b.control_key, revision: 0, stops: [0.5] });
  await request('POST', ctrlUrl(b.code), { control_key: b.control_key, revision: 1, action: 'play' });
  await sleep(700);
  g = await request('GET', `/api/rooms/${b.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.3) < 1e-6, `先到超载边界 0.3，time=${g.json.time}`);
  assert.ok(g.json.protection.tripped, '超载触发');
  assert.equal(g.json.stops.tripped, undefined, '停点未触发');

  // C：停点 0.3 与超载边界同一时码 → 超载优先
  const d = (await createRoom(version.id, { overload_protection: true })).json;
  await request('PUT', stopsUrl(d.code), { control_key: d.control_key, revision: 0, stops: [0.3] });
  await request('POST', ctrlUrl(d.code), { control_key: d.control_key, revision: 1, action: 'play' });
  await sleep(700);
  g = await request('GET', `/api/rooms/${d.code}`);
  assert.equal(g.json.playing, false);
  assert.ok(Math.abs(g.json.time - 0.3) < 1e-6);
  assert.ok(g.json.protection.tripped, '同一时码超载优先');
  assert.equal(g.json.stops.tripped, undefined);
});

test('停点组替换：当前触发标记对应的时码不在新组内则清除标记，仍在则保留', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  await request('PUT', stopsUrl(c.code), { control_key: c.control_key, revision: 0, stops: [0.3] });
  await ctrl({ revision: 1, action: 'play' });
  await sleep(800);
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.ok(g.json.stops.tripped, '已停在停点 0.3');

  // 新组仍含 0.3：触发标记保留（暂停原因仍成立）
  let r = await request('PUT', stopsUrl(c.code), {
    control_key: c.control_key,
    revision: 2,
    stops: [0.3, 0.6],
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.stops.tripped, '0.3 仍在新组：触发标记保留');

  // 新组不含 0.3：触发标记清除（房间仍暂停在 0.3）
  r = await request('PUT', stopsUrl(c.code), {
    control_key: c.control_key,
    revision: 3,
    stops: [0.6],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.stops.tripped, undefined, '0.3 不在新组：触发标记清除');
  assert.equal(r.json.playing, false);
  assert.ok(Math.abs(r.json.time - 0.3) < 1e-6);
});

test('观看者只读：GET 可见停点列表与状态但无密钥；提交停点 403', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  await request('PUT', stopsUrl(c.code), { control_key: c.control_key, revision: 0, stops: [2, 5] });

  const g = await request('GET', `/api/rooms/${c.code}`);
  assert.deepEqual(g.json.stops.points, [2, 5], '观看者可见停点列表');
  assert.equal(g.json.control_key, undefined);

  const r = await request('PUT', stopsUrl(c.code), { revision: 1, stops: [3] });
  assert.equal(r.status, 403);
});

test('主持权交接后新主持人可维护停点，停点与播放状态不重置', async () => {
  const v = await seedPlainVersion();
  const c = (await createRoom(v.id)).json;
  await request('PUT', stopsUrl(c.code), { control_key: c.control_key, revision: 0, stops: [2, 5] });

  const issue = await request('POST', `/api/rooms/${c.code}/handover/issue`, {
    control_key: c.control_key,
    revision: 1,
  });
  assert.equal(issue.status, 200);
  const claim = await request('POST', `/api/rooms/${c.code}/handover/claim`, {
    handover_token: issue.json.handover_token,
    revision: 1,
  });
  assert.equal(claim.status, 200);
  assert.deepEqual(claim.json.stops.points, [2, 5], '交接不重置停点');

  // 旧密钥无权维护停点；新密钥可以
  let r = await request('PUT', stopsUrl(c.code), {
    control_key: c.control_key,
    revision: 2,
    stops: [3],
  });
  assert.equal(r.status, 403);
  r = await request('PUT', stopsUrl(c.code), {
    control_key: claim.json.control_key,
    revision: 2,
    stops: [3],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.stops.points, [3]);
});

test('重启后停点与触发状态一致（持久化在数据库）', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  const ctrl = (body) => request('POST', ctrlUrl(c.code), { control_key: c.control_key, ...body });

  await request('PUT', stopsUrl(c.code), { control_key: c.control_key, revision: 0, stops: [0.3, 0.8] });
  await ctrl({ revision: 1, action: 'play' });
  await sleep(800);
  const g0 = (await request('GET', `/api/rooms/${c.code}`)).json;
  assert.ok(Math.abs(g0.time - 0.3) < 1e-6);
  assert.ok(g0.stops.tripped);

  // 模拟服务重启：同一数据库文件重新起一份 app
  const { app: app2 } = require('../server.js');
  const s2 = http.createServer(app2);
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  try {
    const g = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s2.address().port, path: `/api/rooms/${c.code}` }, (res) => {
        let d = '';
        res.on('data', (x) => (d += x));
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    assert.equal(g.playing, false);
    assert.ok(Math.abs(g.time - 0.3) < 1e-6);
    assert.deepEqual(g.stops.points, [0.3, 0.8], '停点列表持久化');
    assert.ok(g.stops.tripped, '触发原因重启后仍恢复');
    assert.ok(Math.abs(g.stops.tripped.time - 0.3) < 1e-6);
    assert.equal(g.revision, g0.revision, '修订号未变');
  } finally {
    await new Promise((r) => s2.close(r));
  }
});

test('未预置停点的房间行为兼容：GET 带空 stops 块，播放/到末尾停住不变', async () => {
  const v = await seedShortVersion();
  const c = (await createRoom(v.id)).json;
  let g = await request('GET', `/api/rooms/${c.code}`);
  assert.deepEqual(g.json.stops.points, []);
  assert.equal(g.json.stops.tripped, undefined);
  assert.equal(g.json.stops.next, undefined);

  await request('POST', ctrlUrl(c.code), { control_key: c.control_key, revision: 0, action: 'play' });
  await sleep(1300); // 超过 1s 版本末尾
  g = await request('GET', `/api/rooms/${c.code}`);
  assert.equal(g.json.playing, false, '到末尾自动停住');
  assert.ok(Math.abs(g.json.time - 1) < 1e-6);
  assert.equal(g.json.stops.tripped, undefined, '末尾停住不是停点触发');
  assert.equal(g.json.revision, 1, '自动停住不增加修订号');
});
