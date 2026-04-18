import { PlatformMonitor } from '../base.js';
import {
  RUNWAY_OBSERVED_APIS,
  RUNWAY_ENDPOINTS,
  mapRunwayStatus
} from './config.js';

/**
 * Runway 平台监听器
 * 基于 runway-probe 实测数据重写（替代原 runway.js 的猜测版本）
 *
 * 关键差异 vs 原版：
 *   - 域名：api.runwayml.com（不是页面域 runwayml.com）
 *   - 路径前缀：/v1/（不是 /api/v1/）
 *   - 提交端点：POST /v1/tasks 是新版（带 taskType），POST /v1/generations 是旧 UI 路径
 *   - 轮询端点：GET /v1/tasks/{uuid}
 *   - 状态字段：task.status（字符串），task.progressRatio（也是字符串！）
 */
export class RunwayMonitor extends PlatformMonitor {
  constructor() {
    // 注意：domain 用 'runwayml.com' 而非 'api.runwayml.com'，
    // 这样 registry.getMonitor(pageUrl) 也能命中页面 URL（app.runwayml.com）
    // 而不仅仅是 API URL（api.runwayml.com）
    super({
      name: 'Runway',
      domain: 'runwayml.com',
      apis: RUNWAY_OBSERVED_APIS
    });
  }

  /**
   * 提交检测：响应里包含 task.id 或 顶层 id 即视为新任务
   * 同时覆盖 /v1/tasks（新接口）和 /v1/generations（旧接口）
   */
  async detectTaskSubmit(url, method, requestData, responseData) {
    if (method?.toUpperCase() !== 'POST') return null;

    const isNewTaskEndpoint = this.matchesPath(url, RUNWAY_ENDPOINTS.tasks);
    const isLegacyEndpoint = this.matchesPath(url, RUNWAY_ENDPOINTS.generations);
    if (!isNewTaskEndpoint && !isLegacyEndpoint) return null;

    try {
      const taskNode = responseData?.task || responseData;
      if (!taskNode?.id) return null;
      return this.parseTaskInfo(taskNode);
    } catch (error) {
      console.error('[Runway] 解析提交响应失败:', error);
      return null;
    }
  }

  /**
   * 状态更新：GET /v1/tasks/{uuid} 的响应
   * Runway 没有批量任务列表接口，每次只更新单个任务
   */
  async detectTaskUpdate(url, method, requestData, responseData) {
    if (method?.toUpperCase() !== 'GET') return null;
    if (!url.includes('/v1/tasks/')) return null;
    if (url.includes('/can_start')) return null;
    if (url.includes('/feedback_options')) return null;

    try {
      const taskNode = responseData?.task || responseData;
      if (!taskNode?.id || !taskNode?.status) return null;
      return this.parseTaskInfo(taskNode);
    } catch (error) {
      console.error('[Runway] 解析任务更新失败:', error);
      return null;
    }
  }

  parseTaskInfo(node, taskId = null) {
    const id = taskId || node.id;
    if (!id) return null;

    const status = mapRunwayStatus(node.status);
    const progressRatio = node.progressRatio != null ? Number(node.progressRatio) : null;
    const artifacts = Array.isArray(node.artifacts) ? node.artifacts : [];
    const firstArtifact = artifacts[0] || null;

    return {
      platform: 'Runway',
      platformId: 'runway',
      taskId: id,
      status,
      rawStatus: node.status,
      progress: progressRatio != null && !Number.isNaN(progressRatio)
        ? Math.round(progressRatio * 100)
        : null,
      progressText: node.progressText || null,
      estimatedTimeToStartSeconds: node.estimatedTimeToStartSeconds ?? null,
      prompt: node.options?.textPrompt || node.options?.prompt || node.name || '',
      videoUrl: firstArtifact?.url || null,
      thumbnailUrl: firstArtifact?.previewUrls?.[0] || firstArtifact?.thumbnailUrl || null,
      taskType: node.taskType || node.options?.taskType || null,
      createdAt: node.createdAt || null,
      updatedAt: node.updatedAt || null,
      error: this.extractErrorMessage(node),
      rawData: node
    };
  }

  extractErrorMessage(node) {
    if (!node) return null;
    if (typeof node.error === 'string') return node.error;
    if (node.error && typeof node.error === 'object') {
      return node.error.message || JSON.stringify(node.error);
    }
    if (node.failureReason) return node.failureReason;
    return null;
  }

  matchesPath(url, path) {
    try {
      const parsed = new URL(url, 'https://api.runwayml.com');
      // 精确匹配路径或者末尾命中（避免把 /v1/tasks/{uuid} 误判为 /v1/tasks）
      return parsed.pathname === path;
    } catch {
      return url.endsWith(path);
    }
  }
}
