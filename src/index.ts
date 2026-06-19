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
- verboseLog 会为每条消息输出综合判断日志，排障时开启即可。仅对已开启主动发言（活跃度触发或空闲触发）的会话输出，未配置或未开启主动发言的群聊/私聊静默处理，避免无关会话刷日志造成阻塞。
- 日志分级：默认（debugLog 与 verboseLog 均关闭）完全不输出任何消息判断日志；开启 debugLog 时仅在主动触发成功后输出触发原因；开启 verboseLog 时输出每条消息的综合判断日志与完整触发请求内容。即默认日志模式下只在成功触发时输出一条判断日志。

关键行为：
- 活跃度触发生效时会为参与消息积累的用户按需补建 chatluna room，触发执行仍使用最后发言者的 room。
- 主动发言后，对话历史自动向本轮参与者的 room 同步。
- 图片会在每轮群级历史池内缓存到本地，文本中使用 [图片:hash] 标记；注入给 chatluna 时会将本地缓存图片转换为 data URL，避免本地文件路径被 chatluna 当作 HTTP URL 读取。
- 若要让模型输出 <quote id="message_id"/>，请把规则写进 activityPromptTemplate，并配合 chatluna 的 koishi 元素渲染模式使用。
- guaranteedTriggerMinutes 为群聊活跃度的保底触发间隔：若本轮尚未主动触发过，则从本轮第一条可参与 proactive 统计的消息开始计时；若已经主动触发过，则从上次主动触发开始计时。超过此时间后，即使期间活跃度不足也强制触发一次（适合答疑等低频但需保证响应的场景，设为 0 则不启用）。

模板变量：
- {history} {time} {date} {group_name} {user_name} {idle_minutes}

### 0.3.10 版本更新内容:
- 修复日志刷屏导致设备阻塞的严重性能问题：默认日志模式下完全不输出消息判断日志，仅在成功触发时输出一条触发原因（debugLog）；未配置或未开启主动发言的群聊/私聊静默处理（verboseLog）。

### 请注意：本插件暂不兼容 chatluna 1.4.x版本
`

export const inject = {
    required: ['chatluna', 'database']
}

export { Config }
export * from './types'

export function apply(ctx: Context, config: Config) {
    ctx.plugin(ProactiveChatService, config)
}
