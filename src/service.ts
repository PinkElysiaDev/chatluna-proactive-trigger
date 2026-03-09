import { Context, Service, Session, Logger, Next, h } from 'koishi'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Config } from './config'
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
        this._activityScorer = new ActivityScorer(_config)
        this._idleScheduler = new IdleScheduler(_config)
        this._logger = ctx.logger('chatluna-proactive')
        this._stateFilePath = path.resolve(ctx.baseDir || process.cwd(), 'data', 'chatluna-proactive-trigger-state.json')

        // 监听 chatluna 对话完成事件，将结果同步到群内其他 room
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
        // 注册消息收集中间件
        this.ctx.middleware((session, next) => this.handleMessage(session, next))
        // 启动空闲触发调度器
        this._schedulerDisposable = this.ctx.setInterval(() => {
            this._processSchedulerTick()
        }, 1000)
        // 定期落盘，避免重启丢失状态
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
        if (!this._isApplicable(session)) {
            this._logger.debug(`[handleMessage] session not applicable: uid=${session.uid} guildId=${session.guildId} isDirect=${session.isDirect}`)
            await next(); return
        }

        const conversationId = this._getConversationId(session)
        this._sessions[conversationId] = session

        const now = session.timestamp || Date.now()
        this._recordTimestamp(conversationId, now)

        if (!session.isDirect && this._config.includeChatHistory) {
            this._addChatMessage(conversationId, session)
        }

        const state = this._getOrCreateState(conversationId)
        state.lastMessageTime = now
        state.messageCount = (state.messageCount ?? 0) + 1
        this._markDirty()

        this._logger.debug(`[handleMessage] conversationId=${conversationId} messageCount=${state.messageCount} lastActivityScore=${state.lastActivityScore?.toFixed(3)} threshold=${state.currentThreshold?.toFixed(3)}`)

        const triggerReason = this._evaluateTriggers(conversationId, state, now)
        if (triggerReason) {
            await this._triggerResponse(session, triggerReason)
            return
        }

        await next()
    }

    private async _processSchedulerTick(): Promise<void> {
        const now = Date.now()

        for (const [conversationId, state] of Object.entries(this._conversationStates)) {
            const session = this._sessions[conversationId]
            if (!session) continue

            const cooldownRemaining = state.lastTriggerTime ? this._config.cooldownSeconds * 1000 - (now - state.lastTriggerTime) : 0
            if (cooldownRemaining > 0) {
                this._logger.debug(`[schedulerTick] ${conversationId}: in cooldown, ${Math.ceil(cooldownRemaining / 1000)}s remaining`)
                continue
            }
            if (state.responseLocked) {
                this._logger.debug(`[schedulerTick] ${conversationId}: responseLocked, skipping`)
                continue
            }

            const idleTrigger = this._idleScheduler.shouldTrigger(state, now)
            if (idleTrigger) {
                this._logger.debug(`Idle trigger for ${conversationId}: ${idleTrigger.reason}`)
                await this._triggerResponse(session, { type: 'idle', reason: idleTrigger.reason })
                this._markDirty()
            } else if (state.lastMessageTime) {
                const idleMs = now - state.lastMessageTime
                const waitMs = this._config.idleTrigger.intervalMinutes * 60 * 1000
                this._logger.debug(`[schedulerTick] ${conversationId}: idle=${Math.floor(idleMs / 1000)}s, need=${Math.floor(waitMs / 1000)}s`)
            }
        }
    }

    private _evaluateTriggers(conversationId: string, state: ConversationState, now: number): TriggerReason | null {
        if (state.lastTriggerTime && now - state.lastTriggerTime < this._config.cooldownSeconds * 1000) {
            this._logger.debug(`[evaluateTriggers] ${conversationId}: in cooldown`)
            return null
        }
        if (state.responseLocked) {
            this._logger.debug(`[evaluateTriggers] ${conversationId}: responseLocked`)
            return null
        }

        if (this._config.enableActivityTrigger) {
            const timestamps = this._messageTimestamps[conversationId] || []
            const score = this._activityScorer.calculateScore(timestamps, state)
            state.lastActivityScore = score

            this._logger.debug(`[evaluateTriggers] ${conversationId}: activityScore=${score.toFixed(3)} threshold=${state.currentThreshold.toFixed(3)}`)

            if (this._activityScorer.shouldTrigger(score, state.currentThreshold)) {
                return {
                    type: 'activity',
                    reason: '当前群聊氛围十分活跃，以下是群内成员的近期发言，并非在对你发言；优先回应与你相关的问题，若无直接提及你的消息，则根据自身兴趣喜好等信息以旁观者身份自然切入话题；不要假设每条消息都发给你，这十分重要！'
                }
            }
        }

        if (this._config.messageInterval > 0 && state.messageCount >= this._config.messageInterval) {
            this._logger.debug(`[evaluateTriggers] ${conversationId}: messageInterval reached (${state.messageCount}/${this._config.messageInterval})`)
            return {
                type: 'activity',
                reason: '当前群聊氛围十分活跃，以下是群内成员的近期发言，并非在对你发言；优先回应与你相关的问题，若无直接提及你的消息，则根据自身兴趣喜好等信息以旁观者身份自然切入话题；不要假设每条消息都发给你，这十分重要！'
            }
        }

        return null
    }

    /**
     * 触发 chatluna 主动发言。
     *
     * 在 receiveCommand 之前把 room.conversationId → guildId 存入 _pendingBroadcast，
     * 这样 after-chat 事件触发时（receiveCommand 返回前）就能拿到群 ID 并广播。
     */
    private async _triggerResponse(session: Session, trigger: TriggerReason): Promise<void> {
        const conversationId = this._getConversationId(session)
        const state = this._getOrCreateState(conversationId)

        if (state.responseLocked) return
        state.responseLocked = true

        try {
            const room = await queryJoinedConversationRoom(this.ctx, session)
            if (!room) {
                this._logger.debug(`No joined room for ${conversationId}, skipping trigger`)
                return
            }

            // 群聊时，在触发前注册 pending，after-chat 回调会据此广播到其他 room
            if (!session.isDirect && room.conversationId) {
                this._pendingBroadcast.set(room.conversationId, session.guildId)
            }

            const useHist = trigger.type !== 'idle'
            const msgs = useHist ? this._getRecentHistoryMessages(conversationId) : []
            const { txt: histTxt, imgs } = this._fmtHist(msgs)
            const bodyTxt = this._buildReqText(trigger.reason, histTxt)
            const proactiveElements = this._mkEls(bodyTxt, imgs)
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
                        includeChatHistory: this._config.includeChatHistory,
                        includeHistoryForThisTrigger: useHist,
                        maxHistoryMessages: this._config.maxHistoryMessages,
                        cachedMessageCount: this._chatMessages[conversationId]?.length ?? 0,
                        injectedMessageCount: msgs.length,
                        injectedImageCount: imgs.length,
                        injectedImages: imgs
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

            if (useHist) {
                this._chatMessages[conversationId] = []
                this._markDirty()
            }

            this._updateStateAfterResponse(state)

        } catch (error) {
            this._logger.error(`Error triggering proactive response: ${error}`)
            // 清理 pending，避免悬空
            for (const [key, val] of this._pendingBroadcast) {
                if (val === session.guildId) this._pendingBroadcast.delete(key)
            }
        } finally {
            state.responseLocked = false
        }
    }

    /**
     * 将本次主动发言结果同步写入该群内其他所有用户的 room 历史。
     *
     * 仅写入已存在 conversationId 的 room（用户至少对话过一次），
     * 写入内容为一对 HumanMessage('[主动发言触发]') + AIMessage(bot 回复)。
     */
    private async _syncToAllGroupRooms(
        guildId: string,
        excludeConversationId: string,
        aiMessage: any
    ): Promise<void> {
        // 查找群内所有用户当前绑定的 room
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

    private _buildReqText(reason: string, hist: string): string {
        if (!hist) return reason
        return `${reason}\n近期对话消息:\n${hist}`
    }

    private _buildReqContent(txt: string, imgs: string[]) {
        if (!imgs.length) return txt
        return [
            { type: 'text', text: txt },
            ...imgs.map((url) => ({
                type: 'image_url',
                image_url: { url }
            }))
        ]
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

    private _updateStateAfterResponse(state: ConversationState): void {
        const now = Date.now()
        state.lastTriggerTime = now
        state.messageCount = 0
        if (this._config.enableActivityTrigger) {
            this._activityScorer.adjustThreshold(state)
        }
        this._markDirty()
    }

    private _getConversationId(session: Session): string {
        return session.isDirect
            ? `private:${session.userId}`
            : `group:${session.guildId}`
    }

    private _isApplicable(session: Session): boolean {
        if (session.isDirect) {
            return this._config.applyPrivateUsers.includes(session.userId)
        }
        return this._config.applyGroup.includes(session.guildId)
    }

    private _getOrCreateState(conversationId: string): ConversationState {
        if (!this._conversationStates[conversationId]) {
            this._conversationStates[conversationId] = {
                lastMessageTime: 0,
                currentThreshold: this._config.activityThreshold.lowerLimit,
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

        const cap = Math.max(1, this._config.historyBufferSize || this.MAX_MESSAGES)
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

        // 清理常见图片片段，避免将长 URL 写入历史文本
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

    private _getRecentHistory(conversationId: string): string {
        const recentMessages = this._getRecentHistoryMessages(conversationId)
        return this._getRecentHistoryFromMessages(recentMessages)
    }

    private _getRecentHistoryMessages(conversationId: string): ChatMessage[] {
        if (!this._config.includeChatHistory) return []
        const messages = this._chatMessages[conversationId]
        if (!messages || messages.length === 0) return []
        return messages.slice(-this._config.maxHistoryMessages)
    }

    private _getRecentHistoryFromMessages(messages: ChatMessage[]): string {
        if (!messages || messages.length === 0) return ''
        return messages.map(msg =>
            `<message name='${msg.name}' id='${msg.id}' timestamp='${this._formatTimestamp(msg.timestamp)}'>${msg.content}</message>`
        ).join('\n')
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
        const minThreshold = Math.min(this._config.activityThreshold.lowerLimit, this._config.activityThreshold.upperLimit)
        const maxThreshold = Math.max(this._config.activityThreshold.lowerLimit, this._config.activityThreshold.upperLimit)
        const result: Record<string, ConversationState> = {}

        for (const [conversationId, state] of Object.entries(states)) {
            if (!state || typeof state !== 'object') continue
            result[conversationId] = {
                lastMessageTime: Number(state.lastMessageTime) || 0,
                currentThreshold: Math.max(minThreshold, Math.min(maxThreshold, Number(state.currentThreshold) || this._config.activityThreshold.lowerLimit)),
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
                .slice(-Math.max(1, this._config.historyBufferSize || this.MAX_MESSAGES))
        }
        return result
    }
}
