import { Context, Service, Session, Logger, Next, h } from 'koishi'
import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { Config, GroupTriggerConfig, TriggerProfileConfig } from './config'
import { ActivityScorer } from './activity'
import { IdleScheduler } from './scheduler'
import { CachedImageRef, ChatMessage, ConversationState, TriggerReason } from './types'
import {
    createConversationRoom,
    getConversationRoomCount,
    queryJoinedConversationRoom,
    resolveConversationRoom
} from 'koishi-plugin-chatluna/chains'
import type {} from 'koishi-plugin-chatluna/services/chat'
import type {} from 'koishi-plugin-chatluna/llm-core/chat/app'

declare module 'koishi' {
    interface Context {
        chatluna_proactive: ProactiveChatService
    }
}

interface PersistedState {
    version: 1
    conversationStates: Record<string, ConversationState>
    messageTimestamps: Record<string, number[]>
    chatMessages: Record<string, ChatMessage[]>
}

interface ManagedRoom {
    roomId: number
    conversationId: string
    model: string
    preset: string
    roomName: string
    roomMasterId: string
    visibility: string
    chatMode: string
    password?: string | null
    updatedTime?: Date
}

interface PendingAfterChatAction {
    guildId?: string
    resetRoomId?: number
    isProactiveTrigger?: boolean
    // 创建时间戳，调度 tick 据此清扫 after-chat 未消费的残留条目
    createdAt: number
}

interface PendingRoomReset {
    roomId: number
    guildId?: string
    attempts: number
}

export class ProactiveChatService extends Service {
    private _sessions: Record<string, Session> = {}
    private _conversationStates: Record<string, ConversationState> = {}
    private _messageTimestamps: Record<string, number[]> = {}
    private _chatMessages: Record<string, ChatMessage[]> = {}
    private _activityScorer: ActivityScorer
    private _idleScheduler: IdleScheduler
    private _schedulerDisposable: (() => void) | null = null
    private _persistenceDisposable: (() => void) | null = null
    private _logger: Logger

    private _dirty = false
    private _isSaving = false
    private _pendingSave = false
    private _lastSaveTime = 0
    private _stateFilePath: string
    private _imageCacheDir: string
    // 保存循环序列化间隔睡眠的唤醒句柄，stop() 用它避免最后的强制保存被睡眠吞掉
    private _saveWakeUp: (() => void) | null = null
    // 在途的保存循环 Promise，stop() 等待它完成后再做最终保存
    private _saveInFlight: Promise<void> | null = null
    // proactive room 创建段的进程内互斥队列（roomId 按 max+1 分配，需串行化）
    private _roomCreateQueue: Promise<unknown> = Promise.resolve()

    // 两次全量状态序列化的最小间隔，防止活跃群触发 stringify 热循环
    private readonly MIN_SAVE_INTERVAL_MS = 30_000
    // after-chat pending 动作的最大存活时间
    private readonly PENDING_ACTION_TTL_MS = 10 * 60 * 1000
    // 调度器跳过/等待日志的去重间隔
    private readonly TICK_LOG_DEDUP_MS = 30_000

    // conversationId → after-chat 回调动作
    private _pendingBroadcast: Map<string, PendingAfterChatAction> = new Map()
    // roomId → 待执行的 room 历史重置；重置移出 after-chat 关键路径，
    // 由调度 tick 在会话空闲时异步执行，避免与聊天链抢 conversation 队列锁
    private _pendingRoomResets: Map<number, PendingRoomReset> = new Map()
    // conversationId → 调度器上次跳过/等待日志的原因与时间，用于按原因去重
    private _lastTickLog: Map<string, { reason: string; time: number }> = new Map()

    private readonly MAX_MESSAGES = 100
    private readonly MAX_TIMESTAMPS = 200
    private readonly MAX_ROOM_RESET_ATTEMPTS = 5

    constructor(ctx: Context, private _config: Config) {
        super(ctx, 'chatluna_proactive')
        this._activityScorer = new ActivityScorer()
        this._idleScheduler = new IdleScheduler()
        this._logger = ctx.logger('chatluna-proactive')
        this._stateFilePath = path.resolve(ctx.baseDir || process.cwd(), 'data', 'chatluna-proactive-trigger-state.json')
        this._imageCacheDir = path.resolve(ctx.baseDir || process.cwd(), 'data', 'chatluna-proactive-trigger', 'images')

        ctx.on('chatluna/after-chat', async (conversationId, _sourceMessage, _responseMessage) => {
            const action = this._pendingBroadcast.get(conversationId)
            if (action) {
                this._pendingBroadcast.delete(conversationId)

                if (action.resetRoomId != null) {
                    // 只登记，不在这里同步 clearChatHistory：
                    // 慢模型（如 dify workflow 单次 185s）持有 conversation 队列锁时，
                    // 同步重置会等待 180s 超时；改由调度 tick 在会话空闲时异步执行
                    this._pendingRoomResets.set(action.resetRoomId, {
                        roomId: action.resetRoomId,
                        ...(action.guildId ? { guildId: action.guildId } : {}),
                        attempts: 0
                    })
                }
            }

            // 仅在主动触发的 after-chat 中清空消息历史
            // 用户直接触发 ChatLuna 时不清空，以便保底触发能收集到这些消息
            if (action?.isProactiveTrigger) {
                // guildId 由触发时直接携带，避免反查 chathub_room_group_member 时的多群歧义
                const guildId = action.guildId ?? null
                if (guildId) {
                    const pluginConversationId = `group:${guildId}`
                    if (this._chatMessages[pluginConversationId]?.length) {
                        this._chatMessages[pluginConversationId] = []
                        await this._clearConversationImageCache(pluginConversationId)
                        this._markDirty()
                        this._debug(
                            `[after-chat][reset-group-history] conversationId=${conversationId} groupId=${guildId} reset=true (proactive trigger)`
                        )
                    }
                } else {
                    this._debug(
                        `[after-chat][reset-group-history] conversationId=${conversationId} groupId=unknown skip`
                    )
                }
            } else {
                this._debug(
                    `[after-chat][skip-reset] conversationId=${conversationId} reason=not proactive trigger, preserving history for guaranteed trigger`
                )
            }
        })
    }

    async start(): Promise<void> {
        await this._loadState()
        this.ctx.middleware((session, next) => this.handleMessage(session, next))
        this._schedulerDisposable = this.ctx.setInterval(() => {
            this._processSchedulerTick()
        }, 1000)
        this._persistenceDisposable = this.ctx.setInterval(() => {
            this._saveState()
        }, 10000)
        this._logInfo('ProactiveChatService 已启动')
    }

    async stop(): Promise<void> {
        if (this._schedulerDisposable) {
            this._schedulerDisposable()
            this._schedulerDisposable = null
        }
        if (this._persistenceDisposable) {
            this._persistenceDisposable()
            this._persistenceDisposable = null
        }
        this._pendingBroadcast.clear()
        this._pendingRoomResets.clear()
        this._sessions = {}
        // 唤醒可能处于序列化间隔睡眠中的保存循环，并等待在途保存完成，
        // 避免进程快速退出时最后的强制保存被睡眠吞掉
        this._saveWakeUp?.()
        if (this._saveInFlight) await this._saveInFlight
        await this._saveState(true)
        this._logInfo('ProactiveChatService 已停止')
    }

