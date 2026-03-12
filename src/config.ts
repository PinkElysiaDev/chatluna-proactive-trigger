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
    '你现在需要进行一次“活跃触发”的主动发言。',
    '当前时间：{date} {time}',
    '群聊名称：{group_name}',
    '触发原因：{trigger_reason}',
    '',
    '以下是自上次你发言以来的群内消息（可能包含图片）：',
    '{history}',
    '',
    '请注意：这些消息未必都在对你说话；优先回应明确提及你的内容，若没有则以自然、简短、不突兀的方式切入。'
].join('\n')

const defaultIdlePrompt = [
    '你现在需要进行一次“空闲触发”的主动发言。',
    '当前时间：{date} {time}',
    '群聊名称：{group_name}',
    '已空闲分钟数：{idle_minutes}',
    '触发原因：{trigger_reason}',
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
            activityPromptTemplate: Schema.string()
                .role('textarea', { rows: [8, 20] })
                .description('活跃触发提示词模板。可用变量：{history} {time} {date} {group_name} {idle_minutes} {trigger_reason}')
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
                .description('空闲触发提示词模板。可用变量：{history} {time} {date} {group_name} {user_name} {idle_minutes} {trigger_reason}')
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
