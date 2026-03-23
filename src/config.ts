import { Schema } from 'koishi'

export interface GroupTriggerConfig {
    guildId: string

    enableActivityTrigger: boolean
    activityLowerLimit?: number
    activityUpperLimit?: number
    activityMessageInterval?: number
    activityPromptTemplate?: string

    enableIdleTrigger: boolean
    idleIntervalMinutes?: number
    idleEnableJitter?: boolean
    idlePromptTemplate?: string

    historyMessageLimit: number
    maxRequestImages: number
    enableQuoteReplyByMessageId: boolean
    cooldownSeconds: number
}

export interface PrivateTriggerConfig {
    userId: string

    enableIdleTrigger: boolean
    idleIntervalMinutes?: number
    idleEnableJitter?: boolean
    idlePromptTemplate?: string

    historyMessageLimit: number
    maxRequestImages: number
    cooldownSeconds: number
}

export type TriggerProfileConfig = GroupTriggerConfig | PrivateTriggerConfig

export interface Config {
    // 应用默认配置的群组/私聊列表
    applyDefaultGroupConfigs: string[]
    applyDefaultPrivateConfigs: string[]

    // 按会话独立配置
    groupConfigs: GroupTriggerConfig[]
    privateConfigs: PrivateTriggerConfig[]

    // room 同步
    syncToAllRooms: boolean

    // 调试
    debugLog: boolean
    verboseLog: boolean
}

const defaultActivityPrompt = [
    '你现在需要参与到活跃的群聊讨论中。',
    '当前时间：{date} {time}',
    '群聊名称：{group_name}',
    '',
    '以下是自上次你发言以来的群内消息：',
    '{history}',
    '',
    '十分重要！请注意：这些消息并非都在对你说话；优先回应明确提及或者讨论你的内容，否则以自然、简短、不突兀的方式选择一个你感兴趣的角度切入话题或适度评论。',
    '',
    '在生成最终回复时综合以下因素：',
    '    1.分析历史消息内容: 分析历史消息的讨论话题、每句话有无明确的说话对象（对谁说的）、发言人的情绪/语气/目的 (提问/陈述/闲聊?) 。',
    '    2.整合自身知识: 回顾角色设定 (性格/知识/图库/行为) 。',
    '    3.确定发言策略:根据你自己的兴趣点分析是否有必要参与讨论，若你认为群内讨论并不是很有趣则只生成空回复（格式为<message></message>），否则根据你的兴趣点初步制定回应策略 (尊敬/警惕/友好/调戏等)。',
    '',
    '输出严格遵循以下规则:',
    '    你将生成一个 \'<output>\' 标签包裹的回复.\'<output>\' 标签内必须包含一个或多个 \'<message>\' 标签,每个 \'<message>\' 代表一条独立发送的消息.',
    '    严格遵循**以下定义的格式,所有回复内容都必须放入对应的标签内.**禁止**输出不存在的嵌套.',
    '',
    '    Send nothing: <message></message>',
    '    Text with At function: <message><at id="user_id"> msg</message>',
    '    Text with Quote function: <message><quote id="message_id"/> msg</message>',
    '    Text message: <message>msg</message>',
    '',
    '    注意事项: @和 msg 之间要用空格隔开.',
    '     \'<output>\' 标签格式示例:',
    '',
    '    <output>',
    '    <message>嗯？</message>',
    '    <message>怎么了</message>',
    '    </output>',
    '',
    '    消息引用：你可以选择引用（Quote）感兴趣的历史消息来回应特定话题，若你想回应多个话题，请将每一个回应放在单独的“<message><quote id="message_id"/> msg</message>”标签内',
    '    @功能: 当你需要@用户时,请从 "上下文" 或 "用户消息" 中获取准确的 "user_id".一次 \'<output>\' 中同一用户只能@一次.',
    '',
    '',
    '    你的最终输出**必须严格**遵循一个固定的标签序列.输出内容**必须**包含 \'<think>\' 和 \'<output>\' 并以 \'<think>\' 标签开始,到 \'<output>\' 标签结束.',
    '    **严禁**在 \'<think>...</think>\' 中内出现 \'<output>\' 或 \'<message>\' 等任何用于最终输出的标签.',
    '    **绝对遵循**以下规则和顺序,不要添加任何额外的根标签,也不要转义 XML 特殊字符.'
].join('\n')

