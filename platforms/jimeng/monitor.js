import { PlatformMonitor } from '../base.js';

/**
 * 即梦平台监控器
 * 基于实际 API 分析实现
 */
export class JimengMonitor extends PlatformMonitor {
  constructor() {
    super({
      name: '即梦',
      domain: 'jimeng.jianying.com',
      apis: [
        '/mweb/v1/aigc_draft/generate',
        '/mweb/v1/get_history_queue_info',
        '/mweb/v1/get_history_by_ids',
        '/mweb/v1/get_asset_list',
        '/mweb/v1/get_upload_token',
        '/mweb/v1/imagex/submit_audit_job',
        'ApplyImageUpload',
        'CommitImageUpload',
        '/mweb/v1/feed',
        '/mweb/v1/cc_data_sync/get_account_info',
        '/mweb/v1/get_user_info',
        '/commerce/v1/benefits/credit_receive'
      ]
    });

    // 状态码定义（基于实际监控）
    this.TASK_STATUS = {
      INITIAL: 0,        // 初始状态（轮询接口返回）
      QUEUING: 20,       // 排队中（提交接口返回）
      GENERATING: 30,    // 生成中（待验证）
      SUCCESS: 40,       // 完成（待验证）
      FAILED: 50,        // 失败（待验证）
      CANCELLED: -1      // 已取消（网站侧手动取消，待验证具体码值）
    };

    this.QUEUE_STATUS = {
      QUEUING: 1,        // 正在排队
      PROCESSING: 2      // 处理中（推测）
    };
  }

  async detectTaskSubmit(url, method, requestData, responseData) {
    if (!url.includes(this.apis[0])) return null;

    try {
      if (responseData.ret === '0' && responseData.data?.aigc_data) {
        const aigcData = responseData.data.aigc_data;
        return this.parseTaskInfo(aigcData);
      }
    } catch (error) {
      console.error('[即梦] 解析任务提交失败:', error);
    }

    return null;
  }

  async detectTaskUpdate(url, method, requestData, responseData) {
    if (url.includes(this.apis[1])) {
      try {
        if (responseData.ret === '0' && responseData.data) {
          const updates = [];
          for (const [taskId, info] of Object.entries(responseData.data)) {
            updates.push(this.parseTaskInfo(info, taskId));
          }
          return updates.length > 0 ? updates : null;
        }
      } catch (error) {
        console.error('[即梦] 解析任务更新失败:', error);
      }

      return null;
    }

    if (url.includes(this.apis[2])) {
      try {
        if (responseData.ret === '0' && responseData.data) {
          const candidates = this.extractTaskNodes(responseData.data);
          const updates = this.dedupeTasks(
            candidates
              .map((item) => this.parseTaskInfo(item))
              .filter(Boolean)
          );
          return updates.length > 0 ? updates : null;
        }
      } catch (error) {
        console.error('[即梦] 解析历史任务失败:', error);
      }

      return null;
    }

    if (!url.includes(this.apis[3])) return null;

    try {
      if (responseData.ret === '0' && Array.isArray(responseData.data?.asset_list)) {
        const updates = this.dedupeTasks(
          responseData.data.asset_list
            .map((item) => this.parseTaskInfo(item))
            .filter(Boolean)
        );
        return updates.length > 0 ? updates : null;
      }
    } catch (error) {
      console.error('[即梦] 解析资产列表失败:', error);
    }

    return null;
  }

