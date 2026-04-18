/**
 * Content Script - 通用 API 拦截器
 * 注入到所有支持的平台页面，拦截 API 请求并解析任务状态
 */

(function() {
  'use strict';

  const MESSAGE_SOURCE = 'ai-video-monitor-extension';
  const INJECT_FLAG = 'data-ai-video-monitor-injected';
  const HOOK_READY_FLAG = 'data-ai-video-monitor-hook-ready';
  const currentUrl = window.location.href;
  const pendingPageRequests = new Map();
  const pendingGenerateIntercepts = [];
  let jimengUploadAuditInterceptCount = 0;
  const JIMENG_DOM_SUBMIT_DRY_RUN = false;
  const JIMENG_UI_DELAY_RANGE_MS = {
    min: 1200,
    max: 3000
  };
  let extensionActive = true;
  let heartbeatTimer = null;
  let activePlatformConfig = null;
  console.log('[监控] Content script 已加载:', currentUrl);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'PING_PAGE_BRIDGE') {
      return false;
    }

    if (activePlatformConfig) {
      setupMessageRelay(activePlatformConfig.name);
      injectPageInterceptor(activePlatformConfig.name, activePlatformConfig.apis);
    }

    const root = document.documentElement;
    const relayInstalled = Boolean(window.__aiVideoMonitorRelayInstalled);
    const hookReady = Boolean(root?.hasAttribute(HOOK_READY_FLAG));
    const documentReady = document.readyState || 'loading';

    sendResponse({
      success: true,
      ready: Boolean(relayInstalled && hookReady),
      extensionActive,
      relayInstalled,
      hookReady,
      documentReady,
      bridgeVersion: 1,
      pageUrl: window.location.href
    });
    return false;
  });

  function handleExtensionInvalidated(error) {
    const message = String(error?.message || error || '');
    const isInvalidated = message.includes('Extension context invalidated');
    const isReceiverMissing = message.includes('Receiving end does not exist');

    if (!isInvalidated && !isReceiverMissing) {
      return false;
    }

    if (!extensionActive) {
      return true;
    }

    extensionActive = false;
    if (heartbeatTimer) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    pendingPageRequests.forEach((handlers) => {
      handlers.reject(new Error('扩展已重新加载，请刷新页面后重试'));
    });
    pendingPageRequests.clear();
    pendingGenerateIntercepts.splice(0).forEach((handlers) => {
      window.clearTimeout(handlers.timeoutId);
      handlers.reject(new Error('扩展已重新加载，请刷新页面后重试'));
    });

    console.warn('[监控] 扩展通信已断开，已停止旧 content script 的通信');
    return true;
  }

  function isTransientRuntimeMessageError(error) {
    const message = String(error?.message || error || '');
    return (
      message.includes('The message port closed before a response was received') ||
      message.includes('message port closed before a response was received')
    );
  }

  function safeSendMessage(payload, callback) {
    if (!extensionActive) {
      if (typeof callback === 'function') {
        callback(null);
      }
      return;
    }

    try {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          if (!handleExtensionInvalidated(chrome.runtime.lastError) && !isTransientRuntimeMessageError(chrome.runtime.lastError)) {
            console.error('[监控] 通信错误:', chrome.runtime.lastError.message || String(chrome.runtime.lastError));
          }
          if (typeof callback === 'function') {
            callback(null);
          }
          return;
        }

        if (typeof callback === 'function') {
          callback(response);
        }
      });
    } catch (error) {
      if (!handleExtensionInvalidated(error)) {
        console.error('[监控] 发送消息失败:', error);
      }
      if (typeof callback === 'function') {
        callback(null);
      }
    }
  }

  // 发送消息获取当前页面对应的平台配置
  safeSendMessage(
    { type: 'GET_PLATFORM_CONFIG', url: currentUrl },
    (response) => {
      if (!response) {
        return;
      }

      if (response && response.platform) {
        console.log(`[监控] 已激活 ${response.platform.name} 平台监控`);
        initializeInterceptor(response.platform);
      } else {
        console.log('[监控] 当前页面不在监控范围内');
      }
    }
  );

  /**
   * 初始化 API 拦截器
   * @param {object} platformConfig - 平台配置
   */
  function initializeInterceptor(platformConfig) {
    const { name, apis } = platformConfig;
    activePlatformConfig = { name, apis };

    setupMessageRelay(name);
    injectPageInterceptor(name, apis);

    // 定期发送心跳，保持连接
    heartbeatTimer = window.setInterval(() => {
      safeSendMessage({
        type: 'HEARTBEAT',
        platform: name,
        url: window.location.href,
        timestamp: Date.now()
      });
    }, 30000); // 每 30 秒

    console.log(`[监控] ${name} 平台拦截器已初始化`);
  }

  function setupMessageRelay(platformName) {
    if (window.__aiVideoMonitorRelayInstalled) {
      return;
    }

    window.__aiVideoMonitorRelayInstalled = true;

    window.addEventListener('message', (event) => {
      if (!extensionActive) {
        return;
      }

      if (event.source !== window) {
        return;
      }

      const data = event.data;
      if (!data || data.source !== MESSAGE_SOURCE || data.platform !== platformName) {
        if (
          data?.source === MESSAGE_SOURCE &&
          data?.type === 'PAGE_REQUEST_RESULT' &&
          pendingPageRequests.has(data.requestId)
        ) {
          const handlers = pendingPageRequests.get(data.requestId);
          pendingPageRequests.delete(data.requestId);

          if (data.error) {
            handlers.reject(new Error(data.error));
          } else {
            handlers.resolve(data);
          }
        }
        return;
      }

      if (data.url && data.url.includes('/mweb/v1/aigc_draft/generate')) {
        const waiter = pendingGenerateIntercepts.shift();
        if (waiter) {
          window.clearTimeout(waiter.timeoutId);
          waiter.resolve({
            url: data.url,
            method: data.method,
            requestData: data.requestData,
            responseData: data.responseData,
            timestamp: data.timestamp
          });
        }
      }

      if (data.url && data.url.includes('/mweb/v1/imagex/submit_audit_job')) {
        jimengUploadAuditInterceptCount += 1;
      }

      safeSendMessage({
        type: 'API_INTERCEPTED',
        platform: data.platform,
        url: data.url,
        method: data.method,
        requestData: data.requestData,
        responseData: data.responseData,
        timestamp: data.timestamp
      });

      console.log(`[监控] 拦截到 ${data.platform} API:`, data.url);
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === 'EXECUTE_PAGE_REQUEST') {
        executePageRequest(message)
          .then(result => sendResponse({ success: true, ...result }))
          .catch(error => sendResponse({ success: false, error: error.message }));

        return true;
      }

      if (message?.type === 'EXECUTE_JIMENG_DOM_SUBMIT') {
        executeJimengDomSubmit(message)
          .then(result => sendResponse({ success: true, ...result }))
          .catch(error => sendResponse({ success: false, error: error.message }));

        return true;
      }

      return false;
    });
  }

  function executePageRequest(message) {
    const requestId = message.requestId || `page-request-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingPageRequests.delete(requestId);
        reject(new Error('页面请求超时'));
      }, message.timeout || 30000);

      pendingPageRequests.set(requestId, {
        resolve: (data) => {
          window.clearTimeout(timeoutId);
          resolve({
            status: data.status,
            responseData: data.responseData
          });
        },
        reject: (error) => {
          window.clearTimeout(timeoutId);
          reject(error);
        }
      });

      window.postMessage({
        source: MESSAGE_SOURCE,
        type: 'PAGE_REQUEST',
        requestId,
        url: message.url,
        init: message.init || {}
      }, '*');
    });
  }

  function waitForGenerateIntercept(timeout = 45000) {
    let timeoutId = null;
    let waiter = null;
    const promise = new Promise((resolve, reject) => {
      timeoutId = window.setTimeout(() => {
        const index = pendingGenerateIntercepts.findIndex(item => item.timeoutId === timeoutId);
        if (index >= 0) {
          pendingGenerateIntercepts.splice(index, 1);
        }
        reject(new Error('点击生成后未捕获到网页提交请求'));
      }, timeout);

      waiter = {
        resolve,
        reject,
        timeoutId
      };

      pendingGenerateIntercepts.push(waiter);
    });

    return {
      promise,
      cancel() {
        if (timeoutId) {
          window.clearTimeout(timeoutId);
        }
        if (waiter) {
          const index = pendingGenerateIntercepts.indexOf(waiter);
          if (index >= 0) {
            pendingGenerateIntercepts.splice(index, 1);
          }
        }
      }
    };
  }

  function findJimengQueueLimitMessage() {
    const pageText = normalizeText(document.body?.innerText || '');
    const candidates = [
      '当前处于使用高峰期，暂时无法提交更多任务，请等待其他任务完成后再尝试提交',
      '当前正处于使用高峰期，暂时无法提交更多任务，请等待其他任务完成后再尝试提交',
      '暂时无法提交更多任务',
      '请等待其他任务完成后再尝试提交'
    ];

    const matched = candidates.find((text) => pageText.includes(text));
    return matched || null;
  }

  async function executeJimengDomSubmit(message) {
    if (!extensionActive) {
      throw new Error('页面自动提交链路已断开');
    }

    if (activePlatformConfig?.name !== '即梦') {
      throw new Error('当前页面不是即梦页面');
    }

    const taskId = message.taskId;
    const config = message.config || {};
    const images = Array.isArray(message.images) ? message.images : [];
    const promptText = String(message.promptText || '');

    try {
      await reportJimengDomSubmitProgress(taskId, 'preparing');
      await waitForDocumentReady();
      await sleep(300);

      await applyJimengGenerationConfig(config, taskId);

      if (images.length > 0) {
        await reportJimengDomSubmitProgress(taskId, 'uploading_images');
        await uploadJimengReferenceImages(images, config);
        await reportJimengDomSubmitProgress(taskId, 'waiting_upload_complete');
        await sleepJimengUiDelay();
      }

      await reportJimengDomSubmitProgress(taskId, 'filling_prompt');
      await fillJimengPrompt(promptText, config, images.length);

      if (JIMENG_DOM_SUBMIT_DRY_RUN) {
        await reportJimengDomSubmitProgress(taskId, 'dry_run_ready');
        await reportJimengDomSubmitResult(taskId, true, {
          dryRun: true,
          stage: 'before_generate',
          message: '调试模式：已完成参数设置，未点击生成'
        });
        return {
          dryRun: true,
          stage: 'before_generate',
          message: '调试模式：已完成参数设置，未点击生成'
        };
      }

      await reportJimengDomSubmitProgress(taskId, 'clicking_generate');
      const interceptWaiter = waitForGenerateIntercept(message.timeout || 120000);
      await clickJimengGenerateButton();

      await reportJimengDomSubmitProgress(taskId, 'waiting_generate_request');
      const queueLimitPromise = waitForCondition(() => findJimengQueueLimitMessage(), message.timeout || 120000, 200)
        .then((matchedText) => ({ kind: 'queue_limit', matchedText }))
        .catch(() => new Promise(() => {}));

      const outcome = await Promise.race([
        interceptWaiter.promise.then((intercepted) => ({ kind: 'intercept', intercepted })),
        queueLimitPromise
      ]);

      if (outcome?.kind === 'queue_limit') {
        interceptWaiter.cancel();
        throw new Error('HIGH_PEAK_LIMIT_REACHED');
      }

      const intercepted = outcome?.intercepted;

      await reportJimengDomSubmitResult(taskId, true, {
        historyRecordId: intercepted?.responseData?.data?.aigc_data?.history_record_id || null,
        ret: intercepted?.responseData?.ret || null
      });

      return {
        interceptedRequestData: intercepted.requestData,
        interceptedResponseData: intercepted.responseData,
        responseData: intercepted.responseData
      };
    } catch (error) {
      await reportJimengDomSubmitResult(taskId, false, { error: error.message });
      throw error;
    }
  }

  function reportJimengDomSubmitProgress(taskId, state, extra = {}) {
    const timestamp = new Date().toLocaleTimeString('zh-CN');
    console.log(`[即梦DOM提交][${timestamp}] 状态更新:`, {
      taskId,
      state,
      ...extra
    });
    
    return new Promise((resolve) => {
      safeSendMessage({
        type: 'JIMENG_DOM_SUBMIT_PROGRESS',
        taskId,
        state,
        ...extra
      }, (response) => {
        if (!response?.success) {
          console.error(`[即梦DOM提交][${timestamp}] 后台处理失败:`, response?.error);
        }
        resolve();
      });
    });
  }

  function reportJimengDomSubmitResult(taskId, success, extra = {}) {
    return new Promise((resolve) => {
      safeSendMessage({
        type: 'JIMENG_DOM_SUBMIT_RESULT',
        taskId,
        success,
        ...extra
      }, () => resolve());
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function getJimengUiDelayMs(minMs = 0) {
    const lower = Math.max(JIMENG_UI_DELAY_RANGE_MS.min, Number(minMs) || 0);
    const upper = Math.max(lower, JIMENG_UI_DELAY_RANGE_MS.max);
    return Math.round(lower + Math.random() * (upper - lower));
  }

  async function sleepJimengUiDelay(minMs = 0) {
    await sleep(getJimengUiDelayMs(minMs));
  }

  async function waitForDocumentReady() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      await waitForCondition(() => Boolean(document.body), 5000, 100);
      return;
    }

    await new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
    await waitForCondition(() => Boolean(document.body), 5000, 100);
  }

  async function waitForCondition(check, timeoutMs = 5000, intervalMs = 120) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const result = await Promise.resolve().then(check);
      if (result) {
        return result;
      }
      await sleep(intervalMs);
    }

    throw new Error('等待页面状态超时');
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getElementText(element) {
    if (!element) {
      return '';
    }

    const text = [
      element.innerText,
      element.textContent,
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.getAttribute?.('placeholder'),
      element.getAttribute?.('data-placeholder')
    ].filter(Boolean).join(' ');

    return normalizeText(text);
  }

  function isVisibleElement(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isElementDisabled(element) {
    if (!element) {
      return true;
    }

    const ariaDisabled = element.getAttribute?.('aria-disabled');
    return Boolean(
      element.disabled ||
      ariaDisabled === 'true' ||
      element.classList?.contains('disabled')
    );
  }

  function isProbablyClickable(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const className = typeof element.className === 'string' ? element.className : '';
    return Boolean(
      element.matches('button, [role="button"], label, a') ||
      element.getAttribute('role') === 'combobox' ||
      element.onclick ||
      element.getAttribute('tabindex') !== null ||
      element.classList?.contains('btn') ||
      className.includes('select') ||
      className.includes('feature-select') ||
      className.includes('toolbar-button') ||
      style.cursor === 'pointer'
    );
  }

  function resolveInteractiveTarget(element) {
    if (!(element instanceof Element)) {
      return null;
    }

    const semanticTarget = element.closest('button, [role="button"], [tabindex], label, a');
    if (semanticTarget && isVisibleElement(semanticTarget)) {
      return semanticTarget;
    }

    if (isProbablyClickable(element) && isVisibleElement(element)) {
      return element;
    }

    const clickableParent = element.parentElement;
    if (clickableParent && isProbablyClickable(clickableParent) && isVisibleElement(clickableParent)) {
      return clickableParent;
    }

    return isVisibleElement(element) ? element : null;
  }

  function isBottomToolbarCandidate(element) {
    if (!(element instanceof Element) || !isVisibleElement(element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.top >= window.innerHeight * 0.75 && rect.height > 20 && rect.width > 24;
  }

  function collectBottomToolbarCandidates() {
    return Array.from(document.querySelectorAll('button, [role="button"], [tabindex], label, a, div, span'))
      .map(resolveInteractiveTarget)
      .filter((element, index, array) => element && array.indexOf(element) === index)
      .filter(isBottomToolbarCandidate);
  }

  function findJimengToolbarSettingsContainer() {
    console.log('[即梦] 查找工具栏设置容器...');
    
    const candidates = Array.from(document.querySelectorAll('div[class*="toolbar-settings-content"]'))
      .filter(isVisibleElement);

    console.log('[即梦] 通过 toolbar-settings-content 找到候选项:', candidates.length);
    if (candidates.length > 0) {
      const result = candidates.sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return rightRect.top - leftRect.top;
      })[0];
      console.log('[即梦] 选择最下方的容器:', result);
      return result;
    }

    // 备选选择器 1：通过其他工具栏相关类名
    console.log('[即梦] 尝试备选选择器 1：toolbar 相关类名...');
    const candidates2 = Array.from(document.querySelectorAll('div[class*="toolbar"], div[class*="settings"]'))
      .filter(el => isVisibleElement(el) && el.children.length >= 4);
    
    console.log('[即梦] 找到备选容器:', candidates2.length);
    if (candidates2.length > 0) {
      const result = candidates2.sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return rightRect.top - leftRect.top;
      })[0];
      console.log('[即梦] 使用备选容器');
      return result;
    }

    // 备选选择器 2：通过 data-* 属性
    console.log('[即梦] 尝试备选选择器 2：data 属性...');
    const candidates3 = Array.from(document.querySelectorAll('div[data-testid*="toolbar"], div[role="toolbar"]'))
      .filter(isVisibleElement);
    
    if (candidates3.length > 0) {
      console.log('[即梦] 通过 data 属性找到容器');
      return candidates3[0];
    }

    console.warn('[即梦] 未找到任何工具栏容器 - 页面结构可能已变更');
    return null;
  }

  function collectJimengToolbarItems() {
    console.log('[即梦] 开始收集工具栏项目...');
    
    const container = findJimengToolbarSettingsContainer();
    if (!container) {
      console.warn('[即梦] 工具栏容器未找到');
      return [];
    }

    console.log('[即梦] 工具栏容器找到，子元素数:', container.children.length);
    
    const items = Array.from(container.children)
      .map((element, index) => {
        const resolved = resolveInteractiveTarget(element) || element;
        const text = getElementText(resolved);
        console.log(`[即梦] 工具栏项 ${index}:`, {
          tag: element.tagName,
          class: element.className?.slice(0, 100),
          text: text?.slice(0, 50),
          isVisible: isVisibleElement(resolved)
        });
        return resolved;
      })
      .filter((element, index, array) => element && array.indexOf(element) === index)
      .filter(isVisibleElement);

    console.log('[即梦] 有效工具栏项:', items.length);
    return items;
  }

  function findJimengToolbarItemByMatcher(matcher) {
    const items = collectJimengToolbarItems();
    let best = null;
    let bestScore = -1;

    items.forEach((item, index) => {
      const text = getElementText(item);
      const score = matcher({ item, text, index });
      if (typeof score === 'number' && score > bestScore) {
        best = item;
        bestScore = score;
      }
    });

    return best;
  }

  async function waitForJimengToolbarReady(timeoutMs = 5000) {
    return waitForCondition(() => {
      const container = findJimengToolbarSettingsContainer();
      if (!container) {
        return null;
      }

      const items = collectJimengToolbarItems();
      return items.length >= 4 ? { container, items } : null;
    }, timeoutMs, 120);
  }

  async function waitForToolbarSelectionApplied(delayMs = 0) {
    await sleepJimengUiDelay(delayMs);
    await waitForJimengToolbarReady().catch(() => null);
  }

  function findBottomToolbarChipByPredicate(predicate) {
    const candidates = collectBottomToolbarCandidates();
    let best = null;
    let bestScore = -1;

    candidates.forEach((candidate) => {
      const text = getElementText(candidate);
      if (!text || !predicate(text, candidate)) {
        return;
      }

      let score = 100;
      const rect = candidate.getBoundingClientRect();
      score += rect.left < window.innerWidth * 0.7 ? 15 : 0;
      score += rect.top >= window.innerHeight * 0.82 ? 25 : 0;
      score += rect.width < 220 ? 10 : 0;

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    });

    return best;
  }

  function collectContextText(element, depth = 4) {
    const parts = [];
    let current = element;

    for (let level = 0; current && level < depth; level += 1) {
      const text = getElementText(current);
      if (text) {
        parts.push(text);
      }
      current = current.parentElement;
    }

    return normalizeText(parts.join(' '));
  }

  function findBestTextMatch(targetTexts, options = {}) {
    const {
      root = document,
      allowHidden = false,
      clickableOnly = true,
      fieldKeywords = []
    } = options;
    const normalizedTargets = targetTexts.map(text => normalizeText(text)).filter(Boolean);
    const normalizedKeywords = fieldKeywords.map(text => normalizeText(text)).filter(Boolean);
    const selector = clickableOnly
      ? 'button, [role="button"], [tabindex], label, span, div, a'
      : '*';
    const candidates = Array.from(root.querySelectorAll(selector));
    let best = null;
    let bestScore = -1;

    candidates.forEach((element) => {
      const candidate = clickableOnly
        ? resolveInteractiveTarget(element)
        : element;

      if (!candidate) {
        return;
      }

      if (!allowHidden && !isVisibleElement(candidate)) {
        return;
      }

      if (clickableOnly && !isProbablyClickable(candidate)) {
        return;
      }

      const text = getElementText(candidate);
      if (!text) {
        return;
      }

      let score = -1;
      normalizedTargets.forEach((target) => {
        if (!target) {
          return;
        }
        if (text === target) {
          score = Math.max(score, 120);
        } else if (text.startsWith(target)) {
          score = Math.max(score, 100);
        } else if (text.includes(target)) {
          score = Math.max(score, 80);
        }
      });

      if (score < 0) {
        return;
      }

      const contextText = collectContextText(candidate);
      if (normalizedKeywords.length > 0) {
        normalizedKeywords.forEach((keyword) => {
          if (contextText.includes(keyword)) {
            score += 20;
          }
        });
      }

      if (isVisibleElement(candidate)) {
        score += 5;
      }

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    });

    return best;
  }

  async function waitForElement(check, timeoutMs = 4000, intervalMs = 120) {
    return waitForCondition(check, timeoutMs, intervalMs);
  }

  function getComboboxPopupRoot(triggerElement) {
    if (!(triggerElement instanceof Element)) {
      return null;
    }

    const popupId = triggerElement.getAttribute('aria-controls');
    if (!popupId) {
      return null;
    }

    const popup = document.getElementById(popupId);
    return popup && isVisibleElement(popup) ? popup : popup || null;
  }

  async function waitForComboboxPopup(triggerElement, timeoutMs = 4000) {
    const popupId = triggerElement?.getAttribute?.('aria-controls');
    if (!popupId) {
      return null;
    }

    return waitForElement(() => {
      const popup = document.getElementById(popupId);
      return popup && isVisibleElement(popup) ? popup : null;
    }, timeoutMs, 120).catch(() => null);
  }

  function findOptionInPopup(popupRoot, targetTexts, fieldKeywords = []) {
    if (!popupRoot) {
      console.warn('[即梦] 弹窗为 null');
      return null;
    }

    const normalizedTargets = targetTexts.map(text => normalizeText(text)).filter(Boolean);

    // 优先匹配 option 行，而不是里面的文本 span，避免点击文本不生效
    const rowSelectors = [
      'li[role="option"]',
      '.lv-select-option',
      '[class*="option-label"]',
      '[class*="option-content"]'
    ];
    let labelCandidates = [];
    for (const selector of rowSelectors) {
      labelCandidates = Array.from(popupRoot.querySelectorAll(selector))
        .map((element) => element.closest('li[role="option"]') || element.closest('.lv-select-option') || element)
        .filter((element, index, array) => element && array.indexOf(element) === index);
      if (labelCandidates.length > 0) {
        console.log(`[即梦] 使用弹窗选择器 "${selector}" 找到候选项:`, labelCandidates.length);
        break;
      }
    }

    if (labelCandidates.length > 0) {
      const samples = labelCandidates.slice(0, 10).map(el => getElementText(el));
      console.log('[即梦] 弹窗候选项内容:', samples);
    }

    let best = null;
    let bestScore = -1;

    labelCandidates.forEach((element, idx) => {
      if (!isVisibleElement(element)) {
        return;
      }

      // 获取元素的文本
      const text = normalizeText(getElementText(element));
      
      if (!text) {
        return;
      }

      let score = -1;
      normalizedTargets.forEach((target) => {
        if (text === target) {
          score = Math.max(score, 200);
        } else if (text.includes(target)) {
          score = Math.max(score, 150);
        }
      });

      if (score >= 0) {
        console.log(`[即梦] 候选项 ${idx}: "${text}" 分数: ${score}`);
      }

      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    });

    if (best) {
      console.log('[即梦] 找到最佳匹配:', getElementText(best));
      return best;
    }

    console.log('[即梦] 精确匹配失败，尝试 findBestTextMatch 备选方案');
    return findBestTextMatch(targetTexts, {
      root: popupRoot,
      clickableOnly: true,
      fieldKeywords
    });
  }

  async function clickPopupOption(optionElement) {
    if (!(optionElement instanceof Element)) {
      return false;
    }

    const clickTargets = [
      optionElement,
      optionElement.querySelector('[class*="option-content"]'),
      optionElement.querySelector('[class*="option-label"]'),
      optionElement.querySelector('[class*="select-option-label-content"]'),
      optionElement.querySelector('span')
    ].filter(Boolean).filter((element, index, array) => array.indexOf(element) === index);

    for (const clickTarget of clickTargets) {
      await clickElement(clickTarget);
      await sleep(260);
    }

    return true;
  }

  function getComboboxValueText(triggerElement) {
    if (!(triggerElement instanceof Element)) {
      return '';
    }

    const directValue = normalizeText(
      triggerElement.querySelector('[class*="option-content"]')?.innerText ||
      triggerElement.querySelector('[class*="option-label"]')?.innerText ||
      triggerElement.querySelector('.lv-select-view-value')?.innerText ||
      ''
    );

    return directValue || normalizeText(getElementText(triggerElement));
  }

  function matchesTargetText(value, targetTexts) {
    const normalizedValue = normalizeText(value);
    const normalizedTargets = (targetTexts || []).map(text => normalizeText(text)).filter(Boolean);
    return normalizedTargets.some((target) => normalizedValue === target || normalizedValue.includes(target));
  }

  function normalizeJimengModelText(value) {
    return normalizeText(value)
      .replace(/\s+/g, ' ')
      .replace(/\bby seed\b/gi, '')
      .replace(/\bnew\b/gi, '')
      .trim();
  }

  function matchesJimengModel(value, targetTexts) {
    const normalizedValue = normalizeJimengModelText(value);
    const normalizedTargets = (targetTexts || []).map(text => normalizeJimengModelText(text)).filter(Boolean);

    return normalizedTargets.some((target) => {
      if (normalizedValue === target) {
        return true;
      }

      // Avoid treating VIP models as equivalent to standard models.
      if (normalizedValue.includes('VIP') !== target.includes('VIP')) {
        return false;
      }

      return normalizedValue.includes(target);
    });
  }

  function extractAspectRatioText(value) {
    const normalized = normalizeText(value);
    const match = normalized.match(/\d+\s*:\s*\d+/);
    return match ? normalizeText(match[0]) : normalized;
  }

  function extractDurationText(value) {
    const normalized = normalizeText(value);
    const match = normalized.match(/\d+\s*s/);
    return match ? normalizeText(match[0]) : normalized;
  }

  async function openCombobox(triggerElement) {
    if (!(triggerElement instanceof Element)) {
      return null;
    }

    const clickCandidates = [
      triggerElement.querySelector('.lv-select-view-selector'),
      triggerElement.querySelector('[class*="option-content"]'),
      triggerElement.querySelector('[class*="option-label"]'),
      triggerElement.querySelector('[class*="arrow"]'),
      triggerElement
    ].filter(Boolean);

    for (const clickTarget of clickCandidates) {
      await clickElement(clickTarget);
      const popupRoot = await waitForComboboxPopup(triggerElement, 1200);
      if (popupRoot) {
        return popupRoot;
      }
      await sleep(120);
    }

    return null;
  }

  async function clickElement(element) {
    if (!element) {
      throw new Error('目标元素不存在');
    }

    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    const rect = element.getBoundingClientRect();
    const mouseOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };

    if (typeof element.focus === 'function') {
      try {
        element.focus({ preventScroll: true });
      } catch (error) {
        try {
          element.focus();
        } catch (_) {
          // ignore
        }
      }
    }

    if (typeof element.click === 'function') {
      element.click();
    } else {
      if (typeof PointerEvent === 'function') {
        element.dispatchEvent(new PointerEvent('pointerdown', mouseOptions));
        element.dispatchEvent(new PointerEvent('pointerup', mouseOptions));
      } else {
        element.dispatchEvent(new MouseEvent('pointerdown', mouseOptions));
        element.dispatchEvent(new MouseEvent('pointerup', mouseOptions));
      }
      element.dispatchEvent(new MouseEvent('mousedown', mouseOptions));
      element.dispatchEvent(new MouseEvent('mouseup', mouseOptions));
      element.dispatchEvent(new MouseEvent('click', mouseOptions));
    }

    await sleep(180);
  }

  async function clickElementWithPointerSequence(element) {
    if (!element) {
      throw new Error('目标元素不存在');
    }

    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    const rect = element.getBoundingClientRect();
    const mouseOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };

    if (typeof element.focus === 'function') {
      try {
        element.focus({ preventScroll: true });
      } catch (error) {
        try {
          element.focus();
        } catch (_) {
          // ignore
        }
      }
    }

    if (typeof PointerEvent === 'function') {
      element.dispatchEvent(new PointerEvent('pointerdown', mouseOptions));
      element.dispatchEvent(new PointerEvent('pointerup', mouseOptions));
    }
    element.dispatchEvent(new MouseEvent('mousedown', mouseOptions));
    element.dispatchEvent(new MouseEvent('mouseup', mouseOptions));
    element.dispatchEvent(new MouseEvent('click', mouseOptions));

    await sleep(400);
  }

  async function ensureJimengOptionSelection(targetTexts, fieldKeywords, errorMessage) {
    const target = collectVisibleTextTargets(targetTexts) || findBestTextMatch(targetTexts, {
      clickableOnly: true,
      fieldKeywords
    });

    if (target) {
      await clickElement(target);
      return true;
    }

    const trigger = findBestTextMatch(fieldKeywords, {
      clickableOnly: true
    });

    if (trigger) {
      await clickElement(trigger);
      await sleep(180);
      const globalOption = collectVisibleTextTargets(targetTexts);
      if (globalOption) {
        await clickElement(globalOption);
        return true;
      }

      const option = findBestTextMatch(targetTexts, {
        clickableOnly: true,
        fieldKeywords
      });
      if (option) {
        await clickElement(option);
        return true;
      }
    }

    if (!errorMessage) {
      return false;
    }

    throw new Error(errorMessage);
  }

  function collectVisibleTextTargets(targetTexts) {
    const normalizedTargets = targetTexts.map(text => normalizeText(text)).filter(Boolean);
    const popupOptionRows = Array.from(document.querySelectorAll(
      '.lv-select-popup-inner li[role="option"], .lv-select-popup li[role="option"], [role="listbox"] li[role="option"]'
    )).filter(isVisibleElement);
    const candidates = popupOptionRows.length > 0 ? popupOptionRows : Array.from(document.querySelectorAll('body *'));
    let best = null;
    let bestScore = -1;

    candidates.forEach((element) => {
      if (!isVisibleElement(element)) {
        return;
      }

      const text = normalizeText(element.innerText || element.textContent || '');
      if (!text) {
        return;
      }

      let score = -1;
      normalizedTargets.forEach((target) => {
        if (text === target) {
          score = Math.max(score, 220);
        } else if (text.includes(target)) {
          score = Math.max(score, 170);
        }
      });

      if (score < 0) {
        return;
      }

      const candidate = resolveInteractiveTarget(element) || element;
      if (!candidate || !isVisibleElement(candidate)) {
        return;
      }

      const rect = candidate.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.9) {
        score += 10;
      }
      if (candidate !== element) {
        score += 5;
      }
      if (element.matches?.('li[role="option"]')) {
        score += 80;
      }
      if (candidate.matches?.('li[role="option"]')) {
        score += 80;
      }

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    });

    return best;
  }

  async function waitForVisibleTargetOption(targetTexts, timeoutMs = 2200) {
    return waitForElement(() => collectVisibleTextTargets(targetTexts), timeoutMs, 120).catch(() => null);
  }

  function findVisiblePopupContainer() {
    const popups = Array.from(document.querySelectorAll(
      '.lv-select-popup, .lv-trigger-popup, [class*="trigger-popup"], [class*="popup-inner"], [role="listbox"]'
    )).filter(isVisibleElement);

    if (popups.length === 0) {
      return null;
    }

    return popups.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (rightRect.top - leftRect.top) || (rightRect.left - leftRect.left);
    })[0];
  }

  function findVisibleLvSelectPopup() {
    const popups = Array.from(document.querySelectorAll('.lv-select-popup'))
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null);

    if (popups.length === 0) {
      return null;
    }

    return popups[popups.length - 1];
  }

  async function waitForVisiblePopupContainer(timeoutMs = 2200) {
    return waitForElement(() => findVisiblePopupContainer(), timeoutMs, 120).catch(() => null);
  }

  function findAnyVisibleListboxPopup() {
    const popups = Array.from(document.querySelectorAll(
      '.lv-select-popup, .lv-select-popup-inner[role="listbox"], .lv-select-popup[role="listbox"], [role="listbox"][class*="popup"]'
    )).filter(isVisibleElement);

    if (popups.length === 0) {
      return null;
    }

    return popups.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (rightRect.top - leftRect.top) || (rightRect.left - leftRect.left);
    })[0];
  }

  async function waitForAnyVisibleListboxPopup(timeoutMs = 2200) {
    return waitForElement(() => findAnyVisibleListboxPopup(), timeoutMs, 120).catch(() => null);
  }

  async function triggerFeatureSelectPopup(triggerElement) {
    const candidates = [
      triggerElement.querySelector('[class*="option-content"]'),
      triggerElement.querySelector('[class*="option-label"]'),
      triggerElement.querySelector('[class*="arrow"]'),
      triggerElement.querySelector('svg'),
      triggerElement
    ].filter(Boolean).filter((element, index, array) => array.indexOf(element) === index);

    for (const candidate of candidates) {
      await clickElement(candidate);
      await sleep(420);

      const popupByControl = await waitForComboboxPopup(triggerElement, 800);
      if (popupByControl) {
        console.log('[即梦][参考模式] 通过 aria-controls 找到弹窗');
        return popupByControl;
      }

      const popupByListbox = await waitForAnyVisibleListboxPopup(1200);
      if (popupByListbox) {
        console.log('[即梦][参考模式] 通过全局 listbox 找到弹窗');
        return popupByListbox;
      }

      const popupByContainer = await waitForVisiblePopupContainer(1200);
      if (popupByContainer) {
        console.log('[即梦][参考模式] 通过通用 popup 容器找到弹窗');
        return popupByContainer;
      }
    }

    return null;
  }

  async function selectFeatureModeOption(triggerElement, targetTexts, errorMessage) {
    const clickTargets = [
      triggerElement.querySelector('[class*="option-content"]'),
      triggerElement.querySelector('[class*="option-label"]'),
      triggerElement.querySelector('[class*="arrow"]'),
      triggerElement.querySelector('svg'),
      triggerElement
    ].filter(Boolean).filter((element, index, array) => array.indexOf(element) === index);

    let latestText = getComboboxValueText(triggerElement);
    if (matchesTargetText(latestText, targetTexts)) {
      return true;
    }

    for (let round = 0; round < 3; round += 1) {
      console.log(`[即梦][参考模式] 第 ${round + 1}/3 轮尝试，当前值: "${latestText}"`);

      for (const clickTarget of clickTargets) {
        console.log('[即梦][参考模式] 点击候选节点:', clickTarget.className || clickTarget.tagName);
        await clickElement(clickTarget);
        await sleep(500 + round * 250);

        latestText = getComboboxValueText(triggerElement);
        console.log('[即梦][参考模式] 点击后当前值:', latestText);
        if (matchesTargetText(latestText, targetTexts)) {
          await waitForToolbarSelectionApplied(600);
          return true;
        }

        let popupRoot = await waitForComboboxPopup(triggerElement, 1200 + round * 300);
        if (!popupRoot) {
          popupRoot = await waitForVisiblePopupContainer(1200 + round * 300);
        }
        if (popupRoot) {
          console.log('[即梦][参考模式] 检测到弹窗，尝试在弹窗内选择目标');
          const scopedOption = findOptionInPopup(popupRoot, targetTexts, ['参考', '模式', '首尾帧', '全能参考']);
          if (scopedOption) {
            console.log('[即梦][参考模式] 在弹窗中找到目标项:', getElementText(scopedOption));
            await sleepJimengUiDelay();
            await clickPopupOption(scopedOption);
            await waitForToolbarSelectionApplied(700);
            latestText = getComboboxValueText(triggerElement);
            console.log('[即梦][参考模式] 选择弹窗项后当前值:', latestText);
            if (matchesTargetText(latestText, targetTexts)) {
              return true;
            }
          }
        }

        const exactPopup = findVisibleLvSelectPopup();
        if (exactPopup) {
          console.log('[即梦][参考模式] 检测到 .lv-select-popup，使用已验证路径选择目标');
          const exactOption = Array.from(exactPopup.querySelectorAll('li[role="option"]'))
            .find((element) => matchesTargetText(element.innerText || element.textContent || '', targetTexts));

          if (exactOption) {
            console.log('[即梦][参考模式] 通过 li[role="option"] 精确命中:', (exactOption.innerText || '').trim());
            await sleepJimengUiDelay();
            exactOption.click();
            await waitForToolbarSelectionApplied(700);
            latestText = getComboboxValueText(triggerElement);
            console.log('[即梦][参考模式] 精确点击后当前值:', latestText);
            if (matchesTargetText(latestText, targetTexts)) {
              return true;
            }
          }
        }

        const delayedVisibleOption = await waitForVisibleTargetOption(targetTexts, 1800 + round * 400);
        if (delayedVisibleOption) {
          console.log('[即梦][参考模式] 检测到延迟出现的可见目标项，尝试点击');
          await clickElement(delayedVisibleOption);
          await waitForToolbarSelectionApplied(700);
          latestText = getComboboxValueText(triggerElement);
          console.log('[即梦][参考模式] 点击延迟目标项后当前值:', latestText);
          if (matchesTargetText(latestText, targetTexts)) {
            return true;
          }
        }

        const globalOption = collectVisibleTextTargets(targetTexts);
        if (globalOption) {
          console.log('[即梦][参考模式] 发现全局可见目标项，尝试点击');
          await clickPopupOption(globalOption);
          await waitForToolbarSelectionApplied(700);
          latestText = getComboboxValueText(triggerElement);
          console.log('[即梦][参考模式] 点击全局目标项后当前值:', latestText);
          if (matchesTargetText(latestText, targetTexts)) {
            return true;
          }
        }
      }

      await sleep(400);
      latestText = getComboboxValueText(triggerElement);
      if (matchesTargetText(latestText, targetTexts)) {
        return true;
      }
    }

    throw new Error((errorMessage || '未找到即梦参考模式选项') + `（当前值: ${latestText || '未知'}）`);
  }

  function findJimengDurationChip(targetTexts) {
    const normalizedTargets = targetTexts.map(text => normalizeText(text)).filter(Boolean);
    const toolbarItems = collectJimengToolbarItems();
    const candidates = toolbarItems.length > 0
      ? toolbarItems
      : Array.from(document.querySelectorAll('button, [role="button"], [tabindex], label, a, div, span'));
    let best = null;
    let bestScore = -1;

    candidates.forEach((element) => {
      const candidate = toolbarItems.length > 0 ? element : resolveInteractiveTarget(element);
      if (!candidate || !isVisibleElement(candidate)) {
        return;
      }

      const text = getElementText(candidate);
      if (!text) {
        return;
      }

      let score = -1;
      normalizedTargets.forEach((target) => {
        if (text === target) {
          score = Math.max(score, 180);
        }
      });

      if (score < 0 && /^\d+\s*(s|秒)$/.test(text)) {
        score = 90;
      }

      if (score < 0) {
        return;
      }

      const rect = candidate.getBoundingClientRect();
      if (rect.top >= window.innerHeight * 0.65) {
        score += 40;
      }

      const contextText = collectContextText(candidate, 6);
      if (contextText.includes('时长') || contextText.includes('秒')) {
        score += 30;
      }
      if (contextText.includes('9:16') || contextText.includes('16:9') || contextText.includes('seedance')) {
        score += 15;
      }

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    });

    return best;
  }

  async function selectJimengDurationOption(targetDuration) {
    const triggerElement = findJimengToolbarItemByMatcher(({ text, index }) => {
      if (normalizeText(text) === normalizeText(targetDuration)) return 220;
      if (/^\d+\s*(s|秒)$/.test(normalizeText(text))) return 180;
      if (index === 4) return 100;
      return -1;
    }) || findBottomToolbarChipByPredicate((text) => normalizeText(text) === normalizeText(targetDuration) || /^\d+\s*(s|秒)$/.test(normalizeText(text)));

    if (!triggerElement) {
      throw new Error('未找到即梦时长触发器');
    }

    const currentText = extractDurationText(getElementText(triggerElement));
    if (currentText === normalizeText(targetDuration)) {
      console.log('[即梦][时长] 当前时长已匹配目标:', currentText);
      return true;
    }

    console.log('[即梦][时长] 当前值:', currentText, '目标值:', targetDuration);
    const popup = await openCombobox(triggerElement)
      || findVisibleLvSelectPopup()
      || findVisiblePopupContainer()
      || await waitForAnyVisibleListboxPopup(1800)
      || await waitForVisiblePopupContainer(1800);

    if (!popup) {
      throw new Error('未找到即梦时长弹窗');
    }

    const rows = Array.from(popup.querySelectorAll('li[role="option"]'));
    if (rows.length === 0) {
      throw new Error('时长弹窗中未找到可选项');
    }

    const labels = rows.map((row) => extractDurationText(row.innerText));
    console.log('[即梦][时长] 候选项:', labels);

    const targetRow = rows.find((row) => extractDurationText(row.innerText) === normalizeText(targetDuration));
    if (!targetRow) {
      throw new Error(`未找到即梦时长: ${targetDuration}`);
    }

    targetRow.click();
    await waitForToolbarSelectionApplied(400);

    const afterText = extractDurationText(getElementText(triggerElement));
    console.log('[即梦][时长] 切换后当前值:', afterText);
    if (afterText !== normalizeText(targetDuration)) {
      throw new Error(`时长切换失败，当前值仍为: ${afterText || '未知'}`);
    }

    return true;
  }

  function findJimengModelChip() {
    return findJimengToolbarItemByMatcher(({ text, index }) => {
      if (/seedance/i.test(text)) return 200;
      if (index === 1) return 80;
      return -1;
    }) || findBottomToolbarChipByPredicate((text) => /seedance/i.test(text));
  }

  async function selectJimengModelOption(triggerElement, config) {
    const popupRoot = await openCombobox(triggerElement);
    const popup = popupRoot || findVisibleLvSelectPopup() || findVisiblePopupContainer();

    if (!popup) {
      throw new Error('未找到即梦模型弹窗');
    }

    const rows = Array.from(popup.querySelectorAll('li[role="option"]'));
    if (rows.length === 0) {
      throw new Error('即梦模型弹窗中未找到可选项');
    }

    // 当前页面已验证的模型顺序：
    // 0: Seedance 2.0 Fast VIP
    // 1: Seedance 2.0 VIP
    // 2: Seedance 2.0 Fast
    // 3: Seedance 2.0
    // 4: Seedance 1.5 Pro
    const targetIndex = config.model === 'seedance_2' ? 3 : 2;
    const targetRow = rows[targetIndex];

    if (!targetRow) {
      throw new Error(`未找到即梦模型选项索引 ${targetIndex}`);
    }

    console.log('[即梦][模型] 使用已验证索引选择模型:', {
      model: config.model,
      targetIndex,
      targetText: getElementText(targetRow)
    });

    targetRow.click();
    await waitForToolbarSelectionApplied(500);
  }

  function findJimengCreationTypeChip() {
    console.log('[即梦] 开始查找创作类型芯片...');

    // 第一优先级：工具栏第一个标准选择器，兼容 Agent 模式 / 视频生成 / 图片生成
    const result1 = findJimengToolbarItemByMatcher(({ item, text, index }) => {
      const className = typeof item.className === 'string' ? item.className : '';

      if (
        index === 0 &&
        (
          item.getAttribute?.('role') === 'combobox' ||
          className.includes('lv-select') ||
          className.includes('toolbar-select')
        )
      ) {
        console.log('[即梦] 通过第一个下拉选择器找到创作类型');
        return 260;
      }

      if (
        text.includes('视频生成') ||
        text.includes('图片生成') ||
        text.includes('Agent') ||
        text.includes('动作模仿')
      ) {
        console.log('[即梦] 通过文本匹配找到创作类型');
        return 220;
      }

      return -1;
    });

    if (result1) {
      return result1;
    }

    console.log('[即梦] 工具栏匹配器未找到，尝试底部工具栏...');

    const result2 = findBottomToolbarChipByPredicate((text) =>
      text.includes('视频生成') ||
      text.includes('图片生成') ||
      text.includes('Agent') ||
      text.includes('动作模仿')
    );

    if (result2) {
      console.log('[即梦] 通过底部工具栏找到创作类型');
      return result2;
    }

    console.warn('[即梦] 未找到创作类型芯片 - 页面结构已变更或不在创建模式');

    // 诊断信息
    const items = collectJimengToolbarItems();
    console.warn('[即梦] 工具栏诊断:', {
      itemCount: items.length,
      itemTexts: items.map(el => getElementText(el)).slice(0, 5)
    });
    
    return null;
  }

  async function selectJimengCreationTypeOption(targetText) {
    const triggerElement = findJimengCreationTypeChip();
    if (!triggerElement) {
      throw new Error('未找到即梦创作类型选项');
    }

    const currentText = getComboboxValueText(triggerElement) || getElementText(triggerElement);
    if (matchesTargetText(currentText, [targetText])) {
      console.log('[即梦][创作类型] 当前值已匹配目标:', currentText);
      return true;
    }

    console.log('[即梦][创作类型] 当前值:', currentText, '目标值:', targetText);
    const popup = await openCombobox(triggerElement) || findVisibleLvSelectPopup() || findVisiblePopupContainer() || await waitForVisiblePopupContainer(1800);
    if (!popup) {
      throw new Error('未找到即梦创作类型弹窗');
    }

    const rows = Array.from(popup.querySelectorAll('li[role="option"]'));
    if (rows.length === 0) {
      throw new Error('创作类型弹窗中未找到可选项');
    }

    console.log('[即梦][创作类型] 弹窗候选:', rows.map(row => getElementText(row)));

    const targetRow = rows.find((row) => matchesTargetText(getElementText(row), [targetText]));
    if (!targetRow) {
      throw new Error(`未找到创作类型: ${targetText}`);
    }

    await clickElement(targetRow);
    await waitForToolbarSelectionApplied(700);

    const freshTrigger = findJimengCreationTypeChip();
    const afterText = freshTrigger
      ? (getComboboxValueText(freshTrigger) || getElementText(freshTrigger))
      : normalizeText(collectJimengToolbarItems()[0] ? getElementText(collectJimengToolbarItems()[0]) : '');
    console.log('[即梦][创作类型] 切换后当前值(重新读取):', afterText);

    if (!matchesTargetText(afterText, [targetText])) {
      throw new Error(`创作类型切换失败，当前值仍为: ${afterText || '未知'}`);
    }

    return true;
  }

  function findJimengReferenceChip() {
    console.log('[即梦] 开始查找参考模式芯片...');
    
    const result1 = findJimengToolbarItemByMatcher(({ item, text, index }) => {
      const className = typeof item.className === 'string' ? item.className : '';
      console.log(`[即梦] 参考模式候选 ${index}: "${text}" (className: ${className.slice(0, 50)})`);
      
      if (text.includes('首尾帧') || text.includes('全能参考')) {
        console.log('[即梦] 通过文本匹配找到参考模式');
        return 200;
      }
      if (className.includes('feature-select')) {
        console.log('[即梦] 通过 feature-select 类名找到参考模式');
        return 170;
      }
      if (index === 2) {
        console.log('[即梦] 通过索引 2 找到参考模式（备选）');
        return 90;
      }
      return -1;
    });
    
    if (result1) {
      console.log('[即梦] 参考模式找到');
      return result1;
    }
    
    console.log('[即梦] 工具栏匹配失败，尝试底部工具栏...');
    
    const result2 = findBottomToolbarChipByPredicate((text) => text.includes('首尾帧') || text.includes('全能参考'));
    
    if (result2) {
      console.log('[即梦] 通过底部工具栏找到参考模式');
      return result2;
    }
    
    console.warn('[即梦] 未找到参考模式芯片');
    return null;
  }

  function findJimengAspectRatioChip() {
    console.log('[即梦] 开始查找宽高比芯片...');
    
    // 第一优先级：通过正则表达式匹配 X:Y 格式
    const result1 = findJimengToolbarItemByMatcher(({ text, index }) => {
      const normalized = text.trim();
      // 匹配各种宽高比格式：9:16, 16:9, 1:1, 3:4 等
      if (/\d+\s*:\s*\d+/.test(normalized)) {
        console.log('[即梦] 通过比例格式找到宽高比:', normalized);
        return 200;
      }
      // 备选：第 3 项（按顺序）
      if (index === 3) {
        console.log('[即梦] 通过索引 3 找到宽高比:', normalized);
        return 90;
      }
      return -1;
    });
    
    if (result1) {
      return result1;
    }
    
    console.log('[即梦] 工具栏匹配失败，尝试底部工具栏...');
    
    // 第二优先级：在底部工具栏查找
    const result2 = findBottomToolbarChipByPredicate((text) => /\d+\s*:\s*\d+/.test(text));
    
    if (result2) {
      console.log('[即梦] 通过底部工具栏找到宽高比');
      return result2;
    }
    
    console.warn('[即梦] 未找到宽高比芯片');
    return null;
  }

  async function selectJimengAspectRatioOption(targetRatio) {
    const normalizedTargetRatio = normalizeText(targetRatio);
    const readCurrentRatio = () => {
      const latestTrigger = findJimengAspectRatioChip();
      return latestTrigger ? extractAspectRatioText(getElementText(latestTrigger)) : '';
    };
    const findAspectRatioPopover = () => Array.from(document.querySelectorAll('.lv-popover-inner-content'))
      .filter((element) => element instanceof HTMLElement && isVisibleElement(element))
      .find((element) => {
        const text = normalizeText(element.innerText || element.textContent || '');
        return text.includes('选择比例') || Boolean(element.querySelector('[role="radiogroup"]'));
      }) || null;
    const closeAspectRatioPopover = async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
      await sleep(180);
    };

    const currentText = readCurrentRatio();
    if (currentText === normalizedTargetRatio) {
      console.log('[即梦][比例] 当前比例已匹配目标:', currentText);
      return true;
    }

    console.log('[即梦][比例] 当前比例:', currentText, '目标比例:', normalizedTargetRatio);

    for (let round = 0; round < 2; round += 1) {
      const triggerElement = findJimengAspectRatioChip();
      if (!triggerElement) {
        throw new Error('未找到即梦比例按钮');
      }

      await clickElement(triggerElement);
      await sleepJimengUiDelay();

      const popover = await waitForCondition(() => findAspectRatioPopover(), 3000, 120)
        .catch(() => null);

      if (!popover) {
        const visiblePopovers = Array.from(document.querySelectorAll('.lv-popover-inner-content'))
          .filter((element) => element instanceof HTMLElement && isVisibleElement(element))
          .map((element) => normalizeText(element.innerText || element.textContent || ''))
          .filter(Boolean);
        console.warn('[即梦][比例] 未检测到比例面板，当前可见 popover:', visiblePopovers);
        await closeAspectRatioPopover();
        await sleepJimengUiDelay();
        continue;
      }

      const group = popover.querySelector('[role="radiogroup"]');
      if (!group) {
        throw new Error('未找到即梦比例选项组');
      }

      const options = Array.from(group.querySelectorAll('label.lv-radio'))
        .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
        .map((element) => ({
          element,
          text: extractAspectRatioText(getElementText(element)),
          className: String(element.className || '')
        }))
        .filter((item) => item.text);

      console.log('[即梦][比例] 候选项:', options.map((item) => ({
        text: item.text,
        className: item.className
      })));

      const option = options.find((item) => item.text === normalizedTargetRatio);
      if (!option) {
        throw new Error(`未找到即梦比例: ${targetRatio}`);
      }

      await sleepJimengUiDelay();
      await clickElement(option.element);
      await waitForToolbarSelectionApplied();

      const afterText = readCurrentRatio();
      console.log('[即梦][比例] 切换后当前值:', afterText);
      if (afterText === normalizedTargetRatio) {
        await closeAspectRatioPopover();
        return true;
      }

      await closeAspectRatioPopover();
      await sleepJimengUiDelay();
    }

    const finalText = readCurrentRatio();
    throw new Error(`比例切换失败，当前值仍为: ${finalText || '未知'}`);
  }

  async function selectViaToolbarChip({
    targetTexts,
    triggerElement,
    fieldKeywords,
    errorMessage,
    matchCurrentValue = matchesTargetText
  }) {
    const normalizedTargets = targetTexts.map(text => normalizeText(text)).filter(Boolean);
    const currentText = getComboboxValueText(triggerElement);

    console.log('[即梦工具栏] ========== 开始选择 ==========');
    console.log('[即梦工具栏] 目标文本:', targetTexts);
    console.log('[即梦工具栏] 当前文本:', currentText);

    if (matchCurrentValue(currentText, targetTexts)) {
      console.log('[即梦工具栏] ✓ 当前值已匹配目标，无需操作');
      return true;
    }

    if (!triggerElement) {
      console.error('[即梦工具栏] ✗ 错误: triggerElement 为 null');
      if (errorMessage) throw new Error(errorMessage);
      return false;
    }

    const isButton = triggerElement.tagName === 'BUTTON';
    const isFeatureSelect = triggerElement.className?.includes('feature-select');
    
    console.log('[即梦工具栏] 控件类型:', { 标签: triggerElement.tagName, 是按钮: isButton, 是特殊选择器: isFeatureSelect });
    
    if (isFeatureSelect) {
      console.log('[即梦工具栏] 特殊参考模式选择器，进入专用切换逻辑');
      await selectFeatureModeOption(triggerElement, targetTexts, errorMessage);
      console.log('[即梦工具栏] ========== 选择完成（feature-select）==========');
      return true;
    }

    if (isButton) {
      console.log('[即梦工具栏] 按钮类型，尝试直接点击后校验');
      await clickElement(triggerElement);
      await waitForToolbarSelectionApplied(400);
      const afterClickText = getComboboxValueText(triggerElement);
      if (normalizedTargets.some(t => normalizeText(afterClickText) === t || normalizeText(afterClickText).includes(t))) {
        console.log('[即梦工具栏] ========== 选择完成（button）==========');
        return true;
      }
    } else {
      // 标准下拉框
      console.log('[即梦工具栏] 标准下拉框类型');
      const popupRoot = await openCombobox(triggerElement);
      const option = findOptionInPopup(popupRoot, targetTexts, fieldKeywords);
      if (option) {
        console.log('[即梦工具栏] ✓ 找到选项，点击...');
        await clickElement(option);
        await waitForToolbarSelectionApplied();
        return true;
      }
    }

    console.log('[即梦工具栏] 尝试备选方案: ensureJimengOptionSelection');
    await ensureJimengOptionSelection(targetTexts, fieldKeywords, errorMessage);
    console.log('[即梦工具栏] ========== 选择完成（备选方案）==========');
    return true;
  }

  async function ensureJimengCreationTypeSelection() {
    console.log('[即梦] === 开始配置创作类型 ===');

    const items = collectJimengToolbarItems();
    console.log('[即梦] 当前工具栏项数:', items.length);
    items.forEach((item, idx) => {
      console.log(`[即梦] 工具栏项 ${idx}:`, getElementText(item));
    });

    await selectJimengCreationTypeOption('视频生成');
    await waitForToolbarSelectionApplied(1500);
    console.log('[即梦] === 创作类型配置完成 ===');
    return true;
  }

  async function ensureJimengModelSelection(config) {
    const modelCandidates = config.model === 'seedance_2'
      ? ['Seedance 2.0']
      : ['Seedance 2.0 Fast'];

    const triggerElement = findJimengModelChip();
    const currentText = getComboboxValueText(triggerElement);
    if (matchesJimengModel(currentText, modelCandidates)) {
      console.log('[即梦][模型] 当前模型已匹配目标:', currentText);
      return true;
    }

    await selectJimengModelOption(triggerElement, config);
    const afterSelectText = getComboboxValueText(triggerElement);
    if (matchesJimengModel(afterSelectText, modelCandidates)) {
      console.log('[即梦][模型] 索引选择模型成功:', afterSelectText);
      return true;
    }

    return selectViaToolbarChip({
      targetTexts: modelCandidates,
      triggerElement,
      fieldKeywords: ['模型', 'Model', 'Seedance'],
      errorMessage: '未找到即梦模型选项',
      matchCurrentValue: matchesJimengModel
    });
  }

  async function ensureJimengReferenceSelection(config) {
    const referenceCandidates = config.referenceMode === 'first_last_frames'
      ? ['首尾帧', '首尾帧参考', '首尾帧模式']
      : ['全能参考', '全能参考模式', '全能参考图'];
    return selectViaToolbarChip({
      targetTexts: referenceCandidates,
      triggerElement: findJimengReferenceChip(),
      fieldKeywords: ['参考', '模式', '首尾帧', '全能参考'],
      errorMessage: '未找到即梦参考模式选项'
    });
  }

  async function ensureJimengAspectRatioSelection(config) {
    const aspectRatio = config.aspectRatio || '16:9';
    return selectJimengAspectRatioOption(aspectRatio);
  }

  async function ensureJimengDurationSelection(config, taskId) {
    const targetDuration = `${Number(config.durationSeconds || 4)}s`;
    await reportJimengDomSubmitProgress(taskId, 'configuring_duration_dropdown');
    await selectJimengDurationOption(targetDuration);
    return true;
  }

  async function applyJimengGenerationConfig(config, taskId) {
    console.log('[即梦] === 开始配置生成参数 ===');
    
    try {
      await waitForJimengToolbarReady();
      console.log('[即梦] 工具栏已就绪');
    } catch (error) {
      console.error('[即梦] 工具栏超时:', error.message);
      throw new Error('工具栏初始化超时，可能页面结构已变更');
    }

    // 步骤 1：确保在视频生成模式
    await reportJimengDomSubmitProgress(taskId, 'configuring_creation_type');
    await ensureJimengCreationTypeSelection();
    await waitForToolbarSelectionApplied();
    
    // 验证模式切换是否成功
    const itemsAfterModeSwitch = collectJimengToolbarItems();
    const firstItemText = getElementText(itemsAfterModeSwitch[0]);
    console.log('[即梦] 模式切换后第一项:', firstItemText);
    
    if (firstItemText.includes('Agent')) {
      console.error('[即梦] 警告：模式切换可能失败，工具栏仍显示 Agent 模式');
      console.log('[即梦] 可能原因：');
      console.log('  1. 页面结构已变更');
      console.log('  2. 模式选择器的选项不是\'视频生成\'');
      console.log('  3. 需要在即梦网站上手动切换到视频生成');
      throw new Error('未能成功切换到视频生成模式');
    }

    // 步骤 2-5：配置各项参数
    await waitForToolbarSelectionApplied();
    await reportJimengDomSubmitProgress(taskId, 'configuring_reference_mode');
    await ensureJimengReferenceSelection(config);

    await waitForToolbarSelectionApplied();
    await reportJimengDomSubmitProgress(taskId, 'configuring_model');
    await ensureJimengModelSelection(config);

    await waitForToolbarSelectionApplied();
    await reportJimengDomSubmitProgress(taskId, 'configuring_aspect_ratio');
    await ensureJimengAspectRatioSelection(config);

    await waitForToolbarSelectionApplied();
    await reportJimengDomSubmitProgress(taskId, 'configuring_duration');
    await ensureJimengDurationSelection(config, taskId);
    
    console.log('[即梦] === 生成参数配置完成 ===');
  }

  function parsePromptSegments(promptText) {
    const parts = String(promptText || '').split(/(\{\d+\})/);
    const segments = [];

    for (const part of parts) {
      const match = part.match(/^\{(\d+)\}$/);
      if (match) {
        segments.push({
          type: 'image',
          imageIndex: Number(match[1])
        });
      } else if (part) {
        segments.push({
          type: 'text',
          text: part
        });
      }
    }

    return segments;
  }

  function placeCaretAtEnd(element) {
    if (!(element instanceof Element)) {
      return;
    }

    element.focus();
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.addRange(range);
  }

  async function insertTextIntoPrompt(editable, text) {
    if (!text) {
      return;
    }

    placeCaretAtEnd(editable);
    const beforeText = editable.textContent || '';
    let execSucceeded = false;

    try {
      execSucceeded = document.execCommand('insertText', false, text);
    } catch (error) {
      // Ignore execCommand failures and continue with DOM fallback.
    }

    const afterExecText = editable.textContent || '';
    if (!execSucceeded || afterExecText === beforeText) {
      editable.textContent = `${beforeText}${text}`;
    }
    editable.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: text,
      inputType: 'insertText'
    }));
    editable.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: text,
      inputType: 'insertText'
    }));
    await sleep(180);
  }

  function getReferenceButtonCandidates(editable) {
    const editableRect = editable.getBoundingClientRect();
    const ancestors = [];
    let current = editable;

    for (let i = 0; current && i < 8; i += 1) {
      ancestors.push(current);
      current = current.parentElement;
    }

    const exactCandidates = [];
    const seen = new Set();

    const collectFromRoot = (root, depth) => {
      Array.from(root.querySelectorAll('button.toolbar-button-mCaZcW.lv-btn-icon-only'))
        .filter(isVisibleElement)
        .forEach((button) => {
          if (seen.has(button)) {
            return;
          }

          const text = normalizeText(button.innerText || button.textContent || '');
          const metaText = normalizeText([
            text,
            button.getAttribute('aria-label'),
            button.getAttribute('title')
          ].filter(Boolean).join(' '));
          const rect = button.getBoundingClientRect();

          seen.add(button);
          exactCandidates.push({
            button,
            text,
            metaText,
            className: String(button.className || ''),
            score: 1000 - depth * 20 - Math.abs(rect.top - editableRect.bottom)
          });
        });
    };

    ancestors.forEach((root, depth) => collectFromRoot(root, depth));
    collectFromRoot(document, 20);

    return exactCandidates.sort((left, right) => right.score - left.score);
  }

  async function revealReferenceEntryButton(editable) {
    const toolbarContainer = findJimengToolbarSettingsContainer();
    if (!(toolbarContainer instanceof HTMLElement)) {
      return;
    }

    const scrollTargets = [];
    let current = toolbarContainer;

    for (let i = 0; current && i < 4; i += 1) {
      if (
        current instanceof HTMLElement &&
        current.scrollWidth > current.clientWidth + 24
      ) {
        scrollTargets.push(current);
        break;
      }
      current = current.parentElement;
    }

    if (scrollTargets.length === 0) {
      return;
    }

    scrollTargets.forEach((container) => {
      container.scrollLeft = container.scrollWidth;
    });

    await sleep(220);

    scrollTargets.forEach((container) => {
      container.scrollLeft = container.scrollWidth;
    });

    await sleep(220);
  }

  function findReferencePopup() {
    const popups = Array.from(document.querySelectorAll('.lv-select-popup, .lv-select-popup-inner, [role="listbox"]'))
      .filter(isVisibleElement);

    return popups.find((element) => {
      const text = normalizeText(element.innerText || element.textContent || '');
      const optionCount = element.querySelectorAll('li[role="option"], .lv-select-option').length;
      return (
        /可能的内容|创建主体|图片1|图片2|图片/.test(text) ||
        optionCount > 0
      );
    }) || null;
  }

  async function openReferencePicker(editable) {
    for (let round = 0; round < 4; round += 1) {
      placeCaretAtEnd(editable);
      await revealReferenceEntryButton(editable);
      const candidates = getReferenceButtonCandidates(editable);
      console.log('[即梦][提示词] 引用入口候选:', candidates.slice(0, 6).map((item) => ({
        text: item.text,
        metaText: item.metaText,
        className: item.className,
        score: item.score
      })));

      const candidate = candidates[0];
      if (!candidate) {
        console.warn(`[即梦][提示词] 第 ${round + 1} 轮未找到可见引用按钮`);
        await sleepJimengUiDelay();
        continue;
      }

      console.log('[即梦][提示词] 尝试打开引用弹层:', {
        index: round,
        text: candidate.text,
        metaText: candidate.metaText,
        className: candidate.className,
        score: candidate.score
      });

      await clickElementWithPointerSequence(candidate.button);
      await sleepJimengUiDelay();

      try {
        const popup = await waitForCondition(() => findReferencePopup(), 4000, 120);
        await sleepJimengUiDelay();
        console.log('[即梦][提示词] 引用弹层已打开');
        return popup;
      } catch (error) {
        const visiblePopups = Array.from(document.querySelectorAll('.lv-select-popup, .lv-select-popup-inner, [role="listbox"]'))
          .filter(isVisibleElement)
          .map((element) => normalizeText(element.innerText || element.textContent || ''))
          .filter(Boolean);
        console.warn('[即梦][提示词] 本轮未检测到引用弹层，可见候选弹层:', visiblePopups);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
        await sleep(180);
      }
    }

    throw new Error('未找到参考内容弹层');
  }

  function getEditableReferenceState(editable, targetText = '') {
    const mentions = Array.from(editable.querySelectorAll('.node-reference-mention-tag,[contenteditable="false"]'));
    const normalizedTarget = normalizeText(targetText);
    let targetCount = 0;

    mentions.forEach((mention) => {
      const mentionText = normalizeText(mention.innerText || mention.textContent || '');
      if (normalizedTarget && mentionText.includes(normalizedTarget)) {
        targetCount += 1;
      }
    });

    return {
      mentionCount: mentions.length,
      targetCount
    };
  }

  async function insertReferenceMention(editable, imageIndex) {
    const popup = await openReferencePicker(editable);
    const targetText = `图片${imageIndex + 1}`;
    const rows = Array.from(popup.querySelectorAll('li[role="option"], .lv-select-option'))
      .filter(isVisibleElement);

    console.log('[即梦][提示词] 引用候选项:', rows.map((element) => normalizeText(element.innerText || element.textContent || '')).filter(Boolean));
    const row = rows.find((element) => normalizeText(element.innerText) === targetText);
    if (!row) {
      throw new Error(`未找到参考内容候选: ${targetText}`);
    }

    const beforeState = getEditableReferenceState(editable, targetText);
    await sleepJimengUiDelay();
    await clickElement(row);
    await waitForCondition(() => {
      const nextState = getEditableReferenceState(editable, targetText);
      return nextState.mentionCount > beforeState.mentionCount && nextState.targetCount > beforeState.targetCount;
    }, 1500, 120);
    await sleepJimengUiDelay();
    const afterState = getEditableReferenceState(editable, targetText);
    console.log('[即梦][提示词] 引用插入成功:', {
      targetText,
      mentionCount: afterState.mentionCount,
      targetCount: afterState.targetCount
    });
  }

  async function fillJimengPrompt(promptText, config = {}, imageCount = 0) {
    const editable = findJimengPromptInput();
    if (!editable) {
      throw new Error('未找到即梦提示词输入框');
    }

    editable.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    placeCaretAtEnd(editable);

    editable.innerHTML = '';
    editable.textContent = '';
    editable.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'deleteContentBackward'
    }));
    editable.dispatchEvent(new Event('change', { bubbles: true }));

    if (config.referenceMode === 'all_reference' && imageCount > 0) {
      const segments = parsePromptSegments(promptText);
      const imageSegments = segments.filter(segment => segment.type === 'image');
      console.log('[即梦][提示词] 解析片段:', segments.map((segment) => segment.type === 'image' ? `{${segment.imageIndex}}` : segment.text));

      if (imageSegments.length === 0) {
        console.warn('[即梦][提示词] 当前全能参考任务未检测到任何图片占位符，将只填写纯文本提示词');
      }

      for (const segment of segments) {
        if (segment.type === 'text') {
          console.log('[即梦][提示词] 插入文本片段:', segment.text);
          await insertTextIntoPrompt(editable, segment.text);
          await sleepJimengUiDelay();
        } else if (segment.type === 'image' && Number.isInteger(segment.imageIndex) && segment.imageIndex >= 0 && segment.imageIndex < imageCount) {
          console.log('[即梦][提示词] 插入图片引用:', `图片${segment.imageIndex + 1}`);
          await insertReferenceMention(editable, segment.imageIndex);
          await sleepJimengUiDelay();
        } else if (segment.type === 'image') {
          console.warn('[即梦][提示词] 跳过越界图片占位符:', segment.imageIndex, '可用图片数:', imageCount);
        }
      }

      console.log('[即梦][提示词] 填写完成后内容:', normalizeText(editable.innerText || editable.textContent || ''));
      return;
    }

    await insertTextIntoPrompt(editable, promptText);
    await waitForCondition(() => normalizeText(editable.innerText || editable.textContent).includes(normalizeText(promptText)), 5000, 120);
  }

  function findJimengPromptInput() {
    const candidates = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'))
      .filter(element => isVisibleElement(element) && !element.closest('#ai-video-monitor-modal-root'));

    let best = null;
    let bestScore = -1;

    candidates.forEach((element) => {
      const text = getElementText(element);
      const placeholder = normalizeText([
        element.getAttribute?.('placeholder'),
        element.getAttribute?.('data-placeholder'),
        element.getAttribute?.('aria-label')
      ].filter(Boolean).join(' '));
      let score = 0;

      if (element.matches('[contenteditable="true"]')) {
        score += 40;
      }
      if (placeholder.includes('提示') || placeholder.includes('描述') || placeholder.includes('输入')) {
        score += 30;
      }
      if (text.includes('输入') || text.includes('描述') || text.includes('提示')) {
        score += 10;
      }

      const rect = element.getBoundingClientRect();
      score += Math.max(0, Math.min(20, rect.width / 40));
      score += Math.max(0, Math.min(20, rect.height / 10));

      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    });

    return best;
  }

  async function uploadJimengReferenceImages(images, config) {
    if (config.referenceMode === 'first_last_frames') {
      await uploadJimengFirstLastFrameImages(images);
      return;
    }

    await uploadJimengOmniReferenceImages(images);
  }

  async function uploadJimengOmniReferenceImages(images) {
    const input = findJimengFileInput({
      labelKeywords: ['全能参考', '参考', '上传', '图片']
    });
    if (!input) {
      throw new Error('未找到即梦上传控件');
    }

    const files = await Promise.all(images.map(image => dataUrlToFile(image.dataUrl, image.fileName, image.mimeType)));
    const multiple = input.hasAttribute('multiple');

    if (multiple) {
      const beforeSignal = countJimengUploadSignals();
      setFileInputFiles(input, files);
      await waitForJimengUploadComplete(beforeSignal, files.length);
      return;
    }

    for (const file of files) {
      const beforeSignal = countJimengUploadSignals();
      setFileInputFiles(input, [file]);
      await waitForJimengUploadComplete(beforeSignal, 1);
      await sleep(300);
    }
  }

  async function uploadJimengFirstLastFrameImages(images) {
    const uploadAreas = findJimengFirstLastUploadAreas();
    const orderedImageInputs = findJimengAllImageFileInputs();
    const visibleOrderedInputs = findJimengFileInputs({
      labelKeywords: ['上传', '图片']
    });
    const firstInput = findJimengFileInput({
      labelKeywords: ['首帧', '第一帧', '首图', '上传']
    });
    const lastInput = findJimengFileInput({
      labelKeywords: ['尾帧', '末帧', '最后一帧', '上传'],
      excludeInputs: firstInput ? [firstInput] : []
    });

    let resolvedFirstInput = firstInput;
    let resolvedLastInput = lastInput;
    let resolvedFirstArea = uploadAreas[0] || null;
    let resolvedLastArea = uploadAreas[1] || null;

    if (orderedImageInputs.length >= 2) {
      resolvedFirstInput = orderedImageInputs[0];
      resolvedLastInput = orderedImageInputs[1];
    }

    if (visibleOrderedInputs.length >= 2) {
      resolvedFirstInput = visibleOrderedInputs[0];
      resolvedLastInput = visibleOrderedInputs.find((input) => input !== resolvedFirstInput) || visibleOrderedInputs[1] || null;
    }

    if ((!resolvedFirstInput || !resolvedLastInput) && images.length > 1) {
      const orderedInputs = findJimengFileInputs({
        labelKeywords: ['首帧', '尾帧', '第一帧', '最后一帧', '首图', '末帧', '上传']
      });

      if (!resolvedFirstInput && orderedInputs[0]) {
        resolvedFirstInput = orderedInputs[0];
      }
      if (!resolvedLastInput) {
        resolvedLastInput = orderedInputs.find((input) => input !== resolvedFirstInput) || null;
      }
    }

    console.log('[即梦][首尾帧] 上传控件:', {
      uploadAreaCount: uploadAreas.length,
      orderedInputCount: orderedImageInputs.length,
      visibleOrderedCount: visibleOrderedInputs.length,
      firstFound: Boolean(resolvedFirstInput),
      lastFound: Boolean(resolvedLastInput),
      sameInput: Boolean(resolvedFirstInput && resolvedLastInput && resolvedFirstInput === resolvedLastInput)
    });

    if (!resolvedFirstInput && !resolvedLastInput) {
      throw new Error('首帧/尾帧上传区域未找到');
    }

    if (images[0] && resolvedFirstInput) {
      const firstFile = await dataUrlToFile(images[0].dataUrl, images[0].fileName, images[0].mimeType);
      const beforeSignal = countJimengUploadSignals();
      const firstHost = getJimengUploadHost(resolvedFirstInput, resolvedFirstArea);
      const beforeAreaSignal = firstHost ? getJimengUploadAreaSignal(firstHost) : null;
      if (resolvedFirstArea) {
        console.log('[即梦][首尾帧] 激活首帧上传区域');
        await clickElementWithPointerSequence(resolvedFirstArea);
        await sleepJimengUiDelay();
      }
      setFileInputFiles(resolvedFirstInput, [firstFile]);
      await waitForJimengUploadComplete(beforeSignal, 1, beforeAreaSignal, firstHost, '首帧');
      await sleepJimengUiDelay();
    }

    if (images[1] && resolvedLastInput) {
      const lastFile = await dataUrlToFile(images[1].dataUrl, images[1].fileName, images[1].mimeType);
      const beforeSignal = countJimengUploadSignals();
      const lastHost = getJimengUploadHost(resolvedLastInput, resolvedLastArea);
      const beforeAreaSignal = lastHost ? getJimengUploadAreaSignal(lastHost) : null;
      if (resolvedLastArea) {
        console.log('[即梦][首尾帧] 激活尾帧上传区域');
        await clickElementWithPointerSequence(resolvedLastArea);
        await sleepJimengUiDelay();
      }
      setFileInputFiles(resolvedLastInput, [lastFile]);
      await waitForJimengUploadComplete(beforeSignal, 1, beforeAreaSignal, lastHost, '尾帧');
    }
  }

  function findJimengFirstLastUploadAreas() {
    return Array.from(document.querySelectorAll('div[class*="reference-upload"]'))
      .filter(isVisibleElement)
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        if (Math.abs(leftRect.top - rightRect.top) > 8) {
          return leftRect.top - rightRect.top;
        }
        return leftRect.left - rightRect.left;
      });
  }

  function findJimengAllImageFileInputs() {
    return Array.from(document.querySelectorAll('input[type="file"]'))
      .filter((input) => {
        const accept = String(input.accept || '');
        return accept.includes('image') || accept.includes('.png') || accept.includes('.jpg');
      });
  }

  function findJimengFileInputs({ labelKeywords = [], excludeInputs = [] } = {}) {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const normalizedKeywords = labelKeywords.map(item => normalizeText(item)).filter(Boolean);
    const excluded = new Set(excludeInputs.filter(Boolean));
    const ranked = [];

    inputs.forEach((input) => {
      if (excluded.has(input)) {
        return;
      }

      const accept = String(input.accept || '');
      if (!accept.includes('image') && !accept.includes('.png') && !accept.includes('.jpg')) {
        return;
      }

      let score = 0;
      const contextText = collectContextText(input, 5);

      if (input.hasAttribute('multiple')) {
        score += 10;
      }

      normalizedKeywords.forEach((keyword) => {
        if (contextText.includes(keyword)) {
          score += 25;
        }
      });

      if (contextText.includes('上传') || contextText.includes('参考') || contextText.includes('图片')) {
        score += 10;
      }

      ranked.push({ input, score });
    });

    ranked.sort((left, right) => right.score - left.score);
    return ranked.filter(item => item.score > 0).map(item => item.input);
  }

  function findJimengFileInput(options = {}) {
    return findJimengFileInputs(options)[0] || null;
  }

  async function dataUrlToFile(dataUrl, fileName, mimeType) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return new File([blob], fileName || `image-${Date.now()}.png`, {
      type: mimeType || blob.type || 'image/png'
    });
  }

  function setFileInputFiles(input, files) {
    const dataTransfer = new DataTransfer();
    files.forEach(file => dataTransfer.items.add(file));
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
    if (descriptor?.set) {
      descriptor.set.call(input, dataTransfer.files);
    } else {
      input.files = dataTransfer.files;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function countJimengUploadSignals() {
    const pageText = document.body?.innerText || '';
    const labelMatches = pageText.match(/图片\s*\d+/g) || [];
    const blobImageCount = document.querySelectorAll('img[src^="blob:"]').length;
    const visibleImageCount = Array.from(document.querySelectorAll('img'))
      .filter((element) => isVisibleElement(element) && !element.closest('#ai-video-monitor-modal-root')).length;
    const loadingCount = (pageText.match(/上传中|处理中|loading/gi) || []).length;

    return {
      labelCount: labelMatches.length,
      blobImageCount,
      visibleImageCount,
      auditCount: jimengUploadAuditInterceptCount,
      loadingCount
    };
  }

  function getJimengUploadHost(inputElement, fallbackArea = null) {
    const fromInput = inputElement?.closest('[data-index], [class*="reference-item"], [class*="reference-group"]');
    if (fromInput instanceof Element) {
      return fromInput;
    }

    const fromArea = fallbackArea?.closest('[data-index], [class*="reference-item"], [class*="reference-group"]') || fallbackArea;
    if (fromArea instanceof Element) {
      return fromArea;
    }

    return null;
  }

  function getJimengUploadAreaSignal(areaElement) {
    const host = areaElement?.closest?.('[data-index], [class*="reference-item"], [class*="reference-group"]') || areaElement;
    if (!(host instanceof Element)) {
      return null;
    }

    const text = normalizeText(host.innerText || host.textContent || '');
    return {
      text,
      imageCount: host.querySelectorAll('img').length,
      blobImageCount: host.querySelectorAll('img[src^="blob:"]').length,
      loadingCount: (text.match(/上传中|处理中|loading/gi) || []).length
    };
  }

  async function waitForJimengUploadComplete(beforeSignal, expectedIncrease, beforeAreaSignal = null, areaElement = null, label = '上传') {
    try {
      await waitForCondition(() => {
        const nextSignal = countJimengUploadSignals();
        const labelDelta = nextSignal.labelCount - beforeSignal.labelCount;
        const imageDelta = nextSignal.blobImageCount - beforeSignal.blobImageCount;
        const visibleImageDelta = nextSignal.visibleImageCount - beforeSignal.visibleImageCount;
        const auditDelta = nextSignal.auditCount - beforeSignal.auditCount;
        const nextAreaSignal = areaElement ? getJimengUploadAreaSignal(areaElement) : null;
        const areaChanged = Boolean(
          beforeAreaSignal &&
          nextAreaSignal && (
            nextAreaSignal.imageCount > beforeAreaSignal.imageCount ||
            nextAreaSignal.blobImageCount > beforeAreaSignal.blobImageCount ||
            nextAreaSignal.text !== beforeAreaSignal.text ||
            (beforeAreaSignal.loadingCount > 0 && nextAreaSignal.loadingCount === 0)
          )
        );
        if (areaChanged || auditDelta >= expectedIncrease || visibleImageDelta >= expectedIncrease) {
          console.log(`[即梦][${label}] 上传信号命中:`, {
            labelDelta,
            imageDelta,
            visibleImageDelta,
            auditDelta,
            areaChanged,
            beforeAreaSignal,
            nextAreaSignal
          });
        }
        return (
          labelDelta >= expectedIncrease ||
          imageDelta >= expectedIncrease ||
          visibleImageDelta >= expectedIncrease ||
          auditDelta >= expectedIncrease ||
          areaChanged ||
          (nextSignal.loadingCount === 0 && (labelDelta > 0 || imageDelta > 0 || visibleImageDelta > 0 || auditDelta > 0))
        );
      }, 30000, 250);
    } catch (error) {
      throw new Error('图片上传后未在页面显示');
    }
  }

  async function clickJimengGenerateButton() {
    // 即梦生成按钮是圆形图标按钮（无文本标签），位于输入框下方
    // 特征：.lv-btn-primary.lv-btn-shape-circle 且内容为SVG图标
    const button = document.querySelector('button.lv-btn-primary.lv-btn-shape-circle[class*="submit-button"]');

    if (!button) {
      // 备选方案：通过选择器组合查找
      const allCircleBtns = Array.from(document.querySelectorAll('button.lv-btn-primary.lv-btn-shape-circle'));
      const submitBtn = allCircleBtns.find(btn => {
        // 排除有文本的按钮，只要SVG图标按钮
        const text = btn.textContent?.trim() || '';
        const hasSvg = btn.querySelector('svg');
        return hasSvg && text.length === 0;
      });

      if (!submitBtn) {
        throw new Error('未找到即梦生成按钮（圆形向上箭头）');
      }
    }

    const targetButton = button || document.querySelector('button.lv-btn-primary.lv-btn-shape-circle[class*="submit-button"]');
    if (isElementDisabled(targetButton)) {
      throw new Error('生成按钮当前不可点击（disabled）');
    }

    await clickElementWithPointerSequence(targetButton);
  }

  function injectPageInterceptor(platformName, apis) {
    if (!extensionActive) {
      return;
    }

    const root = document.documentElement;
    if (!root) {
      window.addEventListener('DOMContentLoaded', () => injectPageInterceptor(platformName, apis), { once: true });
      return;
    }

    if (root.hasAttribute(INJECT_FLAG)) {
      if (root.hasAttribute(HOOK_READY_FLAG)) {
        return;
      }

      // The page still has an old inject marker but the bridge hook is gone,
      // which commonly happens after the extension is reloaded.
      root.removeAttribute(INJECT_FLAG);
    }

    root.setAttribute(INJECT_FLAG, 'true');

    const script = document.createElement('script');
    try {
      script.src = chrome.runtime.getURL('page-bridge.js');
    } catch (error) {
      if (!handleExtensionInvalidated(error)) {
        console.error('[监控] 获取桥接脚本地址失败:', error);
      }
      root.removeAttribute(INJECT_FLAG);
      return;
    }
    script.dataset.source = MESSAGE_SOURCE;
    script.dataset.platform = platformName;
    script.dataset.apis = JSON.stringify(apis);
    script.onload = () => script.remove();
    script.onerror = () => {
      console.error('[监控] 页面桥接脚本加载失败');
      root.removeAttribute(INJECT_FLAG);
      script.remove();
    };

    (document.head || root).appendChild(script);
  }

  // --- 弹窗模态框注入逻辑 ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SHOW_ADD_TASK_IFRAME') {
      showTaskModal(message.url);
      sendResponse({ success: true });
    } else if (message.type === 'CLOSE_ADD_TASK_IFRAME') {
      closeTaskModal();
    }
  });

  // 监听来自 iframe 的 postMessage，用于关闭弹窗
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'CLOSE_ADD_TASK_IFRAME') {
      closeTaskModal();
    }
  });

  function showTaskModal(url) {
    if (document.getElementById('ai-video-monitor-modal-root')) {
      return;
    }

    const root = document.createElement('div');
    root.id = 'ai-video-monitor-modal-root';
    root.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(4px);
    `;

    const container = document.createElement('div');
    container.style.cssText = `
      width: 600px;
      height: 700px;
      max-width: 95vw;
      max-height: 95vh;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      position: relative;
      animation: ai-video-pop 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    `;

    // 注入动画样式
    const style = document.createElement('style');
    style.textContent = `
      @keyframes ai-video-pop {
        from { transform: scale(0.95); opacity: 0; }
        to { transform: scale(1); opacity: 1; }
      }
    `;
    document.head.appendChild(style);

    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.cssText = `
      flex: 1;
      border: none;
      width: 100%;
      height: 100%;
    `;

    container.appendChild(iframe);
    root.appendChild(container);

    // 点击遮罩关闭
    root.addEventListener('click', (e) => {
      if (e.target === root) {
        closeTaskModal();
      }
    });

    document.body.appendChild(root);
  }

  function closeTaskModal() {
    const root = document.getElementById('ai-video-monitor-modal-root');
    if (root) {
      root.style.opacity = '0';
      root.style.transition = 'opacity 0.2s';
      setTimeout(() => {
        root.remove();
      }, 200);
    }
  }
})();
