'use strict';

const Engine = window.LightingEngine;

const state = {
  lights: [],
  circuits: [],
  cues: [],
  versions: [],
  records: [],
  // 当前打开的临时调光记录：detail 含绑定快照与操作序列，baseCues/byLight 为重算结果
  record: null,
  recordTime: 0,
  // 播放器会话：一旦开始播放，快照与排序后的 Cue 即冻结，草稿/新发布不影响本次播放
  session: null,
  time: 0,
  playing: false,
  speed: 1,
  rafId: null,
  lastWall: 0,
};

/* ------------------------------- API ------------------------------- */

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `请求失败（${res.status}）`);
    e.status = res.status;
    throw e;
  }
  return data;
}

const fmt = (n) => {
  const v = Math.round(n * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (id) => document.getElementById(id);
const showErr = (el, msg) => { el.textContent = msg; el.hidden = false; };
const clearErr = (el) => { el.hidden = true; el.textContent = ''; };

/* ----------------------------- 标签页 ----------------------------- */

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach((p) =>
      p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`)
    );
  });
});

/* ----------------------------- 灯具 ----------------------------- */

async function loadLights() {
  state.lights = await api('GET', '/api/lights');
  renderLights();
  renderLightOptions();
}

function circuitOptions(selectedId, { allowUnassigned = true } = {}) {
  const none = allowUnassigned ? '<option value="">— 未分配 —</option>' : '';
  return (
    none +
    state.circuits
      .map((c) => `<option value="${c.id}" ${String(c.id) === String(selectedId) ? 'selected' : ''}>#${c.id} ${esc(c.name)}</option>`)
      .join('')
  );
}

function renderLights() {
  const tb = $('light-table').querySelector('tbody');
  tb.innerHTML = state.lights
    .map(
      (l) => `
      <tr data-light-id="${l.id}">
        <td>#${l.id}</td>
        <td>${esc(l.name)}</td>
        <td>
          <select data-w="circuit_id">
            ${circuitOptions(l.circuit_id)}
          </select>
        </td>
        <td class="edit-cell">
          <input data-w="watts" type="number" min="0" step="1" placeholder="未分配"
            value="${l.watts ?? ''}" ${l.circuit_id ? '' : 'disabled'} style="width:7rem" />
        </td>
        <td>
          <button data-save-wiring="${l.id}">保存接线</button>
          <button class="danger" data-del-light="${l.id}">删除</button>
        </td>
      </tr>`
    )
    .join('');
}

function renderLightOptions() {
  const opts = state.lights.map((l) => `<option value="${l.id}">#${l.id} ${esc(l.name)}</option>`).join('');
  $('cue-light').innerHTML = opts;
}

$('form-light').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('light-error'));
  const name = $('light-name').value.trim();
  if (!name) return;
  try {
    await api('POST', '/api/lights', { name });
    $('light-name').value = '';
    await loadLights();
  } catch (err) {
    showErr($('light-error'), err.message);
  }
});

// 接线：行内选择回路 + 填写瓦数后整行提交；未分配回路时瓦数留空
$('light-table').addEventListener('click', async (e) => {
  const saveId = e.target.dataset?.saveWiring;
  const delId = e.target.dataset?.delLight;
  clearErr($('light-error'));
  try {
    if (saveId) {
      const tr = e.target.closest('tr');
      const circuit_id = tr.querySelector('[data-w="circuit_id"]').value;
      const watts = tr.querySelector('[data-w="watts"]').value;
      const body = circuit_id ? { circuit_id, watts } : { circuit_id: null };
      await api('PUT', `/api/lights/${saveId}/wiring`, body);
      await loadLights();
      await loadCircuits();
    } else if (delId) {
      await api('DELETE', `/api/lights/${delId}`);
      await loadLights();
    }
  } catch (err) {
    showErr($('light-error'), err.message);
  }
});

// 选中回路后才允许填写瓦数
$('light-table').addEventListener('change', (e) => {
  if (e.target.dataset?.w !== 'circuit_id') return;
  const tr = e.target.closest('tr');
  tr.querySelector('[data-w="watts"]').disabled = !e.target.value;
});

/* ----------------------------- 回路 ----------------------------- */

async function loadCircuits() {
  state.circuits = await api('GET', '/api/circuits');
  renderCircuits();
  renderLights();
  renderLoadOptions();
}

function renderCircuits() {
  const tb = $('circuit-table').querySelector('tbody');
  if (state.circuits.length === 0) {
    tb.innerHTML = '<tr><td colspan="5" class="muted">还没有回路。</td></tr>';
    return;
  }
  tb.innerHTML = state.circuits
    .map(
      (c) => `
      <tr data-circuit-id="${c.id}">
        <td>#${c.id}</td>
        <td class="edit-cell"><input data-c="name" value="${esc(c.name)}" /></td>
        <td class="edit-cell"><input data-c="capacity" type="number" min="0" step="1" value="${c.capacity}" style="width:7rem" /></td>
        <td>${c.light_count}</td>
        <td>
          <button data-save-circuit="${c.id}">保存</button>
          <button class="danger" data-del-circuit="${c.id}">删除</button>
        </td>
      </tr>`
    )
    .join('');
}

$('form-circuit').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('circuit-error'));
  const name = $('circuit-name').value.trim();
  const capacity = $('circuit-capacity').value;
  try {
    await api('POST', '/api/circuits', { name, capacity });
    $('circuit-name').value = '';
    $('circuit-capacity').value = '';
    await loadCircuits();
  } catch (err) {
    showErr($('circuit-error'), err.message);
  }
});

$('circuit-table').addEventListener('click', async (e) => {
  const saveId = e.target.dataset?.saveCircuit;
  const delId = e.target.dataset?.delCircuit;
  clearErr($('circuit-error'));
  try {
    if (saveId) {
      const tr = e.target.closest('tr');
      const body = {};
      tr.querySelectorAll('[data-c]').forEach((el) => {
        body[el.dataset.c] = el.dataset.c === 'name' ? el.value : el.value;
      });
      await api('PATCH', `/api/circuits/${saveId}`, body);
      await loadCircuits();
    } else if (delId) {
      await api('DELETE', `/api/circuits/${delId}`);
      await loadCircuits();
    }
  } catch (err) {
    showErr($('circuit-error'), err.message);
  }
});

/* ----------------------------- 草稿 Cue ----------------------------- */

async function loadCues() {
  state.cues = await api('GET', '/api/cues');
  renderCues();
}

function renderCues() {
  const tb = $('cue-table').querySelector('tbody');
  tb.innerHTML = state.cues
    .map(
      (c) => `
      <tr data-cue-id="${c.id}">
        <td class="edit-cell"><input data-f="cue_no" type="number" min="1" step="1" value="${c.cue_no}" /></td>
        <td>
          <select data-f="light_id">
            ${state.lights
              .map((l) => `<option value="${l.id}" ${l.id === c.light_id ? 'selected' : ''}>#${l.id} ${esc(l.name)}</option>`)
              .join('')}
          </select>
        </td>
        <td class="edit-cell"><input data-f="time" type="number" min="0" step="0.1" value="${c.time}" /></td>
        <td class="edit-cell"><input data-f="target" type="number" min="0" max="100" step="0.1" value="${c.target}" /></td>
        <td class="edit-cell"><input data-f="duration" type="number" min="0" step="0.1" value="${c.duration}" /></td>
        <td>
          <button data-save-cue="${c.id}">保存</button>
          <button class="danger" data-del-cue="${c.id}">删除</button>
        </td>
      </tr>`
    )
    .join('');
}

$('form-cue').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('cue-error'));
  const body = {
    light_id: Number($('cue-light').value),
    time: $('cue-time').value,
    target: $('cue-target').value,
    duration: $('cue-duration').value,
  };
  const no = $('cue-no').value.trim();
  if (no) body.cue_no = no;
  try {
    state.cues = await api('POST', '/api/cues', body);
    $('cue-no').value = '';
    renderCues();
  } catch (err) {
    showErr($('cue-error'), '提交被拒绝：' + err.message);
  }
});

$('cue-table').addEventListener('click', async (e) => {
  const saveId = e.target.dataset?.saveCue;
  const delId = e.target.dataset?.delCue;
  clearErr($('cue-error'));
  try {
    if (saveId) {
      const tr = e.target.closest('tr');
      const body = {};
      tr.querySelectorAll('[data-f]').forEach((el) => {
        body[el.dataset.f] = el.value;
      });
      state.cues = await api('PATCH', `/api/cues/${saveId}`, body);
      renderCues();
    } else if (delId) {
      await api('DELETE', `/api/cues/${delId}`);
      await loadCues();
    }
  } catch (err) {
    showErr($('cue-error'), '提交被拒绝：' + err.message);
  }
});

$('btn-bulk').addEventListener('click', async () => {
  clearErr($('bulk-error'));
  const payload = [];
  const lines = $('cue-bulk').value.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 4 && parts.length !== 5) {
      return showErr($('bulk-error'), `第 ${i + 1} 行格式错误：应为「时码 灯具编号 目标亮度 渐变时长 [Cue编号]」`);
    }
    const [time, light_id, target, duration, cue_no] = parts;
    const row = { time, light_id, target, duration };
    if (cue_no !== undefined) row.cue_no = cue_no;
    payload.push(row);
  }
  if (payload.length === 0) return showErr($('bulk-error'), '没有可提交的行');
  try {
    state.cues = await api('POST', '/api/cues', payload);
    $('cue-bulk').value = '';
    renderCues();
  } catch (err) {
    showErr($('bulk-error'), '整次提交已拒绝：' + err.message);
  }
});

/* ----------------------------- 发布版本 ----------------------------- */

async function loadVersions({ keepSelection = true } = {}) {
  const prev = $('version-select').value;
  const prevA = $('cmp-version-a').value;
  const prevB = $('cmp-version-b').value;
  state.versions = await api('GET', '/api/versions');
  renderVersions();
  renderVersionOptions(keepSelection ? prev : null);
  renderCompareOptions();
  renderRecordVersionOptions();
  renderLoadOptions();
  renderMergeOptions();
  renderRoomVersionOptions();
  if (keepSelection) {
    if (state.versions.some((v) => String(v.id) === String(prevA))) $('cmp-version-a').value = prevA;
    if (state.versions.some((v) => String(v.id) === String(prevB))) $('cmp-version-b').value = prevB;
  }
}

function renderVersions() {
  const tb = $('version-table').querySelector('tbody');
  tb.innerHTML = state.versions
    .map(
      (v) => `
      <tr>
        <td>#${v.id}</td>
        <td>${esc(v.label)}</td>
        <td>${new Date(v.created_at * 1000).toLocaleString('zh-CN', { hour12: false })}</td>
        <td>${v.cue_count}</td>
      </tr>`
    )
    .join('');
}

function renderVersionOptions(preferId) {
  const sel = $('version-select');
  if (state.versions.length === 0) {
    sel.innerHTML = '<option value="">— 请先发布一个版本 —</option>';
    return;
  }
  sel.innerHTML = state.versions
    .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}（${v.cue_count} 条 Cue）</option>`)
    .join('');
  if (preferId && state.versions.some((v) => String(v.id) === String(preferId))) {
    sel.value = preferId;
  }
}