    async handleMessage(session: Session, next: Next): Promise<void> {
        if (this.ctx.bots[session.uid]) { await next(); return }

        const profile = this._getProfileBySession(session)
        const conversationId = this._getConversationId(session)
        const now = session.timestamp || Date.now()

        if (!profile) {
            // verboseLog 关闭时跳过构造判断日志 payload，避免对无关会话的每条消息产生分配开销
            if (this._config.verboseLog) {
                this._logMessageEvaluation(session, {
                    conversationId,
                    profileType: 'none',
                    cooldownRemainingMs: 0,
                    responseLocked: false,
                    activityEnabled: false,
                    activityScore: null,
                    activityThreshold: null,
                    messageCount: 0,
                    messageInterval: null,
                    activityTriggered: false,
                    idleEnabled: false,
                    idleMinutes: 0,
                    idleIntervalMinutes: null,
                    idleEligible: false,
                    guaranteedEnabled: false,
                    guaranteedMinutes: null,
                    guaranteedBaseType: 'none',
                    guaranteedBaseTime: 0,
                    guaranteedFirstEligibleMessageTime: 0,
                    guaranteedLastTriggerTime: 0,
                    guaranteedLastEligibleMessageTime: 0,
                    guaranteedElapsedSeconds: null,
                    guaranteedRemainingSeconds: null,
                    guaranteedHasEligibleMessage: false,
                    guaranteedEligible: false,
                    triggerReason: null,
                    finalDecision: 'no-profile'
                })
            }
            this._debug(`[handleMessage] session not applicable: uid=${session.uid} guildId=${session.guildId} isDirect=${session.isDirect}`)
            await next(); return
        }

        this._sessions[conversationId] = session

        const isDirectChatlunaTrigger =
            !session.isDirect && this._isDirectChatlunaTriggerMessage(session)

        let shouldCountForProactive = true
        if (!session.isDirect) {
            shouldCountForProactive = await this._addChatMessage(conversationId, session)
        }

        const state = this._getOrCreateState(conversationId, profile)
        state.lastMessageTime = now
        state.lastFailureTime = 0
        state.failureCount = 0
        state.retryDisabled = false

        if (isDirectChatlunaTrigger) {
            // 仅当本条消息确实写入了历史时才标记，避免误标上一条
            if (shouldCountForProactive) {
                const msgs = this._chatMessages[conversationId]
                if (msgs?.length) {
                    msgs[msgs.length - 1].isDirectTrigger = true
                }
            }
            this._markDirty()
            this._debug(
                `[handleMessage] ${conversationId}: direct ChatLuna trigger detected, skipped proactive eligibility`
            )
            await next()
            return
        }

        if (!shouldCountForProactive) {
            this._markDirty()
            this._debug(
                `[handleMessage] ${conversationId}: message skipped from proactive eligibility because it was not recorded in proactive history`
            )
            await next()
            return
        }

        this._recordTimestamp(conversationId, now)
        if (!state.firstProactiveEligibleMessageTime) {
            state.firstProactiveEligibleMessageTime = now
        }
        state.lastProactiveEligibleMessageTime = now
        state.messageCount = (state.messageCount ?? 0) + 1
        this._markDirty()

        this._debug(`[handleMessage] conversationId=${conversationId} messageCount=${state.messageCount} lastActivityScore=${state.lastActivityScore?.toFixed(3)} threshold=${state.currentThreshold?.toFixed(3)}`)

        const triggerReason = this._evaluateTriggers(conversationId, state, now, profile)
        const cooldownRemainingMs = state.lastTriggerTime
            ? Math.max(0, profile.cooldownSeconds * 1000 - (now - state.lastTriggerTime))
            : 0
        const activityEnabled = this._isGroupProfile(profile) && profile.enableActivityTrigger
        const messageInterval = activityEnabled ? (profile.activityMessageInterval ?? 20) : null
        const idleEnabled = profile.enableIdleTrigger
        const idleMinutes = state.lastMessageTime ? Math.max(0, (now - state.lastMessageTime) / 60000) : 0
        const idleIntervalMinutes = idleEnabled ? (profile.idleIntervalMinutes ?? 180) : null
        const idleEligible = !!(idleEnabled && idleIntervalMinutes != null && idleMinutes >= idleIntervalMinutes)
        const guaranteedEnabled = activityEnabled && (profile.guaranteedTriggerMinutes ?? 0) > 0
        const guaranteedMinutes = guaranteedEnabled && this._isGroupProfile(profile)
            ? profile.guaranteedTriggerMinutes ?? 0
            : null
        const lastProactive = state.lastProactiveTriggerTime ?? 0
        const guaranteedBaseType = guaranteedEnabled
            ? lastProactive > 0
                ? 'last-proactive-trigger'
                : state.firstProactiveEligibleMessageTime > 0
                    ? 'first-eligible-message'
                    : 'none'
            : 'none'
        const guaranteedBaseTime = guaranteedBaseType === 'last-proactive-trigger'
            ? lastProactive
            : guaranteedBaseType === 'first-eligible-message'
                ? state.firstProactiveEligibleMessageTime
                : 0
        const guaranteedElapsedSeconds = guaranteedEnabled && guaranteedBaseTime > 0
            ? Math.floor((now - guaranteedBaseTime) / 1000)
            : null
        const guaranteedRemainingSeconds = guaranteedEnabled && guaranteedMinutes != null && guaranteedBaseTime > 0
            ? Math.max(0, Math.ceil((guaranteedMinutes * 60 * 1000 - (now - guaranteedBaseTime)) / 1000))
            : null
        const guaranteedHasEligibleMessage = guaranteedEnabled
            ? lastProactive > 0
                ? (state.lastProactiveEligibleMessageTime ?? 0) > lastProactive && (state.messageCount ?? 0) > 0
                : (state.firstProactiveEligibleMessageTime ?? 0) > 0 && (state.messageCount ?? 0) > 0
            : false
        const guaranteedEligible = guaranteedEnabled &&
            guaranteedBaseTime > 0 &&
            guaranteedHasEligibleMessage &&
            guaranteedRemainingSeconds === 0

        // verboseLog 关闭时跳过构造判断日志 payload，避免活跃群每条消息的分配开销
        if (this._config.verboseLog) {
            this._logMessageEvaluation(session, {
                conversationId,
                profileType: this._getProfileType(session, profile),
                cooldownRemainingMs,
                responseLocked: state.responseLocked,
                activityEnabled,
                activityScore: activityEnabled ? state.lastActivityScore : null,
                activityThreshold: activityEnabled ? state.currentThreshold : null,
                messageCount: state.messageCount,
                messageInterval,
                activityTriggered: triggerReason?.type === 'activity',
                idleEnabled,
                idleMinutes,
                idleIntervalMinutes,
                idleEligible,
                guaranteedEnabled,
                guaranteedMinutes,
                guaranteedBaseType,
                guaranteedBaseTime,
                guaranteedFirstEligibleMessageTime: state.firstProactiveEligibleMessageTime ?? 0,
                guaranteedLastTriggerTime: lastProactive,
                guaranteedLastEligibleMessageTime: state.lastProactiveEligibleMessageTime ?? 0,
                guaranteedElapsedSeconds,
                guaranteedRemainingSeconds,
                guaranteedHasEligibleMessage,
                guaranteedEligible,
                triggerReason: triggerReason?.reason ?? null,
                finalDecision: triggerReason
                    ? `${triggerReason.type}-trigger`
                    : cooldownRemainingMs > 0
                        ? 'cooldown'
                        : state.responseLocked
                            ? 'response-locked'
                            : 'skip'
            })
        }

        if (triggerReason) {
            await this._triggerResponse(session, triggerReason, profile)
            return
        }

        await next()
    }

    /**
     * 调度器每秒 tick，跳过/等待分支的日志按"原因变化或 30 秒"去重，
     * 避免 verboseLog 开启时空闲会话产生 1 条/秒的日志刷屏
     */
    private _tickLog(conversationId: string, reason: string, message: string): void {
        const last = this._lastTickLog.get(conversationId)
        const now = Date.now()
        if (last && last.reason === reason && now - last.time < this.TICK_LOG_DEDUP_MS) return
        this._lastTickLog.set(conversationId, { reason, time: now })
        this._debug(message)
    }

    /**
     * 异步执行 after-chat 登记的 room 历史重置。
     * 在对应会话空闲（无触发执行中）时才执行，避免与聊天链竞争 conversation 队列锁；
     * 失败自动重试，达到上限后告警放弃。
     */
    private async _processPendingRoomResets(): Promise<void> {
        for (const [roomId, pending] of this._pendingRoomResets) {
            if (pending.guildId) {
                const state = this._conversationStates[`group:${pending.guildId}`]
                if (state?.responseLocked) continue
            }

            try {
                const room = await resolveConversationRoom(this.ctx, roomId)
                if (room) {
                    await this._resetRoomHistory(room as ManagedRoom)
                }
                this._pendingRoomResets.delete(roomId)
            } catch (error) {
                pending.attempts++
                if (pending.attempts >= this.MAX_ROOM_RESET_ATTEMPTS) {
                    this._logger.warn(
                        `Failed to reset proactive room ${roomId} after ${pending.attempts} attempts: ${error}`
                    )
                    this._pendingRoomResets.delete(roomId)
                }
            }
        }
    }

