'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { open, get } = require('./src/db');
const Engine = require('./public/engine');
const Merge = require('./src/merge');
const Program = require('./public/program');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');

open(DB_PATH);
const db = get();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------- 校验工具 ------------------------------- */

const NAME_RE = /\S/;

// 严格数字转换：数字、数字字符串通过；NaN/Infinity/其他类型一律拒绝
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '' && v.trim() !== '-') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function toPosInt(v) {
  const n = toNum(v);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

// 正实数：容量、额定瓦数
function toPosNum(v) {
  const n = toNum(v);
  return typeof n === 'number' && n > 0 ? n : NaN;
}

/**
 * 校验一条 Cue 的可写字段。
 * 返回 { value: {cue_no?, light_id, time, target, duration} } 或 { error }。
 */
function validateCue(input, { allowCueNo = true, existingId = null } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Cue 必须是一个对象' };
  }

  // 灯具编号
  const lightId = toPosInt(input.light_id);
  if (Number.isNaN(lightId)) {
    return { error: `灯具编号无效：${JSON.stringify(input.light_id)}（须为已存在的灯具编号）` };
  }
  const light = db.prepare('SELECT id FROM lights WHERE id = ?').get(lightId);
  if (!light) {
    return { error: `未知灯具：编号 ${lightId} 不存在` };
  }

  // 触发时码：非负演出秒数
  const time = toNum(input.time);
  if (Number.isNaN(time)) {
    return { error: `非法时码：${JSON.stringify(input.time)}（须为数字）` };
  }
  if (time < 0) {
    return { error: `非法时码：${time}（不得为负）` };
  }

  // 目标亮度 0～100
  const target = toNum(input.target);
  if (Number.isNaN(target)) {
    return { error: `无效亮度：${JSON.stringify(input.target)}（须为数字）` };
  }
  if (target < 0 || target > 100) {
    return { error: `无效亮度：${target}（须在 0～100 之间）` };
  }

  // 渐变时长：非负秒数
  const duration = toNum(input.duration);
  if (Number.isNaN(duration)) {
    return { error: `非法渐变时长：${JSON.stringify(input.duration)}（须为数字）` };
  }
  if (duration < 0) {
    return { error: `非法渐变时长：${duration}（不得为负）` };
  }

  const value = { light_id: lightId, time, target, duration };

  // Cue 编号可选（不传则自动分配）
  if (input.cue_no !== undefined && input.cue_no !== null && input.cue_no !== '') {
    if (!allowCueNo) return { error: '不允许指定 Cue 编号' };
    const cueNo = toPosInt(input.cue_no);
    if (Number.isNaN(cueNo)) {
      return { error: `非法 Cue 编号：${JSON.stringify(input.cue_no)}（须为正整数）` };
    }
    const dup = db
      .prepare('SELECT id FROM cues WHERE cue_no = ? AND id IS NOT ?')
      .get(cueNo, existingId);
    if (dup) {
      return { error: `Cue 编号 ${cueNo} 已被占用（同秒触发按编号顺序生效，编号须唯一）` };
    }
    value.cue_no = cueNo;
  }

  return { value };
}

function err(res, code, message) {
  return res.status(code).json({ error: message });
}

function readCue(row) {
  return {
    id: row.id,
    cue_no: row.cue_no,
    light_id: row.light_id,
    light_name: row.light_name,
    time: row.time,
    target: row.target,
    duration: row.duration,
  };
}

const cueSelect = `
  SELECT c.id, c.cue_no, c.light_id, l.name AS light_name,
         c.time, c.target, c.duration
  FROM cues c JOIN lights l ON l.id = c.light_id
  ORDER BY c.time ASC, c.cue_no ASC
`;

/* -------------------------------- 灯具 -------------------------------- */

app.get('/api/lights', (req, res) => {
  res.json(db.prepare('SELECT * FROM lights ORDER BY id ASC').all());
});

app.post('/api/lights', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!NAME_RE.test(name)) return err(res, 400, '灯具名称不能为空');

  try {
    const info = db
      .prepare('INSERT INTO lights (name, created_at) VALUES (?, ?)')
      .run(name, Date.now() / 1000);
    res.status(201).json(db.prepare('SELECT * FROM lights WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return err(res, 409, `灯具名称已存在：${name}`);
    throw e;
  }
});

app.delete('/api/lights/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const light = db.prepare('SELECT * FROM lights WHERE id = ?').get(id);
  if (!light) return err(res, 404, `灯具 ${id} 不存在`);

  const used = db.prepare('SELECT COUNT(*) AS n FROM cues WHERE light_id = ?').get(id).n;
  if (used > 0) {
    return err(res, 409, `灯具 ${light.name} 仍被 ${used} 条草稿 Cue 引用，请先删除这些 Cue`);
  }
  db.prepare('DELETE FROM lights WHERE id = ?').run(id);
  res.status(204).end();
});

/* ------------------------------- 灯光回路 ------------------------------ */
// 草稿期配置：回路有正数容量（瓦）；灯具可分配到某回路并登记正数额定瓦数。
// 未分配回路（circuit_id 为空）的灯具不计入任何回路负载。
// 全部写接口逐条严格校验，单条请求为一个事务，非法即拒绝、不部分保存。

const circuitSelect = `
SELECT c.id, c.name, c.capacity, c.created_at,
       (SELECT COUNT(*) FROM lights l WHERE l.circuit_id = c.id) AS light_count
FROM circuits c ORDER BY c.id ASC
`;

function readCircuit(row) {
  return {
    id: row.id,
    name: row.name,
    capacity: row.capacity,
    light_count: row.light_count,
    created_at: row.created_at,
  };
}

function getCircuit(id) {
  return db
    .prepare(
      `SELECT c.id, c.name, c.capacity, c.created_at,
              (SELECT COUNT(*) FROM lights l WHERE l.circuit_id = c.id) AS light_count
       FROM circuits c WHERE c.id = ?`
    )
    .get(id);
}

app.get('/api/circuits', (req, res) => {
  res.json(db.prepare(circuitSelect).all().map(readCircuit));
});

app.post('/api/circuits', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!NAME_RE.test(name)) return err(res, 400, '回路名称不能为空');

  const capacity = toPosNum(req.body?.capacity);
  if (Number.isNaN(capacity)) {
    return err(res, 400, `无效容量：${JSON.stringify(req.body?.capacity)}（须为正数瓦数）`);
  }

  try {
    const info = db
      .prepare('INSERT INTO circuits (name, capacity, created_at) VALUES (?, ?, ?)')
      .run(name, capacity, Date.now() / 1000);
    res.status(201).json(readCircuit(getCircuit(info.lastInsertRowid)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return err(res, 409, `回路名称已存在：${name}`);
    throw e;
  }
});

app.patch('/api/circuits/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM circuits WHERE id = ?').get(id);
  if (!row) return err(res, 404, `回路 ${id} 不存在`);

  const body = req.body || {};
  const merged = {
    name: 'name' in body ? body.name : row.name,
    capacity: 'capacity' in body ? body.capacity : row.capacity,
  };
  const name = typeof merged.name === 'string' ? merged.name.trim() : '';
  if (!NAME_RE.test(name)) return err(res, 400, '回路名称不能为空');
  const capacity = toPosNum(merged.capacity);
  if (Number.isNaN(capacity)) {
    return err(res, 400, `无效容量：${JSON.stringify(merged.capacity)}（须为正数瓦数）`);
  }

  try {
    db.prepare('UPDATE circuits SET name = ?, capacity = ? WHERE id = ?').run(name, capacity, id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return err(res, 409, `回路名称已存在：${name}`);
    throw e;
  }
  res.json(readCircuit(getCircuit(id)));
});

app.delete('/api/circuits/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM circuits WHERE id = ?').get(id);
  if (!row) return err(res, 404, `回路 ${id} 不存在`);

  const n = db.prepare('SELECT COUNT(*) AS n FROM lights WHERE circuit_id = ?').get(id).n;
  if (n > 0) {
    return err(
      res,
      409,
      `回路 ${row.name} 下仍有 ${n} 盏灯，请先把这些灯改投其他回路或取消分配后再删除`
    );
  }
  db.prepare('DELETE FROM circuits WHERE id = ?').run(id);
  res.status(204).end();
});

// 灯具接线：设置所属回路与正数额定瓦数；circuit_id 传 null/空 表示取消分配（瓦数一并清空）
app.put('/api/lights/:id/wiring', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const light = db.prepare('SELECT * FROM lights WHERE id = ?').get(id);
  if (!light) return err(res, 404, `灯具 ${id} 不存在`);

  const body = req.body || {};
  const rawCircuit = body.circuit_id;
  const unassign = rawCircuit === null || rawCircuit === undefined || rawCircuit === '';

  let circuitId = null;
  if (!unassign) {
    circuitId = toPosInt(rawCircuit);
    if (Number.isNaN(circuitId)) {
      return err(res, 400, `无效回路引用：${JSON.stringify(rawCircuit)}（须为已存在回路编号，或 null 取消分配）`);
    }
    const circuit = db.prepare('SELECT id FROM circuits WHERE id = ?').get(circuitId);
    if (!circuit) return err(res, 400, `回路引用不存在：编号 ${circuitId} 尚未建立`);
  }

  let watts = null;
  if (!unassign) {
    watts = toPosNum(body.watts);
    if (Number.isNaN(watts)) {
      return err(res, 400, `无效额定瓦数：${JSON.stringify(body.watts)}（灯具已分配回路时须为正数额定瓦数）`);
    }
  } else if (body.watts !== undefined && body.watts !== null && body.watts !== '') {
    return err(res, 400, '未分配回路的灯具不能设置额定瓦数（不计入任何回路负载）');
  }

  db.prepare('UPDATE lights SET circuit_id = ?, watts = ? WHERE id = ?').run(circuitId, watts, id);
  res.json(db.prepare('SELECT * FROM lights WHERE id = ?').get(id));
});

/* ------------------------------- 草稿 Cue ------------------------------ */

app.get('/api/cues', (req, res) => {
  res.json(db.prepare(cueSelect).all().map(readCue));
});

// 新增：接受单条对象，或数组（批量提交；任一条非法则整次拒绝、全部不落库）
app.post('/api/cues', (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [req.body];
  if (rows.length === 0) return err(res, 400, '提交内容为空');

  const parsed = [];
  for (let i = 0; i < rows.length; i++) {
    const prefix = Array.isArray(req.body) ? `第 ${i + 1} 行：` : '';
    const r = validateCue(rows[i]);
    if (r.error) return err(res, 400, prefix + r.error);
    parsed.push(r.value);
  }

  // 已有编号（库内 + 本批显式指定）都要在自动分配时避开
  const used = new Set(db.prepare('SELECT cue_no FROM cues').all().map((r) => r.cue_no));
  let nextNo = (used.size ? Math.max(...used) : 0) + 1;
  for (const v of parsed) {
    if (v.cue_no !== undefined) {
      if (used.has(v.cue_no)) {
        return err(res, 409, `Cue 编号 ${v.cue_no} 冲突，本次提交已全部撤销`);
      }
      used.add(v.cue_no);
    }
  }
  for (const v of parsed) {
    if (v.cue_no === undefined) {
      while (used.has(nextNo)) nextNo++;
      v.cue_no = nextNo;
      used.add(nextNo);
      nextNo++;
    }
  }

  const insert = db.prepare(
    'INSERT INTO cues (cue_no, light_id, time, target, duration) VALUES (?, ?, ?, ?, ?)'
  );
  const tx = db.transaction((items) => {
    for (const v of items) insert.run(v.cue_no, v.light_id, v.time, v.target, v.duration);
  });
  try {
    tx(parsed);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return err(res, 409, 'Cue 编号冲突，本次提交已全部撤销');
    }
    throw e;
  }

  const created = db.prepare(cueSelect).all().map(readCue);
  res.status(201).json(created);
});

// 修改草稿 Cue
app.patch('/api/cues/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM cues WHERE id = ?').get(id);
  if (!row) return err(res, 404, `Cue ${id} 不存在`);

  const merged = {
    cue_no: 'cue_no' in req.body ? req.body.cue_no : row.cue_no,
    light_id: 'light_id' in req.body ? req.body.light_id : row.light_id,
    time: 'time' in req.body ? req.body.time : row.time,
    target: 'target' in req.body ? req.body.target : row.target,
    duration: 'duration' in req.body ? req.body.duration : row.duration,
  };
  const r = validateCue(merged, { existingId: id });
  if (r.error) return err(res, 400, r.error);
  const v = r.value;

  db.prepare(
    'UPDATE cues SET cue_no = ?, light_id = ?, time = ?, target = ?, duration = ? WHERE id = ?'
  ).run(v.cue_no, v.light_id, v.time, v.target, v.duration, id);

  res.json(db.prepare(cueSelect).all().map(readCue));
});

app.delete('/api/cues/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM cues WHERE id = ?').get(id);
  if (!row) return err(res, 404, `Cue ${id} 不存在`);
  db.prepare('DELETE FROM cues WHERE id = ?').run(id);
  res.status(204).end();
});

/* --------------------------- 发布不可变版本 ---------------------------- */

function loadVersionSnapshot(versionId) {
  const version = db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId);
  if (!version) return null;
  const lights = db
    .prepare('SELECT light_id AS id, name FROM version_lights WHERE version_id = ? ORDER BY pos')
    .all(versionId);
  const cues = db
    .prepare(
      `SELECT cue_no, light_id, time, target, duration
       FROM version_cues WHERE version_id = ? ORDER BY time, cue_no`
    )
    .all(versionId);
  // 回路配置随发布冻结；无回路表数据的早期版本返回空集（播放照常，不产生回路负载）
  const circuits = db
    .prepare(
      `SELECT circuit_id AS id, name, capacity
       FROM version_circuits WHERE version_id = ? ORDER BY pos`
    )
    .all(versionId);
  const wiring = db
    .prepare(
      `SELECT light_id, circuit_id, watts
       FROM version_light_wiring WHERE version_id = ?`
    )
    .all(versionId);
  return {
    id: version.id,
    label: version.label,
    created_at: version.created_at,
    cue_count: version.cue_count,
    lights,
    cues,
    circuits,
    wiring,
  };
}