$('form-publish').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('publish-error'));
  try {
    const snap = await api('POST', '/api/versions', { label: $('version-label').value });
    $('version-label').value = '';
    await loadVersions({ keepSelection: false });
    $('version-select').value = String(snap.id);
    if (!state.playing) await loadSession(snap.id, true);
  } catch (err) {
    showErr($('publish-error'), err.message);
  }
});

/* ----------------------------- 播放器 ----------------------------- */

async function loadSession(versionId, resetTime) {
  const snap = await api('GET', `/api/versions/${versionId}`);
  const cues = Engine.prepareCues(snap.cues);
  state.session = {
    id: snap.id,
    label: snap.label,
    lights: snap.lights,
    cues,
    duration: Engine.showDuration(cues),
  };
  if (resetTime) state.time = 0;
  const tl = $('timeline');
  tl.max = String(Math.max(state.session.duration, 0));
  $('time-total').textContent = fmt(state.session.duration);
  $('session-info').textContent = `本次播放冻结于版本 #${snap.id}：${snap.label}`;
  renderPlayer();
}

$('version-select').addEventListener('change', async () => {
  if (state.playing) return; // 播放中不允许切换，保证使用开始时的版本
  const id = $('version-select').value;
  if (id) await loadSession(id, true);
});

function tick(ts) {
  if (!state.playing) return;
  const dt = ((ts - state.lastWall) / 1000) * state.speed;
  state.lastWall = ts;
  state.time += dt;
  if (state.time >= state.session.duration) {
    state.time = state.session.duration;
    state.playing = false;
    $('version-select').disabled = false;
    renderPlayer();
    return;
  }
  renderPlayer();
  state.rafId = requestAnimationFrame(tick);
}

$('btn-play').addEventListener('click', async () => {
  clearErr($('player-error'));
  try {
    const id = $('version-select').value;
    if (!id) return showErr($('player-error'), '还没有已发布版本，请先到「发布版本」页冻结一版。');
    // 开始播放时固定版本；暂停后继续则沿用同一会话
    if (!state.session || String(state.session.id) !== String(id)) {
      await loadSession(id, true);
    }
    if (state.time >= state.session.duration) state.time = 0; // 播完后再按播放：从头开始
    if (state.session.duration === 0) {
      state.time = 0;
      renderPlayer();
      return;
    }
    state.playing = true;
    state.lastWall = performance.now();
    $('version-select').disabled = true;
    state.rafId = requestAnimationFrame(tick);
  } catch (err) {
    showErr($('player-error'), err.message);
  }
});

$('btn-pause').addEventListener('click', pause);
function pause() {
  state.playing = false;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  $('version-select').disabled = false;
  renderPlayer();
}

$('btn-stop').addEventListener('click', () => {
  pause();
  state.time = 0;
  renderPlayer();
});

$('play-speed').addEventListener('change', (e) => {
  state.speed = Number(e.target.value);
});

$('timeline').addEventListener('input', (e) => {
  if (!state.session) return;
  state.time = Math.min(Math.max(Number(e.target.value), 0), state.session.duration);
  renderPlayer();
});

$('btn-jump').addEventListener('click', () => {
  clearErr($('player-error'));
  if (!state.session) return showErr($('player-error'), '请先选择并加载一个演出版本。');
  const t = Number($('jump-time').value);
  if (!Number.isFinite(t)) return showErr($('player-error'), '跳转时刻必须是数字。');
  if (t < 0) return showErr($('player-error'), `非法时码：${$('jump-time').value}（不得为负）。`);
  state.time = Math.min(t, state.session.duration);
  renderPlayer();
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)) {
    e.preventDefault();
    state.playing ? pause() : $('btn-play').click();
  }
});

// 舞台 / 亮度条 / Cue 状态的通用渲染：本地播放与共享房间共用同一套渐变规则
function renderStageInto(session, t, stageEl, levelsEl, cueEl) {
  const levels = Engine.levelsAt(session.cues, session.lights, t);

  // 舞台灯具
  stageEl.innerHTML = session.lights
    .map((l) => {
      const v = Math.round(levels[l.id] * 10) / 10;
      const a = v / 100;
      return `
        <div class="lamp">
          <div class="beam" style="
              background: rgba(245,185,66,${(0.05 + a * 0.95).toFixed(3)});
              box-shadow: 0 0 ${(12 + a * 46).toFixed(0)}px rgba(245,185,66,${(a * 0.85).toFixed(3)});
              border-color: rgba(245,185,66,${(0.2 + a * 0.6).toFixed(3)});
              color: ${a > 0.5 ? '#2a1d04' : '#555'};">${fmt(v)}</div>
          <div class="name" title="${esc(l.name)}">#${l.id} ${esc(l.name)}</div>
        </div>`;
    })
    .join('');

  // 亮度条
  levelsEl.innerHTML = session.lights
    .map((l) => {
      const v = levels[l.id];
      return `
        <div class="level-item">
          <label><span>#${l.id} ${esc(l.name)}</span><span class="v">${fmt(v)}</span></label>
          <div class="level-track"><div class="level-fill" style="width:${v.toFixed(2)}%"></div></div>
        </div>`;
    })
    .join('');

  // Cue 时间线状态
  const nameOf = {};
  session.lights.forEach((l) => (nameOf[l.id] = l.name));
  cueEl.querySelector('tbody').innerHTML = session.cues
    .map((c) => {
      const end = c.time + c.duration;
      let status, cls;
      if (t < c.time) {
        status = '<span class="badge waiting">等待</span>';
        cls = '';
      } else if (c.duration > 0 && t < end) {
        status = '<span class="badge fading">渐变中</span>';
        cls = 'fading';
      } else {
        status = '<span class="badge done">已触发</span>';
        cls = 'done';
      }
      return `
        <tr class="${cls}">
          <td>${c.cueNo}</td>
          <td>#${c.lightId} ${esc(nameOf[c.lightId] || '?')}</td>
          <td>${fmt(c.time)}</td>
          <td>${fmt(c.target)}</td>
          <td>${fmt(c.duration)}</td>
          <td>${status}</td>
        </tr>`;
    })
    .join('');
}

function renderPlayer() {
  const s = state.session;
  const t = state.time;

  $('time-current').textContent = fmt(t);
  const tl = $('timeline');
  tl.value = String(t);

  if (!s) {
    $('stage').innerHTML = '<p class="muted" style="margin:auto">暂无演出版本</p>';
    $('levels').innerHTML = '';
    $('cue-timeline').querySelector('tbody').innerHTML = '';
    return;
  }

  renderStageInto(s, t, $('stage'), $('levels'), $('cue-timeline'));
}

/* ----------------------------- 共享房间 ----------------------------- */
// 创建者持控制密钥，其他人凭房间码加入；观看端以服务端墙钟校时（基准时码 +
// 流逝时间 × 速度），每秒轮询一次服务端状态做纠正，刷新/重连自动恢复。

const HASH_ROOM = 'room';
const ROOM_KEY_STORE = 'cue-room-keys'; // { 房间码: 控制密钥 }，创建者刷新后仍可控制
const ROOM_POLL_MS = 1000;

function loadRoomKeyStore() {
  try {
    return JSON.parse(localStorage.getItem(ROOM_KEY_STORE) || '{}');
  } catch {
    return {};
  }
}
function saveRoomKey(code, key) {
  const store = loadRoomKeyStore();
  if (key) store[code] = key;
  else delete store[code];
  localStorage.setItem(ROOM_KEY_STORE, JSON.stringify(store));
}

state.room = null; // { view, session, key, anchor:{wall,time,speed,playing}, pollTimer, rafId, progRows }

// 循环排演编辑器的段行（主持人本地草稿，未提交不影响房间）
function defaultProgRow() {
  const max = state.room ? state.room.view.duration : 0;
  return { start: 0, end: Math.max(0, Math.min(10, max)), repeat: 1 };
}

