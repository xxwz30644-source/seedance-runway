// Runway 测试控制台逻辑
// 因 MV3 CSP 禁止内联脚本和 inline event handlers，所有 JS 必须在外部文件里

let lastTaskId = null;
let autoPollTimer = null;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function show(divId, ok, payload) {
  const el = document.getElementById(divId);
  el.className = 'result ' + (ok ? 'ok' : 'err');
  el.textContent = (ok ? '✓ ' : '✗ ') + (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
  appendLog(divId, ok, payload);
}

function appendLog(srcId, ok, payload) {
  const log = document.getElementById('log');
  const ts = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.style.borderTop = log.children.length > 0 ? '1px solid #ddd' : 'none';
  line.style.padding = '4px 0';
  const left = document.createElement('span');
  left.style.color = '#888';
  left.textContent = `[${ts}] ${srcId} `;
  const mark = document.createElement('span');
  mark.style.color = ok ? '#16a34a' : '#dc2626';
  mark.textContent = ok ? '✓' : '✗';
  const body = document.createElement('div');
  body.style.whiteSpace = 'pre-wrap';
  body.style.wordBreak = 'break-all';
  body.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  line.appendChild(left);
  line.appendChild(mark);
  line.appendChild(body);
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

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

async function injectCreds() {
  const jwt = document.getElementById('jwt').value.trim();
  const teamId = document.getElementById('teamId').value.trim();
  const assetGroupId = document.getElementById('assetGroupId').value.trim();

  // JWT 留空 = 不动现有；填了就必须是合法的 base64.base64.base64 三段格式
  if (jwt) {
    if (!/^[\x21-\x7e]+$/.test(jwt)) {
      show('r1', false, 'JWT 含非 ASCII 字符（中文/标点等），不是合法 JWT');
      return;
    }
    const parts = jwt.split('.');
    if (parts.length !== 3 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p) && p)) {
      show('r1', false, 'JWT 格式不对——应该是三段用 . 分隔的 base64-url，例如 eyJxxx.eyJyyy.zzz');
      return;
    }
  }
  if (!teamId && !assetGroupId && !jwt) {
    show('r1', false, '三个字段都空，没什么可保存的'); return;
  }

  const tasks = [];
  if (jwt) tasks.push(send({ type: 'RUNWAY_SET_JWT', jwt }));
  const ctx = {};
  if (teamId) ctx.teamId = Number(teamId) || teamId;
  if (assetGroupId) ctx.assetGroupId = assetGroupId;
  if (Object.keys(ctx).length > 0) tasks.push(send({ type: 'RUNWAY_SET_CONTEXT', context: ctx }));

  const results = await Promise.all(tasks);
  const ok = results.every(r => r?.success);
  if (ok) {
    show('r1', true, `已保存：${jwt ? '新 JWT、' : ''}${teamId ? `teamId=${teamId}、` : ''}${assetGroupId ? `assetGroupId=${assetGroupId}` : ''}`.replace(/、$/, ''));
    // 保存成功后立即重新读一遍，确认 storage 真的有
    setTimeout(loadCreds, 200);
  } else {
    show('r1', false, JSON.stringify(results, null, 2));
  }
}

async function loadCreds() {
  const r1 = await send({ type: 'RUNWAY_GET_JWT' });
  const r2 = await send({ type: 'RUNWAY_GET_CONTEXT' });
  // 重要：JWT 输入框只能放真 JWT 或留空，不能填中文/占位符——
  // 否则用户点保存时这串文本会被当成 JWT 存进 storage，
  // 导致 Authorization 头含非 ASCII，所有请求 fetch 报错
  const jwtField = document.getElementById('jwt');
  jwtField.value = '';
  jwtField.placeholder = r1.hasJwt
    ? `已存在凭证（${r1.preview || '...'}）— 留空保留现有，粘贴新值则覆盖`
    : 'eyJhbGciOiJIUzI1NiIs...';
  document.getElementById('teamId').value = (r2.context && r2.context.teamId) || '';
  document.getElementById('assetGroupId').value = (r2.context && r2.context.assetGroupId) || '';
  show('r1', true,
    `JWT: ${r1.hasJwt ? '✓ 已存在' : '✗ 未设置'}\n` +
    `teamId: ${r2.context?.teamId || '(空)'}\n` +
    `assetGroupId: ${r2.context?.assetGroupId || '(空)'}`);
}