  parseTaskInfo(data, taskId = null) {
    const taskData = data?.video && typeof data.video === 'object'
      ? {
          ...data.video,
          created_time: data.video.created_time ?? data.created_time,
          asset_id: data.id ?? data.video.asset_id
        }
      : data;

    const id = taskId || taskData.history_record_id || taskData.task_id || taskData.history_id || taskData.task?.task_id;
    if (!id) return null;

    const queueInfo = taskData.queue_info || {};
    const forecastTime = taskData.forecast_cost_time || {};
    const taskStatus = taskData.status ?? taskData.task?.status;

    const statusInfo = this.determineStatus(taskStatus, queueInfo.queue_status, taskData.item_list, taskData);

    return {
      platform: this.name,
      taskId: id,
      accountKey: this.extractAccountKey(taskData),
      status: statusInfo.status,
      statusPriority: statusInfo.priority,
      queuePosition: queueInfo.queue_idx,
      queueTotal: queueInfo.queue_length,
      estimatedQueueTime: forecastTime.forecast_queue_cost || taskData.forecast_queue_cost,
      estimatedGenerateTime: forecastTime.forecast_generate_cost || taskData.forecast_generate_cost,
      prompt: this.extractPrompt(taskData),
      videoUrl: this.extractVideoUrl(taskData),
      thumbnailUrl: this.extractThumbnailUrl(taskData),
      submitId: taskData.submit_id || taskData.task?.submit_id,
      createdTime: taskData.created_time,
      finishTime: taskData.finish_time || taskData.task?.finish_time,
      error: this.extractErrorMessage(taskData),
      rawData: taskData
    };
  }

  extractAccountKey(data) {
    return (
      data.uid ||
      data.user_id ||
      data.userId ||
      data.account_id ||
      data.accountId ||
      data.user_info?.uid ||
      data.user_info?.user_id ||
      data.account_info?.uid ||
      data.account_info?.user_id ||
      ''
    );
  }

  determineStatus(taskStatus, queueStatus, itemList, data = {}) {
    const normalizedTaskStatus = Number(taskStatus);
    const normalizedQueueStatus = Number(queueStatus);

    if (this.isCancelled(data)) {
      return { status: 'cancelled', priority: 120 };
    }

    if (this.isFailed(data)) {
      return { status: 'failed', priority: 110 };
    }

    if (this.hasVideoOutput(itemList)) {
      return { status: 'completed', priority: 100 };
    }

    if (normalizedQueueStatus === this.QUEUE_STATUS.PROCESSING) {
      return { status: 'generating', priority: 60 };
    }

    if (normalizedQueueStatus === this.QUEUE_STATUS.QUEUING) {
      return { status: 'queuing', priority: 55 };
    }

    if (normalizedTaskStatus === this.TASK_STATUS.SUCCESS) {
      return { status: 'completed', priority: 45 };
    }

    if (normalizedTaskStatus === this.TASK_STATUS.FAILED) {
      return { status: 'failed', priority: 40 };
    }

    if (normalizedTaskStatus === this.TASK_STATUS.GENERATING) {
      return { status: 'generating', priority: 35 };
    }

    if (normalizedTaskStatus === this.TASK_STATUS.CANCELLED) {
      return { status: 'cancelled', priority: 35 };
    }

    if (normalizedTaskStatus === this.TASK_STATUS.QUEUING ||
        normalizedTaskStatus === this.TASK_STATUS.INITIAL) {
      return { status: 'queuing', priority: 30 };
    }

    return { status: 'unknown', priority: 0 };
  }

  extractPrompt(data) {
    const itemPrompt = data.item_list?.[0]?.common_attr?.prompt;
    if (itemPrompt) return itemPrompt;
    if (data.prompt) return data.prompt;
    if (data.ai_gen_prompt) return data.ai_gen_prompt;
    if (data.task?.ai_gen_prompt) return data.task.ai_gen_prompt;

    const draftContent = data.draft_content;
    if (!draftContent || typeof draftContent !== 'string') {
      return '';
    }

    try {
      const parsed = JSON.parse(draftContent);
      const component = parsed?.component_list?.[0];
      const textParams = component?.abilities?.gen_video?.text_to_video_params;
      const directPrompt = textParams?.video_gen_inputs?.[0]?.prompt;
      if (directPrompt) {
        return directPrompt;
      }

      const metaList = textParams?.video_gen_inputs?.[0]?.unified_edit_input?.meta_list || [];
      const parts = metaList.map((item) => {
        if (item?.meta_type === 'text') {
          return item.text || '';
        }
        if (item?.meta_type === 'image') {
          const idx = item.material_ref?.material_idx;
          return Number.isInteger(idx) ? `[图片${idx + 1}]` : '[图片]';
        }
        return '';
      });
      return parts.join('').trim();
    } catch (error) {
      return '';
    }
  }

