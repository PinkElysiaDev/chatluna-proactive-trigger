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
- 群聊的所有主动触发（活跃度/保底/空闲）统一锚定到每个群一个专属 proactive room（合成用户 __proactive_trigger__ 所有），不随最后发言者轮转；每次触发后该 room 的 chatluna 对话历史会被清空，群聊上下文依赖 {history} 模板注入。
- 群聊触发不再为用户补建或使用每用户独立 room；私聊触发仍使用用户已加入的 room。
- 图片会在每轮群级历史池内缓存到本地，文本中使用 [图片:hash] 标记；注入给 chatluna 时会将本地缓存图片转换为 data URL，避免本地文件路径被 chatluna 当作 HTTP URL 读取。
- 若要让模型输出 <quote id="message_id"/>，请把规则写进 activityPromptTemplate，并配合 chatluna 的 koishi 元素渲染模式使用。
- guaranteedTriggerMinutes 为群聊活跃度的保底触发间隔：若本轮尚未主动触发过，则从本轮第一条可参与 proactive 统计的消息开始计时；若已经主动触发过，则从上次主动触发开始计时。超过此时间后，即使期间活跃度不足也强制触发一次（适合答疑等低频但需保证响应的场景，设为 0 则不启用）。

模板变量：
- {history} {time} {date} {group_name} {user_name} {idle_minutes}

### 0.3.18 版本更新内容:
- 修复 maxRequestImages=0 时含图消息被整条丢弃的问题：现在图片不缓存、不注入、不打 [图片:hash] 标记，但消息文本照常记录、照常计入活跃度与保底统计；仅"纯图无文本"消息保持跳过。此前图文混合消息会整体消失，纯图片聊天周期的保底与活跃度完全失效。

### 0.3.17 版本更新内容:
- 新增工作时间段配置 workHours（群聊/私聊每条配置独立，小时粒度）：仅允许范围内执行消息记录、判断与主动发言，如 1,3-5,8-19（支持 22-2 跨零点，留空表示全天）。时段外不影响 chatluna 正常回复；时段开始后若已满足空闲/保底条件会立即触发一次。

### 0.3.16 版本更新内容:
- 修复 0.3.15 中主动回复仍无法发送的问题：合成会话的 userId/username/author 影子属性此前定义为可枚举，而 satori 的 MessageEncoder.send 会把会话的可枚举键逐个拷贝到新生成的发送会话上，author 在真实会话上是仅有 getter 的原型访问器，拷贝赋值即抛出 "Cannot set property author ... which has only a getter" 导致发送崩溃。现改为不可枚举，读取语义不变，键集合与真实会话对齐。

### 0.3.15 版本更新内容:
- verboseLog 开启时，调度器跳过/等待分支的日志（in cooldown / responseLocked / guaranteed skipped / guaranteed waiting 等）按"原因变化或 30 秒"去重，修复空闲会话每秒一条的日志刷屏。该日志仍仅在 verboseLog 下输出，生产环境建议保持 verboseLog 关闭。
- 修复主动回复从未真正发送到群的问题：合成会话的 author 此前被置为 undefined，koishi 的 session.username getter 读取 author.nick 时抛出 TypeError，导致每条主动回复在 OneBot 编码发送阶段崩溃；现改为合成 author 对象。
- 修复 room 历史重置与聊天链的队列竞争：慢模型（单次可达 185s）持有 conversation 队列时，after-chat 中同步执行的 clearChatHistory 会等待 180s 超时导致该轮历史未清；现改为 after-chat 仅登记、调度 tick 在会话空闲时异步执行并自动重试（上限 5 次）。

### 0.3.14 版本更新内容:
- 修复 0.3.13 在生产环境（koishi 4.18.x + chatluna 1.3.x）下群聊触发必然失败的问题：主动发言使用的合成会话此前通过属性描述符克隆，会丢失 koishi 4.18 经 cordis mixin 分发的 session 实例方法（stripped/text/send 等），导致 chatluna allow_reply 读取 session.stripped.atSelf 抛出 "Cannot read properties of undefined (reading 'atSelf')"，错误处理又因 session.text 缺失抛出 "session.text is not a function"。现改为以原 session 为原型派生（Object.create + 影子属性），完整保留方法解析路径，并增加克隆保真哨兵日志。

### 0.3.13 版本更新内容:
- 修复长期运行内存持续增长（可达 GB 级）的问题：chatluna 会为每个被 chat 过的 conversationId 创建 ChatInterface 且永不释放（其构造器在 root 上下文注册 dispose 监听并丢弃 disposer，LRU 淘汰不释放）。本插件此前按"最后发言者"轮转用户 room 并向所有参与者 room 同步历史，使泄漏实例数与历史体积无界膨胀。现在群聊触发统一锚定每群一个 proactive room 并在触发后清空其历史，泄漏面从 O(用户数) 降为 O(群数) 且单实例尺寸有界。
- 移除 syncToAllRooms（对话历史同步到参与者 room）与用户 room 补建（prewarm）机制：二者是上述泄漏的主要放大器。
- 移除 after-chat 中对 chathub_room_group_member 的反查，群历史/图片缓存清理直接使用触发时携带的 guildId。
- 会话状态（消息缓存/时间戳/Session 引用）在配置移除后自动淘汰，状态持久化增加最小序列化间隔，after-chat pending 动作增加超时清扫。
- 修复私聊触发可能误清群聊历史池与图片缓存的问题（部分平台私聊会话携带 guildId）。
- 修复群内无任何 chatluna room 时 proactive room 供给必然失败的问题：chatluna 的 getTemplateConversationRoom 从本插件调用会读到本插件配置并抛 ROOM_TEMPLATE_INVALID，现改用本地模板构建（读取 chatluna 主插件默认配置），供给失败时回退 joined-room 路径而非直接抛错。
- proactive room 创建增加进程内互斥，避免并发触发时 roomId 主键冲突；创建失败后重查一次已建 room。
- 图片缓存下载增加 15 秒超时，并与消息中间件解耦：慢图不再阻塞该消息的下游处理（含 chatluna 常规回复），下载完成前触发的极少数情况回退注入原始 URL。
- 停止插件时会唤醒序列化间隔睡眠中的保存循环并等待在途保存完成，避免进程快速退出时丢失最后一段状态。

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
