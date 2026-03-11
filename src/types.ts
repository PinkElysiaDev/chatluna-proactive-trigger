import { Session } from 'koishi'

/**
 * 群聊消息记录
 */
export interface ChatMessage {
    id: string
    name: string
    content: string
    timestamp: number
    imgs?: string[]
}

/**
 * 会话状态
 */
export interface ConversationState {
    // 最后一条消息时间
    lastMessageTime: number

    // 当前活跃度阈值（自适应）
    currentThreshold: number

    // 上次活跃度分数
    lastActivityScore: number

    // 上次触发时间
    lastTriggerTime: number

    // 响应锁
    responseLocked: boolean

    // 消息计数（用于消息计数触发）
    messageCount: number
}

/**
 * 活跃度评分器配置
 */
export interface ActivityScorerConfig {
    // 是否启用
    enabled: boolean

    // 时间窗口（毫秒）
    recentWindow: number      // 1.5分钟
    instantWindow: number     // 20秒
    burstWindow: number       // 30秒

    // 阈值
    sustainedRate: number     // 持续活跃阈值（条/分钟）
    instantRate: number       // 瞬时活跃阈值
    burstRate: number         // 突发活跃阈值

    // 活跃度阈值配置
    lowerLimit: number
    upperLimit: number
}

/**
 * 空闲触发器配置
 */
export interface IdleTriggerConfig {
    // 是否启用
    enabled: boolean

    // 基础间隔（分钟）
    intervalMinutes: number

    // 是否启用随机抖动
    enableJitter: boolean
}

/**
 * 空闲触发结果
 */
export interface IdleTriggerResult {
    reason: string
    silenceMinutes?: number
}

/**
 * 触发原因类型
 */
export type TriggerType = 'activity' | 'idle'

/**
 * 触发原因
 */
export interface TriggerReason {
    type: TriggerType
    reason: string
    idleMinutes?: number
}
