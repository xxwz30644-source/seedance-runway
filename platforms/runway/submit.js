import {
  RUNWAY_ENDPOINTS,
  RUNWAY_UPLOAD,
  RUNWAY_QUEUE,
  findRunwayModel,
  mapRunwayStatus
} from './config.js';
import {
  callRunway,
  putToPresignedUrl,
  getContext,
  setContext
} from './transport.js';

/**
 * Runway 提交器
 * 完全 headless：所有动作通过 background 直接调 REST，不打开 Runway 页面、不点按钮、不填表单
 *
 * 完整流程（参考 runway-probe 实测的 6 步链）：
 *   1. 对每张参考图 uploadAsset(blob, filename) → { assetId, url }
 *   2. submitTask({ taskType, options:{ referenceImages, ... } }) → { taskId }
 *   3. 调用方负责轮询（pollTask）
 *
 * 注意：原先看到的 /v1/sessions/{sid}/references 和 /v1/sessions/{sid}/play 属于
 * Runway "Story mode 聊天会话" 的工作流，与这里的 tool-mode 提交无关，跳过。
 */

/**
 * 客户端预生成的 task UUID
 * Runway 服务端会用这个 ID 创建任务，我们提交完不用等响应也能开始轮询
 */
function generateTaskUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 兜底：基于 timestamp+random 拼出 UUID v4 形态字符串
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * 上传一张图片到 Runway，拿到 { assetId, url } 用于后续提交
 *
 * 4 子步（按探针实测顺序）：
 *   a) POST /v1/uploads — 申请预签名 S3 URL
 *   b) PUT  <S3 URL>    — 上传二进制
 *   c) POST /v1/uploads/{id}/complete — 确认上传（带 ETag）
 *   d) POST /v1/datasets — 注册 dataset，返回最终 assetId
 */
export async function uploadAsset(blob, filename, opts = {}) {
  if (!(blob instanceof Blob)) {
    throw new Error('uploadAsset 需要 Blob');
  }
  if (blob.size > RUNWAY_UPLOAD.maxSingleUploadBytes) {
    throw new Error(
      `图片过大 (${blob.size} bytes)，超过单 part 上传上限 ${RUNWAY_UPLOAD.maxSingleUploadBytes}`
    );
  }

  const ctx = await getContext();
  const teamId = opts.teamId || ctx.teamId;

  // 内部 helper：申请上传槽 → PUT → complete，返回 uploadId
  // Runway 每张图需要走 2 次（一份 main + 一份 preview，dataset 注册要求两个 ID 都已 complete）
  const uploadOneSlot = async (slotFilename) => {
    const slotResp = await callRunway('POST', RUNWAY_ENDPOINTS.uploads, {
      filename: slotFilename,
      numberOfParts: 1,
      type: RUNWAY_UPLOAD.type
    });
    if (!slotResp?.uploadUrls?.[0]) {
      throw new Error(`uploads 接口未返回 uploadUrls: ${JSON.stringify(slotResp)}`);
    }
    const putHeaders = slotResp.uploadHeaders || {};
    const { etag } = await putToPresignedUrl(slotResp.uploadUrls[0], blob, putHeaders);
    await callRunway('POST', RUNWAY_ENDPOINTS.uploadComplete(slotResp.id), {
      parts: [{ PartNumber: 1, ETag: etag || '' }]
    });
    return slotResp.id;
  };

  // a) main slot
  const uploadId = await uploadOneSlot(filename);
  // b) preview slot（暂时复用同一张图，不生成缩略图——Runway 接受，仅没有专门的预览图）
  const previewUploadId = await uploadOneSlot(`preview_${filename}`);

  // c) 注册成 dataset，返回最终 assetId
  const datasetReq = {
    fileCount: 1,
    name: filename,
    uploadId,
    previewUploadIds: [previewUploadId],
    metadata: opts.metadata || {},
    type: { name: 'image', type: 'image', isDirectory: false }
  };
  // 只在 teamId 是正数时才带 —— Runway 的 -1 占位符 POST 时会被拒
  if (teamId && Number(teamId) > 0) datasetReq.asTeamId = Number(teamId);

  const datasetResp = await callRunway('POST', RUNWAY_ENDPOINTS.datasets, datasetReq);
  const dataset = datasetResp?.dataset;
  if (!dataset?.id || !dataset?.url) {
    throw new Error(`datasets 接口未返回完整 dataset: ${JSON.stringify(datasetResp)}`);
  }

  return {
    assetId: dataset.id,
    url: dataset.url,
    previewUrl: dataset.previewUrls?.[0] || null
  };
}