function renderRoomVersionOptions() {
  const sel = $('room-create-version');
  if (state.versions.length === 0) {
    sel.innerHTML = '<option value="">— 暂无已发布版本 —</option>';
    return;
  }
  sel.innerHTML = state.versions
    .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}（${v.cue_count} 条 Cue）</option>`)
    .join('');
}

$('form-room-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('room-create-error'));
  $('room-created').hidden = true;
  const version_id = $('room-create-version').value;
  if (!version_id) return showErr($('room-create-error'), '还没有已发布版本，请先到「发布版本」页冻结一版。');
  try {
    const d = await api('POST', '/api/rooms', {
      version_id,
      label: $('room-create-label').value,
      overload_protection: $('room-create-protection').checked,
    });
    $('room-create-label').value = '';
    $('room-create-protection').checked = false;
    saveRoomKey(d.code, d.control_key);
    $('room-created').hidden = false;
    $('room-created').innerHTML =
      `房间已创建：房间码 <b class="room-code">${esc(d.code)}</b>（已复制到剪贴板失败时可手动复制）。` +
      `控制密钥仅显示这一次，请妥善保存：<code>${esc(d.control_key)}</code>` +
      ` 其他人凭房间码即可观看同一舞台。`;
    await enterRoom(d.code, d.control_key, d);
  } catch (err2) {
    showErr($('room-create-error'), err2.message);
  }
});

$('form-room-join').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('room-join-error'));
  const code = $('room-join-code').value.trim().toUpperCase();
  const key = $('room-join-key').value.trim();
  if (!code) return showErr($('room-join-error'), '请输入房间码。');
  try {
    await enterRoom(code, key || null);
  } catch (err2) {
    showErr($('room-join-error'), err2.message);
  }
});

$('btn-room-copy-code').addEventListener('click', async () => {
  const code = $('room-code-view').textContent;
  try {
    await navigator.clipboard.writeText(code);
  } catch {
    /* 剪贴板不可用时忽略：房间码始终可见可手选 */
  }
});

// 加入房间：拉取服务端状态 + 固定版本快照（之后草稿/新发布不影响本房间）
async function enterRoom(code, key, initialView) {
  clearErr($('room-error'));
  const view = initialView || (await api('GET', `/api/rooms/${encodeURIComponent(code)}`));
  const snap = await api('GET', `/api/versions/${view.version.id}`);
  const cues = Engine.prepareCues(snap.cues);
  state.room = {
    view,
    key: key || loadRoomKeyStore()[view.code] || null,
    // 本浏览器作为主持人发起交接后、仅本次显示的凭证与到期墙钟（不回显、不入存储）
    issuedToken: null,
    issuedExpiresAt: null,
    issuedIssuedAt: null,
    // 本浏览器领取交接后取得的新密钥提示（仅显示一次，可手动关闭）
    claimedKey: null,
    // 循环排演编辑器的本地段行草稿
    progRows: null,
    session: {
      id: snap.id,
      label: snap.label,
      lights: snap.lights,
      cues,
      duration: Engine.showDuration(cues),
    },
  };
  applyRoomAnchor(view);

  // 重置编排编辑器：进入新房间时强制按本房间草稿重建表格
  $('room-program-table').querySelector('tbody').dataset.rows = '';

  $('room-lobby').hidden = true;
  $('room-workspace').hidden = false;
  $('room-code-view').textContent = view.code;
  $('room-info').textContent =
    `固定版本 #${view.version.id}：${view.version.label} · ${view.label}`;
  $('room-timeline').max = String(Math.max(view.duration, 0));
  $('room-time-total').textContent = fmt(view.duration);
  $('room-key-input').value = state.room.key || '';
  history.replaceState(null, '', `#${HASH_ROOM}=${view.code}`);

  startRoomLoop();
  renderRoomRole();
  renderRoom();
  renderRoomProtection();
  renderRoomHandover();
  renderRoomProgram();

  document.querySelector('.tab[data-tab="room"]').click();
}

// 服务端状态 -> 本地推算锚点（校时基准）
function applyRoomAnchor(view) {
  state.room.anchor = {
    wall: view.server_wall,
    time: view.server_time,
    speed: view.speed,
    playing: view.playing,
  };
}

// 循环排演：把“线性目标时码”映射为编排中的真实演出时码（与服务端同一份纯函数）。
// 观看端只拿到最近一次同步的段/轮/时码锚点；本地用墙钟外推。
function roomProgramProjection(view, targetLinear) {
  const p = view.program;
  if (!p || p.finished) return { time: view.server_time, segIndex: p ? p.segment_index - 1 : 0, iteration: p ? p.loop - 1 : 0, finished: !!p };
  const r = window.LightingProgram.advanceProgram(
    {
      segIndex: p.segment_index - 1,
      iteration: p.loop - 1,
      time: view.server_time,
      finished: false,
    },
    p.segments,
    targetLinear,
    null
  );
  return { time: r.time, segIndex: r.segIndex, iteration: r.iteration, finished: r.finished };
}

// 当前按服务端锚点推算出的本地时码；到末尾自动停住（与服务端同规则）
function roomCurrentTime(nowSec) {
  const r = state.room;
  const a = r.anchor;
  if (!a.playing) return Math.min(a.time, r.view.duration);
  let linear = a.time + Math.max(0, nowSec - a.wall) * a.speed;
  if (r.view.program && !r.view.program.finished) {
    // 循环排演：线性目标 -> 段/轮/时码映射
    const proj = roomProgramProjection(r.view, linear);
    let t = proj.time;
    // 超载保护：本地外推同样不越过前方首个超载边界（下次轮询由服务端纠正）
    const p = r.view.protection;
    if (p && p.enabled && p.next_trip && t > p.next_trip.time) t = p.next_trip.time;
    return t;
  }
  let t = Math.min(linear, r.view.duration);
  // 超载保护：即使观看端轮询间隔较长，两次同步之间也不越过前方首个超载边界
  // （服务端会在该边界自动暂停，下一次轮询即把锚点校正为暂停在边界）
  const p = r.view.protection;
  if (p && p.enabled && p.next_trip && t > p.next_trip.time) t = p.next_trip.time;
  return t;
}

function startRoomLoop() {
  stopRoomLoop();
  state.room.pollTimer = setInterval(pollRoom, ROOM_POLL_MS);
  const loop = () => {
    if (!state.room) return;
    renderRoom();
    state.room.rafId = requestAnimationFrame(loop);
  };
  state.room.rafId = requestAnimationFrame(loop);
}

function stopRoomLoop() {
  if (!state.room) return;
  if (state.room.pollTimer) clearInterval(state.room.pollTimer);
  if (state.room.rafId) cancelAnimationFrame(state.room.rafId);
  state.room.pollTimer = null;
  state.room.rafId = null;
}

// 轮询服务端状态：观看端按它校时，持有者也借此感知（多标签等）冲突后的新修订号
async function pollRoom() {
  if (!state.room) return;
  try {
    const view = await api('GET', `/api/rooms/${encodeURIComponent(state.room.view.code)}`);
    state.room.view = view;
    applyRoomAnchor(view);
    $('room-speed').value = String(view.speed);
    renderRoomRole();
    renderRoomProtection();
    renderRoomHandover();
    renderRoomProgram();
    updateRoomHandoverCountdown();
  } catch {
    /* 单次轮询失败不打断观看：下一周期重试 */
  }
}

function renderRoomRole() {
  const r = state.room;
  if (!r) return;
  const isHost = !!r.key;
  $('room-role').innerHTML = isHost
    ? '<span class="badge fading">持密钥者（可控制）</span>'
    : '<span class="badge waiting">观看者（只读，按服务端校时）</span>';
  $('room-key-line').style.display = isHost ? 'none' : '';
  $('room-transport').classList.toggle('is-viewer', !isHost);
}

$('btn-room-apply-key').addEventListener('click', () => {
  const r = state.room;
  if (!r) return;
  const key = $('room-key-input').value.trim();
  if (!key) return showErr($('room-error'), '请填写控制密钥（留空则保持观看者身份）。');
  r.key = key; // 乐观更新；密钥是否正确在下次控制时由服务端裁定
  saveRoomKey(r.view.code, key);
  clearErr($('room-error'));
  renderRoomRole();
});

// 统一控制入口：携带当前修订号；服务端响应即新锚点。409 冲突时先校时再提示重试
async function roomControl(action, extra = {}) {
  const r = state.room;
  if (!r) return;
  if (!r.key) return showErr($('room-error'), '观看者不能控制房间：请在上方输入创建者的控制密钥。');
  clearErr($('room-error'));
  try {
    const view = await api('POST', `/api/rooms/${encodeURIComponent(r.view.code)}/control`, {
      control_key: r.key,
      revision: r.view.revision,
      action,
      ...extra,
    });
    r.view = view;
    applyRoomAnchor(view);
    $('room-speed').value = String(view.speed);
    renderRoomRole();
    renderRoomProtection();
    renderRoomHandover();
    renderRoomProgram();
  } catch (err2) {
    if (err2.status === 409) {
      await pollRoom(); // 过期：按服务端最新状态校时后提示重试
    } else if (err2.status === 403) {
      // 密钥已失效（主持权已交给他人）：本浏览器降级为观看者，清掉旧密钥
      r.key = null;
      saveRoomKey(r.view.code, null);
      $('room-key-input').value = '';
      await pollRoom();
    } else {
      $('room-speed').value = String(r.view.speed); // 被拒绝（如非法速度）：回滚本地选择
    }
    renderRoomRole();
    renderRoomHandover();
    renderRoomProgram();
    showErr($('room-error'), `控制失败：${err2.message}`);
  }
}

