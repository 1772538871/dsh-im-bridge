import { PLATFORM_IDS, SECRET_FIELDS } from './config-store.mjs';

function field(key, label, type, extra = {}) {
  return {
    key,
    label,
    type,
    required: extra.required === true,
    secret: SECRET_FIELDS.indexOf(key) !== -1,
    placeholder: typeof extra.placeholder === 'string' ? extra.placeholder : '',
    help: typeof extra.help === 'string' ? extra.help : '',
    // select 的候选值必须随字段表下发：前端不写死任何字段/选项（契约 §5）
    options: Array.isArray(extra.options) ? extra.options.slice() : []
  };
}

// 与平台无关的字段：settings 页只按这里渲染，前端不写死任何字段表（契约 §5）
const COMMON_FIELDS = [
  field('enabled', '启用（DSH 启动时自动拉起 bot）', 'boolean'),
  field('storage.rootDir', '数据目录', 'text', { required: true, placeholder: 'E:\\dsh-im-bridge-data', help: '绝对路径；不要放 C 盘' }),
  field('storage.maxFileBytes', '单个文件上限（字节）', 'number', { placeholder: '104857600' }),
  field('storage.retentionDays', '附件保留天数', 'number', { placeholder: '30' }),
  field('security.userWhitelist', '用户白名单（一行一个 QQ 号，留空=拒绝启动）', 'stringList'),
  field('security.groupWhitelist', '群白名单（一行一个群号，留空=不按群管）', 'stringList'),
  field('security.allowPrivate', '允许私聊', 'boolean'),
  field('security.allowGroup', '允许群聊', 'boolean'),
  field('security.groupRequireAt', '群聊必须 @ 机器人', 'boolean'),
  field('security.rateLimitPerMinute', '每人每分钟消息上限', 'number', { placeholder: '6' }),
  field('security.maxConcurrentRuns', '同时处理的最大消息数', 'number', { placeholder: '2' }),
  field('security.maxPromptChars', '单条 prompt 字符上限', 'number', { placeholder: '8000' }),
  field('reply.maxChunkChars', '单条回复最大字符数', 'number', { placeholder: '1500' }),
  field('reply.errorPrefix', '错误回复前缀', 'text', { placeholder: '[bridge] ' }),
  field('reply.showSessionId', '回复里附带会话 id', 'boolean'),
  field('asr.command', '语音转写命令（可留空）', 'text', { placeholder: 'whisper' }),
  field('asr.args', '语音转写参数', 'stringList'),
  field('asr.timeoutMs', '语音转写超时（毫秒）', 'number', { placeholder: '60000' }),
  field('log.level', '日志级别', 'select', { placeholder: 'info', options: ['debug', 'info', 'warn', 'error'], help: '可选：debug / info / warn / error' }),
  field('dsh.binPath', 'DSH 入口路径（留空自动探测）', 'text', { placeholder: 'E:\\Local\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js' }),
  field('dsh.profile', 'DSH profile 名', 'text', { required: true, placeholder: 'im-bridge' }),
  field('dsh.agentPreset', 'Agent 预设（留空 = 不挂预设；web 默认 liangshen）', 'text', { placeholder: 'liangshen' }),
  field('dsh.cwd', 'DSH 工作目录（留空用 <数据目录>/workspace）', 'text'),
  field('dsh.timeoutMs', '单次 DSH 调用超时（毫秒）', 'number', { placeholder: '300000' }),
  field(
    'dsh.runner',
    'DSH 调用方式（headless=每条消息起新进程，稳；sdk=常驻进程，快；inprocess=进程内，支持 IM 审批）',
    'select',
    {
      options: ['headless', 'sdk', 'inprocess'],
      help:
        'headless 每条消息约 5.3s；sdk 常驻一条子进程，只有第一轮付冷启动，之后每轮约 1.2s；' +
        'inprocess 直接用 DSH 主进程建 Agent（最快、可把审批转发到 IM），但依赖 DSH 内部服务名，升级 DSH 时先切回 sdk 验证'
    }
  ),
  field('approval.enabled', '把审批请求转发到 IM（仅 inprocess 方式）', 'boolean', {
    help: '只有"沙箱升权重试"这类操作才会触发审批；普通读写和命令不会弹审批'
  }),
  field('approval.timeoutMs', '审批等待超时（毫秒，最少 10000）', 'number', {
    placeholder: '300000',
    help: '超时按"拒绝"处理（不是取消：取消会让模型立刻重试同一个操作）'
  }),
  field('dsh.provider', 'SDK 方式的模型供应商', 'text', { placeholder: 'deepseek-official', help: '仅 sdk 方式生效，headless 忽略' }),
  field('dsh.model', 'SDK 方式的模型名', 'text', { placeholder: 'deepseek-flash', help: '仅 sdk 方式生效，headless 忽略' }),
  field('dsh.reasoningEffort', 'SDK 方式的推理强度（留空由模型决定）', 'text', {
    placeholder: 'high',
    help: '仅 sdk 方式生效；取值由模型适配器决定，填错会在握手里报错'
  })
];

