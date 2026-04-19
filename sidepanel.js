/**
 * ShopLoop AI 主控台（Side Panel） - Operations Terminal
 *
 * 职责：
 *   1. 显示双平台任务列表（即梦 + Runway）
 *   2. 显示平台健康（in-progress / 上限）
 *   3. 挂机模式开关 (Autopilot)
 *   4. 添加任务 / 启动 / 暂停 / 清空
 *
 * 数据流：
 *   - 主动每 2.5 秒轮询 GET_BATCH_TASKS + GET_PLATFORM_HEALTH
 *   - chrome.storage.onChanged 监听 batchTasks，立即刷新
 */

import { getImageRecord, putImageRecord } from './image-store.js';
import { createZip, parseZip } from './zip-utils.js';

const STATE = {
  filterPlatform: 'all',
  filterStatusList: 'all',
  tasks: [],
  health: { jimeng: { running: 0, limit: 3 }, runway: { running: 0, limit: 2 } },
  autoRun: false,
  pollTimer: null,
  exportSelectMode: false,
};

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

function toast(message, durationMs = 1800) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), durationMs);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pad2(n) {
  if (n == null || isNaN(n)) return '—';
  const v = Number(n);
  return v < 10 ? `0${v}` : String(v);
}

// ─── 渲染 ─────────────────────────────────────────────────

function renderHealth() {
  const j = STATE.health.jimeng || {};
  const r = STATE.health.runway || {};
  $('jimengStat').innerHTML = `${pad2(j.running)}<span class="sep">/</span><span class="limit">${pad2(j.limit)}</span>`;
  $('runwayStat').innerHTML = `${pad2(r.running)}<span class="sep">/</span><span class="limit">${pad2(r.limit)}</span>`;
  // Runway 当日计数（80/天风控）
  const dailyEl = $('runwayDaily');
  if (dailyEl && r.dailyCap) {
    dailyEl.textContent = `今日 ${r.dailyCount}/${r.dailyCap}`;
    dailyEl.classList.toggle('cap', !!r.dailyCapReached);
  }
}

function renderAutoRun() {
  $('autoRunToggle').checked = STATE.autoRun;
  const label = $('autoRunLabel');
  const text = $('autoRunText');
  if (STATE.autoRun) {
    label.classList.add('on');
    text.textContent = '运行中';
  } else {
    label.classList.remove('on');
    text.textContent = '待机';
  }
}

function statusLabel(status) {
  const map = {
    pending: '待提交',
    uploading: '上传中',
    submitting: '提交中',
    queued: '排队',
    generating: '生成中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消'
  };
  return map[status] || status;
}

function platformLabel(platformId) {
  return platformId === 'runway' ? 'Runway' : '即梦';
}

function isActiveStatus(status) {
  return status === 'generating' || status === 'queued' || status === 'uploading' || status === 'submitting';
}