$('btn-room-play').addEventListener('click', () => roomControl('play'));
$('btn-room-pause').addEventListener('click', () => roomControl('pause'));
$('btn-room-stop').addEventListener('click', async () => {
  // 回到起点本质是一次手动跳转：若正在循环排演，会取消编排
  const r0 = state.room;
  if (r0 && r0.key && r0.view.program &&
      !window.confirm('回到起点是手动跳转，将取消当前循环排演并回到普通房间。确定继续？')) {
    return;
  }
  await roomControl('pause');
  await roomControl('seek', { time: 0 });
});
$('btn-room-jump').addEventListener('click', () => {
  const raw = $('room-jump-time').value;
  const t = Number(raw);
  if (!Number.isFinite(t)) return showErr($('room-error'), '跳转时刻必须是数字。');
  if (t < 0) return showErr($('room-error'), `非法时码：${raw}（不得为负）。`);
  const r0 = state.room;
  if (r0 && r0.key && r0.view.program &&
      !window.confirm('手动跳转会取消当前循环排演，并沿用普通房间控制语义。确定跳转到 ' + fmt(t) + ' 秒？')) {
    return;
  }
  roomControl('seek', { time: t });
});
$('room-speed').addEventListener('change', (e) => {
  const r = state.room;
  if (!r) return;
  if (!r.key) {
    e.target.value = String(r.view.speed); // 观看者改速度只影响本地？不：速度由房间统一，回滚
    return;
  }
  roomControl('speed', { speed: Number(e.target.value) });
});

$('btn-room-leave').addEventListener('click', () => {
  leaveRoom();
});

function leaveRoom() {
  stopRoomLoop();
  state.room = null;
  $('room-workspace').hidden = true;
  $('room-lobby').hidden = false;
  $('room-join-code').value = '';
  $('room-join-key').value = '';
  if (readHash()[HASH_ROOM]) history.replaceState(null, '', window.location.pathname);
  document.querySelector('.tab[data-tab="player"]').click();
}

function renderRoom() {
  const r = state.room;
  if (!r) return;
  const t = roomCurrentTime(Date.now() / 1000);
  $('room-time-current').textContent = fmt(t);
  $('room-timeline').value = String(t);
  $('room-revision-view').textContent = String(r.view.revision);
  updateRoomHandoverCountdown();
  updateRoomProgramStatus(t);
  renderStageInto(r.session, t, $('room-stage'), $('room-levels'), $('room-cue-timeline'));
}

/* --------------------------- 循环排演 --------------------------- */
// 主持人提交 1～8 段循环（{start,end,repeat}，携带密钥与修订号）；成功后服务端
// 从首段开始播放。暂停/改速保留进度、继续从断点接续；手动跳转取消编排。观看者
// 只读查看当前段/轮次/时码，看不到编辑器与密钥。

function ensureProgRows(r) {
  if (!r.progRows) r.progRows = [defaultProgRow()];
  return r.progRows;
}

function renderRoomProgram() {
  const r = state.room;
  if (!r) return;
  const isHost = !!r.key;
  $('room-program-host').hidden = !isHost;
  $('room-program-viewer').hidden = isHost;

  if (isHost) {
    const rows = ensureProgRows(r);
    const tb = $('room-program-table').querySelector('tbody');
    // 仅在结构缺失/段数变化时重建表格，避免每秒轮询打断主持人正在输入的焦点
    if (tb.dataset.rows !== String(rows.length)) {
      renderProgramEditorRows();
    }
  }
  updateRoomProgramStatus(roomCurrentTime(Date.now() / 1000));
}

// 重建编排编辑器表格（进入房间/增删段时调用；轮询不重建以免抢走输入焦点）
function renderProgramEditorRows() {
  const r = state.room;
  if (!r) return;
  const rows = ensureProgRows(r);
  const tb = $('room-program-table').querySelector('tbody');
  tb.dataset.rows = String(rows.length);
  tb.innerHTML = rows
    .map(
      (row, i) => `
      <tr data-prog-row="${i}">
        <td class="prog-idx">第 ${i + 1} 段</td>
        <td><input data-prog="start" type="number" min="0" step="0.1" value="${row.start}" /></td>
        <td><input data-prog="end" type="number" min="0" step="0.1" value="${row.end}" /></td>
        <td><input data-prog="repeat" type="number" min="1" step="1" value="${row.repeat}" /></td>
        <td>${rows.length > 1 ? '<button type="button" data-prog-del="' + i + '" class="danger">删除</button>' : ''}</td>
      </tr>`
    )
    .join('');
  tb.querySelectorAll('input[data-prog]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-prog-row]');
      const idx = Number(tr.dataset.progRow);
      const field = e.target.dataset.prog;
      const val = e.target.value;
      rows[idx][field] = val === '' ? '' : Number(val);
    });
  });
  tb.querySelectorAll('button[data-prog-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.progDel);
      r.progRows.splice(idx, 1);
      renderProgramEditorRows();
    });
  });
}

// 状态条：未编排 / 播放中（当前段·轮次·时码）/ 暂停 / 已走完；同时列出全部段并高亮当前段
function updateRoomProgramStatus(time) {
  const box = $('room-program-status');
  const r = state.room;
  if (!r || !box) return;
  const p = r.view.program;
  if (!p) {
    box.className = 'room-program-status';
    box.innerHTML = '<span class="rp-title">循环排演：未安排</span>当前为普通房间播放；主持人可在下方编排 1～8 段循环。';
    return;
  }
  const segList = p.segments
    .map((s, i) => {
      const cur = !p.finished && i === p.segment_index - 1;
      return `<span class="${cur ? 'cur' : ''}">${cur ? '▶ ' : ''}第 ${i + 1} 段 [${fmt(s.start)}–${fmt(s.end)}]×${s.repeat}</span>`;
    })
    .join('　');
  let cls;
  let head;
  if (p.finished) {
    cls = 'is-finished';
    head = '✅ 循环排演已全部完成';
  } else if (r.view.playing) {
    cls = 'is-playing';
    head = '🎬 循环排演播放中';
  } else {
    cls = 'is-paused';
    head = '⏸ 循环排演已暂停（进度保留，继续从断点接续）';
  }
  box.className = `room-program-status ${cls}`;
  box.innerHTML =
    `<span class="rp-title">${head}</span>` +
    `当前第 <b>${p.segment_index}</b>/${p.segment_count} 段 · 第 <b>${p.loop}</b>/${p.loop_total} 轮` +
    ` · 时码 <b class="rp-time">${fmt(time)}</b> s` +
    (p.finished ? '（停在末段终点；按播放从首段重新开始）' : '') +
    `<div class="room-program-seg-list">${segList}</div>`;
}

$('btn-room-prog-add').addEventListener('click', () => {
  const r = state.room;
  if (!r) return;
  const rows = ensureProgRows(r);
  if (rows.length >= 8) return showErr($('room-program-error'), '最多 8 段。');
  rows.push(defaultProgRow());
  renderProgramEditorRows();
});

// 提交循环排演：携带控制密钥与当前修订号；成功后服务端从首段开始播放、修订号 +1
$('btn-room-prog-submit').addEventListener('click', async () => {
  const r = state.room;
  if (!r) return;
  if (!r.key) return showErr($('room-program-error'), '观看者不能编排：请先输入控制密钥。');
  clearErr($('room-program-error'));
  const rows = ensureProgRows(r);
  if (rows.length < 1 || rows.length > 8) {
    return showErr($('room-program-error'), '请编排 1～8 段。');
  }
  const segments = rows.map((row) => ({
    start: Number(row.start),
    end: Number(row.end),
    repeat: Number(row.repeat),
  }));
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (!Number.isFinite(s.start) || s.start < 0 || !Number.isFinite(s.end) || s.end < 0 ||
        !(s.start < s.end)) {
      return showErr($('room-program-error'), `第 ${i + 1} 段非法：起点/终点须为非负数字，且起点严格早于终点。`);
    }
    if (s.end > r.view.duration) {
      return showErr($('room-program-error'), `第 ${i + 1} 段终点 ${fmt(s.end)} 超过版本末尾 ${fmt(r.view.duration)} 秒。`);
    }
    if (!Number.isInteger(s.repeat) || s.repeat < 1) {
      return showErr($('room-program-error'), `第 ${i + 1} 段重复次数须为正整数。`);
    }
  }
  try {
    const view = await api('POST', `/api/rooms/${encodeURIComponent(r.view.code)}/program`, {
      control_key: r.key,
      revision: r.view.revision,
      segments,
    });
    r.view = view;
    applyRoomAnchor(view);
    renderRoomRole();
    renderRoomProtection();
    renderRoomHandover();
    renderRoomProgram();
  } catch (e) {
    if (e.status === 409) await pollRoom();
    else if (e.status === 403) {
      r.key = null;
      saveRoomKey(r.view.code, null);
      $('room-key-input').value = '';
      await pollRoom();
      renderRoomRole();
    }
    renderRoomProgram();
    showErr($('room-program-error'), `提交循环排演失败：${e.message}`);
  }
});

// 取消当前编排：删除编排并沿用普通房间语义（播放状态与时码保留）
$('btn-room-prog-cancel').addEventListener('click', async () => {
  const r = state.room;
  if (!r) return;
  if (!r.key) return showErr($('room-program-error'), '观看者不能取消编排。');
  if (!r.view.program) return showErr($('room-program-error'), '当前没有进行中的循环排演。');
  clearErr($('room-program-error'));
  try {
    const view = await api('POST', `/api/rooms/${encodeURIComponent(r.view.code)}/program/clear`, {
      control_key: r.key,
      revision: r.view.revision,
    });
    r.view = view;
    applyRoomAnchor(view);
    renderRoomRole();
    renderRoomProtection();
    renderRoomHandover();
    renderRoomProgram();
  } catch (e) {
    if (e.status === 409) await pollRoom();
    renderRoomProgram();
    showErr($('room-program-error'), `取消循环排演失败：${e.message}`);
  }
});


