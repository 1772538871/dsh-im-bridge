import { PLATFORM_IDS, SECRET_FIELDS } from './config-store.mjs';

// 分组只有两档：basic 是新手一定要看懂的那几项，advanced 收进折叠区。
// 默认 advanced 是刻意的——新字段必须先被明确判成"通用"，否则不该出现在首屏。
function field(key, label, type, extra = {}) {
  return {
    key,
    label,
    type,
    group: extra.group === 'basic' ? 'basic' : 'advanced',
    required: extra.required === true,
    secret: SECRET_FIELDS.indexOf(key) !== -1,
    placeholder: typeof extra.placeholder === 'string' ? extra.placeholder : '',
    help: typeof extra.help === 'string' ? extra.help : '',
    // select 的候选值必须随字段表下发：前端不写死任何字段/选项（契约 §5）
    options: Array.isArray(extra.options) ? extra.options.slice() : []
  };
}

// 与平台无关的字段：settings 页只按这里渲染，前端不写死任何字段表（契约 §5）
// basic 只留"第一次接入必须填的那几项"（平台 / 凭证 / 数据目录 / 日志目录 / 启用），
// 其余一律 advanced：它们收在设置页底部「显示全部字段（排查用）」后面，默认看不见。
const COMMON_FIELDS = [
  field('enabled', '开机自动启动（DSH 一开，机器人也跟着醒来）', 'boolean', { group: 'basic' }),
  field('storage.rootDir', '数据目录（附件/历史/日志/提示词都在这下面）', 'text', {
    group: 'basic',
    required: true,
    placeholder: 'E:\\dsh-im-bridge-data',
    help: '要填绝对路径，子文件夹会自己建好，不用你动手。放 C 盘只会给你一条黄色警告，但盘满了电脑会出毛病。'
  }),
  field('log.dir', '日志目录（留空=数据目录下的 logs）', 'text', {
    group: 'basic',
    placeholder: '留空即可',
    help: '留空就用数据目录下的 logs；只有想把日志单独放一处时才填绝对路径。'
  }),
  field('security.userWhitelist', '谁能用：填你自己的 QQ 号，一行一个（空着不让启动）', 'stringList', {
    group: 'basic',
    help: '只有名单上的人发消息才理。空着不让启动是故意的：底层语义里空名单等于"谁都能使唤你电脑"。'
  }),
  field('testTarget', '测试消息发给谁（留空=自动用白名单里的号）', 'text', {
    placeholder: '1772538871',
    help: '点「发送测试消息」时发到这个号；留空就按平台从白名单里自动挑一个。'
  }),
  field('storage.maxFileBytes', '单个文件最大多少字节（超了不收，默认 100MB）', 'number', { placeholder: '104857600' }),
  field('storage.retentionDays', '附件留几天（过期自动清，日志和你自己的工作目录不动）', 'number', { placeholder: '30' }),
  field('security.groupWhitelist', '哪些群可以用（一行一个群号，空着=不按群管）', 'stringList', {
    help: '填了群号却忘了把自己加进"谁能用"，群里 @ 它也不会理。'
  }),
  field('security.allowPrivate', '让它管私聊', 'boolean', { help: '关掉后私聊它完全没反应。' }),
  field('security.allowGroup', '让它管群聊', 'boolean', { help: '关掉后群里 @ 它也没反应。' }),
  field('security.groupRequireAt', '群里必须 @ 它才理', 'boolean', {
    help: '关掉后群里任何一句话它都可能插手——很吵，也很费钱。'
  }),
  field('security.rateLimitPerMinute', '每人每分钟最多问几次（0=不限）', 'number', { placeholder: '6' }),
  field('security.maxConcurrentRuns', '同时最多几个问题一起想', 'number', {
    placeholder: '2',
    help: 'headless 方式下每个问题约占 300MB 内存，调太大电脑会卡。'
  }),
  field('security.maxPromptChars', '一次最多看多少字（超了截断）', 'number', {
    placeholder: '8000',
    help: '太小会截断长文档，太大会很慢、很贵。'
  }),
  field('reply.ack', '收到后先回一句「开始处理」（长任务不至于像死机）', 'boolean'),
  field('reply.ackMinSeconds', '多久以上的任务才先回一句「收到」（秒，短问答不回执更像人）', 'number', { placeholder: '20' }),
  field('reply.askWhenUnclear', '收到「ok/嗯/收到」这种没指向的消息时，先回一句「？」问清楚', 'boolean'),
  field('reply.progressEveryMs', '处理过程中每隔多久报一次进度（毫秒，0=不报）', 'number', { placeholder: '45000' }),
  field('reply.progressMax', '最多报几次进度', 'number', { placeholder: '2' }),
  field('reply.maxChunkChars', '一条回复最多多少字（超了拆成几条发）', 'number', {
    placeholder: '1500',
    help: '官方 QQ 一条消息最多回 4 次（私聊）/ 5 次（群聊），拆太多后面的会被平台拒掉，所以别设太小。'
  }),
  field('reply.errorPrefix', '出错时的提示前面加什么标签', 'text', { placeholder: '[bridge] ' }),
  field('reply.showSessionId', '回复末尾带上内部编号（排查问题用）', 'boolean'),
  field('reply.sendDelayMs', '发送前停顿（毫秒/每字，模拟打字）', 'number', {
    placeholder: '0',
    help: '比如填 30：回复 100 字就先停 3 秒再发，像在打字。0=立刻发。只有最终回复会等，回执和进度照旧秒回。'
  }),
  field('reply.sendDelayMaxMs', '上面那个停顿最多等多久（毫秒）', 'number', {
    placeholder: '3000',
    help: '长回复不该让你干等半分钟：停顿时长封顶在这里，并在上下 20% 之间随机浮动。'
  }),
  field('reply.maxReplyChars', '单条回复最多多少字（0=不限）', 'number', {
    placeholder: '0',
    help: '超了先截断到上限，末尾添一句"太长截断了，总共 N 字"，然后再按上面的单条字数分段。'
  }),
  field('reply.ackTone', '回执口吻：casual=像群里混的网友，plain=中性', 'select', {
    options: ['casual', 'plain'],
    help:
      '只管「马上看」「别催，正弄着呢」这类回执和进度句：casual 有点小傲娇、偶尔嘴臭但不脏；' +
      'plain 就是中性白话。超时、审批、报错这些提示两种口吻都说得清清楚楚，不会跟着变。'
  }),
  field('journal.everyTurns', '每隔多少轮自动写一次日记（0=只在发 /日记 时写）', 'number', {
    placeholder: '0',
    help: '写日记要多跑一次模型，所以默认关。打开后每 N 轮它自己回顾一次刚才聊的，只写文件，不会给你多发消息。'
  }),
  field('social.mustReplyKeywords', '这些词出现就一定回（一行一个，群聊免 @）', 'stringList', {
    help: '群里没 @ 它，但消息里出现这些词它也会回。命中优先于"群里必须 @"，私聊不受影响。'
  }),
  field('social.replyProbability', '没 @ 也接话的概率（0~1）', 'number', {
    placeholder: '0',
    help: '0=不接；0.2=没 @ 也没命中必答词时，有两成机会插一句。只会在真有人说话时判断，不会自己定时开口。'
  }),
  field('asr.command', '语音转写程序（比如 whisper，留空=只把语音文件路径给它，不转文字）', 'text', { placeholder: 'whisper' }),
  field('asr.args', '传给转写程序的参数（一行一个，{file} 代表语音文件）', 'stringList'),
  field('asr.timeoutMs', '转写最多等多久（毫秒）', 'number', { placeholder: '60000' }),
  field('approval.scope', '审批范围：own=只问机器人自己的操作；all=你在网页里的操作也发到 QQ', 'select', {
    options: ['own', 'all'],
    help: 'own 更安全（机器人自己的活自己问你）；all 会把你手动开的会话也接进来。'
  }),
  field('approval.chatKey', '网页会话的审批发到哪个 QQ 会话（留空=最近说话的那个）', 'text', { placeholder: 'private_<openid>' }),
  field('log.level', '日志记多细', 'select', {
    placeholder: 'info',
    options: ['debug', 'info', 'warn', 'error'],
    help: 'debug 全记（排查时用）、info 正常、warn 只记问题、error 只记错误。'
  }),
  field('dsh.binPath', 'DSH 主程序在哪（一般不用改，安装时会自动找）', 'text', {
    placeholder: 'E:\\Local\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    help: '留空=让它自己找；日志里出现 spawn_error 时才需要手填这里。'
  }),
  field('dsh.profile', '用哪套 DSH 设置（默认 im-bridge，一般不用改）', 'text', {
    required: true,
    placeholder: 'im-bridge'
  }),
  field('dsh.agentPreset', '用哪个人格预设（决定它的说话风格和能用的工具，留空=不挂预设）', 'text', { placeholder: 'liangshen' }),
  field('dsh.cwd', '它干活的文件夹（留空用 <数据目录>/workspace，它只能改这里面的东西）', 'text'),
  field('dsh.releaseOnIdle', '每轮结束后释放会话（关掉时网页里点开这条会话可能读不到历史）', 'boolean'),
  field('dsh.newSessionPerMessage', '调试开关：每条消息都开新会话（上下文不连续，正常别开）', 'boolean'),
  field('dsh.timeoutMs', '一个问题最多等多久（毫秒，超了就放弃）', 'number', { placeholder: '300000' }),
  field('dsh.runner', '干活方式：inprocess=最快且能在 QQ 里审批；sdk=稳；headless=最保守', 'select', {
    options: ['headless', 'sdk', 'inprocess'],
    help:
      'headless 每条消息起一个新进程（约 5.3s，最稳）；sdk 常驻一条子进程（只有第一轮付冷启动，之后约 1.2s）；' +
      'inprocess 直接在 DSH 主进程里干活（最快、能把审批发到 QQ），但吃 DSH 内部接口，升级 DSH 后先切回 sdk 验证'
  }),
  field('approval.enabled', '把审批请求发到 QQ 问你（只有 inprocess 方式）', 'boolean', {
    help: '只有"要临时升权重试"这类操作才会问；普通读写和命令不会弹审批。'
  }),
  field('approval.timeoutMs', '审批最多等你多久（毫秒，最少 10000）', 'number', {
    placeholder: '300000',
    help: '超时按"拒绝"处理——不用"取消"是因为取消会让模型立刻重试同一个操作，变成死循环。'
  }),
  field('questions.enabled', 'Agent 提问时是否发到 QQ（只有 inprocess 方式）', 'boolean', {
    help: 'Agent 需要你拿主意时会弹一张选择题；打开后这张题会发到 QQ，回数字或直接说话都算回答。超时按"跳过"处理，等多久跟上面的审批时长一致。'
  }),
  field('dsh.provider', 'SDK 方式用哪个模型供应商（只有 sdk 用得上）', 'text', {
    placeholder: 'deepseek-official',
    help: 'headless 方式忽略这一项。'
  }),
  field('dsh.model', 'SDK 方式用哪个模型（只有 sdk 用得上）', 'text', {
    placeholder: 'deepseek-flash',
    help: 'headless 方式忽略这一项。'
  }),
  field('dsh.reasoningEffort', 'SDK 方式的思考强度（留空由模型决定）', 'text', {
    placeholder: 'high',
    help: '取值由模型适配器决定，填错会在握手时报错。'
  })
];

