/**
 * Popup Script
 * 统一任务中心：合并页面捕获任务与插件提交队列
 */

// 开源版：原 license 模块（含商业密钥）已移除
let currentFilter = 'all';
let dataSourceFilter = 'all';
let statusFilter = 'all';
let monitorTasks = [];
let batchTasks = [];
let batchControlState = getDefaultBatchControlState();
let selectedImages = [];
let dashboardRefreshInFlight = false;
let pendingDashboardRefresh = false;
let pendingDashboardForceSync = false;

const BATCH_MODEL_OPTIONS = {
  seedance_2_fast: 'Seedance 2.0 Fast',
  seedance_2: 'Seedance 2.0'
};

const BATCH_REFERENCE_MODE_OPTIONS = {
  all_reference: '全能参考',
  first_last_frames: '首尾帧'
};

const DEFAULT_MONITOR_SETTINGS = {
  autoRefreshEnabled: true
};

const DEFAULT_BATCH_CONFIG = {
  model: 'seedance_2_fast',
  referenceMode: 'all_reference',
  aspectRatio: '16:9',
  durationMode: 'manual',
  durationSeconds: 4
};

document.addEventListener('DOMContentLoaded', () => {
  initializeButtons();
  initializeMonitorSettings();
  initializeTaskComposer();
  refreshDashboard();

  setInterval(() => {
    refreshDashboard();
  }, 3000);
});

// 开源版：批量提交前的授权检查改为始终放行
function requireLicense() {
  return true;
}

function initializeButtons() {
  document.getElementById('addTaskBtn').addEventListener('click', () => {
    openAddTaskModal();
  });

  // 打开主控台（侧边栏）
  const sidePanelBtn = document.getElementById('openSidePanelBtn');
  if (sidePanelBtn) {
    sidePanelBtn.addEventListener('click', async () => {
      try {
        const win = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: win.id });
        window.close();   // 打开侧边栏后关掉 popup
      } catch (err) {
        console.warn('打开侧边栏失败:', err);
        // 兜底：通过 background 打开
        chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
      }
    });
  }

  document.getElementById('refreshBtn').addEventListener('click', () => {
    if (confirm('确定要手动刷新任务列表吗？')) {
      refreshDashboard({ forceSync: true });
    }
  });

  document.getElementById('settingsBtn').addEventListener('click', () => {
    document.getElementById('settingsPanel').classList.toggle('settings-panel-hidden');
  });

  document.getElementById('batchToggleBtn').addEventListener('click', async () => {
    const btn = document.getElementById('batchToggleBtn');
    const state = batchControlState || deriveBatchControlState(batchTasks);

    if (state.isActive) {
      if (!confirm('确定要暂停自动提交剩余待提交任务吗？')) return;
      await runBatchToggleAction(btn, 'PAUSE_BATCH_SUBMIT', '暂停中...');
      return;
    }

    if (!state.pendingCount) {
      return;
    }

    if (!requireLicense()) return;

    const actionText = state.isPaused || state.runningCount > 0 ? '继续提交' : '开始提交';
    if (!confirm(`确定要${actionText}待提交任务吗？`)) return;
    await runBatchToggleAction(btn, 'START_BATCH_SUBMIT', '启动中...');
  });
}

function initializeMonitorSettings() {
  const toggle = document.getElementById('autoRefreshToggle');

  chrome.storage.local.get(['monitorSettings'], ({ monitorSettings }) => {
    const settings = {
      ...DEFAULT_MONITOR_SETTINGS,
      ...(monitorSettings || {})
    };

    toggle.checked = Boolean(settings.autoRefreshEnabled);
  });

  toggle.addEventListener('change', () => {
    chrome.storage.local.get(['monitorSettings'], ({ monitorSettings }) => {
      chrome.storage.local.set({
        monitorSettings: {
          ...(monitorSettings || {}),
          autoRefreshEnabled: toggle.checked
        }
      });
    });
  });
}

function initializeTaskComposer() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TASK_ADDED_SUCCESSFULLY') {
      refreshDashboard();
    }
  });
}