/**
 * 检查队列容量
 * @returns {Promise<{ canStart: boolean, currentLimit: number, currentInProgressTasks: number }>}
 */
export async function canStart(opts = {}) {
  const ctx = await getContext();
  const teamId = opts.teamId || ctx.teamId;
  const model = findRunwayModel(opts.modelId);
  const query = {
    mode: 'credits',
    feature: model.canStartFeature
  };
  if (teamId && Number(teamId) > 0) query.asTeamId = Number(teamId);

  const resp = await callRunway('GET', RUNWAY_ENDPOINTS.canStart, null, { query });
  // 探针实测响应嵌套了一层 canStartNewTask
  const inner = resp?.canStartNewTask || resp || {};
  return {
    canStart: inner.canStartNewTask === true,
    currentLimit: inner.currentLimit ?? null,
    currentInProgressTasks: inner.currentInProgressTasks ?? null
  };
}

/**
 * 估算消耗
 * @returns {Promise<{ cost: number, unit: string, quantityUnit: string }|null>}
 */
export async function estimateCost(taskOptions, opts = {}) {
  const ctx = await getContext();
  const teamId = opts.teamId || ctx.teamId;
  const model = findRunwayModel(taskOptions.model);

  const body = {
    feature: model.estimateFeature,
    count: taskOptions.count || 1,
    taskOptions: { seconds: taskOptions.duration }
  };
  if (teamId && Number(teamId) > 0) body.asTeamId = Number(teamId);

  return callRunway('POST', RUNWAY_ENDPOINTS.estimateCost, body);
}

/**
 * 提交一个生成任务
 *
 * @param {object} task - 通用任务对象
 * @param {string} task.prompt - 文本提示
 * @param {string} task.model - 模型 id（默认 seedance_2）
 * @param {number} task.duration - 秒数 (5/10)
 * @param {string} task.resolution - 分辨率 ('480p'|'720p'|'1080p')
 * @param {string} task.aspectRatio - 比例
 * @param {boolean} [task.generateAudio=true]
 * @param {boolean} [task.exploreMode=true]
 * @param {Array<{blob, filename}>} [task.referenceImages] - 待上传的参考图
 * @param {Array<{assetId, url}>} [task.referenceAssets] - 已上传的资产（跳过上传）
 * @param {object} [opts] - { teamId, assetGroupId }
 *
 * @returns {Promise<{taskId, queueInfo, rawResponse}>}
 */
export async function submitTask(task, opts = {}) {
  const ctx = await getContext();
  const teamId = opts.teamId || ctx.teamId;
  const assetGroupId = opts.assetGroupId || ctx.assetGroupId;

  const model = findRunwayModel(task.model);

  // 上传待提交的参考图（如果有）
  let referenceImages = Array.isArray(task.referenceAssets) ? [...task.referenceAssets] : [];
  if (Array.isArray(task.referenceImages) && task.referenceImages.length > 0) {
    if (referenceImages.length + task.referenceImages.length > model.maxReferenceImages) {
      throw new Error(
        `参考图数量超出模型上限 ${model.maxReferenceImages}（当前 ${referenceImages.length + task.referenceImages.length}）`
      );
    }
    for (const item of task.referenceImages) {
      const uploaded = await uploadAsset(item.blob, item.filename, { teamId });
      referenceImages.push({ assetId: uploaded.assetId, url: uploaded.url });
    }
  }

  // 客户端预生成 taskId（Runway 服务端会用这个 ID 创建任务）
  const taskId = task.taskId || generateTaskUuid();

  const options = {
    name: task.name || `${model.label} - ${(task.prompt || '').slice(0, 30)}`,
    textPrompt: task.prompt || '',
    duration: task.duration ?? model.durations[0],
    aspectRatio: task.aspectRatio || model.aspectRatios[0],
    resolution: task.resolution || model.resolutions[0],
    generateAudio: task.generateAudio !== false && model.supportsAudio,
    exploreMode: task.exploreMode !== false && model.supportsExploreMode,
    referenceImages,
    creationSource: 'tool-mode',
    taskId
  };
  if (assetGroupId) options.assetGroupId = assetGroupId;

  const body = { taskType: model.taskType, options };
  if (teamId && Number(teamId) > 0) body.asTeamId = Number(teamId);

  const resp = await callRunway('POST', RUNWAY_ENDPOINTS.tasks, body);
  const taskNode = resp?.task || resp;

  return {
    taskId: taskNode?.id || taskId,
    rawStatus: taskNode?.status || 'PENDING',
    status: mapRunwayStatus(taskNode?.status),
    estimatedTimeToStartSeconds: taskNode?.estimatedTimeToStartSeconds ?? null,
    rawResponse: resp
  };
}