// 回路超载保护状态条：未启用 / 已启用安全 / 当前已超载 / 已在边界自动暂停
function renderRoomProtection() {
  const r = state.room;
  if (!r) return;
  const box = $('room-protection');
  const p = r.view.protection;
  if (!p || !p.enabled) {
    box.hidden = true;
    box.textContent = '';
    box.className = 'room-protection';
    return;
  }
  box.hidden = false;
  const circuitText = (c) =>
    c ? `回路 #${c.circuit_id}「${c.name}」（容量 ${c.capacity == null ? '—' : c.capacity}W）` : '';

  let cls;
  let html;
  if (!p.configured) {
    cls = 'is-off';
    html = '<span class="rp-title">回路超载保护：已启用</span>该房间固定版本没有回路配置（旧版快照），不产生任何超载回路，播放按原规则进行。';
  } else if (p.tripped) {
    cls = 'is-tripped';
    html = `<span class="rp-title">⚠ 超载保护已触发</span>${esc(p.tripped.reason_text)}` +
      `<br>触发回路：<span class="rp-circuit">${esc(circuitText(p.tripped.circuit))}</span>` +
      ` · 演出时码 <b>${fmt(p.tripped.time)}</b> s（可在暂停状态下跳转避险后再播放）`;
  } else if (p.overloaded_now) {
    const names = (p.circuits_overloaded_now || []).map((c) => esc(circuitText(c))).join('、');
    cls = 'is-warn';
    html = `<span class="rp-title">⛔ 当前时码处于超载段</span>${names} 负载严格大于容量：禁止播放；请暂停后跳转到安全时码。`;
  } else if (p.next_trip) {
    cls = 'is-safe';
    html = `<span class="rp-title">回路超载保护：已启用</span>前方首个超载边界在演出时码 ` +
      `<b>${fmt(p.next_trip.time)}</b> s（约 ${fmt(p.next_trip.seconds_ahead)} 秒后），` +
      `触发回路 <span class="rp-circuit">${esc(circuitText(p.next_trip.circuit))}</span>：播放抵达即自动暂停，不会越过危险段。`;
  } else {
    cls = 'is-safe';
    html = '<span class="rp-title">回路超载保护：已启用</span>前方时程内没有超载区间，可安全播放。';
  }
  box.className = `room-protection ${cls}`;
  box.innerHTML = html;
}

/* --------------------------- 主持权交接 --------------------------- */
// 当前主持人可发起交接：取得仅显示一次、五分钟有效的一次性凭证；同一房间同时
// 只有一份待领取凭证（再次发起使旧凭证失效）。接班人凭房间码与凭证领取新的
// 控制密钥（领取与修订号 +1 原子完成、旧密钥即刻失效）。凭证发出后主持人一旦
// 再成功控制房间，凭证即作废。页面只显示当前交接状态：观看者看不到凭证或密钥。

const HANDOVER_COUNTDOWN_ID = 'room-handover-countdown';

// 主持人发起交接：凭当前控制密钥与当前修订号；凭证只在本次响应里显示一次
async function issueRoomHandover() {
  const r = state.room;
  if (!r || !r.key) return;
  clearErr($('room-error'));
  try {
    const d = await api('POST', `/api/rooms/${encodeURIComponent(r.view.code)}/handover/issue`, {
      control_key: r.key,
      revision: r.view.revision,
    });
    r.view = d;
    r.issuedToken = d.handover_token; // 仅本次显示，不写入 localStorage
    r.issuedExpiresAt = Date.now() / 1000 + d.handover_expires_in;
    r.issuedIssuedAt = d.handover && d.handover.issued_at ? d.handover.issued_at : null;
    applyRoomAnchor(d);
    renderRoomRole();
    renderRoomHandover();
  } catch (err2) {
    if (err2.status === 409) {
      await pollRoom();
    } else if (err2.status === 403) {
      // 密钥已失效（主持权已交给他人）：降级为观看者
      r.key = null;
      saveRoomKey(r.view.code, null);
      $('room-key-input').value = '';
      await pollRoom();
    }
    renderRoomRole();
    renderRoomHandover();
    showErr($('room-error'), `发起交接失败：${err2.message}`);
  }
}

// 接班人领取：凭房间码与一次性凭证；成功后本浏览器成为新主持人
async function claimRoomHandover(token) {
  const r = state.room;
  if (!r) return;
  clearErr($('room-error'));
  try {
    const d = await api('POST', `/api/rooms/${encodeURIComponent(r.view.code)}/handover/claim`, {
      handover_token: token,
      revision: r.view.revision,
    });
    // 新密钥仅显示这一次：保存到本地密钥库（刷新后仍可控制），页面给出醒目一次性提示
    r.key = d.control_key;
    saveRoomKey(d.code, d.control_key);
    r.claimedKey = d.control_key;
    r.issuedToken = null;
    r.issuedExpiresAt = null;
    r.issuedIssuedAt = null;
    r.view = d;
    applyRoomAnchor(d);
    $('room-key-input').value = d.control_key;
    renderRoomRole();
    renderRoomHandover();
  } catch (err2) {
    if (err2.status === 409) await pollRoom();
    showErr($('room-error'), `领取失败：${err2.message}`);
    renderRoomHandover();
  }
}

function dismissClaimedKey() {
  const r = state.room;
  if (!r) return;
  r.claimedKey = null;
  renderRoomHandover();
}

function copyText(text) {
  return navigator.clipboard?.writeText(text).catch(() => {});
}

// 交接状态条：主持人侧（发起 / 凭证一次显示 / 作废说明）与观看者侧（领取入口）
function renderRoomHandover() {
  const r = state.room;
  const box = $('room-handover');
  if (!r) {
    box.hidden = true;
    box.innerHTML = '';
    box.className = 'room-handover';
    return;
  }
  const isHost = !!r.key;
  const ho = r.view.handover;
  const active = ho && ho.active;

  let cls = '';
  let html = '';

  if (r.claimedKey) {
    // 领取成功：新控制密钥只在此处显示一次（含关闭按钮），其他任何刷新/轮询都不再回显
    cls = 'is-done';
    html =
      '<span class="rp-title">✅ 你已成为该房间的主持人</span>' +
      '新的控制密钥<strong>仅显示这一次</strong>，请立即复制保存（已保存在本浏览器）：<br>' +
      `<code class="room-once-key">${esc(r.claimedKey)}</code>` +
      ' <button type="button" id="btn-room-copy-newkey">复制新密钥</button>' +
      ' <button type="button" id="btn-room-dismiss-newkey">我已保存，关闭</button>';
  } else if (isHost) {
    if (r.issuedToken && active && ho.issued_at && r.issuedIssuedAt &&
        Math.abs(ho.issued_at - r.issuedIssuedAt) < 1) {
      // 本浏览器刚发起、且服务端这份待领取凭证就是本次发起的：凭证本体只在此处显示
      cls = 'is-active';
      html =
        '<span class="rp-title">🔑 交接凭证已生成（五分钟内有效）</span>' +
        '把下面的<strong>一次性交接凭证</strong>连同房间码交给接班人；领取后旧控制密钥立即失效。' +
        '剩余 <b id="' + HANDOVER_COUNTDOWN_ID + '">5:00</b><br>' +
        `<code class="room-once-key">${esc(r.issuedToken)}</code>` +
        ' <button type="button" id="btn-room-copy-token">复制凭证</button>' +
        ' <button type="button" id="btn-room-reissue">重新生成（旧凭证立即失效）</button>';
    } else if (r.issuedToken && ho && !ho.active) {
      // 本浏览器发起的凭证已过期或被自己后续的控制操作作废
      cls = 'is-off';
      html =
        `<span class="rp-title">交接凭证已${ho.reason === 'superseded' ? '作废' : '过期'}</span>` +
        `${esc(ho.reason_text || '')} ` +
        '<button type="button" id="btn-room-reissue">重新发起交接</button>';
    } else if (r.issuedToken && active) {
      // 本浏览器曾发起，但服务端当前凭证是在别处（其他标签页）重新生成的：不显示旧凭证
      cls = 'is-active';
      html =
        '<span class="rp-title">🔑 主持权交接进行中</span>' +
        '当前房间的待领取凭证已在其他页面重新生成，本页显示的旧凭证已失效；剩余 ' +
        `<b id="${HANDOVER_COUNTDOWN_ID}">--:--</b>。` +
        ' <button type="button" id="btn-room-reissue">在此重新生成凭证（旧凭证立即失效）</button>';
    } else if (active) {
      // 主持人在其他标签页/由前任发起的凭证仍在：不显示凭证本体，仅提示状态
      cls = 'is-active';
      html =
        '<span class="rp-title">🔑 主持权交接进行中</span>' +
        '当前房间存在一份待领取的交接凭证，剩余 ' +
        `<b id="${HANDOVER_COUNTDOWN_ID}">--:--</b>；` +
        '你在此期间一旦成功控制房间，凭证即作废。' +
        ' <button type="button" id="btn-room-reissue">重新生成凭证（旧凭证立即失效）</button>';
    } else {
      cls = 'is-off';
      html =
        '<span class="rp-title">主持权交接</span>把主持人移交给另一位排演人员：' +
        '生成一份五分钟有效的一次性交接凭证，接班人凭房间码与凭证领取新控制密钥。' +
        ' <button type="button" id="btn-room-issue">发起主持权交接</button>';
    }
  } else {
    // 观看者：只能看到“是否在交接”，看不到凭证与任何密钥
    if (active) {
      cls = 'is-active';
      html =
        '<span class="rp-title">🔑 主持权交接进行中</span>' +
        '若主持人已把一次性交接凭证交给你，粘贴到此处领取新的控制密钥（剩余 ' +
        `<b id="${HANDOVER_COUNTDOWN_ID}">--:--</b>）：<br>` +
        '<input type="text" id="room-claim-token" placeholder="粘贴主持人给你的交接凭证" ' +
        'style="min-width:22rem;max-width:100%" autocomplete="off" />' +
        ' <button type="button" id="btn-room-claim">领取新控制密钥</button>';
    } else if (ho && !ho.active) {
      cls = 'is-off';
      html =
        `<span class="rp-title">交接凭证已${ho.reason === 'superseded' ? '作废' : '过期'}</span>` +
        `${esc(ho.reason_text || '')}`;
    } else {
      cls = 'is-off';
      html =
        '<span class="rp-title">主持权交接</span>当前没有进行中的交接；需要主持人身份时，' +
        '可在上方输入控制密钥，或请当前主持人发起交接。';
    }
  }

  box.hidden = false;
  box.className = `room-handover ${cls}`;
  box.innerHTML = html;
  updateRoomHandoverCountdown();

  // 绑定本帧内出现的按钮/输入（每次重渲染重建，无需事件委托）
  const bind = (id, fn) => {
    const el = $(id);
    if (el) el.addEventListener('click', fn);
  };
  bind('btn-room-issue', issueRoomHandover);
  bind('btn-room-reissue', issueRoomHandover);
  bind('btn-room-dismiss-newkey', dismissClaimedKey);
  bind('btn-room-copy-token', () => copyText(r.issuedToken || ''));
  bind('btn-room-copy-newkey', () => copyText(r.claimedKey || ''));
  const claimBtn = $('btn-room-claim');
  if (claimBtn) {
    claimBtn.addEventListener('click', () => {
      const t = $('room-claim-token').value.trim();
      if (!t) return showErr($('room-error'), '请粘贴主持人提供的一次性交接凭证。');
      claimRoomHandover(t);
    });
  }
}