function refreshDashboard(options = {}) {
  if (dashboardRefreshInFlight) {
    pendingDashboardRefresh = true;
    pendingDashboardForceSync = pendingDashboardForceSync || Boolean(options.forceSync);
    return;
  }

  dashboardRefreshInFlight = true;

  Promise.all([
    sendMessage({ type: 'GET_TASKS', forceSync: Boolean(options.forceSync) }),
    sendMessage({ type: 'GET_BATCH_TASKS' })
  ]).then(([taskResponse, batchResponse]) => {
    monitorTasks = taskResponse?.tasks || [];
    batchTasks = batchResponse?.tasks || [];
    batchControlState = batchResponse?.state || deriveBatchControlState(batchTasks);

    renderTaskCenter();
    updateQueueControls();
    updateHeaderStatus();
  }).catch((error) => {
    console.error('刷新任务中心失败:', error);
  }).finally(() => {
    dashboardRefreshInFlight = false;
    if (pendingDashboardRefresh) {
      const nextForceSync = pendingDashboardForceSync;
      pendingDashboardRefresh = false;
      pendingDashboardForceSync = false;
      refreshDashboard({ forceSync: nextForceSync });
    }
  });
}

function renderTaskCenter() {
  const container = document.getElementById('taskCenterList');

  const unifiedItems = buildUnifiedItems().filter(item => {
    if (currentFilter !== 'all' && item.platform !== currentFilter) return false;
    if (dataSourceFilter === 'task' && item.batchId === null) return false;
    return true;
  });

  const pending = unifiedItems.filter(item => ['pending', 'preparing'].includes(item.status)).length;
  const active = unifiedItems.filter(item => ['queuing', 'generating'].includes(item.status)).length;
  const failed = unifiedItems.filter(item => item.status === 'failed').length;
  const completed = unifiedItems.filter(item => item.status === 'completed').length;

  const filteredItems = statusFilter === 'all' ? unifiedItems : unifiedItems.filter(item => {
    if (statusFilter === 'pending') return ['pending', 'preparing'].includes(item.status);
    if (statusFilter === 'active') return ['queuing', 'generating'].includes(item.status);
    if (statusFilter === 'failed') return item.status === 'failed';
    if (statusFilter === 'completed') return item.status === 'completed';
    return true;
  });

  container.innerHTML = createTaskSection('全部', filteredItems, {
    pending,
    active,
    failed,
    completed
  }, { allCount: unifiedItems.length });
  bindTaskActions(filteredItems);
}

function createTaskSection(title, items, stats, options = {}) {
  const collapsible = Boolean(options.collapsible);
  const sectionClassName = options.className || '';
  const allCount = options.allCount ?? items.length;

  const listHtml = items.length ? items.map(item => createUnifiedTaskCard(item)).join('') : `
    <div class="empty-state empty-state-sm">
      <p>该分类下暂无任务</p>
    </div>
  `;

  const statsHtml = stats ? `
    <div class="section-stats">
      <button class="stats-tab${statusFilter === 'pending' ? ' stats-tab-active' : ''}" data-status-filter="pending">待提交 ${stats.pending}</button>
      <button class="stats-tab${statusFilter === 'active' ? ' stats-tab-active' : ''}" data-status-filter="active">排队中 ${stats.active}</button>
      <button class="stats-tab${statusFilter === 'failed' ? ' stats-tab-active' : ''}" data-status-filter="failed">失败 ${stats.failed}</button>
      <button class="stats-tab${statusFilter === 'completed' ? ' stats-tab-active' : ''}" data-status-filter="completed">已完成 ${stats.completed}</button>
      <select id="dataSourceFilter" class="stats-source-filter">
        <option value="all"${dataSourceFilter === 'all' ? ' selected' : ''}>所有</option>
        <option value="task"${dataSourceFilter === 'task' ? ' selected' : ''}>任务</option>
      </select>
    </div>
  ` : '';

  const sectionInner = `
    <div class="section-header">
      <div class="section-header-left">
        <h4 class="section-title${statusFilter === 'all' ? ' stats-tab-active' : ''}" data-status-filter="all" style="cursor:pointer">${title}</h4>
        <span class="section-count">${allCount}</span>
        ${statsHtml}
      </div>
    </div>
    <div class="section-list">
      ${listHtml}
    </div>
  `;

  if (collapsible) {
    return `
      <details class="section-card section-collapsible ${sectionClassName}" open>
        <summary>${title}<span class="section-count">${items.length}</span></summary>
        <div class="section-collapsible-body">
          <p class="section-hint">${hint}</p>
          <div class="section-list">
            ${items.map(item => createUnifiedTaskCard(item)).join('')}
          </div>
        </div>
      </details>
    `;
  }

  return `
    <section class="section-card ${sectionClassName}">
      ${sectionInner}
    </section>
  `;
}