app.post('/api/versions', (req, res) => {
  const labelRaw = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const label = labelRaw || `演出版本 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;

  const lights = db.prepare('SELECT * FROM lights ORDER BY id').all();
  const cues = db
    .prepare(
      `SELECT cue_no, light_id, time, target, duration
       FROM cues ORDER BY time, cue_no`
    )
    .all();
  const circuits = db.prepare('SELECT * FROM circuits ORDER BY id').all();

  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO versions (label, created_at, cue_count) VALUES (?, ?, ?)')
      .run(label, Date.now() / 1000, cues.length);
    const vid = info.lastInsertRowid;
    const insL = db.prepare(
      'INSERT INTO version_lights (version_id, light_id, name, pos) VALUES (?, ?, ?, ?)'
    );
    lights.forEach((l, i) => insL.run(vid, l.id, l.name, i));
    const insC = db.prepare(
      'INSERT INTO version_cues (version_id, cue_no, light_id, time, target, duration, pos) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    cues.forEach((c, i) =>
      insC.run(vid, c.cue_no, c.light_id, c.time, c.target, c.duration, i)
    );
    // 回路与接线（灯具的所属回路 + 额定瓦数）随版本一并冻结
    const insCircuit = db.prepare(
      'INSERT INTO version_circuits (version_id, circuit_id, name, capacity, pos) VALUES (?, ?, ?, ?, ?)'
    );
    circuits.forEach((c, i) => insCircuit.run(vid, c.id, c.name, c.capacity, i));
    const insWiring = db.prepare(
      'INSERT INTO version_light_wiring (version_id, light_id, circuit_id, watts) VALUES (?, ?, ?, ?)'
    );
    lights.forEach((l) => insWiring.run(vid, l.id, l.circuit_id, l.watts));
    return vid;
  });

  const vid = tx();
  res.status(201).json(loadVersionSnapshot(vid));
});

app.get('/api/versions', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT v.id, v.label, v.created_at, v.cue_count,
                (SELECT COUNT(*) FROM version_circuits vc WHERE vc.version_id = v.id) AS circuit_count
         FROM versions v ORDER BY id DESC`
      )
      .all()
  );
});

app.get('/api/versions/:id', (req, res) => {
  const snap = loadVersionSnapshot(parseInt(req.params.id, 10));
  if (!snap) return err(res, 404, '版本不存在');
  res.json(snap);
});

/* --------------------------- 两版亮度差比对 ---------------------------- */
// 只读已发布快照：不触碰草稿 Cue/灯具，也不影响任何播放会话。
// GET（query，方便直接调用/分享链接）与 POST（JSON body）均支持，同一套校验。

function round6(n) {
  const r = Math.round(n * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

function handleCompare(req, res) {
  const input = { ...req.query, ...(req.body || {}) };

  // 版本编号：正整数且必须存在（相同版本可与自身比较）
  const ids = {};
  for (const key of ['a', 'b']) {
    const field = `version_${key}`;
    const id = toPosInt(input[field]);
    if (Number.isNaN(id)) {
      return err(res, 400, `版本编号无效：${JSON.stringify(input[field])}（须为正整数）`);
    }
    ids[key] = id;
  }
  const snapA = loadVersionSnapshot(ids.a);
  if (!snapA) return err(res, 404, `版本不存在：#${ids.a}`);
  const snapB = ids.b === ids.a ? snapA : loadVersionSnapshot(ids.b);
  if (!snapB) return err(res, 404, `版本不存在：#${ids.b}`);

  // 时窗起止 / 查看时刻：非负数字
  const nums = {};
  const numFields = { start: '时窗起点', end: '时窗终点', at: '查看时刻' };
  for (const field of ['start', 'end', 'at']) {
    const n = toNum(input[field]);
    if (Number.isNaN(n)) {
      return err(res, 400, `${numFields[field]}无效：${JSON.stringify(input[field])}（须为非负数字秒数）`);
    }
    if (n < 0) {
      return err(res, 400, `${numFields[field]}无效：${n}（不得为负）`);
    }
    nums[field] = n;
  }
  if (nums.start > nums.end) {
    return err(res, 400, `时窗起点（${nums.start}）不能大于终点（${nums.end}）`);
  }
  if (nums.at < nums.start || nums.at > nums.end) {
    return err(
      res,
      400,
      `查看时刻 ${nums.at} 超出时窗 [${nums.start}, ${nums.end}]`
    );
  }

  // 亮度差阈值：0～100
  const threshold = toNum(input.threshold);
  if (Number.isNaN(threshold)) {
    return err(res, 400, `亮度差阈值无效：${JSON.stringify(input.threshold)}（须为 0～100 的数字）`);
  }
  if (threshold < 0 || threshold > 100) {
    return err(res, 400, `亮度差阈值越界：${threshold}（须在 0～100 之间）`);
  }

  const cuesA = Engine.prepareCues(snapA.cues);
  const cuesB = Engine.prepareCues(snapB.cues);
  const mapA = new Map(snapA.lights.map((l) => [l.id, l.name]));
  const mapB = new Map(snapB.lights.map((l) => [l.id, l.name]));
  const commonIds = [...mapA.keys()].filter((id) => mapB.has(id)).sort((x, y) => x - y);

  const levels = [];
  const intervals = [];
  for (const id of commonIds) {
    const va = Engine.brightnessAt(cuesA, id, nums.at);
    const vb = Engine.brightnessAt(cuesB, id, nums.at);
    const diff = Math.abs(va - vb);
    levels.push({
      light_id: id,
      name: mapA.get(id),
      brightness_a: round6(va),
      brightness_b: round6(vb),
      difference: round6(diff),
      exceeds: diff > threshold + 1e-9,
    });
    // 零长度时窗：只返回该时刻亮度，不产生任何区间
    const segs =
      nums.end > nums.start
        ? Engine.differenceIntervals(cuesA, cuesB, id, nums.start, nums.end, threshold)
        : [];
    if (segs.length > 0) intervals.push({ light_id: id, name: mapA.get(id), intervals: segs });
  }

  // 配置差异：仅在一版存在的灯具单列；缺失不等于熄灭，不参与逐灯亮度比较
  const onlyA = [...mapA.keys()]
    .filter((id) => !mapB.has(id))
    .sort((x, y) => x - y)
    .map((id) => ({ light_id: id, name: mapA.get(id) }));
  const onlyB = [...mapB.keys()]
    .filter((id) => !mapA.has(id))
    .sort((x, y) => x - y)
    .map((id) => ({ light_id: id, name: mapB.get(id) }));

  res.json({
    versions: {
      a: { id: snapA.id, label: snapA.label },
      b: { id: snapB.id, label: snapB.label },
    },
    window: { start: nums.start, end: nums.end },
    at: nums.at,
    threshold,
    levels,
    intervals,
    config_differences: { only_in_a: onlyA, only_in_b: onlyB },
  });
}

app.get('/api/compare', handleCompare);
app.post('/api/compare', handleCompare);

/* ------------------------- 临时调光记录（覆盖/归还） ------------------------- */
// 记录绑定已发布版本快照：原版 Cue 始终取快照在后台运行，草稿修改与新版本发布均不影响既有记录。
// 每次追加成功 revision + 1；提交须携带当前修订号，过期返回 409 且整次提交不写入。

function loadRecordMeta(recordId) {
  return db
    .prepare(
      `SELECT r.id, r.version_id, r.label, r.created_at, r.revision,
              v.label AS version_label
       FROM rehearsal_records r JOIN versions v ON v.id = r.version_id
       WHERE r.id = ?`
    )
    .get(recordId);
}

function loadRecordOps(recordId) {
  return db
    .prepare(
      `SELECT seq, light_id, time, op_type, target, duration
       FROM record_ops WHERE record_id = ? ORDER BY seq ASC`
    )
    .all(recordId);
}

function readRecordOp(row) {
  return {
    seq: row.seq,
    light_id: row.light_id,
    time: row.time,
    op_type: row.op_type,
    target: row.target,
    duration: row.duration,
  };
}

app.post('/api/records', (req, res) => {
  const versionId = toPosInt(req.body?.version_id);
  if (Number.isNaN(versionId)) {
    return err(res, 400, `版本编号无效：${JSON.stringify(req.body?.version_id)}（须为已发布版本的正整数编号）`);
  }
  const version = db.prepare('SELECT id FROM versions WHERE id = ?').get(versionId);
  if (!version) return err(res, 404, `版本不存在：#${versionId}，无法为其建立调光记录`);

  const labelRaw = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const label = labelRaw || `临时调光记录 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;

  const info = db
    .prepare('INSERT INTO rehearsal_records (version_id, label, created_at, revision) VALUES (?, ?, ?, 0)')
    .run(versionId, label, Date.now() / 1000);

  res.status(201).json(loadRecordDetail(info.lastInsertRowid));
});

// 记录完整内容（元数据 + 操作序列 + 绑定的版本快照）：刷新/跳转后前端据此重算
function loadRecordDetail(recordId, res) {
  const meta = loadRecordMeta(recordId);
  if (!meta) {
    if (res) return err(res, 404, `调光记录 ${recordId} 不存在`);
    return null;
  }
  const snap = loadVersionSnapshot(meta.version_id);
  return {
    id: meta.id,
    label: meta.label,
    created_at: meta.created_at,
    revision: meta.revision,
    version: { id: snap.id, label: snap.label, cue_count: snap.cue_count },
    lights: snap.lights,
    cues: snap.cues,
    ops: loadRecordOps(recordId).map(readRecordOp),
  };
}

app.get('/api/records', (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.id, r.version_id, r.label, r.created_at, r.revision,
              v.label AS version_label,
              (SELECT COUNT(*) FROM record_ops o WHERE o.record_id = r.id) AS op_count
       FROM rehearsal_records r JOIN versions v ON v.id = r.version_id
       ORDER BY r.id DESC`
    )
    .all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      version_id: r.version_id,
      version_label: r.version_label,
      label: r.label,
      created_at: r.created_at,
      revision: r.revision,
      op_count: r.op_count,
    }))
  );
});

app.get('/api/records/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const detail = loadRecordDetail(id, res);
  if (detail) res.json(detail);
});

app.delete('/api/records/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const meta = db.prepare('SELECT id FROM rehearsal_records WHERE id = ?').get(id);
  if (!meta) return err(res, 404, `调光记录 ${id} 不存在`);
  db.prepare('DELETE FROM rehearsal_records WHERE id = ?').run(id); // 操作级联删除
  res.status(204).end();
});

/**
 * 校验一条调光操作。snapshotLightIds 为绑定版本快照中的灯具编号集合。
 * 返回 { value } 或 { error }。
 */
function validateRecordOp(input, snapshotLightIds) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: '操作必须是一个对象' };
  }

  const lightId = toPosInt(input.light_id);
  if (Number.isNaN(lightId)) {
    return { error: `灯具编号无效：${JSON.stringify(input.light_id)}（须为正整数）` };
  }
  if (!snapshotLightIds.has(lightId)) {
    return { error: `灯具 #${lightId} 不在绑定的版本快照中（仅可操作该版本发布时存在的灯具）` };
  }

  const time = toNum(input.time);
  if (Number.isNaN(time)) {
    return { error: `非法时码：${JSON.stringify(input.time)}（须为非负数字秒数）` };
  }
  if (time < 0) return { error: `非法时码：${time}（不得为负）` };

  const opType = input.op_type;
  if (opType !== 'override' && opType !== 'return') {
    return { error: `非法操作类型：${JSON.stringify(opType)}（须为 "override" 覆盖 或 "return" 归还）` };
  }

  const duration = toNum(input.duration);
  if (Number.isNaN(duration)) {
    return { error: `非法时长：${JSON.stringify(input.duration)}（须为非负数字秒数）` };
  }
  if (duration < 0) return { error: `非法时长：${duration}（不得为负）` };

  const value = { light_id: lightId, time, op_type: opType, duration, target: null };

  if (opType === 'override') {
    const target = toNum(input.target);
    if (Number.isNaN(target)) {
      return { error: `覆盖操作缺少有效目标亮度：${JSON.stringify(input.target)}（须为 0～100 的数字）` };
    }
    if (target < 0 || target > 100) {
      return { error: `覆盖目标亮度越界：${target}（须在 0～100 之间）` };
    }
    value.target = target;
  } else if (input.target !== undefined && input.target !== null) {
    return { error: '归还操作不接受目标亮度（只需时码与时长，结束后完全跟随原版）' };
  }

  return { value };
}

// 追加操作：接受单条对象或数组（整批一次提交，任一非法则整批不写入）
app.post('/api/records/:id/ops', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const meta = db.prepare('SELECT * FROM rehearsal_records WHERE id = ?').get(id);
  if (!meta) return err(res, 404, `调光记录 ${id} 不存在`);

  // 修订号：必须携带且与当前一致
  if (req.body === null || typeof req.body !== 'object' || !('revision' in req.body)) {
    return err(res, 400, '提交必须携带记录修订号 revision（与服务器当前修订号一致才允许追加）');
  }
  const clientRev = toNum(req.body.revision);
  if (!Number.isInteger(clientRev) || clientRev < 0) {
    return err(res, 400, `修订号无效：${JSON.stringify(req.body.revision)}（须为非负整数）`);
  }
  if (clientRev !== meta.revision) {
    return err(
      res,
      409,
      `修订号冲突：提交基于修订号 ${clientRev}，记录当前已为修订号 ${meta.revision}；请刷新操作序列后重试（本次未写入）`
    );
  }

  const rows = Array.isArray(req.body.ops) ? req.body.ops : [req.body.op !== undefined ? req.body.op : null];
  if (!Array.isArray(req.body.ops) && req.body.op === undefined) {
    return err(res, 400, '提交缺少操作内容：请提供单个 op 对象或 ops 数组');
  }
  if (rows.length === 0) return err(res, 400, '操作数组为空，没有可追加的内容');

  const snapshotLightIds = new Set(
    db.prepare('SELECT light_id FROM version_lights WHERE version_id = ?').all(meta.version_id).map((r) => r.light_id)
  );

  // 时码不早于末项：先对库内末项比较，批内再逐条比较
  let lastRow = db
    .prepare('SELECT time FROM record_ops WHERE record_id = ? ORDER BY seq DESC LIMIT 1')
    .get(id);
  let minTime = lastRow ? lastRow.time : null;

  const parsed = [];
  for (let i = 0; i < rows.length; i++) {
    const prefix = Array.isArray(req.body.ops) ? `第 ${i + 1} 条操作：` : '';
    const r = validateRecordOp(rows[i], snapshotLightIds);
    if (r.error) return err(res, 400, prefix + r.error + '（整次提交已拒绝，未写入任何操作）');
    if (minTime !== null && r.value.time < minTime - 1e-9) {
      return err(
        res,
        400,
        `${prefix}时码 ${r.value.time} 早于上一操作时码 ${minTime}：仅允许追加不早于末项的操作（整次提交已拒绝）`
      );
    }
    minTime = r.value.time;
    parsed.push(r.value);
  }

  const tx = db.transaction(() => {
    // 事务内复查修订号，杜绝并发覆盖（better-sqlite3 同步执行，此处为双保险）
    const cur = db.prepare('SELECT revision FROM rehearsal_records WHERE id = ?').get(id);
    if (cur.revision !== clientRev) {
      const e = new Error(`REVISION_CONFLICT:${cur.revision}`);
      e.code = 'REVISION_CONFLICT';
      e.current = cur.revision;
      throw e;
    }
    const maxSeq =
      db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM record_ops WHERE record_id = ?').get(id).m;
    const ins = db.prepare(
      'INSERT INTO record_ops (record_id, seq, light_id, time, op_type, target, duration) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    parsed.forEach((v, i) => {
      ins.run(id, maxSeq + i + 1, v.light_id, v.time, v.op_type, v.target, v.duration);
    });
    db.prepare('UPDATE rehearsal_records SET revision = revision + 1 WHERE id = ?').run(id);
  });

  try {
    tx();
  } catch (e) {
    if (e.code === 'REVISION_CONFLICT') {
      return err(res, 409, `修订号冲突：记录当前修订号为 ${e.current}（本次未写入）`);
    }
    throw e;
  }

  res.status(201).json(loadRecordDetail(id, res));
});

