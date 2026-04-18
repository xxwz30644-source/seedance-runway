import { RUNWAY_MODELS, RUNWAY_DEFAULT_TASK_CONFIG } from './config.js';

/**
 * Runway add_task 表单 schema
 * Stage 3 时 add_task.js 会消费这份 schema 动态渲染表单
 *
 * 字段类型约定（与未来即梦表单 schema 共享）：
 *   text         单行文本
 *   textarea     多行文本
 *   select       下拉
 *   number       数字（带 min/max）
 *   toggle       开关
 *   image-list   图片上传槽位（max 控制数量上限）
 *
 * 字段间依赖：
 *   有些字段（duration / resolution / aspectRatio）的可选值随 model 变化
 *   动态规则放在 conditional 字段里，UI 渲染层负责按当前 model 过滤
 */

const modelOptions = RUNWAY_MODELS.map((m) => ({ value: m.id, label: m.label }));

export const runwayFormSchema = [
  {
    key: 'model',
    label: '模型',
    type: 'select',
    options: modelOptions,
    default: RUNWAY_DEFAULT_TASK_CONFIG.model,
    required: true
  },
  {
    key: 'prompt',
    label: '提示词',
    type: 'textarea',
    placeholder: '描述你想要生成的视频内容…',
    default: '',
    required: true,
    maxLength: 2000
  },
  {
    key: 'duration',
    label: '时长（秒）',
    type: 'select',
    options: [
      { value: 5, label: '5 秒' },
      { value: 10, label: '10 秒' },
      { value: 15, label: '15 秒' }
    ],
    default: RUNWAY_DEFAULT_TASK_CONFIG.duration,
    required: true,
    conditional: {
      dependsOn: 'model',
      filter: (modelId, opts) => {
        const m = RUNWAY_MODELS.find((mm) => mm.id === modelId);
        return m ? opts.filter((o) => m.durations.includes(o.value)) : opts;
      }
    }
  },
  {
    key: 'resolution',
    label: '分辨率',
    type: 'select',
    options: [
      { value: '480p', label: '480p（最便宜）' },
      { value: '720p', label: '720p' },
      { value: '1080p', label: '1080p' }
    ],
    default: RUNWAY_DEFAULT_TASK_CONFIG.resolution,
    required: true,
    conditional: {
      dependsOn: 'model',
      filter: (modelId, opts) => {
        const m = RUNWAY_MODELS.find((mm) => mm.id === modelId);
        return m ? opts.filter((o) => m.resolutions.includes(o.value)) : opts;
      }
    }
  },
  {
    key: 'aspectRatio',
    label: '画面比例',
    type: 'select',
    options: [
      { value: '16:9', label: '16:9（横屏）' },
      { value: '9:16', label: '9:16（竖屏）' },
      { value: '1:1', label: '1:1' },
      { value: '4:3', label: '4:3' },
      { value: '3:4', label: '3:4' }
    ],
    default: RUNWAY_DEFAULT_TASK_CONFIG.aspectRatio,
    required: true,
    conditional: {
      dependsOn: 'model',
      filter: (modelId, opts) => {
        const m = RUNWAY_MODELS.find((mm) => mm.id === modelId);
        return m ? opts.filter((o) => m.aspectRatios.includes(o.value)) : opts;
      }
    }
  },
  {
    key: 'generateAudio',
    label: '生成配音',
    type: 'toggle',
    default: RUNWAY_DEFAULT_TASK_CONFIG.generateAudio,
    conditional: {
      dependsOn: 'model',
      visible: (modelId) => {
        const m = RUNWAY_MODELS.find((mm) => mm.id === modelId);
        return m?.supportsAudio === true;
      }
    }
  },
  {
    key: 'exploreMode',
    label: 'Explore Mode（更便宜，可能排队更久）',
    type: 'toggle',
    default: RUNWAY_DEFAULT_TASK_CONFIG.exploreMode,
    conditional: {
      dependsOn: 'model',
      visible: (modelId) => {
        const m = RUNWAY_MODELS.find((mm) => mm.id === modelId);
        return m?.supportsExploreMode === true;
      }
    }
  },
  {
    key: 'referenceImages',
    label: '参考图',
    type: 'image-list',
    max: 15,
    default: [],
    hint: '最多 15 张，每张 ≤ 50MB',
    conditional: {
      dependsOn: 'model',
      visible: (modelId) => {
        const m = RUNWAY_MODELS.find((mm) => mm.id === modelId);
        return m?.supportsReferenceImages === true;
      },
      // max 也随 model 变化
      adjust: (modelId, fieldDef) => {
        const m = RUNWAY_MODELS.find((mm) => mm.id === modelId);
        return m ? { ...fieldDef, max: m.maxReferenceImages } : fieldDef;
      }
    }
  }
];
