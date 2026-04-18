/**
 * Runway 平台常量与映射表
 * 所有数值来源：runway-probe-2026-04-18T08-02-09-310Z.json 实测分析
 */

export const RUNWAY_HOST = 'https://api.runwayml.com';

export const RUNWAY_ENDPOINTS = {
  shortJwt: '/v1/short_jwt',
  uploads: '/v1/uploads',
  uploadComplete: (uploadId) => `/v1/uploads/${uploadId}/complete`,
  datasets: '/v1/datasets',
  sessions: '/v1/sessions',
  sessionReferences: (sessionId) => `/v1/sessions/${sessionId}/references`,
  sessionPlay: (sessionId) => `/v1/sessions/${sessionId}/play`,
  tasks: '/v1/tasks',
  task: (taskId) => `/v1/tasks/${taskId}`,
  canStart: '/v1/tasks/can_start',
  generations: '/v1/generations',                  // 旧路径，保留检测但不主动调用
  estimateCost: '/v1/billing/estimate_feature_cost_credits',
  profile: '/v1/profile',
  profileFeatures: '/v1/profile/features'
};

/**
 * 监听用的 API 路径片段（PlatformMonitor.shouldIntercept 用）
 */
export const RUNWAY_OBSERVED_APIS = [
  '/v1/tasks',
  '/v1/generations',
  '/v1/uploads',
  '/v1/datasets',
  '/v1/sessions',
  '/v1/short_jwt'
];

/**
 * 模型注册表
 * value 是 POST /v1/tasks 时 taskType / feature 字段使用的标识
 */
export const RUNWAY_MODELS = [
  {
    id: 'seedance_2',
    label: 'Seedance 2.0',
    taskType: 'seedance_2',
    estimateFeature: 'gen4',          // 估价接口用的特征名（沿用探针实测值）
    canStartFeature: 'gen4.5',
    durations: [5, 10, 15],            // Seedance 底层支持 5-15s
    resolutions: ['480p', '720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    supportsAudio: true,
    supportsExploreMode: true,
    supportsReferenceImages: true,
    maxReferenceImages: 15
  },
  {
    id: 'gen4',
    label: 'Gen-4',
    taskType: 'gen4',
    estimateFeature: 'gen4',
    canStartFeature: 'gen4',
    durations: [5, 10],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    supportsAudio: false,
    supportsExploreMode: true,
    supportsReferenceImages: true,
    maxReferenceImages: 15
  }
];

export const findRunwayModel = (id) => RUNWAY_MODELS.find((m) => m.id === id) || RUNWAY_MODELS[0];

/**
 * 状态映射：Runway 原始 status string → 插件统一 status
 * 实测命中：RUNNING（其余基于 Runway 公开 SDK 文档推断，需 Stage 1 补充实验验证）
 */
export const RUNWAY_STATUS_MAP = {
  PENDING: 'queuing',
  QUEUED: 'queuing',
  THROTTLED: 'queuing',
  RUNNING: 'generating',
  PROCESSING: 'generating',
  SUCCEEDED: 'completed',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'cancelled',
  CANCELLED: 'cancelled',
  THROTTLED_FOR_TOO_LONG: 'failed'
};

export const mapRunwayStatus = (rawStatus) =>
  RUNWAY_STATUS_MAP[String(rawStatus || '').toUpperCase()] || 'unknown';

/**
 * 队列配置——Runway can_start 接口实测 currentLimit=30
 * 我们设保守上限避免触发上限错误
 */
export const RUNWAY_QUEUE = {
  maxConcurrentDefault: 5,    // 团队账号当前并发上限 5
  maxConcurrentCeiling: 30,   // 硬上限保险丝（API 上限）
  pollIntervalMs: 8000,       // 探针实测页面 2.5s/次；批量场景 8s 已足够
  pollIntervalSlowMs: 20000,  // 任务在 queuing 状态时降频
  submitIntervalMinMs: 3000,  // 两次 submit 之间至少间隔（避免审计）
  submitIntervalMaxMs: 8000
};

/**
 * 上传配置（Runway 4 步流程）
 */
export const RUNWAY_UPLOAD = {
  type: 'DATASET',
  numberOfParts: 1,
  // 当前实现只支持单 part 上传，<= 5MB 的图片足够；视频/大图未来再扩展
  maxSingleUploadBytes: 50 * 1024 * 1024
};

/**
 * 默认提交参数（add_task 表单的初始值）
 */
export const RUNWAY_DEFAULT_TASK_CONFIG = {
  model: 'seedance_2',
  duration: 5,
  resolution: '480p',
  aspectRatio: '16:9',
  generateAudio: true,
  exploreMode: true
};