    private async _processSchedulerTick(): Promise<void> {
        const now = Date.now()

        // 清理超时未消费的 after-chat pending 动作：
        // receiveCommand 正常返回但 after-chat 未触发（或事件 conversationId 与预注册不一致）时条目会永久残留
        for (const [key, action] of this._pendingBroadcast) {
            if (now - action.createdAt > this.PENDING_ACTION_TTL_MS) {
                this._debug(
                    `[schedulerTick] evict stale pending action, conversationId=${key}, age=${Math.floor((now - action.createdAt) / 1000)}s`
                )
                this._pendingBroadcast.delete(key)
            }
        }

        this._pruneStaleConversations()
        this._processPendingRoomResets()

        for (const [conversationId, state] of Object.entries(this._conversationStates)) {
            const session = this._sessions[conversationId]
            if (!session) continue

            const profile = this._getProfileByConversationId(conversationId)
            if (!profile) continue

            const cooldownRemaining = state.lastTriggerTime
                ? profile.cooldownSeconds * 1000 - (now - state.lastTriggerTime)
                : 0

            if (cooldownRemaining > 0) {
                this._tickLog(conversationId, 'cooldown', `[schedulerTick] ${conversationId}: in cooldown, ${Math.ceil(cooldownRemaining / 1000)}s remaining`)
                continue
            }
            if (state.responseLocked) {
                this._tickLog(conversationId, 'response-locked', `[schedulerTick] ${conversationId}: responseLocked, skipping`)
                continue
            }
            if (state.retryDisabled) {
                this._tickLog(conversationId, 'retry-disabled', `[schedulerTick] ${conversationId}: retry disabled after ${state.failureCount} consecutive failures`)
                continue
            }

            const failureCooldownRemaining = state.lastFailureTime
                ? this._config.failureCooldownSeconds * 1000 - (now - state.lastFailureTime)
                : 0

            if (failureCooldownRemaining > 0) {
                this._tickLog(
                    conversationId,
                    'failure-cooldown',
                    `[schedulerTick] ${conversationId}: in failure cooldown, ${Math.ceil(failureCooldownRemaining / 1000)}s remaining`
                )
                continue
            }

            const idleTrigger = this._idleScheduler.shouldTrigger(state, now, profile)
            if (idleTrigger) {
                const trigger = {
                    type: 'idle' as const,
                    reason: '空闲时间触发',
                    idleMinutes: idleTrigger.silenceMinutes ?? 0,
                    debugDetail: `idleMinutes=${idleTrigger.silenceMinutes ?? 0}`
                }
                await this._triggerResponse(session, trigger, profile)
                this._markDirty()
            } else if (state.lastMessageTime && profile.enableIdleTrigger) {
                const idleMs = now - state.lastMessageTime
                const waitMs = (profile.idleIntervalMinutes ?? 180) * 60 * 1000
                this._tickLog(conversationId, 'idle-waiting', `[schedulerTick] ${conversationId}: idle=${Math.floor(idleMs / 1000)}s, need=${Math.floor(waitMs / 1000)}s`)
            }

            // 保底触发检查：
            // 距上次主动发言超过配置的时间阈值，且上次主动发言后确实有新消息进入本轮活跃度积累周期。
            // 保底计时不受用户直接触发 chatluna 的影响，只基于主动发言时间。
            // 若上次主动发言后完全无消息，则应交给 idle trigger 处理，不由活跃度保底触发兜底。
            if (this._isGroupProfile(profile) && profile.enableActivityTrigger && (profile.guaranteedTriggerMinutes ?? 0) > 0) {
                const lastProactive = state.lastProactiveTriggerTime ?? 0
                const guaranteedBaseType = lastProactive > 0
                    ? 'last-proactive-trigger'
                    : state.firstProactiveEligibleMessageTime > 0
                        ? 'first-eligible-message'
                        : 'none'
                const guaranteedBaseTime = guaranteedBaseType === 'last-proactive-trigger'
                    ? lastProactive
                    : guaranteedBaseType === 'first-eligible-message'
                        ? state.firstProactiveEligibleMessageTime
                        : 0

                if (guaranteedBaseTime <= 0) {
                    this._tickLog(
                        conversationId,
                        'guaranteed-no-base',
                        `[schedulerTick] ${conversationId}: guaranteed trigger skipped, no base time, guaranteedMinutes=${profile.guaranteedTriggerMinutes}, firstEligibleMessageTime=${state.firstProactiveEligibleMessageTime ?? 0}, lastProactiveTriggerTime=${lastProactive}, lastEligibleMessageTime=${state.lastProactiveEligibleMessageTime ?? 0}, messageCount=${state.messageCount ?? 0}`
                    )
                    continue
                }

                const hasEligibleMessageForGuaranteed =
                    lastProactive > 0
                        ? (state.lastProactiveEligibleMessageTime ?? 0) > lastProactive && (state.messageCount ?? 0) > 0
                        : (state.firstProactiveEligibleMessageTime ?? 0) > 0 && (state.messageCount ?? 0) > 0

                if (!hasEligibleMessageForGuaranteed) {
                    this._tickLog(
                        conversationId,
                        'guaranteed-no-eligible',
                        `[schedulerTick] ${conversationId}: guaranteed trigger skipped, no proactive-eligible message for current guaranteed cycle, baseType=${guaranteedBaseType}, baseTime=${guaranteedBaseTime}, firstEligibleMessageTime=${state.firstProactiveEligibleMessageTime ?? 0}, lastProactiveTriggerTime=${lastProactive}, lastEligibleMessageTime=${state.lastProactiveEligibleMessageTime ?? 0}, messageCount=${state.messageCount ?? 0}`
                    )
                    continue
                }

                const guaranteedMs = profile.guaranteedTriggerMinutes! * 60 * 1000
                const elapsedSinceGuaranteedBase = now - guaranteedBaseTime
                const guaranteedRemainingMs = guaranteedMs - elapsedSinceGuaranteedBase
                if (elapsedSinceGuaranteedBase < guaranteedMs) {
                    this._tickLog(
                        conversationId,
                        'guaranteed-waiting',
                        `[schedulerTick] ${conversationId}: guaranteed trigger waiting, baseType=${guaranteedBaseType}, elapsed=${Math.floor(elapsedSinceGuaranteedBase / 1000)}s, remaining=${Math.ceil(guaranteedRemainingMs / 1000)}s, threshold=${profile.guaranteedTriggerMinutes}min, baseTime=${guaranteedBaseTime}, firstEligibleMessageTime=${state.firstProactiveEligibleMessageTime ?? 0}, lastProactiveTriggerTime=${lastProactive}, lastEligibleMessageTime=${state.lastProactiveEligibleMessageTime ?? 0}, messageCount=${state.messageCount ?? 0}`
                    )
                    continue
                }

                if (elapsedSinceGuaranteedBase >= guaranteedMs) {
                    const trigger: TriggerReason = {
                        type: 'activity',
                        reason: '保底触发（距上次主动发言超时）',
                        debugDetail: `guaranteedBaseType=${guaranteedBaseType} secondsSinceGuaranteedBase=${Math.floor(elapsedSinceGuaranteedBase / 1000)} guaranteedMinutes=${profile.guaranteedTriggerMinutes} baseTime=${guaranteedBaseTime} firstEligibleMessageTime=${state.firstProactiveEligibleMessageTime ?? 0} lastProactiveTriggerTime=${lastProactive} lastEligibleMessageTime=${state.lastProactiveEligibleMessageTime ?? 0} messageCount=${state.messageCount}`
                    }
                    await this._triggerResponse(session, trigger, profile)
                    this._markDirty()
                }
            }
        }
    }

    private _evaluateTriggers(
        conversationId: string,
        state: ConversationState,
        now: number,
        profile: TriggerProfileConfig
    ): TriggerReason | null {
        if (state.lastTriggerTime && now - state.lastTriggerTime < profile.cooldownSeconds * 1000) {
            this._debug(`[evaluateTriggers] ${conversationId}: in cooldown`)
            return null
        }
        if (state.responseLocked) {
            this._debug(`[evaluateTriggers] ${conversationId}: responseLocked`)
            return null
        }

        if (this._isGroupProfile(profile) && profile.enableActivityTrigger) {
            const timestamps = this._messageTimestamps[conversationId] || []
            const score = this._activityScorer.calculateScore(timestamps, state)
            state.lastActivityScore = score

            this._debug(`[evaluateTriggers] ${conversationId}: activityScore=${score.toFixed(3)} threshold=${state.currentThreshold.toFixed(3)}`)

            if (this._activityScorer.shouldTrigger(score, state.currentThreshold)) {
                const trigger = {
                    type: 'activity' as const,
                    reason: '活跃度触发',
                    debugDetail: `activityScore=${score.toFixed(3)} threshold=${state.currentThreshold.toFixed(3)}`
                }
                return trigger
            }

            const messageInterval = profile.activityMessageInterval ?? 20
            if (messageInterval > 0 && state.messageCount >= messageInterval) {
                const trigger = {
                    type: 'activity' as const,
                    reason: '消息计数触发',
                    debugDetail: `messageCount=${state.messageCount} messageInterval=${messageInterval}`
                }
                return trigger
            }
        }

        return null
    }