function createUnifiedTaskCard(item) {
  const statusInfo = getStatusInfo(item.status);
  const prompt = escapeHtml(item.prompt || '未命名任务');
  const showQueueInfo = item.queuePosition && !['completed', 'failed', 'cancelled'].includes(item.status);
  const queueInfo = showQueueInfo
    ? `排队 ${formatNumber(item.queuePosition)} / ${formatNumber(item.queueTotal)}${item.estimatedQueueTime ? ` · 预计 ${formatTime(item.estimatedQueueTime)}` : ''}`
    : '';

  const errorInfo = item.error ? `<div class="card-error">${escapeHtml(item.error)}</div>` : '';
  const previewImages = (item.images || []).filter(img => img?.preview);
  const images = previewImages.length ? `
    <div class="card-images">
      ${previewImages.map(img => `<img src="${img.preview}" class="card-image-thumb" alt="${escapeHtml(img.fileName || '参考图')}">`).join('')}
    </div>
  ` : '';

  const configChips = `
    <div class="task-config">
      ${item.modelLabel ? `<span class="task-config-chip">${escapeHtml(item.modelLabel)}</span>` : ''}
      ${item.referenceLabel ? `<span class="task-config-chip">${escapeHtml(item.referenceLabel)}</span>` : ''}
      ${item.aspectRatio ? `<span class="task-config-chip">${escapeHtml(item.aspectRatio)}</span>` : ''}
      ${item.durationSeconds ? `<span class="task-config-chip">${item.durationMode === 'auto' ? `自动 ${item.durationSeconds} 秒` : `${item.durationSeconds} 秒`}</span>` : ''}
    </div>
  `;

  const actions = [];
  if (item.batchId) {
    actions.push(`<button class="task-btn delete" data-delete-batch="${item.batchId}">删除</button>`);

    if (['pending', 'failed', 'cancelled'].includes(item.status)) {
      actions.push(`<button class="task-btn" data-edit-batch="${item.batchId}">编辑</button>`);
    }

    if (['queuing', 'completed'].includes(item.status)) {
      actions.push(`<button class="task-btn" data-duplicate-batch="${item.batchId}">新建</button>`);
    }
  }
  if (item.canOpen && item.videoUrl) {
    actions.push(`<button class="task-btn" data-open-url="${escapeHtml(item.videoUrl)}">查看</button>`);
  }

  return `
    <article class="unified-task-card ${statusInfo.className}">
      <div class="card-top">
        <div class="card-top-left">
          <div class="card-prompt">${prompt}</div>
        </div>
        <div class="card-status ${statusInfo.className}">${statusInfo.text}</div>
      </div>
      <div class="card-main">
        ${images}
        <div class="card-content">
          ${configChips}
          ${queueInfo ? `<div class="card-queue">${queueInfo}</div>` : ''}
        </div>
      </div>
      ${errorInfo}
      <div class="card-footer">
        <span class="card-meta">${escapeHtml(item.metaText)}</span>
        <div class="card-actions">${actions.join('')}</div>
      </div>
    </article>
  `;
}

function bindTaskActions(unifiedItems) {
  const sourceFilter = document.getElementById('dataSourceFilter');
  if (sourceFilter) {
    sourceFilter.addEventListener('change', (e) => {
      dataSourceFilter = e.target.value;
      renderTaskCenter();
    });
  }

  document.querySelectorAll('[data-status-filter]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      statusFilter = e.currentTarget.dataset.statusFilter;
      renderTaskCenter();
    });
  });

  document.querySelectorAll('[data-delete-batch]').forEach(button => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteBatchTask(button.dataset.deleteBatch);
    });
  });

  document.querySelectorAll('[data-edit-batch]').forEach(button => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      editBatchTask(button.dataset.editBatch);
    });
  });

  document.querySelectorAll('[data-duplicate-batch]').forEach(button => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      duplicateBatchTask(button.dataset.duplicateBatch);
    });
  });

  document.querySelectorAll('[data-open-url]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      chrome.tabs.create({ url: button.dataset.openUrl });
    });
  });
}