const PLATFORM_FIELDS = {
  'qq-napcat': [
    field('qqNapcat.wsUrl', 'NapCat / OneBot WebSocket 地址', 'text', { required: true, placeholder: 'ws://127.0.0.1:3001' }),
    field('qqNapcat.accessToken', 'accessToken', 'password', { placeholder: '留空表示不鉴权' }),
    field('qqNapcat.reconnectMinMs', '重连最小间隔（毫秒）', 'number', { placeholder: '1000' }),
    field('qqNapcat.reconnectMaxMs', '重连最大间隔（毫秒）', 'number', { placeholder: '30000' })
  ],
  'qq-official': [
    field('qqOfficial.appId', 'AppID', 'text', { placeholder: '机器人 AppID' }),
    field('qqOfficial.appSecret', 'AppSecret', 'password', { help: '只存在本机配置里，接口返回时掩码为 ***' }),
    field('qqOfficial.sandbox', '使用沙箱环境', 'boolean')
  ],
  wechat: []
};

const PLATFORMS = [
  {
    id: 'qq-napcat',
    label: 'QQ（NapCat / OneBot 11）',
    description: '本机 NapCat 反向 WebSocket 接入，支持私聊与群 @。',
    fields: PLATFORM_FIELDS['qq-napcat'].concat(COMMON_FIELDS)
  },
  {
    id: 'qq-official',
    label: 'QQ 官方机器人',
    description: 'QQ 开放平台 WebSocket 网关，需要 AppID / AppSecret。',
    fields: PLATFORM_FIELDS['qq-official'].concat(COMMON_FIELDS)
  },
  {
    id: 'wechat',
    label: '微信（未实现）',
    description: '尚未实现：选择它保存配置可以，但启动会明确返回"未实现"。',
    fields: PLATFORM_FIELDS.wechat.concat(COMMON_FIELDS)
  }
];

export function listPlatforms() {
  return PLATFORMS.map((platform) => ({
    id: platform.id,
    label: platform.label,
    description: platform.description,
    fields: platform.fields.map((item) => ({ ...item }))
  }));
}

export function platformById(id) {
  return PLATFORMS.find((platform) => platform.id === id) || null;
}

/**
 * 适配器装配：宿主半边只负责"平台 -> 内核 deps"，pipeline 一行不改（契约 §4）。
 * 返回 {ok:false, error} 而不是抛，调用方（runtime）据此给出人话错误。
 */
export function createPlatformAdapter({ platform, coreConfig, logger = null, modules = {} } = {}) {
  if (PLATFORM_IDS.indexOf(platform) === -1) {
    return { ok: false, error: '未知平台：' + String(platform) };
  }

  if (platform === 'wechat') {
    return { ok: false, error: '平台 wechat 未实现' };
  }

  if (platform === 'qq-napcat') {
    const createOneBotClient = modules?.onebotClient?.createOneBotClient;
    if (typeof createOneBotClient !== 'function') {
      return { ok: false, error: '平台适配器尚未就绪' };
    }
    const napcat = coreConfig?.onebot ?? {};
    // client 先建、handler 后挂：pipeline 要等适配器起来才能拿到，回调里用闭包转发
    let forward = null;
    let client;
    try {
      client = createOneBotClient({
        url: napcat.wsUrl,
        accessToken: napcat.accessToken ?? '',
        logger,
        onEvent: (raw) => {
          if (typeof forward !== 'function') return;
          try {
            const ret = forward(raw);
            if (ret && typeof ret.catch === 'function') ret.catch(() => {});
          } catch {
            // 单条事件失败不能打断 WebSocket 收包
          }
        },
        onStatus: (status) => {
          try {
            logger?.info?.('OneBot 连接状态', status);
          } catch {
            // 日志失败不影响连接
          }
        },
        reconnectMinMs: napcat.reconnectMinMs,
        reconnectMaxMs: napcat.reconnectMaxMs
      });
    } catch (error) {
      return { ok: false, error: '创建 OneBot 客户端失败：' + String(error?.message ?? error) };
    }
    return {
      ok: true,
      adapter: {
        platform,
        client,
        deps: null,
        start(onEvent) {
          forward = onEvent;
          client.start();
        },
        async stop() {
          forward = null;
          await client.stop();
        },
        status() {
          try {
            return client.status();
          } catch {
            return null;
          }
        }
      }
    };
  }

  const createQqBotAdapter = modules?.qqbotAdapter?.createQqBotAdapter;
  if (typeof createQqBotAdapter !== 'function') {
    // src/qqbot/ 不完整时（缺文件或导出），这里明确报"未就绪"而不是让 apply 崩
    return { ok: false, error: '平台适配器尚未就绪' };
  }
  // 缺 AppID/AppSecret 时 start 只会安静地一直连不上，这里提前把问题说清楚
  const problems = typeof modules?.qqbotAdapter?.qqBotProblems === 'function' ? modules.qqbotAdapter.qqBotProblems(coreConfig) : [];
  if (problems.length > 0) {
    return { ok: false, error: 'QQ 官方机器人配置不完整：' + problems.join('；') };
  }
  try {
    const adapter = createQqBotAdapter({ config: coreConfig, logger });
    return { ok: true, adapter: { platform, ...adapter } };
  } catch (error) {
    return { ok: false, error: '创建 QQ 官方机器人适配器失败：' + String(error?.message ?? error) };
  }
}
