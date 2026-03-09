import { Schema } from 'koishi'

export interface Config {
    // 基础配置
    applyGroup: string[]
    applyPrivateUsers: string[]

    // 活跃度触发
    enableActivityTrigger: boolean
    activityThreshold: {
        lowerLimit: number
        upperLimit: number
    }

    // 空闲触发
    enableIdleTrigger: boolean
    idleTrigger: {
        intervalMinutes: number
        enableJitter: boolean
    }

    // 消息计数触发
    messageInterval: number

    // 历史消息配置
    includeChatHistory: boolean
    maxHistoryMessages: number
    historyBufferSize: number

    // 冷却时间
    cooldownSeconds: number

    // room 同步
    syncToAllRooms: boolean

    // 调试
    verboseLog: boolean
}

export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
        applyGroup: Schema.array(Schema.string())
            .role('table')
            .description('应用到的群组 ID 列表')
            .default([]),
        applyPrivateUsers: Schema.array(Schema.string())
            .role('table')
            .description('应用到的私聊用户 ID 列表')
            .default([]),
    }).description('应用范围'),

    Schema.object({
        enableActivityTrigger: Schema.boolean()
            .description('启用活跃度触发')
            .default(true),
        activityThreshold: Schema.object({
            lowerLimit: Schema.number().min(0).max(1).step(0.05)
                .default(0.85)
                .description('初始触发灵敏度'),
            upperLimit: Schema.number().min(0).max(1).step(0.05)
                .default(0.85)
                .description('灵敏度趋向值'),
        }).description('活跃度阈值配置'),
        messageInterval: Schema.number().min(0).max(100)
            .default(20)
            .description('消息计数触发间隔'),
    }).description('活跃度触发配置'),

    Schema.object({
        enableIdleTrigger: Schema.boolean()
            .description('启用空闲触发')
            .default(true),
        idleTrigger: Schema.object({
            intervalMinutes: Schema.number().min(1).max(60 * 24 * 7)
                .default(180)
                .description('空闲触发间隔（分钟）'),
            enableJitter: Schema.boolean()
                .default(true)
                .description('启用随机抖动'),
        }).description('空闲触发配置'),
    }).description('空闲触发配置'),

    Schema.object({
        includeChatHistory: Schema.boolean()
            .default(true)
            .description('是否在主动发言时包含近期群聊历史'),
        maxHistoryMessages: Schema.number()
            .min(5).max(100).default(20)
            .description('主动发言时包含的最大历史消息数'),
        historyBufferSize: Schema.number()
            .min(20).max(1000).default(100)
            .description('每个会话缓存的历史消息上限（用于后续触发注入）'),
        cooldownSeconds: Schema.number().min(0).max(3600)
            .default(30)
            .description('触发后冷却时间（秒）'),
        syncToAllRooms: Schema.boolean()
            .default(true)
            .description('主动发言后，将对话记录同步写入该群所有用户的对话历史（仅在每用户独立 room 模式下有效）'),
        verboseLog: Schema.boolean()
            .default(false)
            .description('详细日志模式：打印完整的触发请求内容'),
    }).description('高级配置'),
])

export default Config