function editBatchTask(taskId) {
  openExtensionPopupWindow(chrome.runtime.getURL(`add_task.html?edit=${taskId}`), 600, 700);
}

function duplicateBatchTask(taskId) {
  openExtensionPopupWindow(chrome.runtime.getURL(`add_task.html?duplicate=${taskId}`), 600, 700);
}

function buildUnifiedItems() {
  const monitorByTaskId = new Map(monitorTasks.map(task => [String(task.taskId), task]));
  const consumedMonitorIds = new Set();
  const items = [];

  batchTasks.forEach((task) => {
    const matchedMonitor = task.historyRecordId ? monitorByTaskId.get(String(task.historyRecordId)) : null;
    if (matchedMonitor) {
      consumedMonitorIds.add(String(matchedMonitor.taskId));
    }

    // 把旧的历史记录也加入已消费集合，避免二次编辑后原失败记录单独显示出来
    if (Array.isArray(task.oldHistoryRecordIds)) {
      task.oldHistoryRecordIds.forEach(id => consumedMonitorIds.add(String(id)));
    }

    items.push(normalizeBatchTask(task, matchedMonitor));
  });

  monitorTasks.forEach((task) => {
    const key = String(task.taskId);
    if (consumedMonitorIds.has(key)) {
      return;
    }
    items.push(normalizeMonitorTask(task));
  });

  return items.sort((left, right) => {
    // 第一层：根据明确的业务产生排序时间 (即梦的 submitTime 或本地捕获的创建时间)
    const timeDiff = (right.sortTime || 0) - (left.sortTime || 0);
    if (timeDiff !== 0) {
      return timeDiff;
    }
    // 第二层：如果都在同一秒产生，则根据更新状态排序
    const updateDiff = (right.updatedAt || 0) - (left.updatedAt || 0);
    if (updateDiff !== 0) {
      return updateDiff;
    }
    // 第三层：既然即梦平台时间完全一样，回退到我们系统内部微秒级创建时间保证相对稳定
    const leftCreate = left.batchCreatedAt || 0;
    const rightCreate = right.batchCreatedAt || 0;
    if (rightCreate !== leftCreate) {
      return rightCreate - leftCreate;
    }
    // 第四层兜底：完全靠 ID 字典序防跳动
    return String(right.id).localeCompare(String(left.id));
  });
}

function normalizeBatchTask(batchTask, monitorTask) {
  const config = {
    ...DEFAULT_BATCH_CONFIG,
    ...(batchTask.config || {})
  };

  const mergedStatus = mergeTaskStatus(batchTask.status, monitorTask?.status);
  const sortTime = getTaskSortTime(monitorTask) || batchTask.createdAt || 0;
  const updatedAt = monitorTask?.lastUpdate || batchTask.createdAt || Date.now();

  const monitorErrorMessage = monitorTask ? (monitorTask.error || monitorTask.rawData?.fail_starling_message || monitorTask.rawData?.fail_msg) : null;
  const isFailedState = ['failed', 'cancelled'].includes(mergedStatus);
  const derivedError = batchTask.error || (isFailedState ? monitorErrorMessage : null);

  return {
    id: `batch-${batchTask.id}`,
    batchId: batchTask.id,
    platform: '即梦',
    prompt: batchTask.submittedPromptText || batchTask.promptText || monitorTask?.prompt || '未命名任务',
    status: mergedStatus,
    sourceLabel: monitorTask ? '插件提交' : '待提交队列',
    modelLabel: BATCH_MODEL_OPTIONS[config.model] || config.model,
    referenceLabel: BATCH_REFERENCE_MODE_OPTIONS[config.referenceMode] || config.referenceMode,
    aspectRatio: config.aspectRatio,
    durationMode: config.durationMode,
    durationSeconds: config.durationSeconds,
    images: batchTask.images || [],
    queuePosition: batchTask.queueInfo?.queue_info?.queue_idx || monitorTask?.queuePosition || null,
    queueTotal: batchTask.queueInfo?.queue_info?.queue_length || monitorTask?.queueTotal || null,
    estimatedQueueTime: batchTask.queueInfo?.forecast_cost_time?.forecast_queue_cost || monitorTask?.estimatedQueueTime || null,
    error: derivedError,
    videoUrl: monitorTask?.videoUrl || null,
    canOpen: Boolean(monitorTask?.videoUrl),
    metaText: getBatchMetaText(batchTask, monitorTask, sortTime),
    sortTime,
    updatedAt,
    batchCreatedAt: batchTask.createdAt || 0
  };
}

