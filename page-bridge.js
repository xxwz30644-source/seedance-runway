(() => {
  'use strict';

  const currentScript = document.currentScript;
  const source = currentScript?.dataset?.source;
  const platform = currentScript?.dataset?.platform;
  const apis = JSON.parse(currentScript?.dataset?.apis || '[]');

  if (!source || !platform || !Array.isArray(apis)) {
    return;
  }

  document.documentElement?.setAttribute('data-ai-video-monitor-hook-ready', 'true');

  if (window.__aiVideoMonitorHookInstalled) {
    return;
  }
  window.__aiVideoMonitorHookInstalled = true;

  const shouldIntercept = (url) =>
    typeof url === 'string' && apis.some((api) => url.includes(api));

  const getRecentJimengSignedParams = () => {
    const entries = performance.getEntriesByType('resource')
      .map((entry) => entry?.name)
      .filter((name) => typeof name === 'string' && name.includes('jimeng.jianying.com'));

    let msToken = '';
    let aBogus = '';

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = new URL(entries[index]);
        msToken = msToken || parsed.searchParams.get('msToken') || '';
        aBogus = aBogus || parsed.searchParams.get('a_bogus') || '';
        if (msToken && aBogus) {
          break;
        }
      } catch (error) {
        // Ignore malformed resource names.
      }
    }

    return { msToken, aBogus };
  };

  const appendRecentSignedParams = (url) => {
    if (typeof url !== 'string' || !url.includes('jimeng.jianying.com')) {
      return url;
    }

    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.searchParams.get('msToken') && parsed.searchParams.get('a_bogus')) {
        return parsed.toString();
      }

      const isGenerateRequest = parsed.pathname.includes('/mweb/v1/aigc_draft/generate');
      const { msToken, aBogus } = getRecentJimengSignedParams();

      if (isGenerateRequest) {
        // Let the page's current request stack derive a fresh a_bogus value.
        // Keeping the stale background-cached value causes duplicated params.
        parsed.searchParams.delete('a_bogus');
      }

      if (msToken && !parsed.searchParams.get('msToken')) {
        parsed.searchParams.set('msToken', msToken);
      }
      if (!isGenerateRequest && aBogus && !parsed.searchParams.get('a_bogus')) {
        parsed.searchParams.set('a_bogus', aBogus);
      }

      return parsed.toString();
    } catch (error) {
      return url;
    }
  };

  const parseBody = (body) => {
    if (!body) {
      return null;
    }

    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch (error) {
        return body;
      }
    }

    if (body instanceof URLSearchParams) {
      return body.toString();
    }

    if (body instanceof FormData) {
      return Array.from(body.entries()).map(([key, value]) => [
        key,
        typeof value === 'string' ? value : (value && value.name) || 'binary'
      ]);
    }

    return null;
  };

  const parseJsonSafely = async (response) => {
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      return response.json();
    }

    const text = await response.text();
    return JSON.parse(text);
  };

  const emit = (payload) => {
    window.postMessage({ source, platform, ...payload }, '*');
  };

  const originalFetch = window.fetch;

  window.addEventListener('message', async (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || data.source !== source || data.type !== 'PAGE_REQUEST') {
      return;
    }

    try {
      // Use the page's current fetch chain so site-level wrappers can append
      // dynamic risk-control headers such as sign/device-time/app metadata.
      const activeFetch = typeof window.fetch === 'function' ? window.fetch : originalFetch;
      const effectiveUrl = appendRecentSignedParams(data.url);
      const response = await activeFetch.call(window, effectiveUrl, data.init || {});
      const clonedResponse = response.clone();
      let responseData = null;

      try {
        responseData = await parseJsonSafely(clonedResponse);
      } catch (error) {
        responseData = await clonedResponse.text();
      }

      window.postMessage({
        source,
        type: 'PAGE_REQUEST_RESULT',
        requestId: data.requestId,
        status: response.status,
        responseData
      }, '*');
    } catch (error) {
      window.postMessage({
        source,
        type: 'PAGE_REQUEST_RESULT',
        requestId: data.requestId,
        error: error.message
      }, '*');
    }
  });
  window.fetch = async (...args) => {
    const response = await originalFetch.apply(window, args);

    try {
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === 'string' ? input : input && input.url;

      if (!shouldIntercept(url)) {
        return response;
      }

      const clonedResponse = response.clone();
      const responseData = await parseJsonSafely(clonedResponse);

      emit({
        url,
        method: (init.method || (input && input.method) || 'GET').toUpperCase(),
        requestData: parseBody(init.body),
        responseData,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('[监控] Fetch 解析失败:', error);
    }

    return response;
  };

  const OriginalXHR = window.XMLHttpRequest;
  function WrappedXHR() {
    const xhr = new OriginalXHR();
    const originalOpen = xhr.open;
    const originalSend = xhr.send;
    let requestUrl = '';
    let requestMethod = 'GET';
    let requestBody = null;

    xhr.open = function(method, url, ...rest) {
      requestMethod = (method || 'GET').toUpperCase();
      requestUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };

    xhr.send = function(body) {
      requestBody = body;

      this.addEventListener('load', function() {
        if (!shouldIntercept(requestUrl)) {
          return;
        }

        try {
          const responseData = JSON.parse(xhr.responseText);
          emit({
            url: requestUrl,
            method: requestMethod,
            requestData: parseBody(requestBody),
            responseData,
            timestamp: Date.now()
          });
        } catch (error) {
          console.error('[监控] XHR 解析失败:', error);
        }
      });

      return originalSend.call(this, body);
    };

    return xhr;
  }

  WrappedXHR.prototype = OriginalXHR.prototype;
  window.XMLHttpRequest = WrappedXHR;
})();