async function clearCreds() {
  if (!confirm('确定要清空全部 Runway 凭证（JWT + teamId + assetGroupId）？\n之后需要重新打开 Runway 页面让扩展自动重新抓取。')) return;
  await send({ type: 'RUNWAY_SET_JWT', jwt: null });
  await send({ type: 'RUNWAY_SET_CONTEXT', context: { teamId: null, assetGroupId: null, sessionId: null } });
  show('r1', true, '已清空。打开 app.runwayml.com 浏览几下，扩展会自动重新抓取。');
  setTimeout(loadCreds, 500);
}

async function testCanStart() {
  const r = await send({ type: 'RUNWAY_CAN_START' });
  show('r2', r.success, r.success ? r.result : r);
}

async function testEstimate() {
  const r = await send({ type: 'RUNWAY_ESTIMATE_COST', taskOptions: { model: 'seedance_2', duration: 5 } });
  show('r2', r.success, r.success ? r.result : r);
}

async function testUpload() {
  show('r3', true, '上传中（约需 5-10 秒）...');
  const r = await send({ type: 'RUNWAY_TEST_UPLOAD' });
  show('r3', r.success, r.success ? r.result : r);
}

async function testSubmit() {
  const prompt = document.getElementById('testPrompt').value.trim();
  if (!prompt) { show('r4', false, 'prompt 不能空'); return; }
  show('r4', true, '提交中...');
  const r = await send({
    type: 'RUNWAY_TEST_SUBMIT',
    task: { prompt, model: 'seedance_2', duration: 5, resolution: '480p', aspectRatio: '16:9' }
  });
  if (r.success) {
    lastTaskId = r.result.taskId;
    document.getElementById('pollBtn').disabled = false;
    document.getElementById('autoPollBtn').disabled = false;
  }
  show('r4', r.success, r.success ? r.result : r);
}

async function pollLast() {
  if (!lastTaskId) return;
  const r = await send({ type: 'RUNWAY_POLL_TASK', taskId: lastTaskId });
  show('r4', r.success, r.success ? r.result : r);
  return r;
}

async function autoPoll() {
  if (!lastTaskId) return;
  if (autoPollTimer) { clearInterval(autoPollTimer); autoPollTimer = null; }
  const btn = document.getElementById('autoPollBtn');
  btn.textContent = '停止轮询';
  btn.removeEventListener('click', autoPoll);
  btn.addEventListener('click', stopAutoPoll, { once: true });
  let count = 0;
  autoPollTimer = setInterval(async () => {
    count++;
    const r = await pollLast();
    if (r?.success && (r.result.status === 'completed' || r.result.status === 'failed' || r.result.status === 'cancelled')) {
      stopAutoPoll();
      appendLog('autoPoll', true, `已结束: ${r.result.status} (轮询了 ${count} 次)`);
    } else if (count >= 60) {
      stopAutoPoll();
      appendLog('autoPoll', false, '60 次仍未结束，停止');
    }
  }, 5000);
}

function stopAutoPoll() {
  if (autoPollTimer) { clearInterval(autoPollTimer); autoPollTimer = null; }
  const btn = document.getElementById('autoPollBtn');
  btn.textContent = '自动轮询直到完成';
  btn.removeEventListener('click', stopAutoPoll);
  btn.addEventListener('click', autoPoll);
}

// ━━━ 启动：绑定所有按钮 ━━━

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('injectCredsBtn').addEventListener('click', injectCreds);
  document.getElementById('loadCredsBtn').addEventListener('click', loadCreds);
  document.getElementById('clearCredsBtn').addEventListener('click', clearCreds);
  document.getElementById('canStartBtn').addEventListener('click', testCanStart);
  document.getElementById('estimateBtn').addEventListener('click', testEstimate);
  document.getElementById('uploadBtn').addEventListener('click', testUpload);
  document.getElementById('submitBtn').addEventListener('click', testSubmit);
  document.getElementById('pollBtn').addEventListener('click', pollLast);
  document.getElementById('autoPollBtn').addEventListener('click', autoPoll);

  // 自动读出已保存凭证
  loadCreds();
});