// 倒计时：优先用本浏览器发起时的本地锚点，否则用 GET 的 expires_at - server_wall 估算
function updateRoomHandoverCountdown() {
  const r = state.room;
  const el = document.getElementById(HANDOVER_COUNTDOWN_ID);
  if (!r || !el) return;
  const ho = r.view.handover;
  if (!ho || !ho.active) return;
  let remain;
  if (r.issuedToken && r.issuedExpiresAt && r.issuedIssuedAt !== null &&
      ho.issued_at && Math.abs(ho.issued_at - r.issuedIssuedAt) < 1) {
    remain = Math.max(0, r.issuedExpiresAt - Date.now() / 1000);
  } else {
    // expires_at 与 GET 的 server_wall 同为服务端墙钟，按本地墙钟差值显示即可
    remain = Math.max(0, ho.expires_at - Date.now() / 1000);
  }
  const total = Math.ceil(remain);
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  el.textContent = `${mm}:${ss}`;
}

/* ----------------------------- 版本比对 ----------------------------- */

function renderCompareOptions() {
  const make = (sel) => {
    if (state.versions.length === 0) {
      sel.innerHTML = '<option value="">— 暂无已发布版本 —</option>';
      return;
    }
    sel.innerHTML = state.versions
      .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}</option>`)
      .join('');
  };
  make($('cmp-version-a'));
  make($('cmp-version-b'));
  // 默认 A 选最新、B 选次新（或相同版本）
  if (state.versions.length > 0) $('cmp-version-a').value = String(state.versions[0].id);
  if (state.versions.length > 1) $('cmp-version-b').value = String(state.versions[1].id);
}

function intervalText(iv) {
  // [含端点 / (不含端点；start=end 表示仅该瞬间超差的零长度闭区间
  const s = iv.start_inclusive ? '[' : '(';
  const e = iv.end_inclusive ? ']' : ')';
  return `${s}${fmt(iv.start)}, ${fmt(iv.end)}${e}`;
}

$('form-compare').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('compare-error'));
  const body = {
    version_a: $('cmp-version-a').value,
    version_b: $('cmp-version-b').value,
    start: $('cmp-start').value,
    end: $('cmp-end').value,
    at: $('cmp-at').value,
    threshold: $('cmp-threshold').value,
  };
  try {
    const d = await api('POST', '/api/compare', body);
    renderCompare(d);
  } catch (err) {
    $('compare-result').hidden = true;
    showErr($('compare-error'), '比对失败：' + err.message);
  }
});

function renderCompare(d) {
  $('compare-result').hidden = false;
  $('cmp-at-title').textContent =
    `查看时刻 t = ${fmt(d.at)} s：两版逐灯亮度（阈值 ${fmt(d.threshold)}）`;

  // 逐灯亮度
  $('cmp-levels').querySelector('tbody').innerHTML = d.levels
    .map((r) => `
      <tr class="${r.exceeds ? 'cmp-hot' : ''}">
        <td>#${r.light_id} ${esc(r.name)}</td>
        <td>${fmt(r.brightness_a)}</td>
        <td>${fmt(r.brightness_b)}</td>
        <td>${fmt(r.difference)}</td>
        <td>${r.exceeds ? '<span class="badge fading">超差</span>' : '<span class="badge done">否</span>'}</td>
      </tr>`)
    .join('');

  // 区间
  const zeroWindow = d.window.start === d.window.end;
  $('cmp-window-note').textContent = zeroWindow
    ? `零长度时窗 [${fmt(d.window.start)}, ${fmt(d.window.end)}]：仅返回该时刻亮度，不产生区间。`
    : `时窗 [${fmt(d.window.start)}, ${fmt(d.window.end)}] 秒，区间端点含 [ ] / 不含 ( )。`;
  $('cmp-intervals').querySelector('tbody').innerHTML = d.intervals
    .map((g) => `
      <tr>
        <td>#${g.light_id} ${esc(g.name)}</td>
        <td class="cmp-iv-list">${g.intervals.map(intervalText).map(esc).join('，')}</td>
        <td>${g.intervals.length}</td>
      </tr>`)
    .join('');
  $('cmp-no-diff').hidden = d.intervals.length > 0;

  // 配置差异
  const renderOnly = (list, label, cls) =>
    list.length
      ? `<div class="cmp-cfg-group ${cls}"><b>${label}（${list.length}）</b>：` +
        list.map((l) => `#${l.light_id} ${esc(l.name)}`).join('、') +
        '</div>'
      : '';
  const cfgHtml =
    renderOnly(d.config_differences.only_in_a, `仅存在于版本 A（#${d.versions.a.id}）`, 'only-a') +
    renderOnly(d.config_differences.only_in_b, `仅存在于版本 B（#${d.versions.b.id}）`, 'only-b');
  $('cmp-config').innerHTML = cfgHtml || '<p class="muted">两版灯具配置一致。</p>';
}

/* ------------------------- 回路负载预判 ------------------------- */

function renderLoadOptions() {
  const vs = $('load-version');
  if (state.versions.length === 0) {
    vs.innerHTML = '<option value="">— 暂无已发布版本 —</option>';
  } else {
    vs.innerHTML = state.versions
      .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}</option>`)
      .join('');
  }
  const rs = $('load-record');
  if (state.records.length === 0) {
    rs.innerHTML = '<option value="">— 暂无调光记录 —</option>';
  } else {
    rs.innerHTML = state.records
      .map((r) => `<option value="${r.id}">#${r.id} ${esc(r.label)}（绑定版本 #${r.version_id}）</option>`)
      .join('');
  }
}

$('load-target-type').addEventListener('change', (e) => {
  const isRecord = e.target.value === 'record';
  $('load-version-wrap').hidden = isRecord;
  $('load-record-wrap').hidden = !isRecord;
});

$('form-load').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('load-error'));
  const isRecord = $('load-target-type').value === 'record';
  const body = {
    start: $('load-start').value,
    end: $('load-end').value,
    at: $('load-at').value,
  };
  if (isRecord) body.record_id = $('load-record').value;
  else body.version_id = $('load-version').value;
  try {
    const d = await api('POST', '/api/load', body);
    renderLoad(d);
  } catch (err) {
    $('load-result').hidden = true;
    showErr($('load-error'), '分析失败：' + err.message);
  }
});

