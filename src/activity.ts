import { GroupTriggerConfig, TriggerProfileConfig } from './config'
import { ConversationState } from './types'

/**
 * 活跃度评分器
 * 基于 chatluna-character 的实现简化而来
 */
export class ActivityScorer {
    // 时间窗口配置（毫秒）
    private readonly WINDOWS = {
        recent: 90 * 1000,      // 1.5分钟
        instant: 20 * 1000,     // 20秒
        burst: 30 * 1000        // 30秒
    }

    // 阈值配置
    private readonly THRESHOLDS = {
        sustainedRate: 10,      // 持续活跃阈值（条/分钟）
        instantRate: 9,         // 瞬时活跃阈值
        burstRate: 12           // 突发活跃阈值
    }

    /**
     * 计算活跃度分数
     */
    calculateScore(timestamps: number[], state: ConversationState): number {
        if (timestamps.length === 0) return 0

        const now = Date.now()

        // 多窗口观测
        const recentRate = this._calcRate(timestamps, now, this.WINDOWS.recent)
        const instantRate = this._calcRate(timestamps, now, this.WINDOWS.instant)
        const burstRate = this._calcRate(timestamps, now, this.WINDOWS.burst)

        // logistic 平滑
        const sustainedComponent = this._logistic((recentRate - this.THRESHOLDS.sustainedRate) / 3)
        const instantComponent = this._logistic((instantRate - this.THRESHOLDS.instantRate) / 2)

        let score = sustainedComponent * 0.65 + instantComponent * 0.35

        // 突发加成
        if (burstRate > this.THRESHOLDS.burstRate) {
            score += this._clamp((burstRate - this.THRESHOLDS.burstRate) / 4, 0, 1) * 0.25
        }

        // 新鲜度衰减
        const freshness = this._calcFreshness(timestamps, now)
        score *= 0.55 + 0.45 * freshness

        return this._clamp(score, 0, 1)
    }

    /**
     * 判断是否应该触发
     */
    shouldTrigger(score: number, threshold: number): boolean {
        return score >= threshold
    }

    /**
     * 调整阈值（自适应）
     */
    adjustThreshold(state: ConversationState, profile: TriggerProfileConfig): void {
        if (!this._hasActivityTrigger(profile) || !profile.enableActivityTrigger) return

        const lowerLimit = profile.activityLowerLimit ?? 0.85
        const upperLimit = profile.activityUpperLimit ?? 0.85
        const step = (upperLimit - lowerLimit) * 0.1
        state.currentThreshold = this._clamp(
            state.currentThreshold + step,
            Math.min(lowerLimit, upperLimit),
            Math.max(lowerLimit, upperLimit)
        )
    }

    /**
     * 计算指定时间窗口内的消息速率（条/分钟）
     */
    private _calcRate(timestamps: number[], now: number, windowMs: number): number {
        const cutoff = now - windowMs
        const count = timestamps.filter(t => t >= cutoff).length
        return (count / windowMs) * 60000 // 转换为条/分钟
    }

    /**
     * Logistic 函数，用于平滑
     */
    private _logistic(x: number): number {
        return 1 / (1 + Math.exp(-x))
    }

    /**
     * 限制数值范围
     */
    private _clamp(value: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, value))
    }

    /**
     * 计算新鲜度衰减因子
     * 消息越新权重越高
     */
    private _calcFreshness(timestamps: number[], now: number): number {
        if (timestamps.length === 0) return 0

        // 取最近一条消息的时间
        const lastTimestamp = Math.max(...timestamps)
        const elapsed = now - lastTimestamp

        // 60秒半衰期
        const halfLife = 60 * 1000
        return Math.exp(-elapsed / halfLife * Math.log(2))
    }

    private _hasActivityTrigger(profile: TriggerProfileConfig): profile is GroupTriggerConfig {
        return 'enableActivityTrigger' in profile
    }
}