function normalizeMonitorTask(task) {
  const errorMessage = task.error || task.rawData?.fail_starling_message || task.rawData?.fail_msg || null;
  const sortTime = getTaskSortTime(task) || task.lastUpdate || Date.now();
  const updatedAt = task.lastUpdate || Date.now();

  return {
    id: `monitor-${task.taskId}`,
    batchId: null,
    platform: task.platform,
    prompt: task.prompt || `任务 ${task.taskId}`,
    status: task.status || 'unknown',
    sourceLabel: '页面捕获',
    modelLabel: '',
    referenceLabel: '',
    aspectRatio: '',
    durationMode: 'manual',
    durationSeconds: null,
    images: [],
    queuePosition: task.queuePosition || null,
    queueTotal: task.queueTotal || null,
    estimatedQueueTime: task.estimatedQueueTime || null,
    error: ['failed', 'cancelled'].includes(task.status) ? (errorMessage || '任务失败') : null,
    videoUrl: task.videoUrl || null,
    canOpen: Boolean(task.videoUrl),
    metaText: getMonitorMetaText(task, sortTime),
    sortTime,
    updatedAt
  };
}

function mergeTaskStatus(batchStatus, monitorStatus) {
  const batchToUnified = {
    pending: 'pending',
    uploading: 'preparing',
    ready: 'pending',
    submitting: 'preparing',
    queued: 'queuing',
    cancelled: 'cancelled',
    completed: 'completed',
    failed: 'failed'
  };

  if (monitorStatus && ['queuing', 'generating', 'completed', 'failed', 'cancelled'].includes(monitorStatus)) {
    return monitorStatus;
  }

  return batchToUnified[batchStatus] || 'unknown';
}

function updateSummaryCards() {
  const items = buildUnifiedItems().filter(item => currentFilter === 'all' || item.platform === currentFilter);
  const pending = items.filter(item => ['pending', 'preparing'].includes(item.status)).length;
  const active = items.filter(item => ['queuing', 'generating'].includes(item.status)).length;
  const completed = items.filter(item => item.status === 'completed').length;
  const failed = items.filter(item => item.status === 'failed').length;

  document.getElementById('summaryPending').textContent = String(pending);
  document.getElementById('summaryActive').textContent = String(active);
  document.getElementById('summaryCompleted').textContent = String(completed);
  document.getElementById('summaryFailed').textContent = String(failed);
}

function updatePlatformCounts() {
  const items = buildUnifiedItems();
  document.getElementById('count-all').textContent = String(items.length);

  ['即梦', 'Runway'].forEach((platform) => {
    const count = items.filter(item => item.platform === platform).length;
    const element = document.getElementById(`count-${platform}`);
    if (element) {
      element.textContent = String(count);
      element.style.display = count > 0 ? 'inline' : 'none';
    }
  });
}

function updateQueueControls() {
  const state = batchControlState || deriveBatchControlState(batchTasks);
  const toggleBtn = document.getElementById('batchToggleBtn');
  const icon = document.getElementById('batchToggleIcon');

  if (!toggleBtn || !icon) {
    return;
  }

  const hasPending = state.pendingCount > 0;
  const hasRunning = state.runningCount > 0;
  const isActuallyActive = Boolean(state.isActive && (hasPending || hasRunning));

  toggleBtn.classList.remove('primary', 'running');

  if (isActuallyActive) {
    toggleBtn.classList.add('running');
    toggleBtn.disabled = !hasPending && !hasRunning;
    toggleBtn.title = hasPending ? '暂停自动提交待提交任务' : '暂停当前提交';
    toggleBtn.setAttribute('aria-label', '暂停自动提交');
    toggleBtn.dataset.mode = 'pause';
    icon.innerHTML = getPauseIconSvg();
    return;
  }

  toggleBtn.classList.add('primary');
  toggleBtn.dataset.mode = hasPending ? (hasRunning ? 'resume' : 'start') : 'idle';
  icon.innerHTML = getPlayIconSvg();

  if (hasPending) {
    toggleBtn.disabled = false;
    toggleBtn.title = state.isPaused || hasRunning ? '继续提交待提交任务' : '开始提交待提交任务';
    toggleBtn.setAttribute('aria-label', toggleBtn.title);
    return;
  }

  toggleBtn.disabled = true;
  toggleBtn.title = hasRunning ? '当前没有待提交任务' : '没有待提交任务';
  toggleBtn.setAttribute('aria-label', toggleBtn.title);
}