function renderLoad(d) {
  $('load-result').hidden = false;
  const src =
    d.source.kind === 'record'
      ? `调光记录 #${d.source.record.id}（${esc(d.source.record.label)}，修订号 ${d.source.record.revision}）· 绑定版本 #${d.source.version.id}`
      : `已发布版本 #${d.source.version.id}（${esc(d.source.version.label)}）`;
  $('load-at-title').textContent = `查看时刻 t = ${fmt(d.at)} s 的回路负载（${src}）`;
  const zeroWindow = d.window.start === d.window.end;
  $('load-window-note').textContent = zeroWindow
    ? `零长度时窗 [${fmt(d.window.start)}, ${fmt(d.window.end)}]：仅返回该时刻负载，不产生区间。`
    : `时窗 [${fmt(d.window.start)}, ${fmt(d.window.end)}] 秒；负载严格大于容量才计入超载区间，端点 [含 / (不含。`;

  if (!d.has_circuit_config) {
    $('load-table').querySelector('tbody').innerHTML =
      '<tr><td colspan="6" class="muted">该版本发布时没有任何回路配置：播放照常，不产生回路负载。</td></tr>';
    $('load-intervals').querySelector('tbody').innerHTML = '';
    $('load-no-over').hidden = true;
    return;
  }

  $('load-table').querySelector('tbody').innerHTML = d.circuits
    .map((c) => {
      const margin = c.capacity - c.load_at;
      const badge = c.overloaded
        ? '<span class="badge fading">超载</span>'
        : '<span class="badge done">正常</span>';
      const members =
        c.lights.length === 0
          ? '<span class="muted">（无灯具）</span>'
          : c.lights.map((l) => `#${l.light_id} ${esc(l.name)}·${fmt(l.watts)}W`).join('、');
      return `
        <tr class="${c.overloaded ? 'cmp-hot' : ''}">
          <td>#${c.circuit_id} ${esc(c.name)}</td>
          <td>${fmt(c.capacity)}</td>
          <td><b>${fmt(c.load_at)}</b></td>
          <td>${margin < 0 ? `<span class="danger-text">${fmt(margin)}</span>` : fmt(margin)}</td>
          <td>${badge}</td>
          <td class="cmp-iv-list">${members}</td>
        </tr>`;
    })
    .join('');

  const hot = d.circuits.filter((c) => c.intervals.length > 0);
  $('load-intervals').querySelector('tbody').innerHTML = hot
    .map(
      (c) => `
      <tr>
        <td>#${c.circuit_id} ${esc(c.name)}</td>
        <td class="cmp-iv-list">${c.intervals.map(intervalText).map(esc).join('，')}</td>
        <td>${c.intervals.length}</td>
      </tr>`
    )
    .join('');
  $('load-no-over').hidden = hot.length > 0;
}

/* ------------------------- 临时调光记录（覆盖/归还） ------------------------- */

const HASH_RECORD = 'record';
const HASH_TIME = 't';

function readHash() {
  const out = {};
  window.location.hash
    .replace(/^#/, '')
    .split('&')
    .filter(Boolean)
    .forEach((kv) => {
      const [k, v] = kv.split('=');
      out[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
    });
  return out;
}

function writeHash(recId, t) {
  const parts = [`${HASH_RECORD}=${recId}`];
  if (t > 0) parts.push(`${HASH_TIME}=${t}`);
  history.replaceState(null, '', `#${parts.join('&')}`);
}

function renderRecordVersionOptions() {
  const sel = $('rec-version');
  if (state.versions.length === 0) {
    sel.innerHTML = '<option value="">— 暂无已发布版本 —</option>';
    return;
  }
  sel.innerHTML = state.versions
    .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}（${v.cue_count} 条 Cue）</option>`)
    .join('');
}

async function loadRecordList({ preserveOpen = false } = {}) {
  const openId = state.record?.id;
  state.records = await api('GET', '/api/records');
  renderRecordTable();
  renderRecordVersionOptions();
  renderLoadOptions();
  if (preserveOpen && openId && state.records.some((r) => r.id === openId)) {
    await loadRecord(openId, false); // 追加成功后用服务器返回的新修订号刷新详情
  }
}

function renderRecordTable() {
  const tb = $('record-table').querySelector('tbody');
  if (state.records.length === 0) {
    tb.innerHTML = '<tr><td colspan="7" class="muted">还没有调光记录。</td></tr>';
    return;
  }
  tb.innerHTML = state.records
    .map(
      (r) => `
      <tr class="${state.record && state.record.id === r.id ? 'fading' : ''}">
        <td>#${r.id}</td>
        <td>${esc(r.label)}</td>
        <td>#${r.version_id} ${esc(r.version_label)}</td>
        <td>${r.revision}</td>
        <td>${r.op_count}</td>
        <td>${new Date(r.created_at * 1000).toLocaleString('zh-CN', { hour12: false })}</td>
        <td>
          <button data-open-record="${r.id}">打开</button>
          <button class="danger" data-del-record="${r.id}">删除</button>
        </td>
      </tr>`
    )
    .join('');
}

async function loadRecord(id, resetTime) {
  clearErr($('op-error'));
  const d = await api('GET', `/api/records/${id}`);
  const baseCues = Engine.prepareCues(d.cues);
  state.record = { ...d, baseCues, byLight: Engine.prepareOverrides(d.ops, baseCues) };
  $('record-workspace').hidden = false;
  renderRecordTable();
  renderOpFormLights();
  renderOps();
  renderRecordMeta();
  const maxT = Math.max(
    Engine.showDuration(baseCues),
    ...d.ops.map((o) => o.time + o.duration),
    0
  );
  $('rec-timeline').max = String(maxT);
  if (resetTime) state.recordTime = 0;
  renderRecordOutput();
}

function renderRecordMeta() {
  const r = state.record;
  $('rec-title').textContent = `调光记录 #${r.id}：${r.label}`;
  $('rec-meta').textContent =
    `绑定版本 #${r.version.id}（${r.version.label}，${r.version.cue_count} 条 Cue） · ` +
    `当前修订号 ${r.revision} · ${r.ops.length} 条操作 · 快照已冻结，草稿与新版本不影响本记录`;
}

function renderOpFormLights() {
  $('op-light').innerHTML = state.record.lights
    .map((l) => `<option value="${l.id}">#${l.id} ${esc(l.name)}</option>`)
    .join('');
  // 默认时码预填为末项时码，方便连续追加
  const last = state.record.ops[state.record.ops.length - 1];
  if (last) $('op-time').value = String(last.time);
}

$('op-type').addEventListener('change', (e) => {
  $('op-target').disabled = e.target.value !== 'override';
});

$('form-record-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('record-create-error'));
  const version_id = $('rec-version').value;
  if (!version_id) return showErr($('record-create-error'), '还没有已发布版本，请先到「发布版本」页冻结一版。');
  try {
    const r = await api('POST', '/api/records', { version_id, label: $('rec-label').value });
    $('rec-label').value = '';
    await loadRecordList();
    await loadRecord(r.id, true);
    switchToRecordsTab();
  } catch (err2) {
    showErr($('record-create-error'), err2.message);
  }
});

$('record-table').addEventListener('click', async (e) => {
  const openId = e.target.dataset?.openRecord;
  const delId = e.target.dataset?.delRecord;
  try {
    if (openId) {
      await loadRecord(Number(openId), true);
      writeHash(openId, 0);
      switchToRecordsTab();
    } else if (delId) {
      if (!confirm(`确认删除调光记录 #${delId}？该记录的全部操作将一并删除。`)) return;
      await api('DELETE', `/api/records/${delId}`);
      if (state.record && String(state.record.id) === String(delId)) {
        state.record = null;
        $('record-workspace').hidden = true;
        if (readHash()[HASH_RECORD]) history.replaceState(null, '', window.location.pathname);
      }
      await loadRecordList();
    }
  } catch (err2) {
    showErr($('record-create-error'), err2.message);
  }
});

function switchToRecordsTab() {
  document.querySelector('.tab[data-tab="records"]').click();
}

$('form-op').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = state.record;
  clearErr($('op-error'));
  const body = {
    revision: r.revision,
    op: {
      light_id: Number($('op-light').value),
      time: $('op-time').value,
      op_type: $('op-type').value,
      duration: $('op-duration').value,
    },
  };
  if (body.op.op_type === 'override') body.op.target = $('op-target').value;
  try {
    await appendOpsAndReload([body.op]);
  } catch (err2) {
    showErr($('op-error'), '追加失败：' + err2.message);
  }
});

// 统一追加入口：携带当前修订号；409 冲突时拉取最新详情（不覆盖查看时刻）后提示重试
async function appendOpsAndReload(ops) {
  const r = state.record;
  try {
    const d = await api('POST', `/api/records/${r.id}/ops`, { revision: r.revision, ops });
    state.record = {
      ...d,
      baseCues: Engine.prepareCues(d.cues),
      byLight: Engine.prepareOverrides(d.ops, Engine.prepareCues(d.cues)),
    };
    renderRecordTable();
    renderOps();
    renderRecordMeta();
    renderRecordOutput();
    // 同步列表中的修订号/操作数（不重新拉取详情，避免覆盖查看时刻）
    const row = state.records.find((x) => x.id === r.id);
    if (row) {
      row.revision = d.revision;
      row.op_count = d.ops.length;
      renderRecordTable();
    }
  } catch (err2) {
    if (/修订号冲突/.test(err2.message)) {
      await loadRecord(r.id, false); // 过期：以服务器序列为准重算
    }
    throw err2;
  }
}

function renderOps() {
  const nameOf = Object.fromEntries(state.record.lights.map((l) => [l.id, l.name]));
  $('op-table').querySelector('tbody').innerHTML = state.record.ops
    .map((o) => {
      const type =
        o.op_type === 'override'
          ? '<span class="badge fading">覆盖</span>'
          : '<span class="badge done">归还</span>';
      return `
        <tr>
          <td>${o.seq}</td>
          <td>#${o.light_id} ${esc(nameOf[o.light_id] || '?')}</td>
          <td>${fmt(o.time)}</td>
          <td>${type}</td>
          <td>${o.target === null || o.target === undefined ? '—' : fmt(o.target)}</td>
          <td>${fmt(o.duration)}</td>
        </tr>`;
    })
    .join('');
}

$('btn-rec-jump').addEventListener('click', () => {
  const t = Number($('rec-time').value);
  if (!Number.isFinite(t)) return showErr($('op-error'), '查看时刻必须是数字。');
  if (t < 0) return showErr($('op-error'), `非法时码：${$('rec-time').value}（不得为负）。`);
  state.recordTime = t;
  renderRecordOutput();
});

$('rec-timeline').addEventListener('input', (e) => {
  state.recordTime = Number(e.target.value);
  renderRecordOutput();
});