    private async _triggerResponse(
        session: Session,
        trigger: TriggerReason,
        profile: TriggerProfileConfig
    ): Promise<void> {
        const conversationId = this._getConversationId(session)
        const state = this._getOrCreateState(conversationId, profile)
        let pendingConversationId: string | undefined

        if (state.responseLocked) return
        state.responseLocked = true

        try {
            const template = this._getPromptTemplate(trigger, profile)
            const useHist = this._shouldUseHistory(template)
            const isGuaranteedTrigger = trigger.reason.startsWith('保底触发')
            const msgs = useHist
                ? this._getRecentHistoryMessages(conversationId, profile, {
                    // 主动发言一律排除"用户直接触发 ChatLuna"的消息（@bot / 引用 bot / 喊 bot 名字）：
                    // 这些消息已由 chatluna 常规流程回复，注入会导致 LLM 重复作答。
                    // 保底触发额外限定 sinceTimestamp 为上次主动发言后；常规触发取全部缓存。
                    sinceTimestamp: isGuaranteedTrigger
                        ? (state.lastProactiveTriggerTime || 0)
                        : 0,
                    excludeDirectTriggers: true
                })
                : []
            const execution = await this._resolveExecutionContext(session, trigger, msgs)
            if (!execution?.room) {
                this._logInfo(
                    `[triggerResponse] 未能解析执行 room，conversationId=${conversationId}, triggerType=${trigger.type}, userId=${session.userId}, guildId=${session.guildId}`
                )
                return
            }

            const { room, requestSession, resetAfterChat } = execution
            const { txt: histTxt, imgs } = await this._fmtHist(msgs, profile)
            const bodyTxt = await this._buildReqText(session, trigger, histTxt, template, profile)
            const requestImages = useHist
                ? imgs.slice(0, Math.max(0, profile.maxRequestImages ?? 3))
                : []
            const proactiveElements = this._mkEls(bodyTxt, requestImages)
            const commandOptions = {
                message: proactiveElements,
                is_proactive: true
            }

            if (room.conversationId) {
                const pendingAction: PendingAfterChatAction = {
                    // 标记为主动触发，after-chat 仅在此情况下清空消息缓存
                    // 用户直接触发 ChatLuna 时不会写入此标记，从而保留消息供保底触发使用
                    isProactiveTrigger: true,
                    createdAt: Date.now(),
                    // 群聊触发直接携带 guildId，供 after-chat 清理群历史与图片缓存。
                    // 必须排除 isDirect：部分平台的私聊会话也带 guildId，误带会导致私聊触发清空该群的历史池
                    ...( !session.isDirect && session.guildId ? { guildId: session.guildId } : {})
                }
                if (resetAfterChat) {
                    pendingAction.resetRoomId = room.roomId
                }
                // 始终注册 pending，确保 after-chat 能识别主动触发并正确清理历史
                pendingConversationId = room.conversationId
                this._pendingBroadcast.set(room.conversationId, pendingAction)
            }

            this._debug(`开始执行主动触发响应，conversationId=${conversationId}，reason=${trigger.reason}`)

            if (this._config.verboseLog) {
                const verboseSnapshot = {
                    triggerType: trigger.type,
                    triggerReason: trigger.reason,
                    command: '',
                    session: {
                        platform: session.platform,
                        selfId: session.selfId,
                        guildId: session.guildId,
                        channelId: session.channelId,
                        userId: session.userId,
                        isDirect: session.isDirect
                    },
                    conversation: {
                        pluginConversationId: conversationId,
                        roomConversationId: room.conversationId ?? null,
                        executionRoomId: room.roomId
                    },
                    history: {
                        historyCacheAlwaysOn: true,
                        includeHistoryForThisTrigger: useHist,
                        historyMessageLimit: profile.historyMessageLimit,
                        cachedMessageCount: this._chatMessages[conversationId]?.length ?? 0,
                        injectedMessageCount: msgs.length,
                        injectedImageCount: requestImages.length,
                        injectedImages: requestImages.map((image) => this._formatVerboseImageRef(image))
                    },
                    commandOptions: {
                        is_proactive: true,
                        messagePreview: proactiveElements.map((el) => this._formatElementPreview(el))
                    }
                }

                this._logger.info(
                    `[verboseLog][proactive-request] ${JSON.stringify(verboseSnapshot, null, 2)}`
                )
            }

            const ok = await this.ctx.chatluna.chatChain.receiveCommand(
                requestSession,
                '',
                commandOptions
            )
            if (ok === false) {
                // chatluna 聊天链的软失败（模型不可用/平台未加载/链中止）以 resolve false 表达而非 reject，
                // 且此时已向会话发送错误提示；必须按失败记账，否则会误清消息池、重置保底/冷却基准，
                // 且 failureCooldown/maxRetryAttempts 退避保护永远不会介入
                throw new Error(
                    `[triggerResponse] chatluna 聊天链未正常完成（模型/平台/room 解析失败或链中止），conversationId=${conversationId}, triggerType=${trigger.type}, reason=${trigger.reason}`
                )
            }

            if (this._config.debugLog || this._config.verboseLog) {
                this._logger.info(
                    `[debugLog][trigger] conversationId=${conversationId} type=${trigger.type} reason=${trigger.reason}${trigger.idleMinutes != null ? ` idleMinutes=${trigger.idleMinutes}` : ''}${trigger.debugDetail ? ` ${trigger.debugDetail}` : ''}`
                )
            }

            this._chatMessages[conversationId] = []
            state.lastFailureTime = 0
            state.failureCount = 0
            state.retryDisabled = false
            this._markDirty()

            this._updateStateAfterResponse(state, profile)

        } catch (error) {
            state.lastFailureTime = Date.now()
            state.failureCount = (state.failureCount ?? 0) + 1
            state.retryDisabled = this._config.maxRetryAttempts > 0
                && state.failureCount >= this._config.maxRetryAttempts
            this._markDirty()

            this._logger.error(`主动触发响应失败：${error}`)

            if (state.retryDisabled) {
                this._logger.warn(
                    `[triggerResponse] conversationId=${conversationId} reached max retry attempts (${state.failureCount}/${this._config.maxRetryAttempts}), automatic triggering paused until next message`
                )
            }

            if (pendingConversationId) {
                this._pendingBroadcast.delete(pendingConversationId)
            }
        } finally {
            state.responseLocked = false
        }
    }

    private async _resolveExecutionContext(
        session: Session,
        trigger: TriggerReason,
        messages: ChatMessage[] = []
    ): Promise<{ room: ManagedRoom | null; requestSession: Session; resetAfterChat: boolean }> {
        // 群聊触发（活跃度/保底/空闲）统一锚定到每群一个 proactive room。
        // 不随最后发言者轮转 room：chatluna 会为每个新 conversationId 创建 ChatInterface，
        // 且其构造器在 root 上下文注册的 dispose 监听永不注销，轮转会让泄漏实例数达到 O(用户数)。
        if (!session.isDirect) {
            if (!session.guildId) {
                this._logger.warn(
                    `[resolveExecutionContext] 群聊触发缺少 guildId，userId=${session.userId}`
                )
                return {
                    room: null,
                    requestSession: session,
                    resetAfterChat: false
                }
            }

            const room = await this._ensureProactiveRoomForGuild(session)
            if (room) {
                this._logInfo(
                    `[resolveExecutionContext] ${trigger.type} resolved proactive room, guildId=${session.guildId}, roomId=${room.roomId}, conversationId=${room.conversationId}`
                )
                return {
                    room,
                    requestSession: this._createProactiveSession(session),
                    resetAfterChat: true
                }
            }

            this._logger.warn(
                `[resolveExecutionContext] 触发未能解析 proactive room，guildId=${session.guildId}, userId=${session.userId}`
            )
        }

        const room = await queryJoinedConversationRoom(this.ctx, session)
        if (room) {
            this._logger.warn(
                `[resolveExecutionContext] guild room 供给失败，回退到用户 joined room 执行（该路径不重置历史，存在内存放大风险），guildId=${session.guildId}, userId=${session.userId}, roomId=${room.roomId}, conversationId=${room.conversationId}`
            )
        } else {
            this._logInfo(
                `[resolveExecutionContext] joined room 回退路径未命中，guildId=${session.guildId}, userId=${session.userId}, isDirect=${session.isDirect}`
            )
        }
        return {
            room: (room as ManagedRoom) ?? null,
            requestSession: session,
            resetAfterChat: false
        }
    }

    private async _ensureProactiveRoomForGuild(session: Session): Promise<ManagedRoom | null> {
        const proactiveUserId = '__proactive_trigger__'
        const guildId = session.guildId

        if (!guildId) {
            this._logger.warn('[ensureProactiveRoomForGuild] missing guildId in group session')
            return null
        }

        try {
            const existingRoom = await this._resolveProactiveRoomForGuild(guildId)
            if (existingRoom) return existingRoom

            const templateRoom = await this._findAnyUsableRoomInGuild(guildId)
                ?? this._buildLocalTemplateRoom()

            if (!templateRoom) {
                this._logger.warn(`Cannot provision proactive room for guild ${guildId}: no template room available`)
                return null
            }

            // 创建段经 _roomCreateQueue 串行化：roomId 按 max(roomId)+1 分配，
            // 调度器 tick 重入可让不同群的触发并发执行，无互斥时会撞主键
            const createTask = this._roomCreateQueue.then(async () => {
                const room: ManagedRoom = {
                    conversationId: randomUUID(),
                    model: templateRoom.model,
                    preset: templateRoom.preset,
                    roomName: `Proactive Trigger Room ${guildId}`,
                    roomMasterId: proactiveUserId,
                    roomId: (await getConversationRoomCount(this.ctx)) + 1,
                    visibility: 'private',
                    chatMode: templateRoom.chatMode,
                    password: null,
                    updatedTime: new Date()
                }
                await createConversationRoom(this.ctx, this._createProactiveSession(session), room as any)
                return room
            })
            this._roomCreateQueue = createTask.catch(() => {})
            const room = await createTask
            this._logInfo(`Provisioned proactive room ${room.roomId} for guild ${guildId}`)
            return room
        } catch (error) {
            // 创建失败（如多实例共享 DB 时的主键冲突）：重查一次，可能已被其他调用方建好
            this._logger.warn(
                `[ensureProactiveRoomForGuild] 创建 proactive room 失败，guildId=${guildId}, error=${error}`
            )
            try {
                const room = await this._resolveProactiveRoomForGuild(guildId)
                if (room) return room
            } catch (recheckError) {
                this._logger.warn(
                    `[ensureProactiveRoomForGuild] 重查 proactive room 失败，guildId=${guildId}, error=${recheckError}`
                )
            }
            return null
        }
    }

    private async _resolveProactiveRoomForGuild(guildId: string): Promise<ManagedRoom | null> {
        const userRecords = await this.ctx.database.get('chathub_user', {
            userId: '__proactive_trigger__',
            groupId: guildId
        })

        if (userRecords.length === 0) return null

        const room = await resolveConversationRoom(this.ctx, userRecords[0].defaultRoomId)
        return (room as ManagedRoom) ?? null
    }