const defaultIdlePrompt = [
    '你现在需要进行一次“空闲触发”的主动发言。',
    '当前时间：{date} {time}',
    '群聊名称：{group_name}',
    '已空闲分钟数：{idle_minutes}',
    '',
    '以下是自上次你发言以来的群内消息（可能包含图片）：',
    '{history}',
    '',
    '请你主动发起一个自然的话题，语气友好、简洁，不要显得机械。'
].join('\n')

const commonSessionSchema = () => Schema.object({
    historyMessageLimit: Schema.number()
        .min(5).max(1000).default(20)
        .description('历史消息条数上限：同时作为每个会话缓存上限与 {history} 最大注入条数'),
    maxRequestImages: Schema.number()
        .min(0).max(20).default(3)
        .description('请求中的最大图片数量：限制单次主动发言请求中附带的图片总数'),
    cooldownSeconds: Schema.number().min(0).max(3600)
        .default(30)
        .description('触发后冷却时间（秒）'),
})

const activitySchema = () => Schema.intersect([
    Schema.object({
        enableActivityTrigger: Schema.boolean()
            .default(false)
            .description('启用活跃度触发'),
    }),
    Schema.union([
        Schema.object({
            enableActivityTrigger: Schema.const(true).required(),
            activityLowerLimit: Schema.number().min(0).max(1).step(0.05)
                .default(0.85)
                .description('初始触发灵敏度'),
            activityUpperLimit: Schema.number().min(0).max(1).step(0.05)
                .default(0.85)
                .description('灵敏度趋向值'),
            activityMessageInterval: Schema.number().min(0).max(100)
                .default(20)
                .description('消息计数触发间隔'),
            enableQuoteReplyByMessageId: Schema.boolean()
                .default(false)
                .description('是否向历史消息中注入 message_id'),
            activityPromptTemplate: Schema.string()
                .role('textarea', { rows: [8, 20] })
                .description('活跃触发提示词模板。可用变量：{history} {time} {date} {group_name} {idle_minutes}')
                .default(defaultActivityPrompt),
        }),
        Schema.object({}),
    ]),
])

const idleSchema = () => Schema.intersect([
    Schema.object({
        enableIdleTrigger: Schema.boolean()
            .default(false)
            .description('启用空闲触发'),
    }),
    Schema.union([
        Schema.object({
            enableIdleTrigger: Schema.const(true).required(),
            idleIntervalMinutes: Schema.number().min(1).max(60 * 24 * 7)
                .default(180)
                .description('空闲触发间隔（分钟）'),
            idleEnableJitter: Schema.boolean()
                .default(true)
                .description('启用随机抖动'),
            idlePromptTemplate: Schema.string()
                .role('textarea', { rows: [8, 20] })
                .description('空闲触发提示词模板。可用变量：{history} {time} {date} {group_name} {user_name} {idle_minutes}')
                .default(defaultIdlePrompt),
        }),
        Schema.object({}),
    ]),
])

export const Config = Schema.intersect([
    // 基础配置
    Schema.object({
        applyDefaultGroupConfigs: Schema.array(Schema.string())
            .default([])
            .role('table')
            .description('应用默认配置的群号列表：列表中的群组将使用默认群聊配置模板'),
        applyDefaultPrivateConfigs: Schema.array(Schema.string())
            .default([])
            .role('table')
            .description('应用默认配置的私聊用户列表：列表中的用户将使用默认私聊配置模板'),
        syncToAllRooms: Schema.boolean()
            .default(true)
            .description('主动发言后，将对话记录同步写入该群所有用户的对话历史（仅在每用户独立 room 模式下有效）'),
        debugLog: Schema.boolean()
            .default(false)
            .description('普通日志模式：输出每次触发的触发原因'),
        verboseLog: Schema.boolean()
            .default(false)
            .description('详细日志模式：打印完整的触发请求内容'),
    }).description('基础配置'),

    // 群聊配置
    Schema.object({
        groupConfigs: Schema.array(Schema.intersect([
            Schema.object({
                guildId: Schema.string()
                    .required()
                    .description('群号（填写 "default" 作为默认群聊配置模板）'),
            }),
            activitySchema(),
            idleSchema(),
            commonSessionSchema(),
        ])).role('list')
            .default([])
            .description('添加群聊配置'),
    }).description('群聊配置'),

    // 私聊配置
    Schema.object({
        privateConfigs: Schema.array(Schema.intersect([
            Schema.object({
                userId: Schema.string()
                    .required()
                    .description('私聊用户 ID（填写 "default" 作为默认私聊配置模板）'),
            }),
            idleSchema(),
            commonSessionSchema(),
        ])).role('list')
            .default([])
            .description('添加私聊配置'),
    }).description('私聊配置'),
]) as Schema<Config>

export default Config
