import { Context } from 'koishi'
import { ProactiveChatService } from './service'
import { Config } from './config'

export const name = 'chatluna-proactive-trigger'

export const usage = `
关键参数解析及配置方法：

1) 基础配置
- applyDefaultGroupConfigs：应用默认配置的群号列表，列表中的群组将使用默认群聊配置模板。
- applyDefaultPrivateConfigs：应用默认配置的私聊用户列表，列表中的用户将使用默认私聊配置模板。
- syncToAllRooms：主动发言后，将对话记录同步写入该群所有用户的对话历史（仅在每用户独立 room 模式下有效）。
- verboseLog：详细日志模式，排障时开启可输出完整请求快照。

2) 群聊配置（数组列表）
- guildId：群号（必填，填写 "default" 作为默认群聊配置模板）。
- enableActivityTrigger：开启/关闭活跃触发。
  - activityLowerLimit / activityUpperLimit：
    - lower = upper：固定灵敏度；
    - lower < upper：越聊越不容易触发（更克制）；
    - lower > upper：越聊越容易触发（更积极）。
  - activityMessageInterval > 0：消息计数兜底触发间隔。
  - activityPromptTemplate：活跃触发提示词模板。
- enableIdleTrigger：开启/关闭空闲触发。
  - idleIntervalMinutes：无人说话达到时长后触发。
  - idleEnableJitter：开启随机抖动，降低可预测性。
  - idlePromptTemplate：空闲触发提示词模板。
- historyMessageLimit：历史消息条数上限（同时作为缓存上限与注入最大条数）。
- cooldownSeconds：触发后冷却时间（秒）。

3) 私聊配置（数组列表）
- userId：私聊用户 ID（必填，填写 "default" 作为默认私聊配置模板）。
- enableIdleTrigger：开启/关闭空闲触发。
  - idleIntervalMinutes：无人说话达到时长后触发。
  - idleEnableJitter：开启随机抖动，降低可预测性。
  - idlePromptTemplate：空闲触发提示词模板。
- historyMessageLimit：历史消息条数上限。
- cooldownSeconds：触发后冷却时间（秒）。

4) 模板变量
- {history}：自上次 bot 主动发言以来的历史消息（含图片上传）。
- {time}：当前时间。
- {date}：当前年月日星期。
- {group_name}：当前群聊名称（私聊为空）。
- {user_name}：当前会话用户昵称。
- {idle_minutes}：空闲分钟数（空闲触发时有效）。
- {trigger_reason}：内部触发原因文本。

5) 配置技巧
- 基础配置放在最前面，便于统一管理同步与日志行为。
- 群聊和私聊分别使用独立的大标题配置区，每个可配置多个条目。
- 使用 "default" 标识符设置默认配置模板：将 guildId 或 userId 设置为 "default"，该配置将作为默认配置模板。
- 使用 applyDefaultGroupConfigs/applyDefaultPrivateConfigs 指定哪些群组/用户应用默认配置模板。
- 配置优先级：精确匹配（特定群号/用户 ID）> 应用默认配置列表 + default 配置模板。
- 每用户独立 room 场景下，建议开启 syncToAllRooms 减少上下文割裂。

0.2.1 版本更新说明
- 新增 applyDefaultGroupConfigs 和 applyDefaultPrivateConfigs 应用默认配置列表
- 支持使用 "default" 作为 guildId/userId 来设置默认配置模板
- 配置优先级：精确匹配 > 应用默认配置列表 + default 配置模板
`

export const inject = {
    required: ['chatluna', 'database']
}

export { Config }
export * from './types'

export function apply(ctx: Context, config: Config) {
    ctx.plugin(ProactiveChatService, config)
}
