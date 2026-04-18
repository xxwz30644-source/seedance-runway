import { JimengMonitor } from './jimeng/monitor.js';
import { createRunwayPlatform } from './runway/index.js';
import { Platform } from './base.js';

/**
 * 平台注册表
 * 管理所有平台监控器和 Platform 实例
 *
 * 历史包袱：早期只有 PlatformMonitor，registry 也按 monitor 设计。
 * Stage 0 后引入 Platform 契约。为了不破坏即梦现有路径，registry 做向后兼容：
 *   - 即梦：仍按 monitor 注册（背景脚本通过 monitor 接口消费）
 *   - Runway：按 Platform 注册（背景脚本检测到 platform.submitter 时走新路径）
 *   - getMonitor(url) 仍可用——内部对 Platform 解包返回其 monitor
 */
class PlatformRegistry {
  constructor() {
    this.platforms = new Map();   // domain -> PlatformMonitor | Platform
    this.byId = new Map();        // id -> Platform（仅新版 Platform 实例）
    this.registerDefaults();
  }

  registerDefaults() {
    // 即梦走旧 monitor 路径（Stage 2 才迁移到 Platform）
    const jimengMonitor = new JimengMonitor();
    this.register(jimengMonitor);

    // Runway 走新 Platform 路径
    const runwayPlatform = createRunwayPlatform();
    this.register(runwayPlatform);
  }

  /**
   * @param {PlatformMonitor|Platform} entry
   */
  register(entry) {
    const domain = entry.domain || entry.monitor?.domain;
    if (!domain) {
      console.warn('[注册表] 缺少 domain，跳过:', entry);
      return;
    }
    this.platforms.set(domain, entry);
    if (entry instanceof Platform) {
      this.byId.set(entry.id, entry);
    }
    const label = entry.name || entry.monitor?.name || entry.id || domain;
    console.log(`[注册表] 已注册平台: ${label} (${domain})`);
  }

  /**
   * 根据 URL 获取对应的 monitor（向后兼容）
   * 如果对应平台是新版 Platform，返回其内部 monitor
   * @returns {PlatformMonitor|null}
   */
  getMonitor(url) {
    for (const [domain, entry] of this.platforms) {
      if (!url.includes(domain)) continue;
      if (!entry.enabled) continue;
      return entry instanceof Platform ? entry.monitor : entry;
    }
    return null;
  }

  /**
   * 根据 URL 获取对应的 Platform 实例（如果是新契约）
   * @returns {Platform|null}
   */
  getPlatformByUrl(url) {
    for (const [domain, entry] of this.platforms) {
      if (!url.includes(domain)) continue;
      if (!entry.enabled) continue;
      return entry instanceof Platform ? entry : null;
    }
    return null;
  }

  /**
   * 根据 platformId 获取 Platform 实例
   * @param {string} platformId - 'jimeng' | 'runway'
   * @returns {Platform|null}
   */
  getPlatform(platformId) {
    return this.byId.get(platformId) || null;
  }

  getAllMonitors() {
    return Array.from(this.platforms.values()).map(
      (entry) => (entry instanceof Platform ? entry.monitor : entry)
    );
  }

  getAllPlatforms() {
    return Array.from(this.byId.values());
  }

  enablePlatform(name, enabled) {
    for (const entry of this.platforms.values()) {
      const entryName = entry.name || entry.monitor?.name;
      if (entryName === name) {
        entry.enabled = enabled;
        console.log(`[注册表] ${name} 平台已${enabled ? '启用' : '禁用'}`);
      }
    }
  }

  getPlatformList() {
    return Array.from(this.platforms.values()).map((entry) => ({
      name: entry.name || entry.monitor?.name,
      domain: entry.domain || entry.monitor?.domain,
      enabled: entry.enabled
    }));
  }
}

export const registry = new PlatformRegistry();
