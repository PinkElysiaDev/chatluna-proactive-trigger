import { Context } from 'koishi'
import { ProactiveChatService } from './service'
import { Config } from './config'

export const name = 'chatluna-proactive-trigger'

export const usage = `
为 chatluna 提供群聊活跃度触发与空闲触发的主动发言能力。

快速上手：
- 群聊配置与私聊配置分开维护；将 guildId / userId 设为 "default" 可作为默认模板。
- applyDefaultGroupConfigs / applyDefaultPrivateConfigs 用于指定哪些群或用户应用默认模板。
- enableActivityTrigger 用于群聊活跃度触发；enableIdleTrigger 用于群聊或私聊空闲触发。
- historyMessageLimit 控制历史池容量与单次注入上限；cooldownSeconds 控制触发冷却。
- enableQuoteReplyByMessageId 只控制是否向群聊活跃度历史中注入 message_id，不再自动追加提示词说明。
- verboseLog 会为每条消息输出综合判断日志，排障时开启即可。

关键行为：
- 活跃度触发生效时会为参与消息积累的用户按需补建 chatluna room，触发执行仍使用最后发言者的 room。
- 主动发言后，对话历史自动向本轮参与者的 room 同步。
- 图片会在每轮群级历史池内缓存到本地，文本中使用 [图片:hash] 标记。
- 若要让模型输出 <quote id="message_id"/>，请把规则写进 activityPromptTemplate，并配合 chatluna 的 koishi 元素渲染模式使用。

模板变量：
- {history} {time} {date} {group_name} {user_name} {idle_minutes}

### 0.3.1 版本更新内容:
- 新增触发冷却和最大重试次数功能。
`

export const inject = {
    required: ['chatluna', 'database']
}

export { Config }
export * from './types'

export function apply(ctx: Context, config: Config) {
    ctx.plugin(ProactiveChatService, config)
}
