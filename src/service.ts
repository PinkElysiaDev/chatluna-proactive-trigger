import { Context, Service, Session, Logger, Next, h } from 'koishi'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Config, GroupTriggerConfig, TriggerProfileConfig, PrivateTriggerConfig } from './config'
import { ActivityScorer } from './activity'
import { IdleScheduler } from './scheduler'
import { ChatMessage, ConversationState, TriggerReason } from './types'
import { queryJoinedConversationRoom } from 'koishi-plugin-chatluna/chains'
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

export class ProactiveChatService extends Service {
    private _sessions: Record<string, Session> = {}
    private _conversationStates: Record<string, ConversationState> = {}
    private _messageTimestamps: Record<string, number[]> = {}
    private _chatMessages: Record<string, ChatMessage[]> = {}
    private _activityScorer: ActivityScorer
    private _idleScheduler: IdleScheduler
    private _schedulerDisposable: () => void
    private _persistenceDisposable: () => void
    private _logger: Logger

    private _dirty = false
    private _isSaving = false
    private _pendingSave = false
    private _stateFilePath: string

    // conversationId → guildId，等待 after-chat 事件后广播到该群所有 room
    private _pendingBroadcast: Map<string, string> = new Map()

    private readonly MAX_MESSAGES = 100
    private readonly MAX_TIMESTAMPS = 200