// 实际输出既可用服务器 /output，也可由快照+操作序列在本地重算；此处本地重算（与服务器同一引擎）
function renderRecordOutput() {
  const r = state.record;
  if (!r) return;
  const t = state.recordTime;
  $('rec-time').value = String(t);
  $('rec-timeline').value = String(t);
  writeHash(r.id, t);

  $('rec-levels').querySelector('tbody').innerHTML = r.lights
    .map((l) => {
      const orig = Engine.brightnessAt(r.baseCues, l.id, t);
      const actual = Engine.overrideBrightnessAt(r.byLight, r.baseCues, l.id, t);
      const active = Engine.activeOverride(r.byLight, l.id, t);
      const stateBadge =
        active === null
          ? '<span class="badge done">跟随原版</span>'
          : active.state === 'override'
            ? '<span class="badge fading">覆盖中</span>'
            : '<span class="badge waiting">归还融合中</span>';
      return `
        <tr class="${active ? 'fading' : ''}">
          <td>#${l.id} ${esc(l.name)}</td>
          <td class="muted">${fmt(orig)}</td>
          <td><b>${fmt(actual)}</b></td>
          <td>${stateBadge}</td>
          <td><div class="level-track"><div class="level-fill" style="width:${actual.toFixed(2)}%"></div></div></td>
        </tr>`;
    })
    .join('');
}

/* ----------------------------- 版本合并 ----------------------------- */

state.merge = null; // 当前预览结果

function renderMergeOptions() {
  const make = (sel) => {
    if (state.versions.length === 0) {
      sel.innerHTML = '<option value="">— 暂无已发布版本 —</option>';
      return;
    }
    sel.innerHTML = state.versions
      .map((v) => `<option value="${v.id}">#${v.id} ${esc(v.label)}</option>`)
      .join('');
  };
  make($('merge-base'));
  make($('merge-incoming'));
  // 默认基线选次新、待合入选最新（两组各自改稿后发布的典型顺序）
  if (state.versions.length > 0) $('merge-incoming').value = String(state.versions[0].id);
  if (state.versions.length > 1) $('merge-base').value = String(state.versions[1].id);
}

function formatMergeValue(kind, v) {
  if (v === null || v === undefined) return '<span class="badge waiting">— 已删除 —</span>';
  if (kind === 'light') return `名称：${esc(v.name)}`;
  if (kind === 'circuit') return `名称：${esc(v.name)}；容量：${fmt(v.capacity)} W`;
  if (kind === 'cue') {
    return `灯具：#${v.light_id} ${esc(v.light_name || '')}；时码：${fmt(v.time)}s；` +
      `目标：${fmt(v.target)}；渐变：${fmt(v.duration)}s`;
  }
  if (v.circuit_id === null) return '未分配回路（不计入负载）';
  return `回路：#${v.circuit_id} ${esc(v.circuit_name || '')}；额定：${fmt(v.watts)} W`;
}

function actionBadge(action, text) {
  const cls = action === 'delete' ? 'danger-text' : '';
  return `<span class="${cls}">${esc(text)}</span>`;
}

$('form-merge-preview').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr($('merge-error'));
  const body = {
    base_version_id: $('merge-base').value,
    incoming_version_id: $('merge-incoming').value,
  };
  try {
    state.merge = await api('POST', '/api/merge/preview', body);
    renderMergePreview();
  } catch (err2) {
    state.merge = null;
    $('merge-workspace').hidden = true;
    showErr($('merge-error'), '预览失败：' + err2.message);
  }
});

function renderMergePreview() {
  const m = state.merge;
  $('merge-workspace').hidden = false;
  clearErr($('merge-commit-error'));
  $('merge-title').textContent =
    `合并预览：基线 #${m.base.id}（${m.base.label}） → 合入 #${m.incoming.id}（${m.incoming.label}）`;
  $('merge-meta').textContent =
    `自动合入 ${m.summary.auto_total} 项` +
    `（新增 ${m.summary.auto_add} / 修改 ${m.summary.auto_update} / 删除 ${m.summary.auto_delete}），` +
    `冲突 ${m.summary.conflicts_total} 项。预览只读，尚未改动草稿。`;

  $('merge-auto-table').querySelector('tbody').innerHTML = m.auto
    .map(
      (a) => `
      <tr>
        <td>${esc(a.title)}</td>
        <td>${actionBadge(a.action, a.action_text)}</td>
        <td class="merge-side">${formatMergeValue(a.kind, a.base)}</td>
        <td class="merge-side">${formatMergeValue(a.kind, a.current)}</td>
        <td class="merge-side">${formatMergeValue(a.kind, a.incoming)}</td>
        <td class="merge-side"><b>${formatMergeValue(a.kind, a.applied)}</b></td>
      </tr>`
    )
    .join('');
  $('merge-no-auto').hidden = m.auto.length > 0;

  const box = $('merge-conflicts');
  if (m.conflicts.length === 0) {
    box.innerHTML = '';
    $('merge-no-conflict').hidden = false;
    return;
  }
  $('merge-no-conflict').hidden = true;
  box.innerHTML = m.conflicts
    .map(
      (c, idx) => {
        const warn = (side) =>
          c.reasons
            .filter((r) => r.side === side)
            .map((r) => `<li class="danger-text">⚠ ${esc(r.text)}</li>`)
            .join('');
        return `
        <div class="merge-conflict" data-conflict-index="${idx}">
          <div class="merge-conflict-head">
            <b>${esc(c.title)}</b>
            <span class="muted">${esc(c.reason_text)}</span>
          </div>
          <div class="merge-conflict-cols">
            <label class="merge-choice ${c.draft === null ? 'is-deleted' : ''}">
              <input type="radio" name="merge-choice-${idx}" value="draft" />
              <div>
                <div class="merge-choice-label">保留草稿</div>
                <div class="merge-side">${formatMergeValue(c.kind, c.draft)}</div>
                <ul class="merge-warns">${warn('draft')}</ul>
              </div>
            </label>
            <label class="merge-choice ${c.incoming === null ? 'is-deleted' : ''}">
              <input type="radio" name="merge-choice-${idx}" value="incoming" />
              <div>
                <div class="merge-choice-label">采用待合入版本</div>
                <div class="merge-side">${formatMergeValue(c.kind, c.incoming)}</div>
                <ul class="merge-warns">${warn('incoming')}</ul>
              </div>
            </label>
          </div>
        </div>`;
      }
    )
    .join('');
}

$('btn-merge-commit').addEventListener('click', async () => {
  const m = state.merge;
  if (!m) return;
  clearErr($('merge-commit-error'));

  const resolutions = {};
  const unanswered = [];
  m.conflicts.forEach((c, idx) => {
    const picked = document.querySelector(`input[name="merge-choice-${idx}"]:checked`);
    if (!picked) unanswered.push(c.title);
    else resolutions[c.key] = picked.value;
  });
  if (unanswered.length > 0) {
    return showErr(
      $('merge-commit-error'),
      `还有 ${unanswered.length} 个冲突未选择：${unanswered.slice(0, 5).join('、')}${
        unanswered.length > 5 ? ' 等' : ''
      }`
    );
  }

  try {
    const d = await api('POST', '/api/merge/commit', { token: m.token, resolutions });
    state.merge = null;
    $('merge-workspace').hidden = true;
    // 用合并后的新草稿刷新各页
    await loadLights();
    await loadCircuits();
    await loadCues();
    await loadVersions({ keepSelection: false });
    alert(
      `合并成功：自动合入 ${d.summary.auto_total} 项，冲突已全部按抉择处理。` +
      '当前草稿已更新；已发布版本与调光记录保持不变。'
    );
  } catch (err2) {
    if (/重新预览/.test(err2.message)) {
      state.merge = null;
      $('merge-workspace').hidden = true;
    }
    showErr($('merge-commit-error'), '合并提交失败：' + err2.message);
  }
});

/* ----------------------------- 启动 ----------------------------- */

(async function init() {
  try {
    [state.lights, state.circuits, state.cues, state.versions, state.records] = await Promise.all([
      api('GET', '/api/lights'),
      api('GET', '/api/circuits'),
      api('GET', '/api/cues'),
      api('GET', '/api/versions'),
      api('GET', '/api/records'),
    ]);
    renderLights();
    renderLightOptions();
    renderCircuits();
    renderCues();
    renderVersions();
    renderVersionOptions(null);
    renderCompareOptions();
    renderRecordVersionOptions();
    renderRecordTable();
    renderLoadOptions();
    renderRoomVersionOptions();

    // 刷新后按 #room=<房间码> 自动重连（密钥从本地存储恢复；无密钥即以观看者加入）
    const hash = readHash();
    if (hash[HASH_ROOM]) {
      try {
        await enterRoom(hash[HASH_ROOM].toUpperCase(), loadRoomKeyStore()[hash[HASH_ROOM].toUpperCase()] || null);
      } catch (roomErr) {
        showErr($('room-join-error'), roomErr.message);
      }
    }
    if (hash[HASH_RECORD]) {
      const rid = Number(hash[HASH_RECORD]);
      if (state.records.some((r) => r.id === rid)) {
        switchToRecordsTab();
        await loadRecord(rid, true);
        const t = Number(hash[HASH_TIME]);
        if (Number.isFinite(t) && t >= 0) {
          state.recordTime = t;
          renderRecordOutput();
        }
      }
    }

    if (state.versions.length > 0) {
      await loadSession(state.versions[0].id, true); // 默认加载最新版本，停在 0 秒
    } else {
      renderPlayer();
    }
  } catch (err) {
    showErr($('player-error'), '初始化失败：' + err.message);
  }
})();
