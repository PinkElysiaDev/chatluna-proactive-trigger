import { Context } from 'koishi'
import { ProactiveChatService } from './service'
import { Config } from './config'

export const name = 'chatluna-proactive-trigger'

export const usage = `
关键参数解析及配置方法：

1) 应用范围
- applyGroup / applyPrivateUsers：只在列出的群或私聊生效；留空即该类型不触发。

2) 活跃度触发
- activityThreshold.lowerLimit / upperLimit：
  - lower = upper：固定灵敏度；
  - lower < upper：越聊越不容易触发（更克制）；
  - lower > upper：越聊越容易触发（更积极）。

3) 消息计数兜底
- messageInterval > 0：达到消息条数即触发一次，用于避免“活跃分高但一直不触发”。

4) 空闲触发
- enableIdleTrigger + idleTrigger.intervalMinutes：无人说话达到时长后触发。
- idleTrigger.enableJitter：开启随机抖动，降低可预测性。

5) 频率与上下文
- cooldownSeconds：两次触发最小间隔，优先用于控频。
- includeChatHistory + maxHistoryMessages：控制注入上下文的开关与条数。
- historyBufferSize：每个会话缓存上限（影响可注入历史池大小）。
- syncToAllRooms：将主动发言同步到同群其他用户 room 历史（每用户独立 room 时建议开启）。
- verboseLog：排障时开启，可输出完整请求快照。

0.1.3 & 0.1.4 版本更新内容：
- 修复图片文件上传方式，确保图片可以正确发送给大模型 。
- 移除了错误的依赖项，以保证兼容性。
`

export const inject = {
    required: ['chatluna', 'database']
}

export { Config }
export * from './types'

export function apply(ctx: Context, config: Config) {
    ctx.plugin(ProactiveChatService, config)
}