function renderTasks() {
  const list = $('taskList');

  // 过滤
  const filtered = STATE.tasks.filter((t) => {
    const p = t.platform || 'jimeng';
    if (STATE.filterPlatform !== 'all' && p !== STATE.filterPlatform) return false;
    if (STATE.filterStatusList !== 'all') {
      const allowed = STATE.filterStatusList.split(',');
      if (!allowed.includes(t.status)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    const msg = STATE.tasks.length === 0 ? '暂无任务' : '当前筛选条件下没有任务';
    list.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }

  // 排序：未完成在前，按 createdAt 倒序
  const sorted = [...filtered].sort((a, b) => {
    const ad = a.status === 'completed' || a.status === 'failed' || a.status === 'cancelled' ? 1 : 0;
    const bd = b.status === 'completed' || b.status === 'failed' || b.status === 'cancelled' ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  list.innerHTML = sorted.map((task) => renderTaskCard(task)).join('');

  // 绑定按钮
  list.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const action = el.dataset.action;
      const taskId = el.dataset.taskId;
      handleTaskAction(action, taskId);
    });
  });
}

function renderTaskCard(task) {
  const platformId = task.platform || 'jimeng';
  const status = task.status || 'pending';

  // 缩略图：如果有视频结果，用视频的 thumbnailUrl；否则用第一张参考图
  let thumbHtml = '<div class="placeholder">◇</div>';
  if (task.thumbnailUrl) {
    thumbHtml = `<img src="${escapeHtml(task.thumbnailUrl)}" alt="">`;
  } else if (task.images?.[0]?.preview) {
    thumbHtml = `<img src="${escapeHtml(task.images[0].preview)}" alt="">`;
  }

  // 进度 / ETA
  let progressHtml = '';
  if (status === 'generating' || status === 'queued') {
    const pct = task.queueInfo?.progress != null ? task.queueInfo.progress : 0;
    progressHtml = `
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="progress-pct">${pct.toString().padStart(2, '0')}%</span>
    `;
  } else if (status === 'queued' && task.queueInfo?.estimatedTimeToStartSeconds) {
    progressHtml = `<span class="task-eta">预计 ${task.queueInfo.estimatedTimeToStartSeconds}s 后开始</span>`;
  }

  // 操作按钮
  const actions = [];
  if (status === 'completed' && task.videoUrl) {
    actions.push(`<a href="${escapeHtml(task.videoUrl)}" target="_blank" rel="noopener">↓ 下载</a>`);
  }
  if (status === 'failed' || status === 'cancelled') {
    actions.push(`<button data-action="retry" data-task-id="${task.id}">重试</button>`);
  }
  if (status === 'pending' || status === 'failed' || status === 'cancelled' || status === 'completed') {
    actions.push(`<button data-action="edit" data-task-id="${task.id}">编辑</button>`);
    actions.push(`<button data-action="delete" data-task-id="${task.id}">删除</button>`);
  }

  // 防御：历史数据里 task.error 可能是对象（旧 bug 残留），coerce 一次
  const errorText = task.error == null
    ? ''
    : (typeof task.error === 'string'
        ? task.error
        : (task.error.message
            || (() => { try { return JSON.stringify(task.error); } catch { return '任务失败'; } })()));
  const errorHtml = errorText
    ? `<div class="task-error">${escapeHtml(errorText)}</div>`
    : '';

  const promptText = task.promptText || task.config?.prompt || '(无提示词)';
  const aspectRatio = task.config?.aspectRatio || '';
  const duration = task.config?.duration || task.config?.durationSeconds || '—';

  const cardClasses = [
    'task-card',
    `platform-${platformId}`,
    isActiveStatus(status) ? 'is-active' : ''
  ].filter(Boolean).join(' ');

  return `
    <div class="${cardClasses}" data-task-id-card="${task.id}">
      <input type="checkbox" class="export-check" data-export-id="${task.id}">
      <div class="task-thumb">${thumbHtml}</div>
      <div class="task-body">
        <div class="task-row1">
          <span class="task-platform-tag ${platformId}">${platformLabel(platformId)}</span>
          ${aspectRatio ? `<span>${escapeHtml(aspectRatio)}</span>` : ''}
          <span class="task-meta-sep">·</span>
          <span>${duration}S</span>
        </div>
        <div class="task-prompt">${escapeHtml(promptText)}</div>
        <div class="task-status-row">
          <span class="status-badge status-${status}">${statusLabel(status)}</span>
          ${progressHtml}
        </div>
        ${errorHtml}
        ${actions.length > 0 ? `<div class="task-actions">${actions.join('')}</div>` : ''}
      </div>
    </div>
  `;
}

// ─── 数据加载 ────────────────────────────────────────────

async function loadAll() {
  const [tasksResp, healthResp, autoRunResp] = await Promise.all([
    send({ type: 'GET_BATCH_TASKS' }),
    send({ type: 'GET_PLATFORM_HEALTH' }),
    send({ type: 'GET_AUTO_RUN' })
  ]);

  if (tasksResp?.tasks) STATE.tasks = tasksResp.tasks;
  if (healthResp?.health) STATE.health = healthResp.health;
  if (typeof autoRunResp?.enabled === 'boolean') STATE.autoRun = autoRunResp.enabled;

  renderTasks();
  renderHealth();
  renderAutoRun();
}

function startPolling() {
  if (STATE.pollTimer) clearInterval(STATE.pollTimer);
  STATE.pollTimer = setInterval(loadAll, 2500);
}

// ─── 事件处理 ────────────────────────────────────────────

function handleTaskAction(action, taskId) {
  if (action === 'delete') {
    if (!confirm('确认删除此任务？')) return;
    send({ type: 'DELETE_BATCH_TASK', taskId }).then((r) => {
      if (r.success) { toast('已删除'); loadAll(); }
      else toast('删除失败：' + r.error);
    });
  } else if (action === 'edit' || action === 'retry') {
    chrome.windows.create({
      url: chrome.runtime.getURL(`add_task.html?${action === 'retry' ? 'duplicate' : 'edit'}=${encodeURIComponent(taskId)}`),
      type: 'popup', width: 760, height: 720
    });
  }
}

function bindEvents() {
  $('addTaskBtn').addEventListener('click', () => {
    chrome.windows.create({
      url: chrome.runtime.getURL('add_task.html'),
      type: 'popup', width: 760, height: 720
    });
  });

  $('refreshBtn').addEventListener('click', () => {
    loadAll().then(() => toast('已刷新'));
  });

  $('settingsBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('runway-debug.html') });
  });

  $('startBtn').addEventListener('click', async () => {
    const r = await send({ type: 'START_BATCH_SUBMIT' });
    if (r?.success) toast('批量任务已启动');
    else toast('启动失败：' + (r?.error || '未知错误'));
    loadAll();
  });

  $('pauseBtn').addEventListener('click', async () => {
    const r = await send({ type: 'PAUSE_BATCH_SUBMIT' });
    if (r?.success) toast('已暂停');
    loadAll();
  });

  $('clearBtn').addEventListener('click', async () => {
    if (!confirm('清空所有已完成任务？')) return;
    const r = await send({ type: 'CLEAR_COMPLETED' });
    if (r?.success) { toast('已清空'); loadAll(); }
  });

  $('autoRunToggle').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    const r = await send({ type: 'SET_AUTO_RUN', enabled });
    if (r?.success) {
      STATE.autoRun = r.enabled;
      renderAutoRun();
      toast(enabled ? '挂机模式已开启' : '挂机模式已关闭');
    } else {
      e.target.checked = !enabled;  // 回滚
      toast('切换失败：' + (r?.error || '未知错误'));
    }
  });

  // 筛选
  document.querySelectorAll('[data-filter-platform]').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('[data-filter-platform]').forEach((x) => x.classList.remove('active'));
      el.classList.add('active');
      STATE.filterPlatform = el.dataset.filterPlatform;
      renderTasks();
    });
  });
  document.querySelectorAll('[data-filter-status]').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('[data-filter-status]').forEach((x) => x.classList.remove('active'));
      el.classList.add('active');
      STATE.filterStatusList = el.dataset.filterStatus;
      renderTasks();
    });
  });

  // chrome.storage 变化即时刷新（不依赖轮询）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.batchTasks || changes.autoRunEnabled)) {
      loadAll();
    }
  });

  // ─── 导入 / 导出 ─────────────────────────────────────────
  $('exportBtn').addEventListener('click', () => {
    $('exportOverlay').classList.add('show');
  });
  $('exportCancelBtn').addEventListener('click', () => {
    $('exportOverlay').classList.remove('show');
  });
  $('exportOverlay').addEventListener('click', (e) => {
    if (e.target === $('exportOverlay')) $('exportOverlay').classList.remove('show');
  });
  $('exportAllBtn').addEventListener('click', () => {
    $('exportOverlay').classList.remove('show');
    exportFiltered();
  });
  $('exportSelectBtn').addEventListener('click', () => {
    $('exportOverlay').classList.remove('show');
    enterExportSelectMode();
  });
  $('exportSelectedBtn').addEventListener('click', () => {
    const ids = [...document.querySelectorAll('.export-check:checked')].map(cb => cb.dataset.exportId);
    if (ids.length === 0) { toast('请至少勾选一个任务'); return; }
    exitExportSelectMode();
    exportByIds(ids);
  });
  $('exportBarCancel').addEventListener('click', exitExportSelectMode);

  $('importBtn').addEventListener('click', () => {
    $('importFileInput').value = '';
    $('importFileInput').click();
  });
  $('importFileInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importFromZip(file);
  });
}