    /**
     * 使用 chatluna 主插件配置构建本地模板 room。
     * 不使用 chatluna 的 getTemplateConversationRoom：其内部读取 ctx.scope.parent.config
     * （即调用方父作用域的配置），从本插件调用会读到本插件配置，并在 defaultChatMode 缺失时
     * 直接抛出 ROOM_TEMPLATE_INVALID，导致无 room 群的首次触发持续失败。
     */
    private _buildLocalTemplateRoom(): ManagedRoom | null {
        const config = this.ctx.chatluna?.currentConfig

        if (!config?.defaultModel || !config?.defaultPreset || !config?.defaultChatMode || config.defaultModel === '无') {
            this._logger.warn(
                `[buildLocalTemplateRoom] invalid chatluna defaults: model=${config?.defaultModel}, preset=${config?.defaultPreset}, chatMode=${config?.defaultChatMode}`
            )
            return null
        }

        return {
            roomId: 0,
            roomName: '模板房间',
            roomMasterId: '0',
            preset: config.defaultPreset,
            conversationId: '0',
            chatMode: config.defaultChatMode,
            password: '',
            model: config.defaultModel,
            visibility: 'public',
            updatedTime: new Date()
        }
    }

    private async _findAnyUsableRoomInGuild(guildId: string): Promise<ManagedRoom | null> {
        const groupMembers = await this.ctx.database.get('chathub_room_group_member', { groupId: guildId })
        if (groupMembers.length === 0) return null

        const roomIds = [...new Set(groupMembers.map(item => item.roomId))]
        const rooms = await this.ctx.database.get('chathub_room', { roomId: { $in: roomIds } as any })
        const room = rooms.find(item => item.conversationId && item.model && item.preset && item.chatMode)
        return (room as ManagedRoom) ?? null
    }

    private async _resetRoomHistory(room: ManagedRoom): Promise<void> {
        const chatInterface = this.ctx.chatluna.queryInterfaceWrapper(room as any, false)
        await chatInterface?.clearChatHistory(room as any)
        this._debug(`Reset proactive room history for roomId=${room.roomId}, conversationId=${room.conversationId}`)
    }

    private _createProactiveSession(session: Session): Session {
        const baseSession = session as any
        // 以原 session 为原型派生，而非描述符克隆：koishi 4.18 的 session 实例方法
        // （stripped/text/send 等）经 cordis mixin 的 internal accessor 按接收者分发，
        // 描述符克隆会丢失该分发路径（生产实证：session.stripped 为 undefined、
        // session.text 非函数）。原型链直通原对象可完整保留解析路径。
        const cloned = Object.create(baseSession) as any

        // 复制自身数据字段，保持 spread/枚举兼容（原克隆语义不变的部分）
        const descriptors = Object.getOwnPropertyDescriptors(baseSession)
        delete descriptors.author
        delete descriptors.userId
        delete descriptors.username
        Object.defineProperties(cloned, descriptors)

        // 影子属性覆盖合成身份，原 session 对象保持不变。
        // author 必须是对象而非 undefined：koishi 的 session.username getter 会读
        // this.author.nick，OneBot 等编码器发送时依赖它——置 undefined 会让每条
        // 主动回复在发送阶段崩溃（TypeError: reading 'nick'）
        Object.defineProperty(cloned, 'userId', {
            value: '__proactive_trigger__',
            writable: true,
            configurable: true,
            enumerable: true
        })
        Object.defineProperty(cloned, 'username', {
            value: 'proactive-trigger',
            writable: true,
            configurable: true,
            enumerable: true
        })
        Object.defineProperty(cloned, 'author', {
            value: {
                id: '__proactive_trigger__',
                userId: '__proactive_trigger__',
                name: 'proactive-trigger',
                nick: 'proactive-trigger'
            },
            writable: true,
            configurable: true,
            enumerable: true
        })

        // 早期哨兵：若未来 koishi/chatluna 再次改变 session 形状，第一时间在日志暴露
        if (typeof cloned.text !== 'function') {
            this._logger.warn(
                '[createProactiveSession] 克隆会话缺少 text 方法，当前 koishi/chatluna 组合可能不兼容，请反馈'
            )
        }

        return cloned as Session
    }

    private _getProfileType(
        session: Session,
        profile: TriggerProfileConfig
    ): 'exact' | 'default' {
        if (session.isDirect) {
            return this._isGroupProfile(profile)
                ? 'exact'
                : (profile.userId === 'default' ? 'default' : 'exact')
        }

        return this._isGroupProfile(profile) && profile.guildId === 'default'
            ? 'default'
            : 'exact'
    }

    private _logMessageEvaluation(
        session: Session,
        payload: {
            conversationId: string
            profileType: 'exact' | 'default' | 'none'
            cooldownRemainingMs: number
            responseLocked: boolean
            activityEnabled: boolean
            activityScore: number | null
            activityThreshold: number | null
            messageCount: number
            messageInterval: number | null
            activityTriggered: boolean
            idleEnabled: boolean
            idleMinutes: number
            idleIntervalMinutes: number | null
            idleEligible: boolean
            guaranteedEnabled: boolean
            guaranteedMinutes: number | null
            guaranteedBaseType: string
            guaranteedBaseTime: number
            guaranteedFirstEligibleMessageTime: number
            guaranteedLastTriggerTime: number
            guaranteedLastEligibleMessageTime: number
            guaranteedElapsedSeconds: number | null
            guaranteedRemainingSeconds: number | null
            guaranteedHasEligibleMessage: boolean
            guaranteedEligible: boolean
            triggerReason: string | null
            finalDecision: string
        }
    ) {
        if (!this._config.verboseLog) return

        // 仅对已开启主动发言（活跃度触发或空闲触发）的会话输出判断日志。
        // 未配置或未开启主动发言的群聊/私聊一律静默，避免对无关会话的每条消息都刷日志造成阻塞。
        if (!(payload.activityEnabled || payload.idleEnabled)) return

        const activityPart = `activity={enabled:${payload.activityEnabled},score:${payload.activityScore == null ? 'n/a' : payload.activityScore.toFixed(3)},threshold:${payload.activityThreshold == null ? 'n/a' : payload.activityThreshold.toFixed(3)},messageCount:${payload.messageCount},messageInterval:${payload.messageInterval ?? 'n/a'},triggered:${payload.activityTriggered}}`
        const idlePart = `idle={enabled:${payload.idleEnabled},idleMinutes:${payload.idleMinutes.toFixed(2)},intervalMinutes:${payload.idleIntervalMinutes ?? 'n/a'},eligible:${payload.idleEligible}}`
        const guaranteedPart = `guaranteed={enabled:${payload.guaranteedEnabled},minutes:${payload.guaranteedMinutes ?? 'n/a'},baseType:${payload.guaranteedBaseType},baseTime:${payload.guaranteedBaseTime},firstEligibleMessageTime:${payload.guaranteedFirstEligibleMessageTime},lastProactiveTriggerTime:${payload.guaranteedLastTriggerTime},lastEligibleMessageTime:${payload.guaranteedLastEligibleMessageTime},elapsedSeconds:${payload.guaranteedElapsedSeconds ?? 'n/a'},remainingSeconds:${payload.guaranteedRemainingSeconds ?? 'n/a'},hasEligibleMessage:${payload.guaranteedHasEligibleMessage},eligible:${payload.guaranteedEligible}}`

        this._logger.info(
            `[verboseLog][message-eval] conversationId=${payload.conversationId} guildId=${session.guildId ?? ''} userId=${session.userId ?? ''} isDirect=${session.isDirect} profile=${payload.profileType} cooldownRemainingMs=${payload.cooldownRemainingMs} responseLocked=${payload.responseLocked} ${activityPart} ${idlePart} ${guaranteedPart} finalDecision=${payload.finalDecision}${payload.triggerReason ? ` reason="${payload.triggerReason}"` : ''}`
        )
    }

    private async _buildReqText(
        session: Session,
        trigger: TriggerReason,
        hist: string,
        template?: string,
        _profile?: TriggerProfileConfig
    ): Promise<string> {
        const finalTemplate = template ?? '{history}'
        const vars = await this._buildTemplateVars(session, trigger, hist)
        return this._renderTemplate(finalTemplate, vars)
    }

    private _shouldUseHistory(template: string): boolean {
        return String(template ?? '').includes('{history}')
    }

    private _getPromptTemplate(trigger: TriggerReason, profile: TriggerProfileConfig): string {
        if (trigger.type === 'activity' && this._isGroupProfile(profile) && profile.enableActivityTrigger) {
            return profile.activityPromptTemplate ?? '{history}'
        }
        if (trigger.type === 'idle' && profile.enableIdleTrigger) {
            return profile.idlePromptTemplate ?? '{history}'
        }
        return '{history}'
    }

    private async _buildTemplateVars(
        session: Session,
        trigger: TriggerReason,
        hist: string
    ): Promise<Record<string, string>> {
        const now = new Date()
        const groupName = await this._getGroupName(session)
        const userName = this._getUserName(session)
        const idleMinutes = String(trigger.idleMinutes ?? 0)

        return {
            history: hist || '(无)',
            time: this._formatTime(now),
            date: this._formatDate(now),
            group_name: groupName,
            user_name: userName,
            idle_minutes: idleMinutes
        }
    }