    constructor(ctx: Context, private _config: Config) {
        super(ctx, 'chatluna_proactive')
        this._activityScorer = new ActivityScorer()
        this._idleScheduler = new IdleScheduler()
        this._logger = ctx.logger('chatluna-proactive')
        this._stateFilePath = path.resolve(ctx.baseDir || process.cwd(), 'data', 'chatluna-proactive-trigger-state.json')

        ctx.on('chatluna/after-chat', async (conversationId, _sourceMessage, responseMessage) => {
            const guildId = this._pendingBroadcast.get(conversationId)
            if (!guildId) return
            this._pendingBroadcast.delete(conversationId)

            if (this._config.syncToAllRooms) {
                await this._syncToAllGroupRooms(guildId, conversationId, responseMessage)
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
        this._logger.info('ProactiveChatService started')
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
        this._logger.info('ProactiveChatService stopped')
    }

    async handleMessage(session: Session, next: Next): Promise<void> {
        if (this.ctx.bots[session.uid]) { await next(); return }

        const profile = this._getProfileBySession(session)
        if (!profile) {
            this._logger.debug(`[handleMessage] session not applicable: uid=${session.uid} guildId=${session.guildId} isDirect=${session.isDirect}`)
            await next(); return
        }

        const conversationId = this._getConversationId(session)
        this._sessions[conversationId] = session

        const now = session.timestamp || Date.now()
        this._recordTimestamp(conversationId, now)

        if (!session.isDirect) {
            this._addChatMessage(conversationId, session)
        }

        const state = this._getOrCreateState(conversationId, profile)
        state.lastMessageTime = now
        state.messageCount = (state.messageCount ?? 0) + 1
        this._markDirty()

        this._logger.debug(`[handleMessage] conversationId=${conversationId} messageCount=${state.messageCount} lastActivityScore=${state.lastActivityScore?.toFixed(3)} threshold=${state.currentThreshold?.toFixed(3)}`)

        const triggerReason = this._evaluateTriggers(conversationId, state, now, profile)
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

            const idleTrigger = this._idleScheduler.shouldTrigger(state, now, profile)
            if (idleTrigger) {
                this._logger.debug(`Idle trigger for ${conversationId}: ${idleTrigger.reason}`)
                const trigger = {
                    type: 'idle' as const,
                    reason: idleTrigger.reason,
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
                    reason: '当前群聊氛围十分活跃，请结合近期上下文自然切入话题。'
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
                    reason: '消息计数达到阈值，请自然参与当前话题。'
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

        if (state.responseLocked) return
        state.responseLocked = true

        try {
            const room = await queryJoinedConversationRoom(this.ctx, session)
            if (!room) {
                this._logger.debug(`No joined room for ${conversationId}, skipping trigger`)
                return
            }

            if (!session.isDirect && room.conversationId) {
                this._pendingBroadcast.set(room.conversationId, session.guildId)
            }

            const template = this._getPromptTemplate(trigger, profile)
            const useHist = this._shouldUseHistory(template)
            const msgs = useHist ? this._getRecentHistoryMessages(conversationId, profile) : []
            const { txt: histTxt, imgs } = this._fmtHist(msgs)
            const bodyTxt = await this._buildReqText(session, trigger, histTxt, template)
            const requestImages = useHist
                ? imgs.slice(0, Math.max(0, profile.maxRequestImages ?? 3))
                : []
            const proactiveElements = this._mkEls(bodyTxt, requestImages)
            const commandOptions = {
                message: proactiveElements,
                is_proactive: true
            }

            this._logger.info(`Triggering proactive response for ${conversationId}: ${trigger.reason}`)

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
                        roomConversationId: room.conversationId ?? null
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
                session,
                '',
                commandOptions
            )

            this._chatMessages[conversationId] = []
            this._markDirty()

            this._updateStateAfterResponse(state, profile)

        } catch (error) {
            this._logger.error(`Error triggering proactive response: ${error}`)
            for (const [key, val] of this._pendingBroadcast) {
                if (val === session.guildId) this._pendingBroadcast.delete(key)
            }
        } finally {
            state.responseLocked = false
        }
    }

    private async _syncToAllGroupRooms(
        guildId: string,
        excludeConversationId: string,
        aiMessage: any
    ): Promise<void> {
        const userRecords = await this.ctx.database.get('chathub_user', { groupId: guildId })
        if (userRecords.length <= 1) return

        const roomIds = [...new Set(userRecords.map(r => r.defaultRoomId))]
        const rooms = await this.ctx.database.get('chathub_room', { roomId: { $in: roomIds } })

        const otherRooms = rooms.filter(r => r.conversationId && r.conversationId !== excludeConversationId)
        if (otherRooms.length === 0) return

        this._logger.debug(`Syncing proactive message to ${otherRooms.length} other rooms in guild ${guildId}`)

        for (const room of otherRooms) {
            try {
                const history = new KoishiChatMessageHistory(this.ctx, room.conversationId, 10000)
                await history.loadConversation()
                await history.addMessage(aiMessage as any)
            } catch (e) {
                this._logger.warn(`Failed to sync to room ${room.roomId} (${room.conversationId}): ${e}`)
            }
        }
    }

    private async _buildReqText(
        session: Session,
        trigger: TriggerReason,
        hist: string,
        template?: string
    ): Promise<string> {
        const finalTemplate = template ?? '{trigger_reason}\n{history}'
        const vars = await this._buildTemplateVars(session, trigger, hist)
        return this._renderTemplate(finalTemplate, vars)
    }

    private _shouldUseHistory(template: string): boolean {
        return String(template ?? '').includes('{history}')
    }

    private _getPromptTemplate(trigger: TriggerReason, profile: TriggerProfileConfig): string {
        if (trigger.type === 'activity' && this._isGroupProfile(profile) && profile.enableActivityTrigger) {
            return profile.activityPromptTemplate ?? '{trigger_reason}\n{history}'
        }
        if (trigger.type === 'idle' && profile.enableIdleTrigger) {
            return profile.idlePromptTemplate ?? '{trigger_reason}\n{history}'
        }
        return '{trigger_reason}\n{history}'
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
            idle_minutes: idleMinutes,
            trigger_reason: trigger.reason
        }
    }

    private _renderTemplate(template: string, vars: Record<string, string>): string {
        return String(template ?? '').replace(/\{([a-z_]+)\}/gi, (_match, key: string) => {
            return vars[key] ?? ''
        }).trim()
    }

    private async _getGroupName(session: Session): Promise<string> {
        if (session.isDirect) return ''
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

    private _fmtHist(msgs: ChatMessage[]): { txt: string; imgs: string[] } {
        if (!msgs.length) return { txt: '', imgs: [] }

        const imgs: string[] = []
        let globalImageIndex = 0

        const lines = msgs.map((m) => {
            const imageCount = m.imgs?.length ?? 0
            if (imageCount > 0) {
                imgs.push(...m.imgs!)
            }

            const t = this._renumberImageMarks(
                (m.content || '').trim(),
                imageCount,
                () => ++globalImageIndex
            )

            return `[${this._formatTimestamp(m.timestamp)}] ${m.name}(${m.id}): ${t}`
        })

        return { txt: lines.join('\n'), imgs }
    }

    private _renumberImageMarks(
        content: string,
        imageCount: number,
        nextIndex: () => number
    ): string {
        if (imageCount <= 0) return content

        let replaced = 0
        const text = content.replace(/\[图片:\d+]/g, () => {
            if (replaced >= imageCount) return ''
            replaced += 1
            return `[图片:${nextIndex()}]`
        })

        if (replaced >= imageCount) return text.trim()

        const remainMarks: string[] = []
        for (let i = replaced; i < imageCount; i++) {
            remainMarks.push(`[图片:${nextIndex()}]`)
        }

        return [text.trim(), ...remainMarks].filter(Boolean).join(' ').trim()
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

    private _addChatMessage(conversationId: string, session: Session): void {
        if (!this._chatMessages[conversationId]) {
            this._chatMessages[conversationId] = []
        }
        const imgs = this._pickImgs(session)
        const msg: ChatMessage = {
            id: session.author?.id || session.userId,
            name: session.author?.name || session.author?.nick || session.username || 'Unknown',
            content: this._normalizeMessageContent(session.content || '', imgs.length),
            timestamp: session.timestamp || Date.now(),
            ...(imgs.length ? { imgs } : {})
        }
        this._chatMessages[conversationId].push(msg)

        const profile = this._getProfileByConversationId(conversationId)
        const cap = Math.max(1, profile?.historyMessageLimit || this.MAX_MESSAGES)
        if (this._chatMessages[conversationId].length > cap) {
            this._chatMessages[conversationId] = this._chatMessages[conversationId].slice(-cap)
        }
        this._markDirty()
    }

    private _pickImgs(session: Session): string[] {
        const out: string[] = []
        const seen = new Set<string>()
        const els = (session.elements ?? []) as any[]

        for (const e of els) {
            if (e?.type !== 'img') continue
            const u = String(e?.attrs?.url ?? e?.attrs?.src ?? '').trim()
            if (!u || seen.has(u)) continue
            seen.add(u)
            out.push(u)
        }

        return out
    }

    private _normalizeMessageContent(raw: string, imageCount: number): string {
        let text = String(raw ?? '')

        text = text
            .replace(/\[CQ:image,[^\]]*]/gi, '')
            .replace(/<img\b[^>]*\/?>/gi, '')
            .replace(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi, '')
            .replace(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?\S*)?/gi, '')
            .replace(/https?:\/\/\S*\/download\?[^\s"'<>]+/gi, '')
            .replace(/\s+/g, ' ')
            .trim()

        if (imageCount <= 0) return text

        const marks = Array.from({ length: imageCount }, (_, i) => `[图片:${i + 1}]`).join(' ')
        return [text, marks].filter(Boolean).join(' ').trim()
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
            this._logger.info(`Loaded proactive state from ${this._stateFilePath}`)
        } catch (error) {
            this._logger.debug(`No persisted proactive state loaded: ${error}`)
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
            this._logger.error(`Failed to save proactive state: ${error}`)
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
                    const imgs = Array.isArray(msg.imgs)
                        ? msg.imgs.map((u) => String(u)).filter(Boolean)
                        : []

                    return {
                        id: String(msg.id ?? ''),
                        name: String(msg.name ?? 'Unknown'),
                        content: this._normalizeMessageContent(String(msg.content ?? ''), imgs.length),
                        timestamp: Number(msg.timestamp) || Date.now(),
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