const PLATFORM_FIELDS = {
  'qq-napcat': [
    field('qqNapcat.wsUrl', 'NapCat 的门牌号（装好 NapCat 后默认就是这个）', 'text', {
      group: 'basic',
      required: true,
      placeholder: 'ws://127.0.0.1:3001',
      help: '在 NapCat 的「网络配置」里开一个 WebSocket 服务端，端口和这里对上就行。'
    }),
    field('qqNapcat.accessToken', 'NapCat 的口令（NapCat 里没设就留空）', 'password', {
      group: 'basic',
      placeholder: '留空表示不验证'
    }),
    field('qqNapcat.homeDir', 'NapCat 装在哪个目录（一键启动要用）', 'text', {
      group: 'basic',
      placeholder: 'D:\\NapCat',
      help: '填了这里，向导里点「一键启动」就能把本机 NapCat 拉起来，登录二维码直接显示在上面，扫完码再填口令。'
    }),
    field('qqNapcat.port', 'NapCat 的 WebSocket 端口', 'number', {
      placeholder: '3001',
      help: '要和上面地址里的端口一致（默认 3001），一般不用改。'
    }),
    field('qqNapcat.reconnectMinMs', '掉线后多久开始重连（毫秒）', 'number', { placeholder: '1000' }),
    field('qqNapcat.reconnectMaxMs', '重连最长等多久（毫秒，越等越久的上限）', 'number', { placeholder: '30000' })
  ],
  'qq-official': [
    field('qqOfficial.appId', '机器人 AppID（开放平台后台里那串数字）', 'text', {
      group: 'basic',
      placeholder: '机器人 AppID'
    }),
    field('qqOfficial.appSecret', '机器人 AppSecret（后台给的密钥，只存在你这台电脑上）', 'password', {
      group: 'basic',
      help: '网页上永远显示 ***；换了密钥就在这里重填一次。'
    }),
    field('qqOfficial.sandbox', '用沙箱（测试）环境', 'boolean', {
      help: '官方还没给沙箱域名，勾不勾都连正式环境。'
    })
  ],
  wechat: [
    field('wechat.bridgeUrl', '微信桥地址（WeChatFerry 本机桥，默认 19100）', 'text', {
      group: 'basic',
      required: true,
      placeholder: 'http://127.0.0.1:19100',
      help: '扫码登录由微信客户端完成：桥只负责收发，登录还是在微信里点。换端口时改这里和环境变量 WCF_BRIDGE_PORT。'
    }),
    field('wechat.pollMs', '多久问一次桥（毫秒，默认 1000）', 'number', {
      placeholder: '1000',
      help: '越小越快看到消息，也越费 CPU；小于 200 会拒绝保存（按默认 1000 跑）。'
    })
  ]
};

