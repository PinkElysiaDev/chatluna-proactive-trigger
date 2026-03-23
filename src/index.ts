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

### 0.3.0 版本更新内容:
- 新增消息 id 传递功能，允许用户跳过提示词要求模型引用特定消息回复（需要与 chatluna 主插件 “用 koishi 消息元素渲染”配置项配合使用）
- 新增补建 chatluna room 能力，解决活跃度对话参与用户缺失 chatluna room 而无法正常触发对话的 bug。
- 修改主动触发的对话在 room 间同步的逻辑，只为参与当前活跃度触发的用户同步主动触发消息记录。
- 修复 bot 被用户手动触发后，活跃度对话消息池不重置的 bug，避免 bot 主动发言时对已回应问题重复作答。
- 修复图片文件持久化策略，每一轮活跃度对话消息池会自我维护一个图片文件池。
`

export const inject = {
    required: ['chatluna', 'database']
}

export { Config }
export * from './types'

export function apply(ctx: Context, config: Config) {
    ctx.plugin(ProactiveChatService, config)
}