function updateHeaderStatus() {
  const state = batchControlState || deriveBatchControlState(batchTasks);
  const maxQueueCountText = document.getElementById('maxQueueCountText');
  const nextSubmitTimeText = document.getElementById('nextSubmitTimeText');

  if (!maxQueueCountText || !nextSubmitTimeText) {
    return;
  }

  maxQueueCountText.textContent = Number.isFinite(Number(state.maxConcurrentTasks))
    ? formatNumber(state.maxConcurrentTasks)
    : '-';

  const nextRetryAt = Number(state.nextRetryAt || 0);
  if (nextRetryAt > Date.now()) {
    nextSubmitTimeText.textContent = formatClockTime(nextRetryAt);
  } else {
    nextSubmitTimeText.textContent = state.isActive ? '待命中' : '-';
  }
}

async function runBatchToggleAction(button, messageType, busyTitle) {
  button.disabled = true;
  button.title = busyTitle;

  try {
    const response = await sendMessage({ type: messageType });
    if (!response?.success) {
      throw new Error(response?.error || '操作失败');
    }
    batchControlState = response?.state || deriveBatchControlState(batchTasks);
    updateQueueControls();
    refreshDashboard({ forceSync: true });
  } catch (error) {
    console.error('切换批量提交状态失败:', error);
    updateQueueControls();
    alert(`操作失败: ${error.message}`);
  }
}

function getDefaultBatchControlState() {
  return {
    isActive: false,
    isRunning: false,
    isPaused: false,
    dispatchingCount: 0,
    pendingCount: 0,
    runningCount: 0,
    maxConcurrentTasks: 0,
    nextRetryAt: 0
  };
}

function deriveBatchControlState(tasks) {
  const pendingCount = tasks.filter(task => task.status === 'pending').length;
  const dispatchingCount = tasks.filter(task => ['uploading', 'submitting'].includes(task.status)).length;
  const runningCount = tasks.filter(task => ['uploading', 'submitting', 'queued'].includes(task.status)).length;

  return {
    ...getDefaultBatchControlState(),
    isActive: pendingCount > 0 || dispatchingCount > 0,
    dispatchingCount,
    pendingCount,
    runningCount
  };
}

function getPlayIconSvg() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M5 3l14 9-14 9V3z"></path></svg>';
}

function getPauseIconSvg() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';
}

function getStatusInfo(status) {
  const statusMap = {
    pending: { text: '待提交', className: 'pending' },
    preparing: { text: '准备中', className: 'preparing' },
    queuing: { text: '排队中', className: 'queuing' },
    generating: { text: '生成中', className: 'generating' },
    completed: { text: '已完成', className: 'completed' },
    failed: { text: '失败', className: 'failed' },
    cancelled: { text: '已取消', className: 'cancelled' },
    unknown: { text: '未知', className: 'unknown' }
  };
  return statusMap[status] || statusMap.unknown;
}

function getBatchMetaText(batchTask, monitorTask, sortTime) {
  if (sortTime) {
    return `${getRelativeTime(sortTime)} · ${batchTask.historyRecordId || batchTask.id}`;
  }
  return `${getRelativeTime(batchTask.createdAt || Date.now())} · ${batchTask.historyRecordId || batchTask.id}`;
}

function getMonitorMetaText(task, sortTime) {
  return `${getRelativeTime(sortTime || task.lastUpdate || Date.now())} · ${task.taskId}`;
}

function getTaskSortTime(task) {
  if (!task) {
    return 0;
  }

  const candidates = [
    task.finishTime,
    task.createdTime,
    task.rawData?.finish_time,
    task.rawData?.task?.finish_time,
    task.rawData?.created_time
  ];

  for (const value of candidates) {
    const normalized = normalizeTimestamp(value);
    if (normalized > 0) {
      return normalized;
    }
  }

  return 0;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 0;
  }

  return numericValue < 1e12 ? Math.round(numericValue * 1000) : Math.round(numericValue);
}