const PLATFORMS = [
  {
    id: 'qq-napcat',
    label: 'QQ 个人账号',
    description: '用小号 QQ 扫码登录（NapCat / SnowLuma 托管），支持私聊与群 @。',
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
    label: '微信个人号',
    description: 'PC 微信 + WeChatFerry 本机桥：扫码登录由微信客户端完成，只接私聊。',
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
    const createWechatAdapter = modules?.wechatAdapter?.createWechatAdapter;
    if (typeof createWechatAdapter !== 'function') {
      return { ok: false, error: '平台适配器尚未就绪' };
    }
    const wechat = coreConfig?.wechat ?? {};
    try {
      // 桥地址与轮询间隔都在这里注入：适配器自己不去读配置，测试也就不用碰磁盘
      const adapter = createWechatAdapter({ baseUrl: wechat.bridgeUrl, pollMs: wechat.pollMs, logger });
      return {
        ok: true,
        adapter: {
          platform,
          client: adapter.client,
          deps: adapter.deps,
          start(onEvent) {
            return adapter.start(onEvent);
          },
          stop() {
            return adapter.stop();
          },
          status() {
            try {
              return adapter.status();
            } catch {
              return null;
            }
          },
          send(args) {
            return adapter.send(args);
          }
        }
      };
    } catch (error) {
      return { ok: false, error: '创建微信适配器失败：' + String(error?.message ?? error) };
    }
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