// ─── 启动 ────────────────────────────────────────────────

bindEvents();
loadAll();
startPolling();

// ─── 导出/导入逻辑 ─────────────────────────────────────────

function enterExportSelectMode() {
  STATE.exportSelectMode = true;
  document.body.classList.add('export-select-mode');
}

function exitExportSelectMode() {
  STATE.exportSelectMode = false;
  document.body.classList.remove('export-select-mode');
  document.querySelectorAll('.export-check').forEach(cb => cb.checked = false);
}

function getFilteredTasks() {
  return STATE.tasks.filter((t) => {
    const p = t.platform || 'jimeng';
    if (STATE.filterPlatform !== 'all' && p !== STATE.filterPlatform) return false;
    if (STATE.filterStatusList !== 'all') {
      const allowed = STATE.filterStatusList.split(',');
      if (!allowed.includes(t.status)) return false;
    }
    return true;
  });
}

function exportFiltered() {
  const tasks = getFilteredTasks();
  if (tasks.length === 0) { toast('当前筛选下没有任务'); return; }
  exportByIds(tasks.map(t => t.id));
}

async function exportByIds(taskIds) {
  try {
    toast('正在打包…');
    const idSet = new Set(taskIds);
    const tasksToExport = STATE.tasks.filter(t => idSet.has(t.id));

    const cleaned = tasksToExport.map(t => {
      const c = { ...t };
      c.status = 'pending';
      c.error = null;
      c.runwayTaskId = null;
      c.historyRecordId = null;
      c.videoUrl = null;
      c.thumbnailUrl = null;
      c.queueInfo = null;
      return c;
    });

    const imageIds = new Set();
    for (const t of cleaned) {
      if (t.images) {
        for (const img of t.images) {
          if (img.imageId) imageIds.add(img.imageId);
        }
      }
    }

    const zipFiles = [];
    zipFiles.push({
      name: 'tasks.json',
      data: new TextEncoder().encode(JSON.stringify(cleaned, null, 2)),
    });

    for (const imageId of imageIds) {
      try {
        const record = await getImageRecord(imageId);
        if (record?.blob) {
          const ab = await record.blob.arrayBuffer();
          zipFiles.push({
            name: `images/${imageId}.bin`,
            data: new Uint8Array(ab),
          });
        }
      } catch (e) {
        console.warn('读取图片失败:', imageId, e);
      }
    }

    const blob = createZip(zipFiles);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shoploop-export-${ts}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`已导出 ${tasksToExport.length} 个任务`);
  } catch (e) {
    console.error('导出失败:', e);
    toast('导出失败：' + (e.message || '未知错误'));
  }
}