    private _renderTemplate(template: string, vars: Record<string, string>): string {
        return String(template ?? '').replace(/\{([a-z_]+)\}/gi, (_match, key: string) => {
            return vars[key] ?? ''
        }).trim()
    }

    private async _getGroupName(session: Session): Promise<string> {
        if (session.isDirect || !session.guildId) return ''
        try {
            const guild = await session.bot.getGuild(session.guildId)
            return guild?.name ?? session.event?.guild?.name ?? ''
        } catch {
            return session.event?.guild?.name ?? ''
        }
    }

    private _getUserName(session: Session): string {
        return session.author?.nick
            || session.author?.name
            || session.username
            || session.userId
            || ''
    }

    private _formatTime(date: Date): string {
        return date.toLocaleTimeString('zh-CN', { hour12: false })
    }

    private _formatDate(date: Date): string {
        const weekdayMap = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
        const y = date.getFullYear()
        const m = String(date.getMonth() + 1).padStart(2, '0')
        const d = String(date.getDate()).padStart(2, '0')
        const w = weekdayMap[date.getDay()]
        return `${y}-${m}-${d} ${w}`
    }

    private async _fmtHist(msgs: ChatMessage[], profile?: TriggerProfileConfig): Promise<{ txt: string; imgs: string[] }> {
        if (!msgs.length) return { txt: '', imgs: [] }

        const lines = msgs.map((m) => {
            const groupProfile: GroupTriggerConfig | null = this._isGroupProfile(profile ?? null)
                ? (profile as GroupTriggerConfig)
                : null

            const messageIdPrefix = groupProfile
                && groupProfile.enableActivityTrigger
                && groupProfile.enableQuoteReplyByMessageId
                && m.messageId
                ? `[message_id=${m.messageId}]`
                : ''

            return `${messageIdPrefix}[${this._formatTimestamp(m.timestamp)}] ${m.name}(${m.id}): ${(m.content || '').trim()}`
        })

        const imgs = await this._resolveImageSources(msgs)
        return { txt: lines.join('\n'), imgs }
    }

    private _mkEls(txt: string, imgs: string[]) {
        const els: any[] = [h.text(txt)]
        for (const u of imgs) {
            els.push(h.image(u))
        }
        return els
    }

    private _updateStateAfterResponse(state: ConversationState, profile: TriggerProfileConfig): void {
        const now = Date.now()
        state.lastTriggerTime = now
        state.lastProactiveTriggerTime = now
        state.firstProactiveEligibleMessageTime = 0
        state.messageCount = 0
        if (this._isGroupProfile(profile) && profile.enableActivityTrigger) {
            this._activityScorer.adjustThreshold(state, profile)
        }
        this._markDirty()
    }

    private _getConversationId(session: Session): string {
        return session.isDirect
            ? `private:${session.userId}`
            : `group:${session.guildId}`
    }

    /**
     * 根据 session 获取配置
     * 优先级：精确匹配 > 应用默认配置列表 + default 配置模板
     */
    private _getProfileBySession(session: Session): TriggerProfileConfig | null {
        if (session.isDirect) {
            if (!session.userId) return null

            // 1. 首先查找是否有精确匹配的配置（排除 "default"）
            const exactConfig = this._config.privateConfigs.find(
                item => item.userId === session.userId && item.userId !== 'default'
            )
            if (exactConfig) return exactConfig

            // 2. 检查是否在应用默认配置列表中
            if (this._config.applyDefaultPrivateConfigs.includes(session.userId)) {
                // 查找 default 配置模板
                const defaultConfig = this._config.privateConfigs.find(item => item.userId === 'default')
                if (defaultConfig) return defaultConfig
            }

            return null
        }

        if (!session.guildId) return null

        // 1. 首先查找是否有精确匹配的配置（排除 "default"）
        const exactConfig = this._config.groupConfigs.find(
            item => item.guildId === session.guildId && item.guildId !== 'default'
        )
        if (exactConfig) return exactConfig

        // 2. 检查是否在应用默认配置列表中
        if (this._config.applyDefaultGroupConfigs.includes(session.guildId)) {
            // 查找 default 配置模板
            const defaultConfig = this._config.groupConfigs.find(item => item.guildId === 'default')
            if (defaultConfig) return defaultConfig
        }

        return null
    }

    /**
     * 根据 conversationId 获取配置
     * 优先级：精确匹配 > 应用默认配置列表 + default 配置模板
     */
    private _getProfileByConversationId(conversationId: string): TriggerProfileConfig | null {
        if (conversationId.startsWith('private:')) {
            const userId = conversationId.slice('private:'.length)
            
            // 1. 首先查找是否有精确匹配的配置（排除 "default"）
            const exactConfig = this._config.privateConfigs.find(
                item => item.userId === userId && item.userId !== 'default'
            )
            if (exactConfig) return exactConfig
            
            // 2. 检查是否在应用默认配置列表中
            if (this._config.applyDefaultPrivateConfigs.includes(userId)) {
                // 查找 default 配置模板
                const defaultConfig = this._config.privateConfigs.find(item => item.userId === 'default')
                if (defaultConfig) return defaultConfig
            }
            
            return null
        }
        
        if (conversationId.startsWith('group:')) {
            const guildId = conversationId.slice('group:'.length)
            
            // 1. 首先查找是否有精确匹配的配置（排除 "default"）
            const exactConfig = this._config.groupConfigs.find(
                item => item.guildId === guildId && item.guildId !== 'default'
            )
            if (exactConfig) return exactConfig
            
            // 2. 检查是否在应用默认配置列表中
            if (this._config.applyDefaultGroupConfigs.includes(guildId)) {
                // 查找 default 配置模板
                const defaultConfig = this._config.groupConfigs.find(item => item.guildId === 'default')
                if (defaultConfig) return defaultConfig
            }
            
            return null
        }
        
        return null
    }

    private _isApplicable(session: Session): boolean {
        return !!this._getProfileBySession(session)
    }

    private _getOrCreateState(conversationId: string, profile: TriggerProfileConfig): ConversationState {
        if (!this._conversationStates[conversationId]) {
            this._conversationStates[conversationId] = {
                lastMessageTime: 0,
                firstProactiveEligibleMessageTime: 0,
                lastProactiveEligibleMessageTime: 0,
                currentThreshold: this._isGroupProfile(profile) && profile.enableActivityTrigger
                    ? (profile.activityLowerLimit ?? 0.85)
                    : 1,
                lastActivityScore: 0,
                lastTriggerTime: 0,
                lastProactiveTriggerTime: 0,
                lastFailureTime: 0,
                failureCount: 0,
                retryDisabled: false,
                responseLocked: false,
                messageCount: 0
            }
            this._markDirty()
        }
        return this._conversationStates[conversationId]
    }

    private _isDirectChatlunaTriggerMessage(session: Session): boolean {
        const chatlunaConfig = this.ctx.chatluna?.currentConfig
        const botId = String(session.bot?.userId ?? session.selfId ?? '')

        if (!botId) return false

        if ((session as any).stripped?.atSelf) return true

        const elements = (session.elements ?? []) as any[]
        if (elements.some((element) =>
            element?.type === 'at' &&
            String(element?.attrs?.id ?? element?.attrs?.userId ?? '') === botId
        )) {
            return true
        }

        if (
            chatlunaConfig?.allowQuoteReply &&
            String(session.quote?.user?.id ?? '') === botId
        ) {
            return true
        }

        const text = h.select(session.elements ?? [], 'text').join('').trimStart()
        const botNames = Array.isArray(chatlunaConfig?.botNames)
            ? chatlunaConfig.botNames.filter(Boolean)
            : []

        if (
            chatlunaConfig?.isNickname &&
            botNames.some((name) => text.startsWith(name))
        ) {
            return true
        }

        if (
            chatlunaConfig?.isNickNameWithContent &&
            botNames.some((name) => text.includes(name))
        ) {
            return true
        }

        return false
    }

    private _recordTimestamp(conversationId: string, timestamp: number): void {
        if (!this._messageTimestamps[conversationId]) {
            this._messageTimestamps[conversationId] = []
        }
        this._messageTimestamps[conversationId].push(timestamp)
        if (this._messageTimestamps[conversationId].length > this.MAX_TIMESTAMPS) {
            this._messageTimestamps[conversationId] = this._messageTimestamps[conversationId].slice(-this.MAX_TIMESTAMPS)
        }
        this._markDirty()
    }

