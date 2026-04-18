/**
 * Runway 凭证抓取器 - 页面注入部分（运行在页面 MAIN world）
 *
 * 工作原理：
 *   钩住 window.fetch，每次页面发 api.runwayml.com 请求时：
 *     - 从 Authorization 头抠 JWT
 *     - 从 URL query 的 asTeamId 抠 teamId
 *     - 从 POST body / response body 抠 assetGroupId
 *   抠到完整凭证后通过 postMessage 通知 content script 转发到 background
 *
 * 注意：必须在 document_start 注入，赶在页面自己 import 任何业务代码之前
 */
(() => {
  'use strict';
  if (window.__runwayHarvesterInstalled) return;
  window.__runwayHarvesterInstalled = true;

  const SOURCE = 'runway-harvester';
  const harvested = { jwt: null, teamId: null, assetGroupId: null };
  let lastEmitAt = 0;
  let lastSnapshot = '';

  const emitMaybe = () => {
    const now = Date.now();
    if (now - lastEmitAt < 500) return;          // 节流
    const snapshot = JSON.stringify(harvested);
    if (snapshot === lastSnapshot) return;        // 没新变化不重复发
    lastEmitAt = now;
    lastSnapshot = snapshot;
    window.postMessage({ source: SOURCE, type: 'CREDS', creds: { ...harvested } }, '*');
  };

  const extractAuth = (headersLike) => {
    if (!headersLike) return null;
    if (typeof Headers !== 'undefined' && headersLike instanceof Headers) {
      return headersLike.get('Authorization') || headersLike.get('authorization');
    }
    if (Array.isArray(headersLike)) {
      const found = headersLike.find(([k]) => String(k).toLowerCase() === 'authorization');
      return found ? found[1] : null;
    }
    if (typeof headersLike === 'object') {
      return headersLike.Authorization || headersLike.authorization || null;
    }
    return null;
  };

  const harvestFromBody = (bodyStr) => {
    if (typeof bodyStr !== 'string' || !bodyStr.trim().startsWith('{')) return;
    try {
      const body = JSON.parse(bodyStr);
      const groupId = body?.options?.assetGroupId || body?.assetGroupId;
      if (groupId && !harvested.assetGroupId) harvested.assetGroupId = groupId;
      const teamId = body?.asTeamId;
      const tNum = Number(teamId);
      if (teamId && tNum > 0 && !harvested.teamId) harvested.teamId = tNum;
    } catch {}
  };

  const harvestFromResponse = (responseText) => {
    if (typeof responseText !== 'string' || !responseText.trim().startsWith('{')) return;
    try {
      const body = JSON.parse(responseText);
      // /v1/asset_groups/by_name 等返回的 dataset/asset_group 结构里也带 id
      // 但要谨慎：随便一个 GET /v1/asset_groups/{uuid} 就有 id 字段，会抓到错的
      // 所以只在路径明确是 by_name 的响应里抓
      // （这里不能拿 url，所以这个 helper 只在 by_name 调用现场调用）
      const id = body?.assetGroup?.id || body?.id;
      if (id && !harvested.assetGroupId) harvested.assetGroupId = id;
    } catch {}
  };

  const originalFetch = window.fetch;
  window.fetch = async function(input, init = {}) {
    let url = '';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || '';
    } catch {}

    const isRunwayApi = url.includes('api.runwayml.com');

    if (isRunwayApi) {
      // 1. JWT from Authorization header
      const auth = extractAuth(init.headers || (input && input.headers));
      if (auth && auth.startsWith('Bearer ')) {
        const token = auth.slice(7).trim();
        if (token && token !== harvested.jwt) {
          harvested.jwt = token;
        }
      }

      // 2. teamId from URL query —— 注意 Runway 用 -1 表示"个人无团队"占位符，POST 时会被拒，必须过滤掉
      try {
        const u = new URL(url);
        const t = u.searchParams.get('asTeamId');
        const tNum = Number(t);
        if (t && tNum > 0 && !harvested.teamId) harvested.teamId = tNum;
      } catch {}

      // 3. assetGroupId from request body
      if (init.body) {
        if (typeof init.body === 'string') {
          harvestFromBody(init.body);
        }
      }
    }

    const response = await originalFetch.apply(this, arguments);

    // 4. assetGroupId from response (only for by_name lookup)
    if (isRunwayApi && url.includes('/v1/asset_groups/by_name')) {
      try {
        const cloned = response.clone();
        const text = await cloned.text();
        harvestFromResponse(text);
      } catch {}
    }

    // 5. 寄生模式：捕获 GET /v1/tasks/{uuid} 响应，把状态白嫖给 background
    //    用户开着 Runway 页面时，我们的 SW 完全不用自己发轮询请求
    const taskMatch = isRunwayApi && /\/v1\/tasks\/([0-9a-f-]{36})(?:\?|$)/.exec(url);
    const reqMethod = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (taskMatch && reqMethod === 'GET' && response.ok) {
      try {
        const cloned = response.clone();
        const text = await cloned.text();
        if (text && text.trim().startsWith('{')) {
          const body = JSON.parse(text);
          window.postMessage({
            source: SOURCE,
            type: 'TASK_UPDATE',
            taskId: taskMatch[1],
            body
          }, '*');
        }
      } catch {}
    }

    if (isRunwayApi) emitMaybe();
    return response;
  };

  console.log('[Runway Harvester] 凭证抓取器已就位。在 Runway 上正常浏览/操作即可，凭证会自动保存到扩展。');
})();
