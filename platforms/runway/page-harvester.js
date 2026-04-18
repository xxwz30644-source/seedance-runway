/**
 * Runway 凭证抓取器 - content script 部分
 *
 * 只在 runwayml.com 域上运行。负责：
 *   1. 把 page-harvester-inject.js 注入到页面 MAIN world
 *   2. 监听 inject 抛回来的 CREDS 消息，转发给 background
 *   3. background 收到后写到 chrome.storage（通过 RUNWAY_AUTO_HARVEST handler）
 */
(() => {
  'use strict';

  const HOST = location.hostname || '';
  if (!HOST.endsWith('runwayml.com')) return;

  // 注入页脚本（document_start 时机，赶在页面业务代码之前）
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('platforms/runway/page-harvester-inject.js');
    script.async = false;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  } catch (err) {
    console.warn('[Runway Harvester] 注入失败:', err);
    return;
  }

  // 监听 inject 抛过来的凭证 / 任务状态
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'runway-harvester') return;

    if (data.type === 'CREDS') {
      chrome.runtime.sendMessage(
        { type: 'RUNWAY_AUTO_HARVEST', creds: data.creds },
        (response) => {
          if (chrome.runtime.lastError) return;
          if (response?.updated) {
            console.log('[Runway Harvester] 已自动保存凭证:', response.updated);
          }
        }
      );
      return;
    }

    if (data.type === 'TASK_UPDATE' && data.taskId && data.body) {
      // 寄生模式：把 Runway 页面拿到的任务状态直接喂给 background
      chrome.runtime.sendMessage(
        { type: 'RUNWAY_PASSIVE_UPDATE', taskId: data.taskId, body: data.body },
        () => { void chrome.runtime.lastError; }
      );
    }
  });
})();