    private async _addChatMessage(conversationId: string, session: Session): Promise<boolean> {
        this._ensureMessageBucket(conversationId)

        const profile = this._getProfileByConversationId(conversationId) ?? null
        const imageUrls = this._pickImageUrls(session)

        if ((profile?.maxRequestImages ?? 3) <= 0 && imageUrls.length > 0) {
            this._debug(
                `[addChatMessage] skip image message because maxRequestImages=0, conversationId=${conversationId}, imageCount=${imageUrls.length}, proactiveEligible=false`
            )
            return false
        }

        const images = this._cacheImages(conversationId, imageUrls)

        const msg: ChatMessage = {
            id: session.author?.id ?? session.userId ?? 'unknown',
            name:
                session.author?.name ??
                session.author?.nick ??
                session.username ??
                'Unknown',
            content: this._normalizeMessageContent(session.content || '', images),
            timestamp: session.timestamp || Date.now(),
            messageId: session.messageId ?? undefined,
            ...(images.length ? { imgs: images } : {})
        }

        const cap = Math.max(1, profile?.historyMessageLimit || this.MAX_MESSAGES)
        this._appendChatMessage(conversationId, msg, cap)
        return true
    }

    private _ensureMessageBucket(conversationId: string): void {
        if (!this._chatMessages[conversationId]) {
            this._chatMessages[conversationId] = []
        }
    }

    private _appendChatMessage(conversationId: string, message: ChatMessage, limit: number): void {
        this._chatMessages[conversationId].push(message)
        if (this._chatMessages[conversationId].length > limit) {
            this._chatMessages[conversationId] = this._chatMessages[conversationId].slice(-limit)
        }
        this._markDirty()
    }

    private _pickImageUrls(session: Session): string[] {
        const urls: string[] = []
        const seen = new Set<string>()
        const elements = (session.elements ?? []) as any[]

        for (const element of elements) {
            if (element?.type !== 'img') continue
            const url = String(element?.attrs?.url ?? element?.attrs?.src ?? '').trim()
            if (!url || seen.has(url)) continue
            seen.add(url)
            urls.push(url)
        }

        return urls
    }

    private _getImageKey(url: string): string {
        return createHash('sha1').update(url).digest('hex').slice(0, 8)
    }

    private _getConversationImageDir(conversationId: string): string {
        const safeConversationId = conversationId.replace(/[:/\\]/g, '_')
        return path.join(this._imageCacheDir, safeConversationId)
    }

    private _getImageFilePath(conversationId: string, imageKey: string, ext: string): string {
        return path.join(this._getConversationImageDir(conversationId), `${imageKey}${ext}`)
    }

    private _cacheImages(conversationId: string, urls: string[]): CachedImageRef[] {
        // 同步登记引用（暂无 localPath，触发时若文件尚未就绪会回退原始 URL），
        // 下载异步完成后补写 localPath——避免慢图把中间件链（含 chatluna 对该消息的常规处理）拖住数分钟
        return urls.map((url) => {
            const ref: CachedImageRef = { key: this._getImageKey(url), originalUrl: url }
            void this._cacheImage(conversationId, url)
                .then((localPath) => {
                    if (localPath) ref.localPath = localPath
                })
                .catch(() => {})
            return ref
        })
    }

