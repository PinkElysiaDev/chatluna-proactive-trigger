import { Config } from './config'
import { ConversationState, IdleTriggerResult } from './types'

/**
 * 空闲调度器
 * 当对话长时间无新消息时，主动发起话题
 */
export class IdleScheduler {
    private readonly config: Config

    constructor(config: Config) {
        this.config = config
    }

    /**
     * 检查是否应该触发空闲回复
     */
    shouldTrigger(state: ConversationState, now: number): IdleTriggerResult | null {
        if (!this.config.enableIdleTrigger) return null

        const lastMessageTime = state.lastMessageTime
        if (!lastMessageTime) return null

        // 空闲触发的计时锚点：
        // 1) 最近一条用户消息
        // 2) 最近一次主动触发（避免达到阈值后仅按 cooldown 高频重复触发）
        const triggerAnchor = Math.max(lastMessageTime, state.lastTriggerTime || 0)
        const elapsedFromAnchor = now - triggerAnchor

        // 固定等待间隔（可选随机抖动）
        const waitInterval = this._calcWaitInterval()

        if (elapsedFromAnchor >= waitInterval) {
            // 文案仍使用“距最后用户消息”的时长，便于理解群聊真实沉默时长
            const silenceMinutes = Math.floor((now - lastMessageTime) / 60000)
            return {
                reason: `已经${silenceMinutes}分钟没有消息了，请尝试发起一个话题`
            }
        }

        return null
    }

    /**
     * 计算等待间隔
     */
    private _calcWaitInterval(): number {
        const baseMs = this.config.idleTrigger.intervalMinutes * 60 * 1000
        return this._applyJitter(baseMs)
    }

    /**
     * 应用随机抖动
     */
    private _applyJitter(interval: number): number {
        if (!this.config.idleTrigger.enableJitter) return interval

        const ratio = 0.05 + Math.random() * 0.05  // 5%-10%
        const direction = Math.random() < 0.5 ? -1 : 1
        return Math.max(1000, Math.round(interval * (1 + direction * ratio)))
    }
}