// 查看任意时刻的逐灯实际输出（原版在后台运行，叠加覆盖/归还操作序列后重算）
app.get('/api/records/:id/output', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const meta = loadRecordMeta(id);
  if (!meta) return err(res, 404, `调光记录 ${id} 不存在`);

  const at = toNum(req.query.at);
  if (Number.isNaN(at)) {
    return err(res, 400, `查看时刻无效：${JSON.stringify(req.query.at)}（须为非负数字秒数）`);
  }
  if (at < 0) return err(res, 400, `查看时刻无效：${at}（不得为负）`);

  const snap = loadVersionSnapshot(meta.version_id);
  const baseCues = Engine.prepareCues(snap.cues);
  const byLight = Engine.prepareOverrides(loadRecordOps(id), baseCues);

  const levels = snap.lights.map((l) => {
    const original = Engine.brightnessAt(baseCues, l.id, at);
    const actual = Engine.overrideBrightnessAt(byLight, baseCues, l.id, at);
    const active = Engine.activeOverride(byLight, l.id, at);
    return {
      light_id: l.id,
      name: l.name,
      original: round6(original),
      actual: round6(actual),
      overridden: Math.abs(actual - original) > 1e-9 || active !== null,
      state: active ? active.state : 'original', // override 覆盖中 / return 归还融合中 / original 跟随原版
      active_seq: active ? active.seq : null,
    };
  });

  res.json({
    record: { id: meta.id, label: meta.label, revision: meta.revision },
    version: { id: snap.id, label: snap.label },
    at,
    levels,
  });
});

/* ----------------------- 回路负载预判（只读精确分析） ----------------------- */
// 针对已发布版本，或绑定它的临时调光记录：按每灯【实际亮度/100×额定瓦数】汇总到回路，
// 返回查看时刻各回路负载，以及时窗内【严格超出】容量的全部连续区间（含端点包含性）。
// 瞬变、同秒顺序、渐变接管、归还与持续变化原版亮度的融合均走灯光引擎既有规则；
// 区间在转折点之间用一/二次方程精确求根，不做固定步长采样。只读，不改动任何数据。

function parseLoadWindow(input) {
  const nums = {};
  const labels = { start: '时窗起点', end: '时窗终点', at: '查看时刻' };
  for (const field of ['start', 'end', 'at']) {
    const n = toNum(input[field]);
    if (Number.isNaN(n)) {
      return { error: `${labels[field]}无效：${JSON.stringify(input[field])}（须为非负数字秒数）` };
    }
    if (n < 0) return { error: `${labels[field]}无效：${n}（不得为负）` };
    nums[field] = n;
  }
  if (nums.start > nums.end) {
    return { error: `时窗起点（${nums.start}）不能大于终点（${nums.end}）` };
  }
  if (nums.at < nums.start || nums.at > nums.end) {
    return { error: `查看时刻 ${nums.at} 超出时窗 [${nums.start}, ${nums.end}]` };
  }
  return { value: nums };
}

// 由版本快照构造回路 -> 成员灯具（{light_id, watts}）映射；未分配回路的灯具不计入
function buildCircuitMembers(snap) {
  const members = new Map();
  for (const c of snap.circuits) members.set(c.id, []);
  for (const w of snap.wiring) {
    if (w.circuit_id === null || w.circuit_id === undefined) continue;
    if (!members.has(w.circuit_id)) continue; // 防御：接线指向快照内不存在的回路
    members.get(w.circuit_id).push({ light_id: w.light_id, watts: w.watts });
  }
  for (const list of members.values()) list.sort((x, y) => x.light_id - y.light_id);
  return members;
}

function handleLoad(req, res) {
  const input = { ...req.query, ...(req.body || {}) };

  // 分析目标：版本 或 绑定版本的调光记录，二者恰好给一个
  const hasVersion = input.version_id !== undefined && input.version_id !== '';
  const hasRecord = input.record_id !== undefined && input.record_id !== '';
  if (hasVersion === hasRecord) {
    return err(res, 400, '请且仅请指定一个分析目标：version_id（已发布版本）或 record_id（绑定该版本的调光记录）');
  }

  let snap;
  let recordInfo = null;
  if (hasRecord) {
    const recordId = toPosInt(input.record_id);
    if (Number.isNaN(recordId)) {
      return err(res, 400, `调光记录编号无效：${JSON.stringify(input.record_id)}（须为正整数）`);
    }
    const meta = loadRecordMeta(recordId);
    if (!meta) return err(res, 404, `调光记录不存在：#${recordId}`);
    snap = loadVersionSnapshot(meta.version_id);
    recordInfo = {
      id: meta.id,
      label: meta.label,
      revision: meta.revision,
      ops: loadRecordOps(recordId),
    };
  } else {
    const versionId = toPosInt(input.version_id);
    if (Number.isNaN(versionId)) {
      return err(res, 400, `版本编号无效：${JSON.stringify(input.version_id)}（须为正整数）`);
    }
    snap = loadVersionSnapshot(versionId);
    if (!snap) return err(res, 404, `版本不存在：#${versionId}`);
  }

  const win = parseLoadWindow(input);
  if (win.error) return err(res, 400, win.error);
  const { start, end, at } = win.value;

  // 实际亮度：版本直接跑快照 Cue；记录则叠加其覆盖/归还操作序列
  const baseCues = Engine.prepareCues(snap.cues);
  const byLight = recordInfo
    ? Engine.prepareOverrides(recordInfo.ops, baseCues)
    : new Map();

  const membersByCircuit = buildCircuitMembers(snap);
  const nameOfLight = new Map(snap.lights.map((l) => [l.id, l.name]));

  const circuits = snap.circuits.map((c) => {
    const members = membersByCircuit.get(c.id) || [];
    const load = Engine.circuitLoadAt(byLight, baseCues, members, at);
    const intervals =
      end > start
        ? Engine.circuitOverloadIntervals(byLight, baseCues, members, start, end, c.capacity)
        : [];
    return {
      circuit_id: c.id,
      name: c.name,
      capacity: c.capacity,
      lights: members.map((m) => ({
        light_id: m.light_id,
        name: nameOfLight.get(m.light_id) ?? `#${m.light_id}`,
        watts: m.watts,
      })),
      load_at: round6(load),
      overloaded: load - c.capacity > 1e-9,
      intervals,
    };
  });

  res.json({
    source: recordInfo
      ? {
          kind: 'record',
          record: { id: recordInfo.id, label: recordInfo.label, revision: recordInfo.revision },
          version: { id: snap.id, label: snap.label },
        }
      : { kind: 'version', version: { id: snap.id, label: snap.label } },
    window: { start, end },
    at,
    // 早期无回路配置的版本：回路为空，播放照常，不产生回路负载
    has_circuit_config: snap.circuits.length > 0,
    circuits,
  });
}

app.get('/api/load', handleLoad);
app.post('/api/load', handleLoad);

/* ----------------- 草稿三方合并（预览令牌 + 一次事务提交） ----------------- */
// 两组排演人员从同一已发布版本（base 共同基线）各自改稿：当前草稿（draft）为一方成果，
// 另一已发布版本（incoming 待合入）按灯具/回路编号、Cue 编号、灯具接线做三方比较。
// 预览只读并颁发一次性令牌；提交逐项抉择，草稿在预览后被编辑过则 409 要求重新预览，
// 最终结果仍违反唯一性/引用规则则整次拒绝；成功后一次事务重写灯具/回路/接线/Cue。

const PREVIEW_TTL_SECONDS = 24 * 3600;

// 当前草稿按版本快照同构读出（接线来自灯具行）
function loadDraftState() {
  const lights = db.prepare('SELECT id, name, circuit_id, watts FROM lights ORDER BY id ASC').all();
  const circuits = db
    .prepare('SELECT id, name, capacity FROM circuits ORDER BY id ASC')
    .all();
  const cues = db
    .prepare('SELECT cue_no, light_id, time, target, duration FROM cues ORDER BY cue_no ASC')
    .all();
  return {
    lights: lights.map(({ id, name }) => ({ id, name })),
    circuits,
    cues,
    wiring: lights.map((l) => ({
      light_id: l.id,
      circuit_id: l.circuit_id ?? null,
      watts: l.watts ?? null,
    })),
  };
}

