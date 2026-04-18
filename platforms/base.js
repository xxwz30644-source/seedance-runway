/**
 * 平台监控基类
 * 所有平台监控器都需要继承此类并实现抽象方法
 */
export class PlatformMonitor {
  constructor(config) {
    this.name = config.name;
    this.domain = config.domain;
    this.apis = config.apis;
    this.enabled = config.enabled !== false;
  }

  /**
   * 检测任务提交
   * @param {string} url - 请求 URL
   * @param {string} method - 请求方法
   * @param {object} requestData - 请求数据
   * @param {object} responseData - 响应数据
   * @returns {object|null} 任务信息或 null
   */
  async detectTaskSubmit(url, method, requestData, responseData) {
    throw new Error('Must implement detectTaskSubmit');
  }

  /**
   * 检测任务更新
   * @param {string} url - 请求 URL
   * @param {string} method - 请求方法
   * @param {object} requestData - 请求数据
   * @param {object} responseData - 响应数据
   * @returns {object|object[]|null} 任务信息或任务数组或 null
   */
  async detectTaskUpdate(url, method, requestData, responseData) {
    throw new Error('Must implement detectTaskUpdate');
  }

  /**
   * 解析任务信息为标准格式
   * @param {object} data - 原始数据
   * @param {string} taskId - 任务 ID（可选）
   * @returns {object} 标准化的任务信息
   */
  parseTaskInfo(data, taskId = null) {
    throw new Error('Must implement parseTaskInfo');
  }

  /**
   * 判断是否应该拦截此 URL
   * @param {string} url - 请求 URL
   * @returns {boolean}
   */
  shouldIntercept(url) {
    return this.apis.some(api => url.includes(api));
  }

  /**
   * 通知任务完成
   * @param {object} taskInfo - 任务信息
   */
  notifyComplete(taskInfo) {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        type: 'TASK_COMPLETED',
        task: taskInfo
      });
    }
  }
}

/**
 * 平台契约（Stage 0 引入，供 Stage 1 之后的代码消费）
 *
 * 一个 Platform 实例 = 一个平台所有可被 core 调用的能力。
 * 实现路径：每个平台一个 platforms/{id}/index.js，组装 monitor + submit + form-schema 后导出。
 *
 * 与 PlatformMonitor 的区别：
 *   PlatformMonitor 只负责"被动观察页面流量并解析任务"——这是即梦模式（DOM 自动化为主、监听为辅）
 *   Platform 在此基础上增加"主动提交、轮询、表单 schema"——是 Runway 模式（headless REST 为主）
 *
 * 旧的 PlatformMonitor 仍然可用（即梦还没迁移）。新平台直接实现 Platform。
 */
export class Platform {
  constructor(config) {
    if (!config?.id) throw new Error('Platform 需要 id');
    if (!config?.name) throw new Error('Platform 需要 name');
    if (!config?.monitor) throw new Error('Platform 需要 monitor 实例');

    this.id = config.id;                     // 'jimeng' | 'runway'
    this.name = config.name;                 // 显示名 '即梦' | 'Runway'
    this.domain = config.domain || config.monitor.domain;
    this.monitor = config.monitor;           // PlatformMonitor 实例（向后兼容入口）
    this.submitter = config.submitter || null;     // 可选：headless 提交器
    this.domActions = config.domActions || null;   // 可选：DOM 自动化（即梦专属）
    this.formSchema = config.formSchema || null;   // 可选：UI 表单字段定义
    this.platformConfig = config.platformConfig || {};  // 平台常量（队列上限、轮询节奏等）
    this.enabled = config.enabled !== false;
  }

  /**
   * 提交一个任务，返回 { taskId, queueInfo? }
   * core/batch-manager 调用，不关心是 DOM 自动化还是 REST
   */
  async submit(task) {
    if (this.submitter?.submit) return this.submitter.submit(task);
    if (this.domActions?.submit) return this.domActions.submit(task);
    throw new Error(`Platform ${this.id} 未实现 submit`);
  }

  /**
   * 主动轮询单个任务状态
   * 返回标准化的 TaskUpdate
   */
  async poll(taskId, context = {}) {
    if (this.submitter?.poll) return this.submitter.poll(taskId, context);
    throw new Error(`Platform ${this.id} 未实现 poll`);
  }

  /**
   * 查询当前账号是否还能起新任务（可选实现）
   * 返回 { canStart: boolean, currentLimit?: number, currentInProgressTasks?: number }
   */
  async canStart(context = {}) {
    if (this.submitter?.canStart) return this.submitter.canStart(context);
    return { canStart: true };  // 不支持的平台默认放行
  }

  /**
   * 估算任务消耗（可选实现）
   * 返回 { cost: number, unit: string }
   */
  async estimateCost(taskOptions, context = {}) {
    if (this.submitter?.estimateCost) return this.submitter.estimateCost(taskOptions, context);
    return null;
  }

  /**
   * 获取该平台的 add_task 表单 schema
   * 返回 [{key, label, type, options?, default?, required?}, ...]
   */
  getFormSchema() {
    return this.formSchema || [];
  }

  /**
   * 校验任务配置是否合法（可选实现）
   */
  validateTaskConfig(config) {
    return { valid: true };
  }

  /**
   * 委托给内部 monitor 的 detectTaskSubmit
   */
  detectTaskSubmit(url, method, requestData, responseData) {
    return this.monitor.detectTaskSubmit(url, method, requestData, responseData);
  }

  /**
   * 委托给内部 monitor 的 detectTaskUpdate
   */
  detectTaskUpdate(url, method, requestData, responseData) {
    return this.monitor.detectTaskUpdate(url, method, requestData, responseData);
  }

  /**
   * 委托给内部 monitor 的 shouldIntercept
   */
  shouldIntercept(url) {
    return this.monitor.shouldIntercept(url);
  }
}