function getRelativeTime(timestamp) {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60000) return '刚刚更新';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} 分钟前更新`;
  return `${Math.floor(elapsed / 3600000)} 小时前更新`;
}



function formatTime(seconds) {
  if (!seconds) return '未知';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  return `${minutes}分钟`;
}

function formatNumber(value) {
  return typeof value === 'number' ? value.toLocaleString() : '未知';
}

function formatClockTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  } catch (error) {
    return '-';
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function openAddTaskModal() {
  openExtensionPopupWindow(chrome.runtime.getURL('add_task.html'), 600, 600);
}

async function openExtensionPopupWindow(url, width, height) {
  // 优先尝试在当前页面注入 iframe 模态框
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://')) {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'SHOW_ADD_TASK_IFRAME',
        url: url
      }).catch(() => null);

      if (response && response.success) {
        console.log('[Popup] 成功在页面上打开模态框');
        // 如果是 popup 模式打开的插件页，打开模态框后可以考虑关闭自己，但由于用户可能还要看进度，暂不强制关闭。
        return;
      }
    }
  } catch (err) {
    console.warn('[Popup] 无法向当前页面注入弹窗，准备回退到独立窗口:', err);
  }

  // 兜底方案：打开独立窗口
  const left = Math.max(0, Math.round((window.screen.availWidth - width) / 2));
  const top = Math.max(0, Math.round((window.screen.availHeight - height) / 2));

  try {
    const createdWindow = await chrome.windows.create({
      url,
      type: 'popup',
      state: 'normal',
      focused: true,
      width,
      height,
      left,
      top
    });

    // macOS/Chrome 全屏下，popup 有时仍会继承全屏空间；创建后再强制拉回 normal。
    if (createdWindow?.id && createdWindow.state && createdWindow.state !== 'normal') {
      await chrome.windows.update(createdWindow.id, { state: 'normal' });
      await chrome.windows.update(createdWindow.id, {
        width,
        height,
        left,
        top,
        focused: true
      });
    }
  } catch (error) {
    console.error('打开任务弹窗失败:', error);
    // 最后的最后兜底：直接开个新标签页
    chrome.tabs.create({ url });
  }
}



function deleteBatchTask(taskId) {
  if (!confirm('确定要删除这个任务吗？')) {
    return;
  }

  sendMessage({ type: 'DELETE_BATCH_TASK', taskId })
    .then(() => refreshDashboard())
    .catch((error) => {
      console.error('删除任务失败:', error);
      alert(`删除任务失败: ${error.message}`);
    });
}



function renderJimengDebugSummary(debug) {
  const card = document.getElementById('jimengDebugCard');
  const content = document.getElementById('jimengDebugContent');

  if (!card || !content || !debug) {
    card?.classList.add('debug-card-hidden');
    return;
  }

  const lines = [
    `root_model: ${debug.extend?.root_model || '-'}`,
    `benefit_type: ${debug.extend?.m_video_commerce_info?.benefit_type || '-'}`,
    `model_req_key: ${debug.modelReqKey || '-'}`,
    `video_mode: ${debug.videoMode ?? '-'}`,
    `aspect_ratio: ${debug.aspectRatio || '-'}`,
    `duration_ms: ${debug.durationMs ?? '-'}`,
    `first_frame: ${debug.hasFirstFrame ? 'yes' : 'no'}`,
    `last_frame: ${debug.hasLastFrame ? 'yes' : 'no'}`,
    `ability_list: ${debug.abilityListCount ?? 0}`,
    `placeholder_count: ${debug.placeholderCount ?? 0}`,
    `ret: ${debug.response?.ret ?? '-'}`,
    `errmsg: ${debug.response?.errmsg || '-'}`,
    `logid: ${debug.response?.logid || '-'}`
  ];

  content.textContent = lines.join('\n');
  card.classList.remove('debug-card-hidden');
}



function sendMessage(message) {
  return new Promise((resolve, reject) => {
    const trySend = (attempt = 0) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          const errorMessage = chrome.runtime.lastError.message || String(chrome.runtime.lastError);
          const isTransient = errorMessage.includes('Receiving end does not exist') ||
            errorMessage.includes('message port closed before a response was received') ||
            errorMessage.includes('The message port closed before a response was received');

          if (isTransient && attempt < 1) {
            window.setTimeout(() => trySend(attempt + 1), 250);
            return;
          }

          reject(new Error(errorMessage));
          return;
        }
        resolve(response);
      });
    };

    trySend();
  });
}

function readStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}
