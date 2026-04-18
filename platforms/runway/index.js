import { Platform } from '../base.js';
import { RunwayMonitor } from './monitor.js';
import { runwaySubmitter } from './submit.js';
import { runwayFormSchema } from './form-schema.js';
import { RUNWAY_QUEUE, RUNWAY_DEFAULT_TASK_CONFIG, RUNWAY_MODELS } from './config.js';

export { RunwayMonitor } from './monitor.js';
export {
  setJwt as setRunwayJwt,
  getJwt as getRunwayJwt,
  setContext as setRunwayContext,
  getContext as getRunwayContext,
  setFingerprint as setRunwayFingerprint,
  getFingerprint as getRunwayFingerprint,
  jitter,
  randSleep
} from './transport.js';
export { runwaySubmitter, parseRunwayTaskResponse } from './submit.js';
export { runwayFormSchema } from './form-schema.js';

/**
 * 组装一个完整的 Runway Platform 实例
 * 供 platforms/registry.js 调用
 */
export function createRunwayPlatform() {
  const monitor = new RunwayMonitor();

  return new Platform({
    id: 'runway',
    name: 'Runway',
    domain: monitor.domain,
    monitor,
    submitter: runwaySubmitter,
    domActions: null,                // Runway 不需要 DOM 自动化
    formSchema: runwayFormSchema,
    platformConfig: {
      queue: RUNWAY_QUEUE,
      defaultTaskConfig: RUNWAY_DEFAULT_TASK_CONFIG,
      models: RUNWAY_MODELS
    }
  });
}