    private async _cacheImage(conversationId: string, url: string): Promise<string | undefined> {
        const key = this._getImageKey(url)
        const ext = this._getImageExtension(url)
        const localPath = this._getImageFilePath(conversationId, key, ext)

        try {
            await fs.mkdir(this._getConversationImageDir(conversationId), { recursive: true })
            await fs.access(localPath)
            return localPath
        } catch {}

        try {
            // 老版本 Node（<17.3）无 AbortSignal.timeout，退化为无超时
            const timeoutSignal = typeof AbortSignal.timeout === 'function'
                ? AbortSignal.timeout(15_000)
                : undefined
            const response = await fetch(url, timeoutSignal ? { signal: timeoutSignal } : {})
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`)
            }

            const buffer = Buffer.from(await response.arrayBuffer())
            await fs.writeFile(localPath, buffer)
            return localPath
        } catch (error) {
            this._logger.warn(
                `[cacheImage] 图片缓存失败，conversationId=${conversationId}, key=${key}, url=${url}, error=${error}`
            )
            return undefined
        }
    }

    private _getImageExtension(url: string): string {
        try {
            const pathname = new URL(url).pathname
            const ext = path.extname(pathname).toLowerCase()
            return ext && /^[.a-z0-9]+$/i.test(ext) ? ext : '.bin'
        } catch {
            return '.bin'
        }
    }

    private _normalizeMessageContent(raw: string, images: CachedImageRef[]): string {
        let text = String(raw ?? '')

        text = text
            .replace(/\[CQ:image,[^\]]*]/gi, '')
            .replace(/<img\b[^>]*\/?>/gi, '')
            .replace(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi, '')
            .replace(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?\S*)?/gi, '')
            .replace(/https?:\/\/\S*\/download\?[^\s"'<>]+/gi, '')
            .replace(/\[图片:[^\]]+]/g, '')
            .replace(/\s+/g, ' ')
            .trim()

        if (images.length <= 0) return text

        const marks = images.map((image) => `[图片:${image.key}]`).join(' ')
        return [text, marks].filter(Boolean).join(' ').trim()
    }

    private async _resolveImageSources(messages: ChatMessage[]): Promise<string[]> {
        const sources: string[] = []
        const seen = new Set<string>()

        for (const message of messages) {
            for (const image of message.imgs ?? []) {
                if (image.localPath) {
                    const dataUrl = await this._readCachedImageAsDataUrl(image)
                    if (dataUrl) {
                        const dataUrlKey = `data:${image.key}`
                        if (!seen.has(dataUrlKey)) {
                            seen.add(dataUrlKey)
                            sources.push(dataUrl)
                        }
                        continue
                    }
                }

                if (!seen.has(image.originalUrl)) {
                    seen.add(image.originalUrl)
                    sources.push(image.originalUrl)
                }
            }
        }

        return sources
    }

    private async _readCachedImageAsDataUrl(image: CachedImageRef): Promise<string | null> {
        if (!image.localPath) return null

        try {
            const buffer = await fs.readFile(image.localPath)
            const mimeType = this._detectImageMimeType(buffer)
            if (!mimeType) {
                this._logger.warn(
                    `[resolveImageSources] 无法识别本地缓存图片类型，fallback 到原始 URL，key=${image.key}, localPath=${image.localPath}`
                )
                return null
            }

            return `data:${mimeType};base64,${buffer.toString('base64')}`
        } catch (error) {
            this._logger.warn(
                `[resolveImageSources] 读取本地缓存图片失败，fallback 到原始 URL，key=${image.key}, localPath=${image.localPath}, error=${error}`
            )
            return null
        }
    }

    private _detectImageMimeType(buffer: Buffer): string | null {
        if (buffer.length >= 8 &&
            buffer[0] === 0x89 &&
            buffer[1] === 0x50 &&
            buffer[2] === 0x4e &&
            buffer[3] === 0x47 &&
            buffer[4] === 0x0d &&
            buffer[5] === 0x0a &&
            buffer[6] === 0x1a &&
            buffer[7] === 0x0a
        ) {
            return 'image/png'
        }

        if (buffer.length >= 3 &&
            buffer[0] === 0xff &&
            buffer[1] === 0xd8 &&
            buffer[2] === 0xff
        ) {
            return 'image/jpeg'
        }

        if (buffer.length >= 6) {
            const signature = buffer.subarray(0, 6).toString('ascii')
            if (signature === 'GIF87a' || signature === 'GIF89a') {
                return 'image/gif'
            }
        }

        if (buffer.length >= 12 &&
            buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
            buffer.subarray(8, 12).toString('ascii') === 'WEBP'
        ) {
            return 'image/webp'
        }

        if (buffer.length >= 2 &&
            buffer[0] === 0x42 &&
            buffer[1] === 0x4d
        ) {
            return 'image/bmp'
        }

        return null
    }

    private _formatVerboseImageRef(source: string): string {
        if (source.startsWith('data:image')) {
            const mimeMatch = source.match(/^data:([^;]+);base64,/)
            const mimeType = mimeMatch?.[1] ?? 'image/unknown'
            const base64Length = source.length - (mimeMatch?.[0].length ?? 0)
            return `data-url:${mimeType};base64Length=${base64Length}`
        }

        return source
    }

    private _formatElementPreview(element: any): string {
        if (element?.type === 'img' || element?.type === 'image') {
            const source = String(element?.attrs?.url ?? element?.attrs?.src ?? '')
            return `<${element.type} src="${this._formatVerboseImageRef(source)}"/>`
        }

        return element?.toString?.(true) ?? String(element)
    }

    private async _clearConversationImageCache(conversationId: string): Promise<void> {
        try {
            await fs.rm(this._getConversationImageDir(conversationId), { recursive: true, force: true })
        } catch (error) {
            this._logInfo(
                `[clearConversationImageCache] 清理图片缓存失败，conversationId=${conversationId}, error=${error}`
            )
        }
    }

    private _getRecentHistoryMessages(
        conversationId: string,
        profile: TriggerProfileConfig,
        options?: {
            sinceTimestamp?: number
            excludeDirectTriggers?: boolean
        }
    ): ChatMessage[] {
        const messages = this._chatMessages[conversationId]
        if (!messages || messages.length === 0) return []

        const sinceTimestamp = options?.sinceTimestamp ?? 0
        const excludeDirectTriggers = options?.excludeDirectTriggers ?? false

        let filtered = messages
        if (sinceTimestamp > 0) {
            filtered = filtered.filter(msg => msg.timestamp > sinceTimestamp)
        }
        if (excludeDirectTriggers) {
            filtered = filtered.filter(msg => !msg.isDirectTrigger)
        }

        return filtered.slice(-profile.historyMessageLimit)
    }

    private _formatTimestamp(timestamp: number): string {
        return new Date(timestamp).toLocaleString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        })
    }

    private _markDirty(): void {
        this._dirty = true
        if (this._isSaving) {
            this._pendingSave = true
        }
    }

    /**
     * 淘汰已不在配置范围内的会话键（群/私聊被移除或不再应用默认模板），
     * 避免 _conversationStates/_chatMessages/_messageTimestamps/_sessions 与状态文件只增不减。
     */
    private _pruneStaleConversations(): void {
        const conversationIds = new Set([
            ...Object.keys(this._conversationStates),
            ...Object.keys(this._chatMessages),
            ...Object.keys(this._messageTimestamps),
            ...Object.keys(this._sessions)
        ])

        for (const conversationId of conversationIds) {
            if (this._getProfileByConversationId(conversationId)) continue
            delete this._conversationStates[conversationId]
            delete this._chatMessages[conversationId]
            delete this._messageTimestamps[conversationId]
            delete this._sessions[conversationId]
            this._lastTickLog.delete(conversationId)
            this._dirty = true
        }
    }

    private async _loadState(): Promise<void> {
        try {
            const raw = await fs.readFile(this._stateFilePath, 'utf8')
            const parsed = JSON.parse(raw) as PersistedState
            this._conversationStates = this._sanitizeConversationStates(parsed?.conversationStates ?? {})
            this._messageTimestamps = this._sanitizeTimestamps(parsed?.messageTimestamps ?? {})
            this._chatMessages = this._sanitizeChatMessages(parsed?.chatMessages ?? {})
            this._logInfo(`已加载 proactive 状态文件：${this._stateFilePath}`)
        } catch (error) {
            this._debug(`未加载到持久化 proactive 状态：${error}`)
        }
    }

    private async _saveState(force = false): Promise<void> {
        if (!force && !this._dirty) return
        if (this._isSaving) {
            this._pendingSave = true
            return
        }

        const task = this._runSaveLoop()
        this._saveInFlight = task
        try {
            await task
        } finally {
            this._saveInFlight = null
        }
    }

    private async _runSaveLoop(): Promise<void> {
        this._isSaving = true
        try {
            do {
                // prune 放在标志复位之前：删除结果直接体现在本轮序列化对象里，
                // 避免复位后再置脏导致配置变更后多跑一轮"全量序列化 + 30s 等待"
                this._pruneStaleConversations()
                this._pendingSave = false
                this._dirty = false
                const payload: PersistedState = {
                    version: 1,
                    conversationStates: this._conversationStates,
                    messageTimestamps: this._messageTimestamps,
                    chatMessages: this._chatMessages
                }
                await fs.mkdir(path.dirname(this._stateFilePath), { recursive: true })
                await fs.writeFile(this._stateFilePath, JSON.stringify(payload), 'utf8')
                this._lastSaveTime = Date.now()
                // 序列化期间有新变更时，与上次全量序列化至少间隔 MIN_SAVE_INTERVAL_MS，
                // 避免活跃群把 do-while 变成无间歇的 stringify 热循环（大字符串churn导致 RSS 攀升）
                if (this._pendingSave || this._dirty) {
                    const waitMs = this.MIN_SAVE_INTERVAL_MS - (Date.now() - this._lastSaveTime)
                    if (waitMs > 0) {
                        await new Promise<void>((resolve) => {
                            // stop() 通过 _saveWakeUp 立即唤醒，避免最后的强制保存被睡眠吞掉
                            this._saveWakeUp = resolve
                            const timer = setTimeout(resolve, waitMs) as unknown as { unref?: () => void }
                            timer.unref?.()
                        })
                        this._saveWakeUp = null
                    }
                }
            } while (this._pendingSave || this._dirty)
        } catch (error) {
            this._logger.error(`保存 proactive 状态失败：${error}`)
            this._dirty = true
        } finally {
            this._isSaving = false
            this._saveWakeUp = null
        }
    }

    private _sanitizeConversationStates(
        states: Record<string, ConversationState>
    ): Record<string, ConversationState> {
        const result: Record<string, ConversationState> = {}

        for (const [conversationId, state] of Object.entries(states)) {
            if (!state || typeof state !== 'object') continue

            const profile = this._getProfileByConversationId(conversationId)
            const isGroupProfile = this._isGroupProfile(profile)
            const lowerLimit = isGroupProfile ? (profile.activityLowerLimit ?? 0.85) : 0.85
            const upperLimit = isGroupProfile ? (profile.activityUpperLimit ?? 0.85) : 0.85
            const minThreshold = isGroupProfile && profile.enableActivityTrigger
                ? Math.min(lowerLimit, upperLimit)
                : 1
            const maxThreshold = isGroupProfile && profile.enableActivityTrigger
                ? Math.max(lowerLimit, upperLimit)
                : 1

            result[conversationId] = {
                lastMessageTime: Number(state.lastMessageTime) || 0,
                firstProactiveEligibleMessageTime: Number((state as Partial<ConversationState>).firstProactiveEligibleMessageTime) || 0,
                lastProactiveEligibleMessageTime: Number((state as Partial<ConversationState>).lastProactiveEligibleMessageTime) || 0,
                currentThreshold: Math.max(
                    minThreshold,
                    Math.min(
                        maxThreshold,
                        Number(state.currentThreshold) || ((isGroupProfile && profile.enableActivityTrigger) ? lowerLimit : 1)
                    )
                ),
                lastActivityScore: Number(state.lastActivityScore) || 0,
                lastTriggerTime: Number(state.lastTriggerTime) || 0,
                lastProactiveTriggerTime: Number((state as Partial<ConversationState>).lastProactiveTriggerTime) || 0,
                lastFailureTime: Number((state as Partial<ConversationState>).lastFailureTime) || 0,
                failureCount: Number((state as Partial<ConversationState>).failureCount) || 0,
                retryDisabled: Boolean((state as Partial<ConversationState>).retryDisabled),
                responseLocked: false,
                messageCount: Number(state.messageCount) || 0
            }
        }

        return result
    }

    private _sanitizeTimestamps(
        timestamps: Record<string, number[]>
    ): Record<string, number[]> {
        const result: Record<string, number[]> = {}
        for (const [conversationId, values] of Object.entries(timestamps)) {
            if (!Array.isArray(values)) continue
            result[conversationId] = values
                .map(v => Number(v))
                .filter(v => Number.isFinite(v) && v > 0)
                .slice(-this.MAX_TIMESTAMPS)
        }
        return result
    }

    private _sanitizeChatMessages(
        messagesMap: Record<string, ChatMessage[]>
    ): Record<string, ChatMessage[]> {
        const result: Record<string, ChatMessage[]> = {}
        for (const [conversationId, messages] of Object.entries(messagesMap)) {
            if (!Array.isArray(messages)) continue
            result[conversationId] = messages
                .filter(msg => msg && typeof msg === 'object')
                .map(msg => {
                    const imgs: CachedImageRef[] = Array.isArray(msg.imgs)
                        ? msg.imgs
                            .map((item) => {
                                if (typeof item === 'string') {
                                    return {
                                        key: this._getImageKey(item),
                                        originalUrl: item
                                    }
                                }

                                if (!item || typeof item !== 'object') return null

                                const key = String(item.key ?? '').trim()
                                const originalUrl = String(item.originalUrl ?? '').trim()
                                const localPath = item.localPath == null ? undefined : String(item.localPath)

                                if (!key || !originalUrl) return null

                                return {
                                    key,
                                    originalUrl,
                                    ...(localPath ? { localPath } : {})
                                }
                            })
                            .filter((item): item is CachedImageRef => !!item)
                        : []

                    return {
                        id: String(msg.id ?? ''),
                        name: String(msg.name ?? 'Unknown'),
                        content: this._normalizeMessageContent(String(msg.content ?? ''), imgs),
                        timestamp: Number(msg.timestamp) || Date.now(),
                        messageId: msg.messageId == null ? undefined : String(msg.messageId),
                        imgs,
                        ...(msg.isDirectTrigger ? { isDirectTrigger: true } : {})
                    }
                })
                .slice(-Math.max(1, this._getProfileByConversationId(conversationId)?.historyMessageLimit || this.MAX_MESSAGES))
        }
        return result
    }

    private _isGroupProfile(profile: TriggerProfileConfig | null): profile is GroupTriggerConfig {
        return !!profile && 'enableActivityTrigger' in profile
    }

    /**
     * 基础运营日志（启停、room 补建、状态加载、触发成功原因等）。
     * 基础日志模式(debugLog)或详细日志模式(verboseLog)开启时输出；默认模式下静默。
     */
    private _logInfo(message: string): void {
        if (!this._config.debugLog && !this._config.verboseLog) return
        this._logger.info(message)
    }

    /**
     * 详细判断日志（每条消息/每次调度的中间判断）。
     * 仅当 verboseLog 开启时输出，默认日志模式下完全静默，避免对活跃群刷日志造成阻塞。
     */
    private _debug(message: string): void {
        if (!this._config.verboseLog) return
        this._logger.info(message)
    }
}