/**
 * 把 Runway 原始 task 响应解析成统一更新对象。
 * 抽出来是给「寄生模式」用：harvester 拦到 Runway 页面发的 GET /v1/tasks/{id}
 * 响应后，把 raw body 直接喂给 background，免得 background 自己再发请求。
 */
export function parseRunwayTaskResponse(resp) {
  const taskNode = resp?.task || resp;
  if (!taskNode?.id) return null;
  const progressRatio = taskNode.progressRatio != null ? Number(taskNode.progressRatio) : null;
  const artifacts = Array.isArray(taskNode.artifacts) ? taskNode.artifacts : [];

  // Runway 失败时各种错误字段都可能出现，全部归一化到 error 对象里：
  //   error / failure / failureReason / errorReason / errorMessage / failureCode / errorCode
  // 让 formatRunwayError 决定怎么拼显示文案
  let error = null;
  if (taskNode.error || taskNode.failure || taskNode.failureReason || taskNode.errorReason ||
      taskNode.failureCode || taskNode.errorCode || taskNode.errorMessage) {
    error = {
      reason: taskNode.failureReason || taskNode.errorReason || taskNode.failure || null,
      code: taskNode.failureCode || taskNode.errorCode || null,
      message: taskNode.errorMessage || (typeof taskNode.error === 'string' ? taskNode.error : null),
      // 把原 error 对象也带上（如果是对象），formatRunwayError 兜底会用
      raw: taskNode.error && typeof taskNode.error === 'object' ? taskNode.error : null
    };
  }

  return {
    taskId: taskNode.id,
    status: mapRunwayStatus(taskNode.status),
    rawStatus: taskNode.status,
    progress: progressRatio != null && !Number.isNaN(progressRatio)
      ? Math.round(progressRatio * 100)
      : null,
    estimatedTimeToStartSeconds: taskNode.estimatedTimeToStartSeconds ?? null,
    videoUrl: artifacts[0]?.url || null,
    thumbnailUrl: artifacts[0]?.previewUrls?.[0] || null,
    error,
    rawData: taskNode
  };
}

/**
 * 单次轮询
 */
export async function pollTask(taskId, opts = {}) {
  const resp = await callRunway('GET', RUNWAY_ENDPOINTS.task(taskId), null, opts);
  const update = parseRunwayTaskResponse(resp);
  if (!update) {
    throw new Error(`pollTask 响应缺少 task.id: ${JSON.stringify(resp).slice(0, 200)}`);
  }
  return update;
}

/**
 * 阻塞式等待任务完成
 * @param {string} taskId
 * @param {object} [opts] - { onProgress, intervalMs, timeoutMs }
 */
export async function waitForCompletion(taskId, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const timeoutMs = opts.timeoutMs || 30 * 60 * 1000;   // 30 分钟硬上限
  const startedAt = Date.now();

  while (true) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Runway 任务 ${taskId} 等待超时（${timeoutMs}ms）`);
    }

    const update = await pollTask(taskId);
    onProgress(update);

    if (update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled') {
      return update;
    }

    const intervalMs = update.status === 'queuing'
      ? RUNWAY_QUEUE.pollIntervalSlowMs
      : (opts.intervalMs || RUNWAY_QUEUE.pollIntervalMs);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * 一次性入口：上传图、提交、等完成
 * batch-manager 调用的便捷接口
 */
export async function submitAndWait(task, opts = {}) {
  const submission = await submitTask(task, opts);
  if (opts.waitForCompletion === false) {
    return submission;
  }
  const completion = await waitForCompletion(submission.taskId, opts);
  return { ...submission, ...completion };
}

/**
 * 给 Platform 契约用的统一对象
 */
export const runwaySubmitter = {
  submit: (task, opts) => submitTask(task, opts),
  poll: (taskId, opts) => pollTask(taskId, opts),
  canStart: (opts) => canStart(opts),
  estimateCost: (taskOptions, opts) => estimateCost(taskOptions, opts),
  uploadAsset: (blob, filename, opts) => uploadAsset(blob, filename, opts),
  waitForCompletion: (taskId, opts) => waitForCompletion(taskId, opts),
  submitAndWait: (task, opts) => submitAndWait(task, opts),
  // 上下文管理（Stage 1 验收时由 popup/调试入口调用）
  setContext: (ctx) => setContext(ctx),
  getContext: () => getContext()
};
