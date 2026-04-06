import { Context, Service, Session, Logger, Next, h } from 'koishi'
import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { Config, GroupTriggerConfig, TriggerProfileConfig, PrivateTriggerConfig } from './config'
import { ActivityScorer } from './activity'
import { IdleScheduler } from './scheduler'
import { CachedImageRef, ChatMessage, ConversationState, TriggerReason } from './types'
import {
    createConversationRoom,
    getConversationRoomCount,
    getTemplateConversationRoom,
    queryJoinedConversationRoom,
    resolveConversationRoom
} from 'koishi-plugin-chatluna/chains'
import { KoishiChatMessageHistory } from 'koishi-plugin-chatluna/llm-core/memory/message'
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
    participantUserIds?: string[]
    resetRoomId?: number
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
    private _stateFilePath: string
    private _imageCacheDir: string

    // conversationId → after-chat 回调动作
    private _pendingBroadcast: Map<string, PendingAfterChatAction> = new Map()
    private _knownUserRooms: Set<string> = new Set()

    private readonly MAX_MESSAGES = 100
    private readonly MAX_TIMESTAMPS = 200

    constructor(ctx: Context, private _config: Config) {
        super(ctx, 'chatluna_proactive')
        this._activityScorer = new ActivityScorer()
        this._idleScheduler = new IdleScheduler()
        this._logger = ctx.logger('chatluna-proactive')
        this._stateFilePath = path.resolve(ctx.baseDir || process.cwd(), 'data', 'chatluna-proactive-trigger-state.json')
        this._imageCacheDir = path.resolve(ctx.baseDir || process.cwd(), 'data', 'chatluna-proactive-trigger', 'images')

        ctx.on('chatluna/after-chat', async (conversationId, _sourceMessage, responseMessage) => {
            const action = this._pendingBroadcast.get(conversationId)
            if (action) {
                this._pendingBroadcast.delete(conversationId)

                if (
                    this._config.syncToAllRooms &&
                    action.guildId &&
                    action.participantUserIds?.length
                ) {
                    await this._syncToParticipantRooms(
                        action.guildId,
                        conversationId,
                        responseMessage,
                        action.participantUserIds
                    )
                }

                if (action.resetRoomId != null) {
                    try {
                        const room = await resolveConversationRoom(this.ctx, action.resetRoomId)
                        if (room) {
                            await this._resetRoomHistory(room as ManagedRoom)
                        }
                    } catch (error) {
                        this._logger.warn(`Failed to reset proactive room ${action.resetRoomId}: ${error}`)
                    }
                }
            }

            const guildId = await this._resolveGuildIdByRoomConversationId(conversationId)
            if (guildId) {
                const pluginConversationId = `group:${guildId}`
                if (this._chatMessages[pluginConversationId]?.length) {
                    this._chatMessages[pluginConversationId] = []
                    await this._clearConversationImageCache(pluginConversationId)
                    this._markDirty()
                    this._logger.info(
                        `[after-chat][reset-group-history] conversationId=${conversationId} groupId=${guildId} reset=true`
                    )
                }
            } else {
                this._logger.debug(
                    `[after-chat][reset-group-history] conversationId=${conversationId} groupId=unknown skip`
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
        this._logger.info('ProactiveChatService 已启动')
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
        await this._saveState(true)
        this._logger.info('ProactiveChatService 已停止')
    }

    async handleMessage(session: Session, next: Next): Promise<void> {
        if (this.ctx.bots[session.uid]) { await next(); return }

        const profile = this._getProfileBySession(session)
        const conversationId = this._getConversationId(session)
        const now = session.timestamp || Date.now()

        if (!profile) {
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
                triggerReason: null,
                finalDecision: 'no-profile'
            })
            this._logger.debug(`[handleMessage] session not applicable: uid=${session.uid} guildId=${session.guildId} isDirect=${session.isDirect}`)
            await next(); return
        }

        this._sessions[conversationId] = session

        this._recordTimestamp(conversationId, now)

        if (!session.isDirect) {
            await this._addChatMessage(conversationId, session)
        }

        const state = this._getOrCreateState(conversationId, profile)
        state.lastMessageTime = now
        state.messageCount = (state.messageCount ?? 0) + 1
        state.lastFailureTime = 0
        state.failureCount = 0
        state.retryDisabled = false
        this._markDirty()

        this._logger.debug(`[handleMessage] conversationId=${conversationId} messageCount=${state.messageCount} lastActivityScore=${state.lastActivityScore?.toFixed(3)} threshold=${state.currentThreshold?.toFixed(3)}`)

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
            triggerReason: triggerReason?.reason ?? null,
            finalDecision: triggerReason
                ? `${triggerReason.type}-trigger`
                : cooldownRemainingMs > 0
                    ? 'cooldown'
                    : state.responseLocked
                        ? 'response-locked'
                        : 'skip'
        })

        if (triggerReason) {
            await this._triggerResponse(session, triggerReason, profile)
            return
        }

        await next()
    }

    private async _processSchedulerTick(): Promise<void> {
        const now = Date.now()

        for (const [conversationId, state] of Object.entries(this._conversationStates)) {
            const session = this._sessions[conversationId]
            if (!session) continue

            const profile = this._getProfileByConversationId(conversationId)
            if (!profile) continue

            const cooldownRemaining = state.lastTriggerTime
                ? profile.cooldownSeconds * 1000 - (now - state.lastTriggerTime)
                : 0

            if (cooldownRemaining > 0) {
                this._logger.debug(`[schedulerTick] ${conversationId}: in cooldown, ${Math.ceil(cooldownRemaining / 1000)}s remaining`)
                continue
            }
            if (state.responseLocked) {
                this._logger.debug(`[schedulerTick] ${conversationId}: responseLocked, skipping`)
                continue
            }
            if (state.retryDisabled) {
                this._logger.debug(`[schedulerTick] ${conversationId}: retry disabled after ${state.failureCount} consecutive failures`)
                continue
            }

            const failureCooldownRemaining = state.lastFailureTime
                ? this._config.failureCooldownSeconds * 1000 - (now - state.lastFailureTime)
                : 0

            if (failureCooldownRemaining > 0) {
                this._logger.debug(
                    `[schedulerTick] ${conversationId}: in failure cooldown, ${Math.ceil(failureCooldownRemaining / 1000)}s remaining`
                )
                continue
            }

            const idleTrigger = this._idleScheduler.shouldTrigger(state, now, profile)
            if (idleTrigger) {
                this._logger.debug(`Idle trigger for ${conversationId}: ${idleTrigger.reason}`)
                const trigger = {
                    type: 'idle' as const,
                    reason: '空闲时间触发',
                    idleMinutes: idleTrigger.silenceMinutes ?? 0
                }
                if (this._config.debugLog) {
                    this._logger.info(
                        `[debugLog][trigger] conversationId=${conversationId} type=${trigger.type} reason=${trigger.reason} idleMinutes=${trigger.idleMinutes}`
                    )
                }
                await this._triggerResponse(session, trigger, profile)
                this._markDirty()
            } else if (state.lastMessageTime && profile.enableIdleTrigger) {
                const idleMs = now - state.lastMessageTime
                const waitMs = (profile.idleIntervalMinutes ?? 180) * 60 * 1000
                this._logger.debug(`[schedulerTick] ${conversationId}: idle=${Math.floor(idleMs / 1000)}s, need=${Math.floor(waitMs / 1000)}s`)
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
            this._logger.debug(`[evaluateTriggers] ${conversationId}: in cooldown`)
            return null
        }
        if (state.responseLocked) {
            this._logger.debug(`[evaluateTriggers] ${conversationId}: responseLocked`)
            return null
        }

        if (this._isGroupProfile(profile) && profile.enableActivityTrigger) {
            const timestamps = this._messageTimestamps[conversationId] || []
            const score = this._activityScorer.calculateScore(timestamps, state)
            state.lastActivityScore = score

            this._logger.debug(`[evaluateTriggers] ${conversationId}: activityScore=${score.toFixed(3)} threshold=${state.currentThreshold.toFixed(3)}`)

            if (this._activityScorer.shouldTrigger(score, state.currentThreshold)) {
                const trigger = {
                    type: 'activity' as const,
                    reason: '活跃度触发'
                }
                if (this._config.debugLog) {
                    this._logger.info(
                        `[debugLog][trigger] conversationId=${conversationId} type=${trigger.type} reason=${trigger.reason} activityScore=${score.toFixed(3)} threshold=${state.currentThreshold.toFixed(3)}`
                    )
                }
                return trigger
            }

            const messageInterval = profile.activityMessageInterval ?? 20
            if (messageInterval > 0 && state.messageCount >= messageInterval) {
                this._logger.debug(`[evaluateTriggers] ${conversationId}: messageInterval reached (${state.messageCount}/${messageInterval})`)
                const trigger = {
                    type: 'activity' as const,
                    reason: '消息计数触发'
                }
                if (this._config.debugLog) {
                    this._logger.info(
                        `[debugLog][trigger] conversationId=${conversationId} type=${trigger.type} reason=${trigger.reason} messageCount=${state.messageCount} messageInterval=${messageInterval}`
                    )
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
            const msgs = useHist ? this._getRecentHistoryMessages(conversationId, profile) : []
            const execution = await this._resolveExecutionContext(session, trigger, msgs)
            if (!execution?.room) {
                this._logger.warn(
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
                const pendingAction: PendingAfterChatAction = {}
                if (!session.isDirect && trigger.type === 'activity') {
                    pendingAction.guildId = session.guildId
                    pendingAction.participantUserIds = this._collectParticipantUserIds(msgs)
                }
                if (resetAfterChat) {
                    pendingAction.resetRoomId = room.roomId
                }
                if (pendingAction.guildId || pendingAction.resetRoomId != null) {
                    pendingConversationId = room.conversationId
                    this._pendingBroadcast.set(room.conversationId, pendingAction)
                }
            }

            this._logger.info(`开始执行主动触发响应，conversationId=${conversationId}，reason=${trigger.reason}`)

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
                        injectedImages: requestImages
                    },
                    commandOptions: {
                        is_proactive: true,
                        messagePreview: proactiveElements.map((el) => el?.toString?.(true) ?? String(el))
                    }
                }

                this._logger.info(
                    `[verboseLog][proactive-request] ${JSON.stringify(verboseSnapshot, null, 2)}`
                )
            }

            await this.ctx.chatluna.chatChain.receiveCommand(
                requestSession,
                '',
                commandOptions
            )

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

    private async _syncToParticipantRooms(
        guildId: string,
        excludeConversationId: string,
        aiMessage: any,
        participantUserIds: string[]
    ): Promise<void> {
        if (participantUserIds.length === 0) return

        const uniqueParticipantIds = [...new Set(participantUserIds)]
        const rooms: ManagedRoom[] = []

        for (const userId of uniqueParticipantIds) {
            try {
                const room = await this._ensureUserRoomForGroup(userId, guildId)
                if (room && room.conversationId && room.conversationId !== excludeConversationId) {
                    rooms.push(room)
                }
            } catch (e) {
                this._logger.warn(`Failed to ensure participant room for user ${userId} in guild ${guildId}: ${e}`)
            }
        }

        const uniqueRooms = rooms.filter((room, index, arr) =>
            arr.findIndex(item => item.roomId === room.roomId) === index
        )

        if (uniqueRooms.length === 0) return

        this._logger.debug(`Syncing proactive message to ${uniqueRooms.length} participant rooms in guild ${guildId}`)

        for (const room of uniqueRooms) {
            try {
                const history = new KoishiChatMessageHistory(this.ctx, room.conversationId, 10000)
                await history.loadConversation()
                await history.addMessage(aiMessage as any)
            } catch (e) {
                this._logger.warn(`Failed to sync to participant room ${room.roomId} (${room.conversationId}): ${e}`)
            }
        }
    }

    private async _resolveExecutionContext(
        session: Session,
        trigger: TriggerReason,
        messages: ChatMessage[] = []
    ): Promise<{ room: ManagedRoom | null; requestSession: Session; resetAfterChat: boolean }> {
        if (trigger.type === 'idle' && !session.isDirect) {
            const room = await this._ensureProactiveRoomForGuild(session)
            if (room) {
                this._logger.info(
                    `[resolveExecutionContext] idle resolved proactive room, guildId=${session.guildId}, roomId=${room.roomId}, conversationId=${room.conversationId}`
                )
                return {
                    room,
                    requestSession: this._createProactiveSession(session),
                    resetAfterChat: true
                }
            }

            this._logger.warn(
                `[resolveExecutionContext] 空闲触发未能解析 proactive room，guildId=${session.guildId}, userId=${session.userId}`
            )
        }

        if (trigger.type === 'activity' && !session.isDirect) {
            if (!session.userId || !session.guildId) {
                this._logger.warn(
                    `[resolveExecutionContext] 活跃度触发缺少必要会话标识，guildId=${session.guildId}, userId=${session.userId}`
                )
                return {
                    room: null,
                    requestSession: session,
                    resetAfterChat: false
                }
            }

            const room = await this._ensureUserRoomForGroup(session.userId, session.guildId)
            if (room) {
                this._logger.info(
                    `[resolveExecutionContext] 活跃度触发已解析用户 room，guildId=${session.guildId}, userId=${session.userId}, roomId=${room.roomId}, conversationId=${room.conversationId}`
                )
                return {
                    room,
                    requestSession: session,
                    resetAfterChat: false
                }
            }

            this._logger.warn(
                `[resolveExecutionContext] 活跃度触发未能解析或补建用户 room，guildId=${session.guildId}, userId=${session.userId}`
            )
        }

        const room = await queryJoinedConversationRoom(this.ctx, session)
        if (room) {
            this._logger.info(
                `[resolveExecutionContext] 已命中 joined room 回退路径，guildId=${session.guildId}, userId=${session.userId}, roomId=${room.roomId}, conversationId=${room.conversationId}`
            )
        } else {
            this._logger.warn(
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

        const userRecords = await this.ctx.database.get('chathub_user', {
            userId: proactiveUserId,
            groupId: guildId
        })

        if (userRecords.length > 0) {
            const room = await resolveConversationRoom(this.ctx, userRecords[0].defaultRoomId)
            if (room) return room as ManagedRoom
        }

        const templateRoom = await this._findAnyUsableRoomInGuild(guildId)
            ?? await getTemplateConversationRoom(this.ctx, this.ctx.scope.parent.config)

        if (!templateRoom) {
            this._logger.warn(`Cannot provision proactive room for guild ${guildId}: no template room available`)
            return null
        }

        const room: ManagedRoom = {
            conversationId: randomUUID(),
            model: templateRoom.model,
            preset: templateRoom.preset,
            roomName: `Proactive Trigger Room ${session.guildId}`,
            roomMasterId: proactiveUserId,
            roomId: (await getConversationRoomCount(this.ctx)) + 1,
            visibility: 'private',
            chatMode: templateRoom.chatMode,
            password: null,
            updatedTime: new Date()
        }

        await createConversationRoom(this.ctx, this._createProactiveSession(session), room as any)
        this._logger.info(`Provisioned proactive room ${room.roomId} for guild ${guildId}`)
        return room
    }

    private async _findAnyUsableRoomInGuild(guildId: string): Promise<ManagedRoom | null> {
        const groupMembers = await this.ctx.database.get('chathub_room_group_member', { groupId: guildId })
        if (groupMembers.length === 0) return null

        const roomIds = [...new Set(groupMembers.map(item => item.roomId))]
        const rooms = await this.ctx.database.get('chathub_room', { roomId: { $in: roomIds } as any })
        const room = rooms.find(item => item.conversationId && item.model && item.preset && item.chatMode)
        return (room as ManagedRoom) ?? null
    }

    private async _ensureUserRoomForGroup(userId: string, guildId: string): Promise<ManagedRoom | null> {
        const existingUserRecords = await this.ctx.database.get('chathub_user', {
            userId,
            groupId: guildId
        })

        if (existingUserRecords.length > 0) {
            this._logger.info(
                `[ensureUserRoomForGroup] found chathub_user record, guildId=${guildId}, userId=${userId}, defaultRoomId=${existingUserRecords[0].defaultRoomId}`
            )
            const existingRoom = await resolveConversationRoom(this.ctx, existingUserRecords[0].defaultRoomId)
            if (existingRoom) {
                this._logger.info(
                    `[ensureUserRoomForGroup] 已解析现有 room，guildId=${guildId}, userId=${userId}, roomId=${existingRoom.roomId}, conversationId=${existingRoom.conversationId}`
                )
                this._knownUserRooms.add(`${guildId}:${userId}`)
                return existingRoom as ManagedRoom
            }

            this._logger.warn(
                `[ensureUserRoomForGroup] defaultRoomId exists but room missing, guildId=${guildId}, userId=${userId}, defaultRoomId=${existingUserRecords[0].defaultRoomId}`
            )
        } else {
            this._logger.info(
                `[ensureUserRoomForGroup] no chathub_user record, guildId=${guildId}, userId=${userId}, provisioning required`
            )
        }

        const guildTemplateRoom = await this._findAnyUsableRoomInGuild(guildId)
        const localTemplateRoom = guildTemplateRoom ?? this._buildLocalTemplateRoom()
        const templateRoom = localTemplateRoom

        if (!templateRoom) {
            this._logger.warn(`Cannot provision user room for user ${userId} in guild ${guildId}: no template room available`)
            return null
        }

        this._logger.info(
            `[ensureUserRoomForGroup] 使用模板 room 进行补建，guildId=${guildId}, userId=${userId}, source=${guildTemplateRoom ? 'guild-room' : 'local-template'}, model=${templateRoom.model}, preset=${templateRoom.preset}, chatMode=${templateRoom.chatMode}`
        )

        const room: ManagedRoom = {
            conversationId: randomUUID(),
            model: templateRoom.model,
            preset: templateRoom.preset,
            roomName: `Proactive User Room ${guildId}:${userId}`,
            roomMasterId: userId,
            roomId: (await getConversationRoomCount(this.ctx)) + 1,
            visibility: 'private',
            chatMode: templateRoom.chatMode,
            password: null,
            updatedTime: new Date()
        }

        try {
            await createConversationRoom(this.ctx, this._createUserRoomSession(guildId, userId), room as any)
            this._knownUserRooms.add(`${guildId}:${userId}`)
            this._logger.info(`已为用户补建 room，guildId=${guildId}, userId=${userId}, roomId=${room.roomId}`)
            return room
        } catch (error) {
            this._logger.error(
                `[ensureUserRoomForGroup] 补建 room 失败，guildId=${guildId}, userId=${userId}, roomId=${room.roomId}, conversationId=${room.conversationId}, error=${error}`
            )
            return null
        }
    }

    private async _resetRoomHistory(room: ManagedRoom): Promise<void> {
        const chatInterface = this.ctx.chatluna.queryInterfaceWrapper(room as any, false)
        await chatInterface?.clearChatHistory(room as any)
        this._logger.debug(`Reset proactive room history for roomId=${room.roomId}, conversationId=${room.conversationId}`)
    }

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

    private _createProactiveSession(session: Session): Session {
        const proactiveUserId = '__proactive_trigger__'
        const baseSession = session as any
        const cloned = Object.create(Object.getPrototypeOf(baseSession))
        const descriptors = Object.getOwnPropertyDescriptors(baseSession)

        delete descriptors.author
        delete descriptors.userId
        delete descriptors.username

        Object.defineProperties(cloned, descriptors)

        Object.defineProperty(cloned, 'userId', {
            value: proactiveUserId,
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

        return cloned as Session
    }

    private _createUserRoomSession(guildId: string, userId: string): Session {
        const baseSession = this._sessions[`group:${guildId}`] as any
        if (!baseSession) {
            this._logger.error(
                `[createUserRoomSession] missing cached base session, guildId=${guildId}, userId=${userId}`
            )
            throw new Error(`Cannot provision user room for guild ${guildId}: no cached session available`)
        }

        const cloned = Object.create(Object.getPrototypeOf(baseSession))
        const descriptors = Object.getOwnPropertyDescriptors(baseSession)

        delete descriptors.author
        delete descriptors.userId
        delete descriptors.username
        delete descriptors.guildId

        Object.defineProperties(cloned, descriptors)

        Object.defineProperty(cloned, 'guildId', {
            value: guildId,
            writable: true,
            configurable: true,
            enumerable: true
        })
        Object.defineProperty(cloned, 'userId', {
            value: userId,
            writable: true,
            configurable: true,
            enumerable: true
        })
        Object.defineProperty(cloned, 'username', {
            value: userId,
            writable: true,
            configurable: true,
            enumerable: true
        })

        return cloned as Session
    }

    private _collectParticipantUserIds(messages: ChatMessage[]): string[] {
        return [...new Set(messages.map((message) => message.id).filter(Boolean))]
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
            triggerReason: string | null
            finalDecision: string
        }
    ) {
        if (!this._config.verboseLog) return

        const activityPart = `activity={enabled:${payload.activityEnabled},score:${payload.activityScore == null ? 'n/a' : payload.activityScore.toFixed(3)},threshold:${payload.activityThreshold == null ? 'n/a' : payload.activityThreshold.toFixed(3)},messageCount:${payload.messageCount},messageInterval:${payload.messageInterval ?? 'n/a'},triggered:${payload.activityTriggered}}`
        const idlePart = `idle={enabled:${payload.idleEnabled},idleMinutes:${payload.idleMinutes.toFixed(2)},intervalMinutes:${payload.idleIntervalMinutes ?? 'n/a'},eligible:${payload.idleEligible}}`

        this._logger.info(
            `[verboseLog][message-eval] conversationId=${payload.conversationId} guildId=${session.guildId ?? ''} userId=${session.userId ?? ''} isDirect=${session.isDirect} profile=${payload.profileType} cooldownRemainingMs=${payload.cooldownRemainingMs} responseLocked=${payload.responseLocked} ${activityPart} ${idlePart} finalDecision=${payload.finalDecision}${payload.triggerReason ? ` reason="${payload.triggerReason}"` : ''}`
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
                currentThreshold: this._isGroupProfile(profile) && profile.enableActivityTrigger
                    ? (profile.activityLowerLimit ?? 0.85)
                    : 1,
                lastActivityScore: 0,
                lastTriggerTime: 0,
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

    private async _addChatMessage(conversationId: string, session: Session): Promise<void> {
        this._ensureMessageBucket(conversationId)

        const imageUrls = this._pickImageUrls(session)
        const images = await this._cacheImages(conversationId, imageUrls)
        const profile = this._getProfileByConversationId(conversationId) ?? null

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
        this._prewarmUserRoomIfNeeded(conversationId, session, profile ?? null)
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

    private _prewarmUserRoomIfNeeded(
        conversationId: string,
        session: Session,
        profile: TriggerProfileConfig | null
    ): void {
        if (session.isDirect || !profile || !this._isGroupProfile(profile)) return
        if (!session.guildId || !session.userId) return

        const cacheKey = `${session.guildId}:${session.userId}`
        if (this._knownUserRooms.has(cacheKey)) return

        this._knownUserRooms.add(cacheKey)
        void this._ensureUserRoomForGroup(session.userId, session.guildId).catch((error) => {
            this._knownUserRooms.delete(cacheKey)
            this._logger.warn(
                `[ensureUserRoomPrewarm] conversationId=${conversationId} guildId=${session.guildId} userId=${session.userId} error=${error}`
            )
        })
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

    private async _cacheImages(conversationId: string, urls: string[]): Promise<CachedImageRef[]> {
        const tasks = urls.map((url) => this._cacheImage(conversationId, url))
        return Promise.all(tasks)
    }

    private async _cacheImage(conversationId: string, url: string): Promise<CachedImageRef> {
        const key = this._getImageKey(url)
        const ext = this._getImageExtension(url)
        const localPath = this._getImageFilePath(conversationId, key, ext)

        try {
            await fs.mkdir(this._getConversationImageDir(conversationId), { recursive: true })
            await fs.access(localPath)
            return { key, originalUrl: url, localPath }
        } catch {}

        try {
            const response = await fetch(url)
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`)
            }

            const buffer = Buffer.from(await response.arrayBuffer())
            await fs.writeFile(localPath, buffer)
            return { key, originalUrl: url, localPath }
        } catch (error) {
            this._logger.warn(
                `[cacheImage] 图片缓存失败，conversationId=${conversationId}, key=${key}, url=${url}, error=${error}`
            )
            return { key, originalUrl: url }
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
                    try {
                        await fs.access(image.localPath)
                        if (!seen.has(image.localPath)) {
                            seen.add(image.localPath)
                            sources.push(image.localPath)
                        }
                        continue
                    } catch {}
                }

                if (!seen.has(image.originalUrl)) {
                    seen.add(image.originalUrl)
                    sources.push(image.originalUrl)
                }
            }
        }

        return sources
    }

    private async _clearConversationImageCache(conversationId: string): Promise<void> {
        try {
            await fs.rm(this._getConversationImageDir(conversationId), { recursive: true, force: true })
        } catch (error) {
            this._logger.warn(
                `[clearConversationImageCache] 清理图片缓存失败，conversationId=${conversationId}, error=${error}`
            )
        }
    }

    private _getRecentHistoryMessages(conversationId: string, profile: TriggerProfileConfig): ChatMessage[] {
        const messages = this._chatMessages[conversationId]
        if (!messages || messages.length === 0) return []
        return messages.slice(-profile.historyMessageLimit)
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

    private async _loadState(): Promise<void> {
        try {
            const raw = await fs.readFile(this._stateFilePath, 'utf8')
            const parsed = JSON.parse(raw) as PersistedState
            this._conversationStates = this._sanitizeConversationStates(parsed?.conversationStates ?? {})
            this._messageTimestamps = this._sanitizeTimestamps(parsed?.messageTimestamps ?? {})
            this._chatMessages = this._sanitizeChatMessages(parsed?.chatMessages ?? {})
            this._logger.info(`已加载 proactive 状态文件：${this._stateFilePath}`)
        } catch (error) {
            this._logger.debug(`未加载到持久化 proactive 状态：${error}`)
        }
    }

    private async _saveState(force = false): Promise<void> {
        if (!force && !this._dirty) return
        if (this._isSaving) {
            this._pendingSave = true
            return
        }

        this._isSaving = true
        try {
            do {
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
            } while (this._pendingSave || this._dirty)
        } catch (error) {
            this._logger.error(`保存 proactive 状态失败：${error}`)
            this._dirty = true
        } finally {
            this._isSaving = false
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
                currentThreshold: Math.max(
                    minThreshold,
                    Math.min(
                        maxThreshold,
                        Number(state.currentThreshold) || ((isGroupProfile && profile.enableActivityTrigger) ? lowerLimit : 1)
                    )
                ),
                lastActivityScore: Number(state.lastActivityScore) || 0,
                lastTriggerTime: Number(state.lastTriggerTime) || 0,
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

    private async _resolveGuildIdByRoomConversationId(conversationId: string): Promise<string | null> {
        const rooms = await this.ctx.database.get('chathub_room', { conversationId })
        if (rooms.length === 0) return null

        const roomId = rooms[0].roomId
        const groupMembers = await this.ctx.database.get('chathub_room_group_member', { roomId })
        if (groupMembers.length === 0) return null

        return groupMembers[0].groupId ?? null
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
                        imgs
                    }
                })
                .slice(-Math.max(1, this._getProfileByConversationId(conversationId)?.historyMessageLimit || this.MAX_MESSAGES))
        }
        return result
    }

    private _isGroupProfile(profile: TriggerProfileConfig | null): profile is GroupTriggerConfig {
        return !!profile && 'enableActivityTrigger' in profile
    }
}