  extractVideoUrl(data) {
    const item = data.item_list?.[0];
    const transcoded = item?.video?.transcoded_video || {};
    return (
      transcoded.origin?.video_url ||
      transcoded['720p']?.video_url ||
      transcoded['480p']?.video_url ||
      transcoded['360p']?.video_url ||
      item?.video?.origin_video?.video_url ||
      item?.video?.video_url ||
      item?.video_url ||
      ''
    );
  }

  extractThumbnailUrl(data) {
    const item = data.item_list?.[0];
    return (
      item?.video?.cover_url ||
      item?.video?.poster_url ||
      item?.video?.thumb?.detail_infos?.[0]?.url ||
      item?.common_attr?.cover_url ||
      item?.thumbnail_url ||
      ''
    );
  }

  extractErrorMessage(data) {
    return data.fail_starling_message || data.fail_msg || data.extra_content || '';
  }

  hasVideoOutput(itemList) {
    if (!Array.isArray(itemList) || itemList.length === 0) {
      return false;
    }

    const firstItem = itemList[0];
    return Boolean(
      firstItem?.video?.video_id ||
      firstItem?.video?.transcoded_video?.origin?.video_url ||
      firstItem?.video?.transcoded_video?.['720p']?.video_url ||
      firstItem?.video?.origin_video?.video_url ||
      firstItem?.common_attr?.item_urls?.some(Boolean)
    );
  }

  isCancelled(data) {
    const failMessage = this.extractErrorText(data);
    return (
      failMessage.includes('taskcanceled') ||
      failMessage.includes('取消生成') ||
      failMessage.includes('积分已返还') ||
      failMessage.includes('cancel')
    );
  }

  isFailed(data) {
    const failMessage = this.extractErrorText(data);
    return (
      failMessage.includes('inputvideorisk') ||
      failMessage.includes('不符合平台规则') ||
      failMessage.includes('生成失败') ||
      failMessage.includes('rejectface') ||
      failMessage.includes('审核失败') ||
      failMessage.includes('risk')
    );
  }

  extractErrorText(data) {
    return [
      data.fail_code,
      data.fail_msg,
      data.fail_starling_key,
      data.fail_starling_message,
      data.extra_content
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  dedupeTasks(tasks) {
    const taskMap = new Map();
    tasks.forEach((task) => {
      if (task?.taskId) {
        const key = String(task.taskId);
        const existing = taskMap.get(key);
        if (!existing || this.getTaskRichnessScore(task) >= this.getTaskRichnessScore(existing)) {
          taskMap.set(key, task);
        }
      }
    });
    return Array.from(taskMap.values());
  }

  getTaskRichnessScore(task) {
    const rawData = task?.rawData || {};
    let score = 0;

    if (task?.status && task.status !== 'unknown') score += 10;
    if (task?.prompt) score += 5;
    if (task?.videoUrl) score += 20;
    if (task?.thumbnailUrl) score += 5;
    if (task?.error) score += 20;
    if (rawData?.fail_msg) score += 20;
    if (rawData?.fail_starling_message) score += 20;
    if (Array.isArray(rawData?.item_list) && rawData.item_list.length > 0) score += 15;
    if (rawData?.queue_info) score += 5;
    if (rawData?.task && !rawData?.history_record_id && !rawData?.fail_msg && !rawData?.item_list) score -= 15;

    return score;
  }

  extractTaskNodes(value) {
    const results = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;

      if (
        node.history_record_id ||
        node.task_id ||
        node.history_id ||
        node.task?.task_id
      ) {
        results.push(node);
      }

      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }

      Object.values(node).forEach(walk);
    };

    walk(value);
    return results;
  }

  /**
   * 格式化等待时间
   * @param {number} seconds - 秒数
   * @returns {string} 格式化的时间字符串
   */
  formatTime(seconds) {
    if (!seconds) return '未知';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
      return `${hours}小时${minutes}分钟`;
    }
    return `${minutes}分钟`;
  }
}