async function importFromZip(file) {
  try {
    toast('正在导入…');
    const buffer = await file.arrayBuffer();
    const entries = parseZip(buffer);

    const tasksEntry = entries.find(e => e.name === 'tasks.json');
    if (!tasksEntry) { toast('ZIP 中找不到 tasks.json'); return; }

    const tasksJson = new TextDecoder().decode(tasksEntry.data);
    const tasks = JSON.parse(tasksJson);
    if (!Array.isArray(tasks) || tasks.length === 0) { toast('没有可导入的任务'); return; }

    const imageEntries = entries.filter(e => e.name.startsWith('images/'));
    for (const ie of imageEntries) {
      const imageId = ie.name.replace('images/', '').replace('.bin', '');
      if (!imageId) continue;
      const blob = new Blob([ie.data]);
      await putImageRecord({ id: imageId, blob });
    }

    let imported = 0;
    for (const task of tasks) {
      task.id = crypto.randomUUID();
      task.status = 'pending';
      task.error = null;
      task.runwayTaskId = null;
      task.historyRecordId = null;
      task.videoUrl = null;
      task.thumbnailUrl = null;
      task.queueInfo = null;
      task.createdAt = Date.now();

      const r = await send({ type: 'ADD_BATCH_TASK', task });
      if (r?.success) imported++;
    }

    await loadAll();
    toast(`已导入 ${imported} 个任务`);
  } catch (e) {
    console.error('导入失败:', e);
    toast('导入失败：' + (e.message || '未知错误'));
  }
}

// ─── Footer 交互（避开 MV3 CSP 对内联 <script> 的禁用） ───

// 风险 / 更新日志 折叠
document.getElementById('riskToggle')?.addEventListener('click', () => {
  document.getElementById('riskPanel')?.classList.toggle('open');
});
document.getElementById('changelogToggle')?.addEventListener('click', () => {
  document.getElementById('changelogPanel')?.classList.toggle('open');
});

// 微信号点击复制
document.querySelectorAll('.credit-copy').forEach((el) => {
  el.addEventListener('click', async () => {
    const wx = el.getAttribute('data-copy');
    if (!wx) return;
    try {
      await navigator.clipboard.writeText(wx);
      const orig = el.textContent;
      el.textContent = '已复制 ✓';
      el.style.color = 'var(--success)';
      setTimeout(() => {
        el.textContent = orig;
        el.style.color = '';
      }, 1200);
    } catch (e) {
      console.warn('复制失败', e);
    }
  });
});