// 草稿内容版本戳：灯具/回路/Cue/接线任一变化都会改变；提交时据此判断预览后是否被编辑
function computeDraftStamp(state) {
  return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

// 三方快照中出现过的编号 -> 名称（重名/改名时以后遍历侧为准），仅供展示
function buildNameCtx(base, draft, incoming) {
  const lightNames = new Map();
  const circuitNames = new Map();
  for (const snap of [base, draft, incoming]) {
    for (const l of snap.lights) lightNames.set(l.id, l.name);
    for (const c of snap.circuits) circuitNames.set(c.id, c.name);
  }
  return {
    lightName: (id) => lightNames.get(id) ?? `#${id}（该侧不存在）`,
    circuitName: (id) => circuitNames.get(id) ?? `#${id}（该侧不存在）`,
  };
}

function enrichValue(kind, v, ctx) {
  if (v === null || v === undefined) return null;
  if (kind === 'cue') {
    return { ...v, light_name: ctx.lightName(v.light_id) };
  }
  if (kind === 'wiring') {
    return {
      ...v,
      light_name: ctx.lightName(v.light_id),
      circuit_name: v.circuit_id === null ? null : ctx.circuitName(v.circuit_id),
    };
  }
  return { ...v };
}

function entryTitle(c) {
  if (c.kind === 'cue') return `Cue #${c.id}`;
  if (c.kind === 'wiring') return `灯具 #${c.id} 的接线`;
  return `${c.label} #${c.id}`;
}

// 单条冲突原因的中文说明（name_collision / reference_missing 区分抉择侧）
function describeReason(kind, id, r) {
  const sideText = r.side === 'draft' ? '保留草稿侧' : '采用待合入版本侧';
  switch (r.code) {
    case 'both_modified':
      return '两侧相对共同基线做了不同修改';
    case 'delete_vs_modify':
      return '一侧删除而另一侧做了修改（删除与修改并存）';
    case 'same_key_diff':
      return '同编号新增但两侧内容不同';
    case 'name_collision':
      return `若${sideText}，名称「${r.detail.name}」与同表另一项重名（${kind === 'light' ? '灯具' : '回路'}名称须唯一）`;
    case 'reference_missing':
      if (kind === 'cue') {
        return `若${sideText}，Cue #${id} 引用的灯具 #${r.detail.missing_light_id} 在合并结果中不存在`;
      }
      return `若${sideText}，灯具 #${id} 的接线引用了合并结果中不存在的回路 #${r.detail.missing_circuit_id}`;
    case 'reference_dependency': {
      const sideText2 = r.side === 'draft' ? '保留草稿侧' : '采用待合入版本侧';
      const who = r.detail.by_kind === 'cue' ? `Cue #${r.detail.by_id}` : `灯具 #${r.detail.by_id} 的接线`;
      const what = kind === 'light' ? '灯具' : '回路';
      return `若${sideText2}，${who} 引用本${what}；请与该冲突选择同一侧（删除本项则该引用无法保留）`;
    }
    case 'attached_to_conflict': {
      const hostLabel = r.detail.host_kind === 'light' ? `灯具 #${r.detail.host_id}` : `回路 #${r.detail.host_id}`;
      return `随冲突项 ${hostLabel} 一并新增：选择是否引入该${hostLabel}时此项跟随同侧处理`;
    }
    default:
      return r.code;
  }
}

function describeViolation(v) {
  const { kind, id } = Merge.parseKey(v.key);
  return describeReason(kind, id, { code: v.code, detail: v.detail });
}

function presentAuto(e, ctx) {
  const actionText = {
    add: '采用待合入版本的新增',
    update: '采用待合入版本的修改',
    delete: '按待合入版本删除（草稿侧未改）',
  };
  return {
    kind: e.kind,
    key: e.key,
    id: e.id,
    title: entryTitle(e),
    action: e.action,
    action_text: actionText[e.action],
    base: enrichValue(e.kind, e.base, ctx),
    current: enrichValue(e.kind, e.current, ctx),
    incoming: enrichValue(e.kind, e.incoming, ctx),
    applied: enrichValue(e.kind, e.applied, ctx),
  };
}

function presentConflict(c, ctx) {
  return {
    kind: c.kind,
    key: c.key,
    id: c.id,
    title: entryTitle(c),
    reason: c.reason,
    reason_text: describeReason(c.kind, c.id, c.reasons[0]),
    reasons: c.reasons.map((r) => ({
      code: r.code,
      side: r.side || null,
      text: describeReason(c.kind, c.id, r),
    })),
    base: enrichValue(c.kind, c.base, ctx),
    draft: enrichValue(c.kind, c.draft, ctx),
    incoming: enrichValue(c.kind, c.incoming, ctx),
  };
}

function parseMergeVersions(body) {
  const out = {};
  for (const [field, label] of [
    ['base_version_id', '共同基线版本'],
    ['incoming_version_id', '待合入版本'],
  ]) {
    const id = toPosInt(body?.[field]);
    if (Number.isNaN(id)) {
      return { error: `${label}编号无效：${JSON.stringify(body?.[field])}（须为正整数）` };
    }
    out[field] = id;
  }
  return { value: out };
}

// POST /api/merge/preview  只读三方比较，颁发预览令牌（不写任何业务数据）
app.post('/api/merge/preview', (req, res) => {
  const parsed = parseMergeVersions(req.body);
  if (parsed.error) return err(res, 400, parsed.error);
  const { base_version_id: baseId, incoming_version_id: incomingId } = parsed.value;

  const base = loadVersionSnapshot(baseId);
  if (!base) return err(res, 404, `共同基线版本不存在：#${baseId}`);
  const incoming =
    incomingId === baseId ? base : loadVersionSnapshot(incomingId);
  if (!incoming) return err(res, 404, `待合入版本不存在：#${incomingId}`);

  const draftState = loadDraftState();
  const cls = Merge.classify(base, draftState, incoming);
  const ctx = buildNameCtx(base, draftState, incoming);

  // 清理过期预览令牌
  db.prepare('DELETE FROM merge_previews WHERE created_at < ?').run(
    Date.now() / 1000 - PREVIEW_TTL_SECONDS
  );

  const token = crypto.randomBytes(24).toString('hex');
  db.prepare(
    `INSERT INTO merge_previews (token, base_id, incoming_id, draft_stamp, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    token,
    baseId,
    incomingId,
    computeDraftStamp(draftState),
    JSON.stringify({ auto: cls.auto, conflicts: cls.conflicts, summary: cls.summary }),
    Date.now() / 1000
  );

  res.json({
    token,
    base: { id: base.id, label: base.label },
    incoming: { id: incoming.id, label: incoming.label },
    draft_stamp: computeDraftStamp(draftState),
    summary: cls.summary,
    auto: cls.auto.map((e) => presentAuto(e, ctx)),
    conflicts: cls.conflicts.map((c) => presentConflict(c, ctx)),
    draft: draftState,
  });
});

// POST /api/merge/commit  凭令牌与逐项抉择一次事务提交
app.post('/api/merge/commit', (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const row = token ? db.prepare('SELECT * FROM merge_previews WHERE token = ?').get(token) : null;
  if (!row) {
    return err(res, 404, '合并预览不存在或已失效：请重新发起预览（预览不写库，令牌一次性有效）');
  }

  const base = loadVersionSnapshot(row.base_id);
  const incoming =
    row.incoming_id === row.base_id ? base : loadVersionSnapshot(row.incoming_id);
  if (!base || !incoming) {
    db.prepare('DELETE FROM merge_previews WHERE token = ?').run(token);
    return err(res, 404, '预览引用的版本已不存在，请重新预览');
  }

  // 草稿在预览后发生编辑：当前内容版本戳与预览时不一致 → 409，要求重新预览
  const draftState = loadDraftState();
  const currentStamp = computeDraftStamp(draftState);
  if (currentStamp !== row.draft_stamp) {
    db.prepare('DELETE FROM merge_previews WHERE token = ?').run(token);
    return err(
      res,
      409,
      '草稿在预览之后已被编辑，本次合并结果已过期：请重新预览并逐项抉择后再提交（本次未写入）'
    );
  }

  const resolutions = req.body?.resolutions;
  if (resolutions === null || typeof resolutions !== 'object' || Array.isArray(resolutions)) {
    return err(res, 400, '提交必须携带 resolutions 抉择对象（冲突 key -> "draft" 或 "incoming"）');
  }

  const result = Merge.resolve(base, draftState, incoming, resolutions);
  if (!result.ok) {
    const body = { error: '合并结果仍不合法，整次提交已拒绝（未写入任何数据）' };
    if (result.badResolutions.length > 0) {
      body.error = `抉择内容无效：${result.badResolutions[0].key} ${result.badResolutions[0].reason}`;
      body.bad_resolutions = result.badResolutions;
    } else if (result.unresolved.length > 0) {
      body.error = `仍有 ${result.unresolved.length} 个冲突未做选择，请逐项选择「保留草稿」或「采用待合入版本」后再提交`;
      body.unresolved = result.unresolved;
    } else if (result.violations.length > 0) {
      body.error = '合并结果仍违反唯一性或引用规则，整次提交已拒绝：' +
        result.violations.map(describeViolation).join('；');
      body.violations = result.violations.map((v) => ({
        key: v.key,
        code: v.code,
        detail: v.detail,
        text: describeViolation(v),
      }));
    }
    return res.status(400).json(body);
  }

  const finalState = result.final;
  const stampExpected = row.draft_stamp;

  const applyMerge = db.transaction(() => {
    // 事务内再次确认草稿未被并发改动（双保险）
    if (computeDraftStamp(loadDraftState()) !== stampExpected) {
      const e = new Error('DRAFT_CHANGED');
      e.code = 'DRAFT_CHANGED';
      throw e;
    }

    const keepLightIds = new Set(finalState.lights.map((l) => l.id));
    const keepCircuitIds = new Set(finalState.circuits.map((c) => c.id));
    const keepCueNos = new Set(finalState.cues.map((c) => c.cue_no));

    // 1) 灯具：先 upsert（Cue 外键需要），最后删除不再保留的
    const upsertLight = db.prepare(
      `INSERT INTO lights (id, name, created_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name`
    );
    for (const l of finalState.lights) {
      upsertLight.run(l.id, l.name, Date.now() / 1000);
    }

    // 2) Cue：删除待移除编号，upsert 保留项（编号即业务身份，保持稳定）
    db.prepare('DELETE FROM cues WHERE cue_no NOT IN (SELECT value FROM json_each(?))').run(
      JSON.stringify([...keepCueNos])
    );
    const upsertCue = db.prepare(
      `INSERT INTO cues (cue_no, light_id, time, target, duration) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (cue_no) DO UPDATE SET
         light_id = excluded.light_id, time = excluded.time,
         target = excluded.target, duration = excluded.duration`
    );
    for (const c of finalState.cues) {
      upsertCue.run(c.cue_no, c.light_id, c.time, c.target, c.duration);
    }

    // 3) 删除不再保留的灯具（其 Cue 已随上面的投影结果移除）
    db.prepare('DELETE FROM lights WHERE id NOT IN (SELECT value FROM json_each(?))').run(
      JSON.stringify([...keepLightIds])
    );

    // 4) 接线：逐灯落定所属回路与额定瓦数
    const setWiring = db.prepare(
      'UPDATE lights SET circuit_id = ?, watts = ? WHERE id = ?'
    );
    for (const w of finalState.wiring) {
      setWiring.run(w.circuit_id, w.watts, w.light_id);
    }

    // 5) 回路：upsert 保留项，删除不再保留的（最终接线已不再引用它们）
    const upsertCircuit = db.prepare(
      `INSERT INTO circuits (id, name, capacity, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, capacity = excluded.capacity`
    );
    for (const c of finalState.circuits) {
      upsertCircuit.run(c.id, c.name, c.capacity, Date.now() / 1000);
    }
    db.prepare('DELETE FROM circuits WHERE id NOT IN (SELECT value FROM json_each(?))').run(
      JSON.stringify([...keepCircuitIds])
    );

    // 6) 令牌一次性使用
    db.prepare('DELETE FROM merge_previews WHERE token = ?').run(token);
  });

  try {
    applyMerge();
  } catch (e) {
    if (e.code === 'DRAFT_CHANGED') {
      return err(res, 409, '草稿在提交时已被他人编辑，请重新预览后再提交（本次未写入）');
    }
    // 兜底：唯一性/外键等约束未被前置校验覆盖时，整次回滚并返回可读中文错误
    if (String(e.message || '').includes('UNIQUE') || String(e.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return err(res, 400, `合并结果违反数据库唯一/引用约束，整次提交已拒绝：${e.message}（未写入任何数据）`);
    }
    throw e;
  }

  // 返回合并后的新草稿（已发布版本与绑定的调光记录均不变）
  res.json({
    merged: true,
    base: { id: base.id, label: base.label },
    incoming: { id: incoming.id, label: incoming.label },
    summary: result.summary,
    draft: {
      lights: db.prepare('SELECT * FROM lights ORDER BY id ASC').all(),
      circuits: db.prepare(circuitSelect).all().map(readCircuit),
      cues: db.prepare(cueSelect).all().map(readCue),
    },
  });
});

/* ----------------------- 共享房间（同一舞台同步观看） ----------------------- */
// 排演人员基于一个已发布版本创建共享房间：创建者取得控制密钥，其他人凭房间码观看
// 同一舞台与逐灯亮度。房间固定所选版本，保存播放/暂停、基准时码、速度及修订号；
// 服务端按墙钟推算当前时码，到版本末尾自动停住；页面刷新、服务重启、观看者重连后
// 均能恢复进度。后续草稿修改和发布不影响它。房间操作不改版本、草稿或调光记录。
// 持密钥者可播放、暂停、跳转及设置 0.5/1/2 倍速；控制请求携带当前修订号，过期返回
// 409 冲突且不改房间。
//
// 回路超载保护（创建时可选启用）：只使用房间固定版本快照中的回路容量与灯具接线
// （旧版快照无回路配置时没有任何超载回路）。服务端按既有逐灯亮度与负载规则，找出
// 播放方向上首个负载【严格大于】容量的区间左边界；播放惰性推算一旦抵达该边界即
// 暂停在此并惰性落库（不增加控制修订号），返回触发回路与演出时码——观看端轮询
// 间隔再长也不会越过危险段。当前时码已超载时拒绝播放；播放中跳入超载段拒绝且
// 房间不变；暂停时允许跳转（可用于跳过/避开危险段）。

const ROOM_CODE_LEN = 6;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除 0/O/1/I 等易混字符
const ROOM_SPEEDS = [0.5, 1, 2];
// 与引擎一致的端点浮点容差（超载区间端点已按 1e-9 归整）
const ROOM_EPS = 1e-7;
// 主持权交接凭证有效期：五分钟（凭证仅在发起响应中完整显示一次）
const HANDOVER_TTL_SECONDS = 300;

// 等长常量时间比较，避免密钥/凭证比较的计时侧信道；长度不同直接失败
function secretEqual(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function genRoomCode() {
  for (;;) {
    let code = '';
    const bytes = crypto.randomBytes(ROOM_CODE_LEN);
    for (let i = 0; i < ROOM_CODE_LEN; i++) code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    if (!db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(code)) return code;
  }
}

const roomSelect = `
  SELECT r.*, v.label AS version_label
  FROM rooms r JOIN versions v ON v.id = r.version_id
`;

function getRoomRowByCode(code) {
  return db.prepare(`${roomSelect} WHERE r.code = ?`).get(code);
}

// 房间码归一化：去除首尾空白与内部连字符/空格并转大写；长度不符视为格式非法
function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return '';
  const code = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return code;
}

// 由版本快照求房间末尾时刻：最后一条 Cue 渐变结束时刻（无 Cue 为 0）
function roomDurationForSnapshot(snap) {
  return Engine.showDuration(Engine.prepareCues(snap.cues));
}

/* ---------------- 房间超载保护（基于不可变版本快照，进程内缓存） ---------------- */

// versionId -> 保护器。版本快照不可变，故缓存永不失效；快照无回路配置时
// circuits 为空数组（启用了保护也不会产生任何超载回路）。
const roomGuardCache = new Map();

function loadRoomGuard(versionId) {
  const cached = roomGuardCache.get(versionId);
  if (cached) return cached;
  const snap = loadVersionSnapshot(versionId);
  if (!snap) return null;
  const baseCues = Engine.prepareCues(snap.cues);
  const duration = Engine.showDuration(baseCues);
  const membersByCircuit = buildCircuitMembers(snap);

  const circuitsInOrder = [];
  // 全部回路的超载区间左边界（按时码、再按回路编号定序），供播放方向上取“首个”
  const boundaries = [];
  for (const c of snap.circuits) {
    const members = membersByCircuit.get(c.id) || [];
    // 保护判定与负载预判页同一套精确求根（一/二次方程，不做步长采样）
    const intervals =
      duration > 0
        ? Engine.circuitOverloadIntervals(new Map(), baseCues, members, 0, duration, c.capacity)
        : [];
    const entry = { id: c.id, name: c.name, capacity: c.capacity, members, intervals };
    circuitsInOrder.push(entry);
    for (const iv of intervals) boundaries.push({ start: iv.start, interval: iv, circuit: entry });
  }
  boundaries.sort((x, y) => x.start - y.start || x.circuit.id - y.circuit.id);

  const guard = {
    duration,
    circuitsInOrder,
    circuitsById: new Map(circuitsInOrder.map((c) => [c.id, c])),
    boundaries,
  };
  roomGuardCache.set(versionId, guard);
  return guard;
}

// t 是否落在某条（严格超载）区间内：交点开端点不算超载，触发瞬间闭端点算
function intervalContains(iv, t) {
  if (t < iv.start - ROOM_EPS || t > iv.end + ROOM_EPS) return false;
  if (Math.abs(t - iv.start) <= ROOM_EPS) return !!iv.start_inclusive;
  if (Math.abs(t - iv.end) <= ROOM_EPS) return !!iv.end_inclusive;
  return true;
}

function circuitRef(c) {
  return { circuit_id: c.id, name: c.name, capacity: c.capacity };
}

// 时刻 t 全部处于超载状态的回路（按回路编号排序）
function overloadedCircuitsAt(guard, t) {
  const out = [];
  for (const c of guard.circuitsInOrder) {
    if (c.intervals.some((iv) => intervalContains(iv, t))) out.push(circuitRef(c));
  }
  return out;
}

/**
 * 播放从锚点时码 fromTime 推进到 t 时撞上的首个超载区间左边界。
 *  - 边界严格在锚点前方：推进抵达（含恰好抵达开端点——该瞬间负载等于容量，
 *    按“抵达边界即停”冻结在此，不进入其后的危险段）即拦截；
 *  - 边界与锚点重合/仅差浮点噪声（开端点恰好等于锚点）：锚点本身尚安全，
 *    但墙钟一旦真正推进（t > fromTime）就立刻冻结在边界上；
 *  - 严格位于锚点后方的边界不再拦截。
 */
function tripBoundaryBetween(guard, fromTime, t) {
  for (const b of guard.boundaries) {
    if (b.start < fromTime - ROOM_EPS) continue; // 严格在身后
    if (b.start > fromTime + ROOM_EPS) {
      if (b.start <= t + ROOM_EPS) return b; // 前方边界：已抵达
    } else if (t > fromTime + ROOM_EPS) {
      return b; // 锚点就在（开）边界上：时间一推进即冻结在此
    }
  }
  return null;
}

// 当前位置前方最近的超载边界（仅用于页面提示）
function nextBoundaryAfter(guard, t) {
  for (const b of guard.boundaries) {
    if (b.start >= t - ROOM_EPS) return b;
  }
  return null;
}

// 读取房间的循环排演编排行（不存在 = 未编排；含从未编排、手动跳转取消、走完已清行）
function getRoomProgram(roomId) {
  const p = db.prepare('SELECT * FROM room_programs WHERE room_id = ?').get(roomId);
  if (!p) return null;
  let segments;
  try {
    segments = JSON.parse(p.segments);
  } catch {
    return null;
  }
  if (!Array.isArray(segments) || segments.length === 0) return null;
  return { ...p, segments, finished: !!p.finished };
}

// 读取房间讨论停点：不存在/空组 = 无停点；返回升序时码数组（写入时已排序去重）
function getRoomStops(roomId) {
  const row = db.prepare('SELECT times FROM room_stops WHERE room_id = ?').get(roomId);
  if (!row) return [];
  try {
    const times = JSON.parse(row.times);
    return Array.isArray(times) ? times : [];
  } catch {
    return [];
  }
}

/**
 * 播放从锚点时码 fromTime 连续向上推进到 t 时撞上的首个讨论停点。
 * 停点只在“连续经过”时触发：锚点本身（含暂停在刚触发的停点上）不算，
 * 必须严格位于锚点前方且已被抵达（t >= s）。段尾瞬时跳转落点之间未连续
 * 经过的时码由调用方分段调用本函数，故不会误触发被跳过的停点。
 */
function nextStopBetween(stops, fromTime, t) {
  for (const s of stops) {
    if (s <= fromTime + ROOM_EPS) continue; // 锚点及身后：不触发
    if (s <= t + ROOM_EPS) return s; // 前方停点：已抵达
  }
  return null;
}

/**
 * 读取房间当前状态：服务端按墙钟推算时码。
 * 播放中按 time + (now - anchor_wall) * speed 推算；到末尾则自动停住并惰性落库
 * （不改修订号：这只是时间流逝的结果，不与任何控制竞争）。
 * 启用超载保护且提供 guard 时：推算一旦抵达前方首个超载区间左边界，即暂停在该
 * 边界上并惰性落库（同样不改修订号），返回 trip 信息——无论观看端多久轮询一次，
 * 时码都不会越过危险段。
 *
 * 循环排演（prog 非空）：墙钟先给出线性目标时码，再由 Program.advanceProgram
 * 按段尾跳回/跳段规则把它映射到真实演出时码；段尾跳跃不耗墙钟。整次编排走完
 * 停在末段终点（惰性落库 finished=1，不改修订号）；编排进行中抵达超载边界同样
 * 自动暂停（不越过危险段、不加修订号）。
 *
 * 讨论停点（stops 非空）：播放连续向上经过任一停点即在该时码自动暂停并惰性落库
 * （不改修订号），返回 stopHit 时码。停点与超载边界同时码时超载优先（同一时码
 * 优先超载）；段尾瞬时跳回/跳段不经过的时码不会触发；编排循环再次经过同一停点
 * 仍会暂停。
 */
function computeRoomState(row, { now = Date.now() / 1000, persistStopped = false, guard = null, prog = undefined, stops = undefined } = {}) {
  if (prog === undefined) prog = getRoomProgram(row.id);
  if (stops === undefined) stops = getRoomStops(row.id);
  let playing = !!row.playing;
  let time = row.time;
  let ended = false;
  let trip = null;
  let stopHit = null;
  const progState = prog
    ? { segIndex: prog.seg_index, iteration: prog.iteration, time: prog.prog_time, finished: !!prog.finished }
    : null;

  if (playing) {
    const elapsed = Math.max(0, now - row.anchor_wall) * row.speed;

    if (prog && !prog.finished) {
      // 编排播放：墙钟目标 -> 段/轮/时码映射；段尾瞬时跳跃落点之间不连续经过，
      // 引擎对每个连续段分别回调，故跳过段内的超载边界/停点都不会误触发
      const findEvent = (segIndex, fromT, toT) => {
        if (guard) {
          const b = guard.boundaries.find((x) => x.start >= fromT - ROOM_EPS && x.start <= toT + ROOM_EPS);
          // 同一时码优先超载：仅当停点严格更早（超过容差）时才由停点抢先
          const s = nextStopBetween(stops, fromT, toT);
          if (b && (s === null || b.start <= s + ROOM_EPS)) return { start: b.start, kind: 'boundary', boundary: b };
          if (s !== null) return { start: s, kind: 'stop' };
          return null;
        }
        const s = nextStopBetween(stops, fromT, toT);
        return s === null ? null : { start: s, kind: 'stop' };
      };
      const r = Program.advanceProgram(progState, prog.segments, progState.time + elapsed, findEvent);
      time = r.time;
      progState.segIndex = r.segIndex;
      progState.iteration = r.iteration;
      progState.time = r.time;
      progState.finished = r.finished;
      if (r.boundary) {
        playing = false;
        if (r.boundary.kind === 'stop') {
          stopHit = r.boundary.start;
        } else {
          trip = { circuit_id: r.boundary.boundary.circuit.id, time: r.boundary.start };
        }
      } else if (r.finished) {
        playing = false;
        ended = true;
      }

      if (!playing && persistStopped) {
        if (ended) {
          const lastSeg = prog.segments[prog.segments.length - 1];
          db.prepare(
            `UPDATE rooms SET playing = 0, time = ?, anchor_wall = ?,
                             tripped_circuit_id = NULL, tripped_time = NULL,
                             tripped_stop_time = NULL, tripped_reason = NULL WHERE id = ?`
          ).run(lastSeg.end, now, row.id);
          db.prepare(
            `UPDATE room_programs SET seg_index = ?, iteration = ?, prog_time = ?, finished = 1 WHERE room_id = ?`
          ).run(prog.segments.length - 1, lastSeg.repeat - 1, lastSeg.end, row.id);
        } else if (trip) {
          // 自动暂停：固化在超载区间左边界；不增加控制修订号
          db.prepare(
            `UPDATE rooms SET playing = 0, time = ?, anchor_wall = ?,
                             tripped_circuit_id = ?, tripped_time = ?,
                             tripped_stop_time = NULL, tripped_reason = ? WHERE id = ?`
          ).run(trip.time, now, trip.circuit_id, trip.time, 'overload_boundary', row.id);
          db.prepare(
            `UPDATE room_programs SET seg_index = ?, iteration = ?, prog_time = ? WHERE room_id = ?`
          ).run(progState.segIndex, progState.iteration, trip.time, row.id);
        } else if (stopHit !== null) {
          // 讨论停点自动暂停：固化在停点时码；不增加控制修订号
          db.prepare(
            `UPDATE rooms SET playing = 0, time = ?, anchor_wall = ?,
                             tripped_circuit_id = NULL, tripped_time = NULL,
                             tripped_stop_time = ?, tripped_reason = ? WHERE id = ?`
          ).run(stopHit, now, stopHit, 'stop_point', row.id);
          db.prepare(
            `UPDATE room_programs SET seg_index = ?, iteration = ?, prog_time = ? WHERE room_id = ?`
          ).run(progState.segIndex, progState.iteration, stopHit, row.id);
        }
      }
    } else {
      let t = row.time + elapsed;

      // 连续向上经过的首个事件：超载边界优先于同时码停点；两者都先于版本末尾
      const guardHit = guard ? tripBoundaryBetween(guard, row.time, t) : null;
      const stopAt = nextStopBetween(stops, row.time, t);
      const stopWins = stopAt !== null && (!guardHit || stopAt < guardHit.start - ROOM_EPS);
      if (guardHit && !stopWins) {
        t = guardHit.start;
        playing = false;
        trip = { circuit_id: guardHit.circuit.id, time: guardHit.start };
      } else if (stopWins) {
        t = stopAt;
        playing = false;
        stopHit = stopAt;
      }

      if (playing && t >= row.duration) {
        t = row.duration;
        playing = false;
        ended = true;
      }

      if (!playing && persistStopped) {
        if (ended) {
          db.prepare(
            `UPDATE rooms SET playing = 0, time = duration, anchor_wall = ?,
                             tripped_circuit_id = NULL, tripped_time = NULL,
                             tripped_stop_time = NULL, tripped_reason = NULL WHERE id = ?`
          ).run(now, row.id);
        } else if (trip) {
          // 自动暂停：固化在超载区间左边界；不增加控制修订号
          db.prepare(
            `UPDATE rooms SET playing = 0, time = ?, anchor_wall = ?,
                             tripped_circuit_id = ?, tripped_time = ?,
                             tripped_stop_time = NULL, tripped_reason = ? WHERE id = ?`
          ).run(trip.time, now, trip.circuit_id, trip.time, 'overload_boundary', row.id);
        } else if (stopHit !== null) {
          // 讨论停点自动暂停：固化在停点时码；不增加控制修订号
          db.prepare(
            `UPDATE rooms SET playing = 0, time = ?, anchor_wall = ?,
                             tripped_circuit_id = NULL, tripped_time = NULL,
                             tripped_stop_time = ?, tripped_reason = ? WHERE id = ?`
          ).run(stopHit, now, stopHit, 'stop_point', row.id);
        }
      }
      time = t;
    }
  }
  return {
    playing,
    time,
    speed: row.speed,
    duration: row.duration,
    revision: row.revision,
    ended,
    trip,
    stopHit,
    prog: progState,
  };
}

// 组装对外的超载保护状态块（页面据此显示保护状态与触发原因）
function buildProtection(row, state, guard) {
  if (!row.overload_protection) return { enabled: false };
  const block = { enabled: true, configured: !!(guard && guard.circuitsInOrder.length > 0) };
  if (!guard || guard.circuitsInOrder.length === 0) return block;

  const over = overloadedCircuitsAt(guard, state.time);
  block.overloaded_now = over.length > 0;
  block.circuits_overloaded_now = over;

  // 未处于超载段时，预告前方最近的触发边界
  if (over.length === 0) {
    const nb = nextBoundaryAfter(guard, state.time);
    if (nb) {
      block.next_trip = {
        time: round6(nb.start),
        seconds_ahead: round6(Math.max(0, nb.start - state.time)),
        circuit: circuitRef(nb.circuit),
      };
    }
  }

  // 自动暂停标记由惰性落库的列恢复（服务重启后同样有效）；仅超载触发时在此报告
  if (row.tripped_reason === 'overload_boundary' && row.tripped_circuit_id !== null && row.tripped_circuit_id !== undefined) {
    const c = guard.circuitsById.get(row.tripped_circuit_id);
    block.tripped = {
      reason: 'overload_boundary',
      reason_text:
        '回路超载保护已触发：播放抵达超载区间左边界，已自动暂停在此（自动暂停不增加控制修订号），暂停状态下可跳转避险',
      time: round6(row.tripped_time ?? state.time),
      circuit: c
        ? circuitRef(c)
        : { circuit_id: row.tripped_circuit_id, name: `回路 #${row.tripped_circuit_id}`, capacity: null },
    };
  }
  return block;
}

// 房间当前待领取交接凭证的对外状态块（所有房间状态响应一致，观看者也可见）。
// 仅报告交接进行与否与到期信息；绝不回显凭证本体或任何控制密钥。
//  - 凭证不存在：不输出 handover 字段；
//  - 已过期 / 已被原主持人后续控制作废（绑定修订号落后于房间修订号）：active=false；
//  - 待领取：active=true，附到期墙钟、剩余秒数与发起时修订号。
function buildHandoverBlock(row, state, now) {
  const ho = db.prepare('SELECT * FROM room_handovers WHERE room_id = ?').get(row.id);
  if (!ho) return undefined;
  const block = {
    active: false,
    revision: ho.revision,
    issued_at: round6(ho.created_at),
    expires_at: round6(ho.expires_at),
  };
  const active = ho.expires_at > now && ho.revision === state.revision;
  if (active) {
    block.active = true;
    block.seconds_remaining = round6(Math.max(0, ho.expires_at - now));
  } else if (ho.revision !== state.revision) {
    block.reason = 'superseded';
    block.reason_text = '原主持人在凭证发出后又控制了房间，本交接凭证已作废，请让主持人重新发起交接';
  } else {
    block.reason = 'expired';
    block.reason_text = '交接凭证已过期（有效期五分钟），请让主持人重新发起交接';
  }
  return block;
}

// 循环排演对外状态块（创建编排 / 查询 / 控制响应一致；观看者只读可见、无密钥字段）。
// prog 行不存在（state.prog 为 null）时不输出 program 字段（未编排房间原行为兼容）。
function buildProgramBlock(row, state, prog) {
  if (!state.prog || !prog) return undefined;
  const totalLoops = prog.segments.reduce((s, g) => s + g.repeat, 0);
  const block = {
    segments: prog.segments.map((g) => ({
      start: round6(g.start),
      end: round6(g.end),
      repeat: g.repeat,
    })),
    // 当前段 / 轮次：输出 1 基，便于页面直接展示
    segment_index: state.prog.segIndex + 1,
    segment_count: prog.segments.length,
    loop: state.prog.iteration + 1,
    loop_total: prog.segments[state.prog.segIndex].repeat,
    finished: !!state.prog.finished,
    total_loops: totalLoops,
  };
  block.status = state.prog.finished ? 'finished' : state.playing ? 'playing' : 'paused';
  return block;
}

// 讨论停点对外状态块（房间状态/控制/停点替换响应一致；观看者只读可见、无密钥字段）。
// 所有房间都带 stops 字段（无停点时 times 为空数组，兼容前端统一渲染）。
function buildStopsBlock(row, state, stops) {
  const block = {
    times: stops.map(round6),
    configured: stops.length > 0,
  };

  // 已触发（停点自动暂停，惰性落库；继续播放/手动跳转/超载触发后由控制或惰性落库清除）
  if (row.tripped_reason === 'stop_point' && row.tripped_stop_time !== null && row.tripped_stop_time !== undefined) {
    block.tripped = {
      reason: 'stop_point',
      reason_text:
        '讨论停点已触发：播放连续经过预置停点，已自动暂停在此供讨论（自动暂停不增加控制修订号）；继续播放须越过本停点，循环排演再次经过仍会暂停',
      time: round6(row.tripped_stop_time ?? state.time),
    };
  }

  // 前方下一个停点（严格位于当前时码前方；停在刚触发的停点上时不再预告它）
  const next = stops.find((s) => s > state.time + ROOM_EPS) ?? null;
  block.next_stop =
    next !== null ? { time: round6(next), seconds_ahead: round6(Math.max(0, next - state.time)) } : null;
  return block;
}

// 房间对外视图（创建/查询/控制/交接共用）；state 由 computeRoomState 得到
function buildRoomView(row, state, now, guard, prog, stops) {
  const view = {
    code: row.code,
    label: row.label,
    version: { id: row.version_id, label: row.version_label },
    duration: round6(state.duration),
    playing: state.playing,
    time: round6(state.time),
    speed: state.speed,
    revision: state.revision,
    protection: buildProtection(row, state, guard),
    // 讨论停点配置与触发/预告状态（主持人可维护，观看者只读查看）
    stops: buildStopsBlock(row, state, stops === undefined ? getRoomStops(row.id) : stops),
    // 服务端墙钟与对应时码：观看端据此校时（基准时码 + 流逝时间 × 速度）
    server_wall: now,
    server_time: round6(state.time),
  };
  // 当前交接状态（不含凭证、不含密钥）；无待领取凭证时不输出该字段
  const handover = buildHandoverBlock(row, state, now);
  if (handover) view.handover = handover;
  // 循环排演状态（含段列表与当前段/轮次）；未编排房间不输出该字段
  const program = buildProgramBlock(row, state, prog);
  if (program) view.program = program;
  return view;
}

// 创建共享房间：基于已发布版本，固定版本快照，初始暂停在 0 秒
app.post('/api/rooms', (req, res) => {
  const versionId = toPosInt(req.body?.version_id);
  if (Number.isNaN(versionId)) {
    return err(res, 400, `版本编号无效：${JSON.stringify(req.body?.version_id)}（须为已发布版本的正整数编号）`);
  }
  const snap = loadVersionSnapshot(versionId);
  if (!snap) return err(res, 404, `版本不存在：#${versionId}，无法基于它创建共享房间`);

  // 回路超载保护：可选布尔开关；不传等同不启用，沿用原房间行为
  let overloadProtection = false;
  if (req.body?.overload_protection !== undefined) {
    if (typeof req.body.overload_protection !== 'boolean') {
      return err(res, 400, `超载保护开关无效：${JSON.stringify(req.body.overload_protection)}（须为布尔值 true/false）`);
    }
    overloadProtection = req.body.overload_protection;
  }

  const labelRaw = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const label = labelRaw || `共享房间（${snap.label}）`;
  const duration = roomDurationForSnapshot(snap);
  const now = Date.now() / 1000;
  const code = genRoomCode();
  const controlKey = crypto.randomBytes(24).toString('hex');

  const info = db
    .prepare(
      `INSERT INTO rooms (code, version_id, control_key, label, playing, time, anchor_wall, speed,
                          duration, revision, overload_protection, tripped_circuit_id, tripped_time, created_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, 1, ?, 0, ?, NULL, NULL, ?)`
    )
    .run(code, versionId, controlKey, label, now, duration, overloadProtection ? 1 : 0, now);

  // 启用保护即预热保护器（仅读冻结快照，不写任何业务数据）
  if (overloadProtection) loadRoomGuard(versionId);

  const row = db.prepare(`${roomSelect} WHERE r.id = ?`).get(info.lastInsertRowid);
  const guard = overloadProtection ? loadRoomGuard(versionId) : null;
  const state = computeRoomState(row, { now, guard, prog: null });
  res.status(201).json({
    ...buildRoomView(row, state, now, guard, null),
    // 控制密钥仅在创建响应中完整返回一次；之后任何接口都不再回显
    control_key: controlKey,
  });
});

// 加入/查看房间：凭房间码（无需密钥）只读服务端状态，观看端按返回的服务端墙钟校时
app.get('/api/rooms/:code', (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (code.length !== ROOM_CODE_LEN) {
    return err(res, 400, `房间码无效：${JSON.stringify(req.params.code)}（须为 ${ROOM_CODE_LEN} 位房间码）`);
  }
  let row = getRoomRowByCode(code);
  if (!row) return err(res, 404, `房间不存在：房间码 ${code}（请核对后重新加入）`);
  const now = Date.now() / 1000;
  const guard = row.overload_protection ? loadRoomGuard(row.version_id) : null;
  // 到末尾自动停住 / 撞上超载边界自动暂停：此处惰性落库，刷新/重启/重连后状态一致
  let prog = getRoomProgram(row.id);
  const state = computeRoomState(row, { now, guard, persistStopped: true, prog });
  if (!state.playing) {
    row = getRoomRowByCode(code);
    prog = getRoomProgram(row.id);
  }
  res.json(buildRoomView(row, state, now, guard, prog));
});

// 房间控制：持密钥者播放/暂停/跳转/设置速度；携带修订号，过期 409 且不改房间
app.post('/api/rooms/:code/control', (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (code.length !== ROOM_CODE_LEN) {
    return err(res, 400, `房间码无效：${JSON.stringify(req.params.code)}（须为 ${ROOM_CODE_LEN} 位房间码）`);
  }
  const row = getRoomRowByCode(code);
  if (!row) return err(res, 404, `房间不存在：房间码 ${code}（请核对后重试）`);

  // 控制密钥：必须携带且正确（不回显房间当前密钥；等长比较避免计时侧信道）
  const key = req.body?.control_key;
  if (key === undefined || key === null || key === '') {
    return err(res, 403, '缺少控制密钥：仅房间创建者（持密钥者）可以控制播放，请在页面填写密钥');
  }
  if (!secretEqual(key, row.control_key)) {
    return err(res, 403, '控制密钥无效：无权控制该房间（观看者只能同步观看）');
  }

  // 修订号：必须携带且与当前一致（先按墙钟惰性推算，末尾自动停住不改修订号）
  if (req.body === null || typeof req.body !== 'object' || !('revision' in req.body)) {
    return err(res, 400, '控制请求必须携带房间修订号 revision（与服务器当前修订号一致才允许控制）');
  }
  const clientRev = toNum(req.body.revision);
  if (!Number.isInteger(clientRev) || clientRev < 0) {
    return err(res, 400, `修订号无效：${JSON.stringify(req.body.revision)}（须为非负整数）`);
  }

  const action = req.body.action;
  if (!['play', 'pause', 'seek', 'speed'].includes(action)) {
    return err(
      res,
      400,
      `非法控制动作：${JSON.stringify(action)}（须为 play 播放 / pause 暂停 / seek 跳转 / speed 设置速度）`
    );
  }

  // 跳转时码：非负数字且不得超过版本末尾
  let seekTime = null;
  if (action === 'seek') {
    seekTime = toNum(req.body.time);
    if (Number.isNaN(seekTime)) {
      return err(res, 400, `非法时码：${JSON.stringify(req.body.time)}（须为数字秒数）`);
    }
    if (seekTime < 0) return err(res, 400, `非法时码：${seekTime}（不得为负）`);
    if (seekTime > row.duration) {
      return err(res, 400, `时码越界：${seekTime}（房间固定版本长度为 ${round6(row.duration)} 秒，不得跳到末尾之后）`);
    }
  }

  // 速度：仅允许现有的 0.5 / 1 / 2 倍
  let speed = null;
  if (action === 'speed') {
    speed = toNum(req.body.speed);
    if (!ROOM_SPEEDS.some((s) => Math.abs(s - speed) <= 1e-12)) {
      return err(res, 400, `非法速度：${JSON.stringify(req.body.speed)}（仅支持 0.5、1、2 倍速）`);
    }
  }

  const guard = row.overload_protection ? loadRoomGuard(row.version_id) : null;
  const now = Date.now() / 1000;
  const tx = db.transaction(() => {
    const cur = db.prepare(`${roomSelect} WHERE r.id = ?`).get(row.id);
    // 事务内复查密钥与修订号（双保险）
    if (cur.control_key !== key) {
      const e = new Error('ROOM_FORBIDDEN');
      e.code = 'ROOM_FORBIDDEN';
      throw e;
    }
    if (cur.revision !== clientRev) {
      const e = new Error(`ROOM_CONFLICT:${cur.revision}`);
      e.code = 'ROOM_CONFLICT';
      e.current = cur.revision;
      throw e;
    }
    // 先按墙钟实时推算（可能已到末尾或已撞上超载边界；此处不落库，随本次控制一并固化）
    const curProg = getRoomProgram(cur.id);
    const live = computeRoomState(cur, { now, guard, prog: curProg });

    let { playing, time } = live;
    let nextSpeed = cur.speed;
    const anchor = now;
    // 写库的自动暂停标记：仅当本次结果确为保护触发的暂停时保留
    let tripCircuit = live.trip ? live.trip.circuit_id : null;
    let tripTime = live.trip ? live.trip.time : null;
    // 写库的讨论停点自动暂停标记：仅当本次实时推算确实停在停点上时保留
    let trippedStopTime = live.stopHit !== null ? live.stopHit : null;
    let trippedReason = live.trip ? 'overload_boundary' : live.stopHit !== null ? 'stop_point' : null;
    // 写库的循环排演逻辑进度（仅 prog 存在时使用）
    let progSeg = live.prog ? live.prog.segIndex : 0;
    let progIter = live.prog ? live.prog.iteration : 0;
    let progTime = live.prog ? live.prog.time : time;
    let progFinished = live.prog ? live.prog.finished : false;
    // seek 会取消编排：本次控制提交后删除 room_programs 行
    let cancelProgram = false;

    if (action === 'play') {
      // seek 已在本次控制中取消编排：curProg 是删除前读出的旧行，须按普通房间处理
      if (curProg && !cancelProgram) {
        if (live.prog.finished) {
          // 整次编排已走完（停在末段终点）：再播放从首段重新开始整次编排
          progSeg = 0;
          progIter = 0;
          progTime = curProg.segments[0].start;
          progFinished = false;
          time = curProg.segments[0].start;
        } else {
          // 编排暂停（含保护自动暂停在开端点）：从断点接续
          progSeg = live.prog.segIndex;
          progIter = live.prog.iteration;
          progTime = live.prog.time;
          time = live.prog.time;
        }
      } else if (live.time >= cur.duration) {
        if (cur.duration <= 0) {
          const e = new Error('ROOM_ZERO_DURATION');
          e.code = 'ROOM_ZERO_DURATION';
          throw e;
        }
        time = 0; // 已停在末尾：再播放从头开始
      }
      // 当前时码已处于超载区间（含闭端点）：拒绝播放，房间不变
      if (guard) {
        const over = overloadedCircuitsAt(guard, time);
        if (over.length > 0) {
          const e = new Error('ROOM_UNSAFE');
          e.code = 'ROOM_UNSAFE';
          e.time = time;
          e.circuits = over;
          throw e;
        }
      }
      playing = true;
      tripCircuit = null;
      tripTime = null;
      // 继续播放：越过刚触发的停点/超载边界（清除自动暂停标记；停点配置不清除）
      trippedStopTime = null;
      trippedReason = null;
    } else if (action === 'pause') {
      playing = false;
      // 非保护触发的普通暂停清除全部自动暂停标记
      if (!live.trip) {
        tripCircuit = null;
        tripTime = null;
      }
      trippedStopTime = null;
      trippedReason = live.trip ? 'overload_boundary' : null;
    } else if (action === 'seek') {
      // 手动跳转取消编排并沿用原房间控制语义（跳转后为普通房间）；停点配置保留，
      // 跳到停点时码上不立即触发（须播放连续向上经过）
      cancelProgram = !!curProg;
      // 播放中跳入超载段：拒绝且房间不变；暂停（含已被保护自动暂停）时允许任意跳转避险
      if (guard && live.playing) {
        const over = overloadedCircuitsAt(guard, seekTime);
        if (over.length > 0) {
          const e = new Error('ROOM_UNSAFE');
          e.code = 'ROOM_UNSAFE';
          e.time = seekTime;
          e.circuits = over;
          throw e;
        }
      }
      time = seekTime;
      if (seekTime >= cur.duration) playing = false; // 跳到末尾即停住
      // 跳转后人不在自动暂停触发点上：清除既有自动暂停标记
      tripCircuit = null;
      tripTime = null;
      trippedStopTime = null;
      trippedReason = null;
      // 播放/暂停状态沿用（播放则从新时码起按速度继续；暂停锚住该时码）
    } else {
      // speed：以当前实时推算时码为新基准（若保护/停点刚把播放截停，则停在触发点），
      // 立刻按新速度继续（暂停则保持暂停）；编排逻辑进度按实时推算固化
      nextSpeed = speed;
      if (curProg) {
        progSeg = live.prog.segIndex;
        progIter = live.prog.iteration;
        progTime = live.prog.time;
        progFinished = live.prog.finished;
      }
      if (!live.trip) {
        tripCircuit = null;
        tripTime = null;
      }
      // 停点/超载的自动暂停标记按实时推算结果保留或清除
      trippedStopTime = live.stopHit !== null ? live.stopHit : null;
      trippedReason = live.trip ? 'overload_boundary' : live.stopHit !== null ? 'stop_point' : null;
    }

    db.prepare(
      `UPDATE rooms
       SET playing = ?, time = ?, anchor_wall = ?, speed = ?, revision = revision + 1,
           tripped_circuit_id = ?, tripped_time = ?, tripped_stop_time = ?, tripped_reason = ?
       WHERE id = ?`
    ).run(playing ? 1 : 0, time, anchor, nextSpeed, tripCircuit, tripTime, trippedStopTime, trippedReason, cur.id);
    if (cancelProgram) {
      // 手动跳转：取消编排（行删除后该房间回到未编排语义）
      db.prepare('DELETE FROM room_programs WHERE room_id = ?').run(cur.id);
    } else if (curProg) {
      // 播放/暂停/改速：把当前编排逻辑进度随本次控制一并固化（断点接续）
      db.prepare(
        `INSERT INTO room_programs (room_id, segments, seg_index, iteration, prog_time, finished)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET
           segments = excluded.segments, seg_index = excluded.seg_index,
           iteration = excluded.iteration, prog_time = excluded.prog_time,
           finished = excluded.finished`
      ).run(
        cur.id,
        JSON.stringify(curProg.segments),
        progSeg,
        progIter,
        progTime,
        progFinished ? 1 : 0
      );
    }
    // 原主持人成功控制房间（修订号前进）：已发出的交接凭证即刻失效——不删行，
    // 保留为 active:false / reason:"superseded" 供等待的接班人看到明确的作废原因；
    // 接班人再领取会按过期修订号 409 被拒且控制权不变（需让主持人重新发起）。
    return db.prepare(`${roomSelect} WHERE r.id = ?`).get(cur.id);
  });

  let updated;
  try {
    updated = tx();
  } catch (e) {
    if (e.code === 'ROOM_CONFLICT') {
      return err(
        res,
        409,
        `修订号冲突：提交基于修订号 ${clientRev}，房间当前已为修订号 ${e.current}；请按服务端最新状态校时后重试（本次未改动房间）`
      );
    }
    if (e.code === 'ROOM_FORBIDDEN') {
      return err(res, 403, '控制密钥无效：无权控制该房间（本次未改动房间）');
    }
    if (e.code === 'ROOM_ZERO_DURATION') {
      return err(res, 400, '该房间固定的版本时长为 0（没有 Cue），无法播放');
    }
    if (e.code === 'ROOM_UNSAFE') {
      // 400 明确拒绝：当前/目标时码已超载。不改动房间、不增加修订号
      const names = e.circuits.map((c) => `回路 #${c.circuit_id}「${c.name}」`).join('、');
      return res.status(400).json({
        error: `时码 ${round6(e.time)} 秒处 ${names} 负载严格大于容量：${action === 'play' ? '当前已超载，拒绝播放' : '播放中不得跳入超载段'}；请先在暂停状态下跳转到安全时码（本次未改动房间）`,
        reason: 'overloaded_timecode',
        time: round6(e.time),
        circuits: e.circuits,
      });
    }
    throw e;
  }

  const updatedProg = getRoomProgram(row.id);
  const state = computeRoomState(updated, { now, guard, prog: updatedProg });
  res.json(buildRoomView(updated, state, now, guard, updatedProg));
});

/* ----------------------- 共享房间循环排演（1～8 段循环） ----------------------- */
// 当前主持人可按房间固定版本提交 1～8 段循环排演：每段非负起止时码、start < end、
// end 不超过版本末尾，repeat 为正整数。提交携带当前控制密钥与房间修订号；过期
// 修订号、无效段、无权操作均不改变房间。成功后从首段开始播放、修订号 +1，并使
// 已发出的交接凭证作废（与成功控制同一口径）。播放按服务端墙钟与当前倍速依次
// 穿过各段（段尾瞬时跳回本段起点或跳到下段起点），全部完成后停在末段终点。
// 手动跳转取消编排并沿用原房间控制语义；暂停/改速保留进度，继续从断点接续。
// 启用回路超载保护时：超载（闭端点）的段起点使整次编排被拒绝；运行途中抵达
// 超载边界仍按现有规则自动暂停，不越过危险段。主持权交接后新主持人可继续
// 控制编排，观看者只读、不见密钥。

/**
 * 校验编排段列表，返回 { segments } 或 { status, message }。
 *  - 须为 1～8 段的数组；
 *  - start/end 为非负有限数字、start < end、end <= duration；
 *  - repeat 为正整数。
 */
function validateProgramSegments(rawSegments, duration) {
  if (!Array.isArray(rawSegments) || rawSegments.length < 1 || rawSegments.length > 8) {
    return { status: 400, message: '循环排演段无效：segments 须为 1～8 段的数组' };
  }
  const segments = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const s = rawSegments[i];
    const label = `第 ${i + 1} 段`;
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      return { status: 400, message: `${label}无效：每段须为 {start, end, repeat} 对象` };
    }
    const start = toNum(s.start);
    const end = toNum(s.end);
    const repeat = toNum(s.repeat);
    if (Number.isNaN(start) || start < 0) {
      return { status: 400, message: `${label}起点无效：${JSON.stringify(s.start)}（须为非负数字秒数）` };
    }
    if (Number.isNaN(end) || end < 0) {
      return { status: 400, message: `${label}终点无效：${JSON.stringify(s.end)}（须为非负数字秒数）` };
    }
    if (!(start < end)) {
      return { status: 400, message: `${label}非法：起点 ${round6(start)} 须严格早于终点 ${round6(end)}` };
    }
    if (end > duration + ROOM_EPS) {
      return {
        status: 400,
        message: `${label}终点越界：${round6(end)}（房间固定版本长度为 ${round6(duration)} 秒，终点不得超过版本末尾）`,
      };
    }
    if (!Number.isInteger(repeat) || repeat < 1) {
      return { status: 400, message: `${label}重复次数无效：${JSON.stringify(s.repeat)}（须为正整数）` };
    }
    if (!Number.isSafeInteger(repeat)) {
      return { status: 400, message: `${label}重复次数过大：${s.repeat}（须为不超过 2^53-1 的安全正整数）` };
    }
    segments.push({ start, end, repeat });
  }
  return { segments };
}

// 共享的主持人鉴权/修订号校验（与 /control 同一口径），通过返回 null
function authorizeRoomControl(req, res, row) {
  const key = req.body?.control_key;
  if (key === undefined || key === null || key === '') {
    err(res, 403, '缺少控制密钥：仅房间主持人（持密钥者）可以安排循环排演');
    return 403;
  }
  if (!secretEqual(key, row.control_key)) {
    err(res, 403, '控制密钥无效：无权为该房间安排循环排演（观看者只能同步观看）');
    return 403;
  }
  if (req.body === null || typeof req.body !== 'object' || !('revision' in req.body)) {
    err(res, 400, '提交必须携带房间修订号 revision（与服务器当前修订号一致才允许安排循环排演）');
    return 400;
  }
  const clientRev = toNum(req.body.revision);
  if (!Number.isInteger(clientRev) || clientRev < 0) {
    err(res, 400, `修订号无效：${JSON.stringify(req.body.revision)}（须为非负整数）`);
    return 400;
  }
  return { key, clientRev };
}

// POST /api/rooms/:code/program  提交循环排演：
// {control_key, revision, segments:[{start,end,repeat}]}
// 成功后从首段开始播放、修订号 +1；返回最新房间状态（含 program 段/轮次块）
app.post('/api/rooms/:code/program', (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (code.length !== ROOM_CODE_LEN) {
    return err(res, 400, `房间码无效：${JSON.stringify(req.params.code)}（须为 ${ROOM_CODE_LEN} 位房间码）`);
  }
  const row = getRoomRowByCode(code);
  if (!row) return err(res, 404, `房间不存在：房间码 ${code}（请核对后重试）`);

  const auth = authorizeRoomControl(req, res, row);
  if (auth === 403 || auth === 400) return;
  const { key, clientRev } = auth;

  const checked = validateProgramSegments(req.body?.segments, row.duration);
  if (checked.message) return err(res, checked.status, checked.message);
  const segments = checked.segments;

  const guard = row.overload_protection ? loadRoomGuard(row.version_id) : null;
  // 启用超载保护：超载（闭端点）的段起点使整次编排被拒绝（整次提交不落库、不改房间）
  if (guard) {
    for (let i = 0; i < segments.length; i++) {
      const over = overloadedCircuitsAt(guard, segments[i].start);
      if (over.length > 0) {
        const names = over.map((c) => `回路 #${c.circuit_id}「${c.name}」`).join('、');
        return res.status(400).json({
          error: `第 ${i + 1} 段起点 ${round6(segments[i].start)} 秒处 ${names} 负载严格大于容量：该段起点已超载，整次循环排演被拒绝（本次未改动房间）`,
          reason: 'overloaded_segment_start',
          segment_index: i + 1,
          time: round6(segments[i].start),
          circuits: over,
        });
      }
    }
  }

  const now = Date.now() / 1000;
  const tx = db.transaction(() => {
    const cur = db.prepare(`${roomSelect} WHERE r.id = ?`).get(row.id);
    if (cur.control_key !== key) {
      const e = new Error('ROOM_FORBIDDEN');
      e.code = 'ROOM_FORBIDDEN';
      throw e;
    }
    if (cur.revision !== clientRev) {
      const e = new Error(`ROOM_CONFLICT:${cur.revision}`);
      e.code = 'ROOM_CONFLICT';
      e.current = cur.revision;
      throw e;
    }
    // 成功提交：从首段起点开始播放，修订号 +1；清除旧编排与既有触发标记
    db.prepare(
      `UPDATE rooms
       SET playing = 1, time = ?, anchor_wall = ?, speed = speed, revision = revision + 1,
           tripped_circuit_id = NULL, tripped_time = NULL,
           tripped_stop_time = NULL, tripped_reason = NULL
       WHERE id = ?`
    ).run(segments[0].start, now, cur.id);
    db.prepare(
      `INSERT INTO room_programs (room_id, segments, seg_index, iteration, prog_time, finished)
       VALUES (?, ?, 0, 0, ?, 0)
       ON CONFLICT(room_id) DO UPDATE SET
         segments = excluded.segments, seg_index = 0, iteration = 0,
         prog_time = excluded.prog_time, finished = 0`
    ).run(cur.id, JSON.stringify(segments), segments[0].start);
    return db.prepare(`${roomSelect} WHERE r.id = ?`).get(cur.id);
  });

  let updated;
  try {
    updated = tx();
  } catch (e) {
    if (e.code === 'ROOM_CONFLICT') {
      return err(
        res,
        409,
        `修订号冲突：提交基于修订号 ${clientRev}，房间当前已为修订号 ${e.current}；请按服务端最新状态校时后重试（本次未改动房间）`
      );
    }
    if (e.code === 'ROOM_FORBIDDEN') {
      return err(res, 403, '控制密钥无效：无权为该房间安排循环排演（本次未改动房间）');
    }
    throw e;
  }

  const prog = getRoomProgram(updated.id);
  const state = computeRoomState(updated, { now, guard, prog });
  res.json(buildRoomView(updated, state, now, guard, prog));
});

// POST /api/rooms/:code/program/clear  手动取消循环排演：
// {control_key, revision}。删除编排并沿用原房间控制语义（播放状态与时码保留，
// 修订号 +1，已发出的交接凭证随修订号前进而作废）
app.post('/api/rooms/:code/program/clear', (req, res) => {
  const code = normalizeRoomCode(req.params.code);
  if (code.length !== ROOM_CODE_LEN) {
    return err(res, 400, `房间码无效：${JSON.stringify(req.params.code)}（须为 ${ROOM_CODE_LEN} 位房间码）`);
  }
  const row = getRoomRowByCode(code);
  if (!row) return err(res, 404, `房间不存在：房间码 ${code}（请核对后重试）`);

  const auth = authorizeRoomControl(req, res, row);
  if (auth === 403 || auth === 400) return;
  const { key, clientRev } = auth;

  const guard = row.overload_protection ? loadRoomGuard(row.version_id) : null;
  const now = Date.now() / 1000;
  const tx = db.transaction(() => {
    const cur = db.prepare(`${roomSelect} WHERE r.id = ?`).get(row.id);
    if (cur.control_key !== key) {
      const e = new Error('ROOM_FORBIDDEN');
      e.code = 'ROOM_FORBIDDEN';
      throw e;
    }
    if (cur.revision !== clientRev) {
      const e = new Error(`ROOM_CONFLICT:${cur.revision}`);
      e.code = 'ROOM_CONFLICT';
      e.current = cur.revision;
      throw e;
    }
    // 先按墙钟实时推算（含编排映射），把当前进度固化为普通房间时码，再取消编排
    const curProg = getRoomProgram(cur.id);
    const live = computeRoomState(cur, { now, guard, prog: curProg });
    db.prepare(
      `UPDATE rooms
       SET playing = ?, time = ?, anchor_wall = ?, revision = revision + 1,
           tripped_circuit_id = ?, tripped_time = ?, tripped_stop_time = ?, tripped_reason = ?
       WHERE id = ?`
    ).run(
      live.playing ? 1 : 0,
      live.time,
      now,
      live.trip ? live.trip.circuit_id : null,
      live.trip ? live.trip.time : null,
      live.stopHit !== null ? live.stopHit : null,
      live.trip ? 'overload_boundary' : live.stopHit !== null ? 'stop_point' : null,
      cur.id
    );
    db.prepare('DELETE FROM room_programs WHERE room_id = ?').run(cur.id);
    return db.prepare(`${roomSelect} WHERE r.id = ?`).get(cur.id);
  });

  let updated;
  try {
    updated = tx();
  } catch (e) {
    if (e.code === 'ROOM_CONFLICT') {
      return err(
        res,
        409,
        `修订号冲突：提交基于修订号 ${clientRev}，房间当前已为修订号 ${e.current}；请按服务端最新状态校时后重试（本次未改动房间）`
      );
    }
    if (e.code === 'ROOM_FORBIDDEN') {
      return err(res, 403, '控制密钥无效：无权取消该房间的循环排演（本次未改动房间）');
    }
    throw e;
  }

  const state = computeRoomState(updated, { now, guard, prog: null });
  res.json(buildRoomView(updated, state, now, guard, null));
});

/* ----------------------- 共享房间讨论停点（预置讨论暂停点） ----------------------- */
// 主持人凭当前控制密钥与房间修订号原子替换整组讨论停点：互不重复的非负演出时码，
// 均不超过房间固定版本末尾；空数组表示清除。整组校验通过后才替换：无权、过期修订号
// 或任一非法时码均不改变房间。成功替换修订号 +1（与成功控制同一口径，已发出的交接
// 凭证随之作废）。播放连续向上经过任一停点即自动暂停并显示原因（惰性落库、不加修订
// 号）；继续播放须越过刚触发的停点；循环排演每次重新经过仍暂停；手动跳转与段尾瞬时
// 跳转不触发跳过的停点；同一时码超载边界优先。停点配置不随手动跳转/交接/编排变化。

/**
 * 校验一组讨论停点，返回 { times } 或 { status, message }。
 *  - 须为数组（空数组合法，表示清除）；
 *  - 每项为非负有限数字且不超过版本末尾；
 *  - 整组互不重复。
 */
function validateStopTimes(rawTimes, duration) {
  if (!Array.isArray(rawTimes)) {
    return { status: 400, message: '讨论停点无效：times 须为时码数组（空数组表示清除全部停点）' };
  }
  const times = [];
  const seen = new Set();
  for (let i = 0; i < rawTimes.length; i++) {
    const t = toNum(rawTimes[i]);
    if (Number.isNaN(t) || t < 0) {
      return { status: 400, message: `第 ${i + 1} 个停点非法：${JSON.stringify(rawTimes[i])}（须为非负数字秒数）` };
    }
    if (t > duration + ROOM_EPS) {
      return {
        status: 400,
        message: `第 ${i + 1} 个停点越界：${round6(t)}（房间固定版本长度为 ${round6(duration)} 秒，停点不得超过版本末尾）`,
      };
    }
    // 去重按归整到容差后的时码判定，避免 1 与 1.0000000001 之类噪声重复
    const key = Math.round(t / ROOM_EPS);
    if (seen.has(key)) {
      return { status: 400, message: `停点时码重复：${round6(t)}（一组停点内时码互不重复，整次提交已拒绝）` };
    }
    seen.add(key);
    times.push(t);
  }
  times.sort((a, b) => a - b);
  return { times };
}

// POST /api/rooms/:code/stops  原子替换讨论停点：
// {control_key, revision, times:[秒数...]}（times 为空数组 = 清除）
app.post('/api/rooms/:code/stops', (req, res) => {
  const found = resolveRoomCode(req);
  if (found.message) return err(res, found.status, found.message);
  const { row } = found;

  // 鉴权与修订号与 /control、/program 同一口径（错误/缺失密钥 403、过期修订号 409）
  const auth = authorizeRoomControl(req, res, row);
  if (auth === 403 || auth === 400) return;
  const { key, clientRev } = auth;

  const checked = validateStopTimes(req.body?.times, row.duration);
  if (checked.message) return err(res, checked.status, checked.message);
  const times = checked.times;

  const guard = row.overload_protection ? loadRoomGuard(row.version_id) : null;
  const now = Date.now() / 1000;
  const tx = db.transaction(() => {
    const cur = db.prepare(`${roomSelect} WHERE r.id = ?`).get(row.id);
    if (cur.control_key !== key) {
      const e = new Error('ROOM_FORBIDDEN');
      e.code = 'ROOM_FORBIDDEN';
      throw e;
    }
    if (cur.revision !== clientRev) {
      const e = new Error(`ROOM_CONFLICT:${cur.revision}`);
      e.code = 'ROOM_CONFLICT';
      e.current = cur.revision;
      throw e;
    }
    // 整组校验已在事务外完成；原子替换：非空 UPSERT，空组删行。
    // 仅替换停点配置：播放/暂停、时码、速度、编排、自动暂停标记一律不动。
    if (times.length > 0) {
      db.prepare(
        `INSERT INTO room_stops (room_id, times) VALUES (?, ?)
         ON CONFLICT(room_id) DO UPDATE SET times = excluded.times`
      ).run(cur.id, JSON.stringify(times));
    } else {
      db.prepare('DELETE FROM room_stops WHERE room_id = ?').run(cur.id);
    }
    db.prepare('UPDATE rooms SET revision = revision + 1 WHERE id = ?').run(cur.id);
    return db.prepare(`${roomSelect} WHERE r.id = ?`).get(cur.id);
  });

  let updated;
  try {
    updated = tx();
  } catch (e) {
    if (e.code === 'ROOM_CONFLICT') {
      return err(
        res,
        409,
        `修订号冲突：提交基于修订号 ${clientRev}，房间当前已为修订号 ${e.current}；请按服务端最新状态校时后重试（本次未改动房间）`
      );
    }
    if (e.code === 'ROOM_FORBIDDEN') {
      return err(res, 403, '控制密钥无效：无权维护该房间的讨论停点（本次未改动房间）');
    }
    throw e;
  }

  const prog = getRoomProgram(updated.id);
  const state = computeRoomState(updated, { now, guard, prog, stops: times });
  res.json(buildRoomView(updated, state, now, guard, prog, times));
});

/* ----------------------- 主持权交接（一次性五分钟凭证） ----------------------- */
// 当前主持人凭当前控制密钥与房间修订号发起交接，取得仅显示一次、五分钟有效的
// 交接凭证；同一房间同时只保留一份待领取凭证，再次发起覆盖旧凭证（旧凭证失效）。
// 接班人凭房间码与凭证领取新的控制密钥：领取与房间修订号 +1 原子完成，旧密钥
// 即刻失效；并发领取至多一人成功。凭证发出后原主持人一旦成功控制房间，凭证即
// 作废（修订号不再匹配），接班人须重新索取。播放/暂停状态、时码、速度、固定
// 版本与超载保护状态均不因交接而重置。

// 解析并校验房间码：返回 { code } 或 { status, message }（与既有房间接口同一口径）
function resolveRoomCode(req) {
  const code = normalizeRoomCode(req.params.code);
  if (code.length !== ROOM_CODE_LEN) {
    return { status: 400, message: `房间码无效：${JSON.stringify(req.params.code)}（须为 ${ROOM_CODE_LEN} 位房间码）` };
  }
  const row = getRoomRowByCode(code);
  if (!row) return { status: 404, message: `房间不存在：房间码 ${code}（请核对后重试）` };
  return { code, row };
}

// POST /api/rooms/:code/handover/issue  主持人发起交接：{control_key, revision}
app.post('/api/rooms/:code/handover/issue', (req, res) => {
  const found = resolveRoomCode(req);
  if (found.message) return err(res, found.status, found.message);
  const { row } = found;

  // 必须携带当前控制密钥（错误/缺失 → 403，与控制接口同一口径，不回显房间密钥）
  const key = req.body?.control_key;
  if (key === undefined || key === null || key === '') {
    return err(res, 403, '缺少控制密钥：仅当前主持人（持密钥者）可以发起主持权交接');
  }
  if (!secretEqual(key, row.control_key)) {
    return err(res, 403, '控制密钥无效：无权发起该房间的主持权交接');
  }

  // 修订号：必须携带、为非负整数且与房间当前一致（过期修订号 → 409，凭证不变）
  if (req.body === null || typeof req.body !== 'object' || !('revision' in req.body)) {
    return err(res, 400, '发起交接必须携带房间修订号 revision（与服务器当前修订号一致才允许交接）');
  }
  const clientRev = toNum(req.body.revision);
  if (!Number.isInteger(clientRev) || clientRev < 0) {
    return err(res, 400, `修订号无效：${JSON.stringify(req.body.revision)}（须为非负整数）`);
  }
  if (clientRev !== row.revision) {
    return err(
      res,
      409,
      `修订号冲突：提交基于修订号 ${clientRev}，房间当前已为修订号 ${row.revision}；请按服务端最新状态校时后重新发起交接（本次未改动房间）`
    );
  }

  const now = Date.now() / 1000;
  const token = crypto.randomBytes(24).toString('hex');
  // 同一房间只保留一份待领取凭证：UPSERT 覆盖旧凭证，旧凭证随之失效
  db.prepare(
    `INSERT INTO room_handovers (room_id, token, revision, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (room_id) DO UPDATE SET
       token = excluded.token, revision = excluded.revision,
       expires_at = excluded.expires_at, created_at = excluded.created_at`
  ).run(row.id, token, row.revision, now + HANDOVER_TTL_SECONDS, now);
  // 顺手清理其他房间已过期的交接凭证（用严格小于，绝不波及刚 UPSERT 的本行）
  db.prepare('DELETE FROM room_handovers WHERE room_id IS NOT ? AND expires_at <= ?').run(row.id, now);

  const guard = row.overload_protection ? loadRoomGuard(row.version_id) : null;
  const prog = getRoomProgram(row.id);
  const state = computeRoomState(row, { now, guard, prog });
  res.json({
    ...buildRoomView(row, state, now, guard, prog),
    // 交接凭证仅在本次发起响应中完整返回一次；之后任何接口（含 GET 房间）都不再回显
    handover_token: token,
    handover_expires_in: HANDOVER_TTL_SECONDS,
  });
});

// POST /api/rooms/:code/handover/claim  接班人领取：{handover_token, revision}
// 领取成功与房间修订号 +1 在同一事务内原子完成；旧密钥即刻失效、凭证一次性删除。
app.post('/api/rooms/:code/handover/claim', (req, res) => {
  const found = resolveRoomCode(req);
  if (found.message) return err(res, found.status, found.message);
  const { row } = found;

  // 接班人不持控制密钥：仅凭房间码与交接凭证领取
  const token = req.body?.handover_token;
  if (token === undefined || token === null || token === '') {
    return err(res, 403, '缺少交接凭证：请向当前主持人索取一次性交接凭证（handover_token）');
  }
  if (typeof token !== 'string') {
    return err(res, 403, '交接凭证无效：请使用主持人发起交接时取得的一次性凭证');
  }

  // 修订号：必须携带、为非负整数（客户端看到的房间修订号，须与凭证绑定的修订号一致）
  if (req.body === null || typeof req.body !== 'object' || !('revision' in req.body)) {
    return err(res, 400, '领取交接凭证必须携带房间修订号 revision（以加入房间时看到的当前修订号为准）');
  }
  const clientRev = toNum(req.body.revision);
  if (!Number.isInteger(clientRev) || clientRev < 0) {
    return err(res, 400, `修订号无效：${JSON.stringify(req.body.revision)}（须为非负整数）`);
  }

  const now = Date.now() / 1000;
  const claim = db.transaction(() => {
    const cur = db.prepare(`${roomSelect} WHERE r.id = ?`).get(row.id);
    const ho = db.prepare('SELECT * FROM room_handovers WHERE room_id = ?').get(cur.id);

    // 凭证不存在（从未发起、已被领取删除、或被再次发起覆盖后又领取）：明确拒绝
    if (!ho || !secretEqual(token, ho.token)) {
      const e = new Error('HANDOVER_BAD_TOKEN');
      e.code = 'HANDOVER_BAD_TOKEN';
      throw e;
    }
    // 凭证已过期：抛出后由事务外删除（事务内抛出会整体回滚）
    if (ho.expires_at <= now) {
      const e = new Error('HANDOVER_EXPIRED');
      e.code = 'HANDOVER_EXPIRED';
      throw e;
    }
    // 凭证发出后原主持人成功控制过房间：绑定修订号不再匹配 → 凭证作废，
    // 抛出后由事务外删除（接班人须重新索取），控制权不变。
    // 先于客户端修订号检查：即使客户端携带的修订号也过期，也明确告知“凭证已作废”。
    if (ho.revision !== cur.revision) {
      const e = new Error('HANDOVER_REVOKED');
      e.code = 'HANDOVER_REVOKED';
      e.current = cur.revision;
      e.bound = ho.revision;
      throw e;
    }
    // 过期修订号（客户端看到的修订号落后）：不改变控制权、不删凭证（同修订号可刷新后重试）
    if (clientRev !== cur.revision) {
      const e = new Error(`ROOM_CONFLICT:${cur.revision}`);
      e.code = 'ROOM_CONFLICT';
      e.current = cur.revision;
      throw e;
    }

    // 原子领取：换发新控制密钥、修订号 +1、删除一次性凭证。
    // 播放状态/时码/速度/固定版本/超载保护触发信息一律不动。
    const newKey = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE rooms SET control_key = ?, revision = revision + 1 WHERE id = ?').run(newKey, cur.id);
    db.prepare('DELETE FROM room_handovers WHERE room_id = ?').run(cur.id);
    return { newKey, updated: db.prepare(`${roomSelect} WHERE r.id = ?`).get(cur.id) };
  });

  let result;
  try {
    result = claim();
  } catch (e) {
    if (e.code === 'HANDOVER_BAD_TOKEN') {
      return err(res, 403, '交接凭证无效：凭证不存在、输入有误或已被使用（同一房间只认最新一份待领取凭证，请重新向主持人索取；本次未改变控制权）');
    }
    if (e.code === 'HANDOVER_EXPIRED') {
      db.prepare('DELETE FROM room_handovers WHERE room_id = ?').run(row.id);
      return err(res, 403, '交接凭证已过期（有效期五分钟）：请让当前主持人重新发起交接（本次未改变控制权）');
    }
    if (e.code === 'HANDOVER_REVOKED') {
      db.prepare('DELETE FROM room_handovers WHERE room_id = ?').run(row.id);
      return err(
        res,
        409,
        `交接凭证已作废：发起时房间为修订号 ${e.bound}，原主持人之后又成功控制了房间（当前修订号 ${e.current}）；请让主持人重新发起交接（本次未改变控制权）`
      );
    }
    if (e.code === 'ROOM_CONFLICT') {
      return err(
        res,
        409,
        `修订号冲突：领取基于修订号 ${clientRev}，房间当前已为修订号 ${e.current}；请重新查看房间状态后用最新修订号领取（凭证仍然有效，本次未改变控制权）`
      );
    }
    throw e;
  }

  const guard = result.updated.overload_protection ? loadRoomGuard(result.updated.version_id) : null;
  const prog = getRoomProgram(result.updated.id);
  const state = computeRoomState(result.updated, { now, guard, prog });
  res.json({
    ...buildRoomView(result.updated, state, now, guard, prog),
    // 新控制密钥仅在本次领取响应中完整返回一次；重试/任何其他接口都不再回显
    control_key: result.newKey,
  });
});

/* ------------------------------- 错误处理 ------------------------------ */

// JSON 解析失败（如非法时码导致的畸形 JSON 之外的格式错误）
app.use((e, req, res, next) => {
  if (e.type === 'entity.parse.failed') {
    return err(res, 400, '请求体不是合法 JSON，提交已拒绝');
  }
  console.error(e);
  err(res, 500, '服务器内部错误');
});

// 前端单页回退（API 未命中返回 JSON 404）
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 直接运行（node server.js / npm start / Docker）时启动监听；被测试 require 时只导出 app
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`小剧场灯光 Cue 排演应用已启动: http://localhost:${PORT}`);
    console.log(`数据库: ${DB_PATH}`);
  });
}

module.exports = { app, PORT, DB_PATH };
