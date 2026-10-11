# koishi-plugin-chatluna-proactive-trigger

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-proactive-trigger?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-proactive-trigger)

为 chatluna 主插件提供群聊活跃度触发与空闲触发的主动发言能力。

## 功能概览

本插件围绕「主动发言」提供两类触发方式：

- **活跃度触发**
  - 基于群聊消息时间窗口计算活跃度分数
  - 支持消息计数兜底触发
  - 支持动态阈值（越聊越积极 / 越聊越克制）
- **空闲触发**
  - 群聊或私聊在长时间无人继续对话后主动发言
  - 支持随机抖动，降低触发时间的可预测性

同时插件还提供以下能力：

- **群级历史池**
  - 群聊历史按群维护，不按 room 维护
  - bot 在该群成功回复后，会重置该群历史池
- **每群一个 proactive room**
  - 群聊的所有主动触发统一在每群专属的 proactive room 中执行
  - 不再随最后发言者轮转用户 room，也不再为用户补建 room
  - 每次触发后清空该 room 的 chatluna 历史，上下文依赖 `{history}` 模板注入
- **图片本地缓存**
  - 每轮群级历史池内的图片会缓存到本地
  - 历史文本中的图片标记使用 `[图片:hash]`
  - 群级历史池重置时，对应图片缓存也会一起清理
- **调试日志**
  - `debugLog`：触发日志
  - `verboseLog`：每条消息的完整判断快照与请求快照

---

## 安装

```bash
npm install koishi-plugin-chatluna-proactive-trigger
```

---

## 依赖

- `koishi ^4.18.7`
- `koishi-plugin-chatluna ^1.0.0`
- 数据库服务（用于 proactive room 的创建与查询）

如果你希望模型输出：

```xml
<quote id="message_id"/>...
```

还需要在 chatluna 主插件中启用与 Koishi 消息元素渲染相关的能力。

---

## 核心行为说明

## 1. 群级历史池

插件内部会为每个群维护一份历史消息池：

```txt
group:${guildId}
```

这份历史池表示：

> 该群 **自 bot 上次成功回复以来** 的新消息集合。

因此：

- 用户主动 @ bot 并成功收到回复后，群级历史池会被重置
- proactive 的 activity / idle 触发成功后，群级历史池同样会被重置
- 下一轮主动发言只会看到 bot 上次成功回复之后的新消息

---

## 2. 活跃度触发

群聊中启用 `enableActivityTrigger` 后，插件会同时使用两类条件：

### 活跃度分数触发
基于多时间窗口消息密度计算活跃度分数。

### 消息计数兜底触发
当消息数量达到 `activityMessageInterval` 时，即使分数未达到阈值，也会触发一次。

### 动态阈值
- `activityLowerLimit === activityUpperLimit`：固定阈值
- `activityLowerLimit < activityUpperLimit`：越聊越克制
- `activityLowerLimit > activityUpperLimit`：越聊越积极

---

## 3. 空闲触发

启用 `enableIdleTrigger` 后：

- 当会话在 `idleIntervalMinutes` 内无人继续发言
- 插件会主动发起一次对话

适用于：
- 群聊冷场补位
- 私聊长时间无继续对话后的自然开场

建议搭配 `idleEnableJitter` 使用，避免触发时间过于固定。

---

## 4. 每群一个 proactive room

群聊的所有主动触发（活跃度/保底/空闲）统一锚定到**每个群一个专属 room**：

- room 由合成用户 `__proactive_trigger__` 持有，群内第一次触发时自动创建
- 触发请求通过该合成用户的会话发出，chatluna 按 `chathub_user` 记录解析到该 room
- **每次触发后清空该 room 的 chatluna 对话历史**：群聊上下文由 `{history}` 模板注入，chatluna 侧不保留 bot 主动发言的记忆
- 私聊触发仍使用该用户已加入的 room

> 该设计同时是内存安全考量：chatluna ≤1.3.34 会为每个被 chat 过的 conversationId 创建 ChatInterface 且永不释放（root 上下文监听 + LRU 淘汰不释放）。若 room 随最后发言者轮转，泄漏实例数会达到 O(用户数) 且历史被同步机制无限灌大；锚定每群一个 room 并每次清空历史后，泄漏面收敛为 O(群数)、单实例尺寸有界。

---

## 5. 图片缓存与图片标记

为避免 QQ 图片 URL 在长时间后失效，本插件会：

- 在消息进入群级历史池时尝试把图片缓存到本地
- prompt 构造时优先使用本地文件
- 若本地文件不可用，则回退使用原始 URL

### 图片标记格式
历史文本中不再使用：

```txt
[图片:1]
[图片:2]
```

而改用类似：

```txt
[图片:a1b2c3d4]
```

这样可以减少模型输出“第 1 张图 / 第 2 张图”这类违和描述。

---

## 配置说明

## 基础配置

| 配置项 | 说明 |
|--------|------|
| `applyDefaultGroupConfigs` | 应用默认群聊配置模板的群号列表 |
| `applyDefaultPrivateConfigs` | 应用默认私聊配置模板的用户列表 |
| `failureCooldownSeconds` | 主动触发失败后的会话冷却时间（秒） |
| `maxRetryAttempts` | 主动触发连续失败的最大重试次数 |
| `debugLog` | 输出触发原因等普通调试日志 |
| `verboseLog` | 输出每条消息的综合判断日志与完整请求快照 |

---

## 群聊配置

每个群聊配置项都需要指定：

| 配置项 | 说明 |
|--------|------|
| `guildId` | 群号；填写 `"default"` 作为默认群聊配置模板 |

### 活跃度触发相关

| 配置项 | 说明 |
|--------|------|
| `enableActivityTrigger` | 是否启用群聊活跃度触发 |
| `activityLowerLimit` | 初始触发灵敏度 |
| `activityUpperLimit` | 灵敏度趋向值 |
| `activityMessageInterval` | 消息计数兜底触发间隔 |
| `enableQuoteReplyByMessageId` | 是否向历史消息中注入 `message_id` |
| `activityPromptTemplate` | 活跃度触发提示词模板 |

### 空闲触发相关

| 配置项 | 说明 |
|--------|------|
| `enableIdleTrigger` | 是否启用空闲触发 |
| `idleIntervalMinutes` | 空闲触发间隔（分钟） |
| `idleEnableJitter` | 是否启用随机抖动 |
| `idlePromptTemplate` | 空闲触发提示词模板 |

### 通用

| 配置项 | 说明 |
|--------|------|
| `historyMessageLimit` | 历史池容量，同时也是单次最多注入条数 |
| `maxRequestImages` | 单次主动发言最多注入的图片数量 |
| `cooldownSeconds` | 触发后冷却时间（秒） |
| `workHours` | 工作时间段（小时，0-23）：仅在该范围内执行消息记录、判断与主动发言，如 `1,3-5,8-19`（支持 `22-2` 跨零点）；留空表示全天。时段外不影响 chatluna 正常回复 |

---

## 私聊配置

每个私聊配置项都需要指定：

| 配置项 | 说明 |
|--------|------|
| `userId` | 私聊用户 ID；填写 `"default"` 作为默认私聊配置模板 |

私聊当前只支持空闲触发：

| 配置项 | 说明 |
|--------|------|
| `enableIdleTrigger` | 是否启用空闲触发 |
| `idleIntervalMinutes` | 空闲触发间隔（分钟） |
| `idleEnableJitter` | 是否启用随机抖动 |
| `idlePromptTemplate` | 空闲触发提示词模板 |
| `historyMessageLimit` | 历史消息条数上限 |
| `maxRequestImages` | 单次主动发言最多注入的图片数量 |
| `cooldownSeconds` | 触发后冷却时间（秒） |
| `workHours` | 工作时间段（同群聊配置说明） |

---

## 默认模板与应用范围

本插件支持把某一项配置作为默认模板使用。

### 群聊默认模板
把某条群聊配置写成：

```yml
guildId: default
```

然后通过：

```yml
applyDefaultGroupConfigs:
  - "123456"
  - "654321"
```

指定哪些群使用它。

### 私聊默认模板
把某条私聊配置写成：

```yml
userId: default
```

然后通过：

```yml
applyDefaultPrivateConfigs:
  - "10001"
  - "10002"
```

指定哪些用户使用它。

### 优先级
始终是：

> 精确匹配 > applyDefault 列表命中的默认模板 > 无配置

---

## 模板变量

当前支持的模板变量如下：

| 变量 | 说明 |
|------|------|
| `{history}` | 当前会话历史消息 |
| `{time}` | 当前时间 |
| `{date}` | 当前年月日与星期 |
| `{group_name}` | 当前群聊名称（私聊为空） |
| `{user_name}` | 当前会话用户昵称 |
| `{idle_minutes}` | 当前空闲分钟数 |

### 已移除变量
以下变量已不再注入：

- `{trigger_reason}`

如果你希望模型知道触发语境，请直接把相关说明写进：
- `activityPromptTemplate`
- `idlePromptTemplate`

---

## `enableQuoteReplyByMessageId` 说明

这个选项现在**只负责是否向群聊 activity 历史中注入 `message_id`**：

### 开启时
历史文本中会出现类似：

```txt
[message_id=123456789][3/22 09:30] Alice(10001): ...
```

### 关闭时
不会注入 `message_id`

### 注意
插件**不会再自动往 prompt 里追加引用规则说明**。  
如果你希望模型使用：

```xml
<quote id="message_id"/>你的回复内容
```

请把这条规则直接写进你的 `activityPromptTemplate` 中。

---

## 推荐配置思路

## 1. 保守型群聊
适合不想让 bot 太爱说话的群：

- 提高 `activityLowerLimit`
- 提高 `activityUpperLimit`
- 增大 `cooldownSeconds`

---

## 2. 积极型群聊
适合希望 bot 更频繁参与：

- 降低 `activityLowerLimit`
- 适当降低 `activityUpperLimit`
- 设置 `activityMessageInterval` 作为兜底

---

## 3. 空闲补位型
适合主要让 bot 在冷场时开口：

- 开启 `enableIdleTrigger`
- 提高 `idleIntervalMinutes`
- 开启 `idleEnableJitter`

---

## FAQ

## 为什么 bot 回复后，历史消息会被清空？
因为插件维护的是“每群一份，自 bot 上次成功回复以来的新消息池”。  
这样下一轮主动发言才不会重复回应 bot 已经回答过的话题。

---

## 为什么不再为用户自动补建 chatluna room？

0.3.13 起移除了该机制。原因：
- chatluna 核心为每个被 chat 过的 conversationId 创建的 ChatInterface 永不释放，按用户补建/轮转 room 会让泄漏实例数随用户数无界增长
- 群聊触发已统一锚定每群一个 proactive room，用户 room 不再参与主动发言流程
- 存量部署中历史版本创建的用户 room 不会被自动清理，如需可手动删除（room 名以 `Proactive User Room` 开头）

---

## 为什么图片标记不是 `[图片:1]`？
因为顺序号很容易诱导模型说出“第 1 张图 / 第 2 张图”之类违和表达。  
使用 `[图片:hash]` 更中性，也更适合作为本地缓存文件名。

---

## 图片为什么要缓存到本地？
因为 QQ 等平台的图片 URL 可能会过期。  
本地缓存能保证：
- 在这一轮群级历史池生命周期内，图片仍可继续被模型使用。

---

## 为什么 `enableQuoteReplyByMessageId` 不再自动拼提示词？
因为提示词规则应由：
- 预设
- 用户模板

统一控制。  
插件只负责注入 `message_id`，避免和 chatluna 预设内容冲突。

---

## 版本更新日志

### 0.3.17
- 新增 `workHours` 工作时间段配置（群聊/私聊每条配置独立，小时粒度，如 `1,3-5,8-19`，支持跨零点，留空全天）：时段外不执行消息记录、判断与主动发言；不影响 chatluna 正常回复；时段开始后若已满足空闲/保底条件会立即触发一次。

### 0.3.16
- 修复 0.3.15 主动回复仍无法发送：合成会话影子属性（userId/username/author）改为不可枚举，避免 satori MessageEncoder.send 的可枚举键拷贝撞上仅有 getter 的原型访问器（"Cannot set property author"）。

### 0.3.15
- verboseLog 下调度器跳过/等待日志按"原因变化或 30 秒"去重，修复空闲会话 1 条/秒的日志刷屏；verboseLog 仍仅建议排障时开启。
- 修复主动回复从未真正发送到群的问题：合成会话 author 为 undefined 导致 session.username 在 OneBot 发送阶段抛 TypeError；现改为合成 author 对象。
- 修复 room 历史重置与聊天链的 conversation 队列竞争（慢模型下 180s 超时、该轮历史未清）：改为 after-chat 登记、调度 tick 空闲时异步执行并自动重试。

### 0.3.14
- 修复 0.3.13 在 koishi 4.18.x + chatluna 1.3.x 生产环境下群聊触发必然失败的问题：
  - 现象：`TypeError: Cannot read properties of undefined (reading 'atSelf')`（chatluna allow_reply）与 `TypeError: session.text is not a function`。
  - 根因：koishi 4.18 的 session 实例方法（stripped/text/send 等）经 cordis mixin 的 internal accessor 按接收者分发，0.3.13 的描述符克隆会话丢失该分发路径。
  - 修复：合成会话改为以原 session 为原型派生（Object.create + 影子属性覆盖 userId/username/author），完整保留方法解析路径；并增加克隆保真哨兵日志。

### 0.3.13
- **破坏性变更**：移除 `syncToAllRooms` 配置（主动发言历史同步到参与者 room）与用户 room 自动补建机制。
- **修复长期运行内存持续增长（可达 GB 级）的问题**：chatluna ≤1.3.34 中每个被 chat 过的 conversationId 都会创建一个永不释放的 ChatInterface（构造器在 root 上下文注册 dispose 监听并丢弃 disposer，LRU 淘汰不释放，且整段历史全量驻留）。本插件此前按最后发言者轮转用户 room 并向所有参与者 room 同步历史，使泄漏实例数达 O(用户数)、历史体积无界膨胀。现在群聊触发统一锚定每群一个 proactive room，并在每次触发后清空其历史。
- after-chat 清理不再反查 `chathub_room_group_member`，直接使用触发时携带的 guildId。
- 会话状态（消息缓存/时间戳/Session 引用）在配置移除后自动淘汰；状态持久化增加最小序列化间隔（30s）；after-chat pending 动作增加 10 分钟超时清扫。
- 修复：私聊触发可能误清群聊历史池与图片缓存（部分平台私聊会话携带 guildId）。
- 修复：群内无任何 chatluna room 时 proactive room 供给必然失败（getTemplateConversationRoom 从本插件调用读到本插件配置并抛 ROOM_TEMPLATE_INVALID）；现改用本地模板构建并在供给失败时回退 joined-room 路径。
- 修复：proactive room 创建并发时 roomId 主键冲突（增加进程内互斥 + 失败重查）。
- 修复：图片缓存下载无超时且阻塞消息中间件（15s 超时 + 异步补写 localPath）。
- 修复：停止插件时最后的强制保存可能被序列化间隔睡眠吞掉（睡眠可唤醒 + 等待在途保存）。
- 已知残留：chatluna 核心的 ChatInterface 泄漏本身仍存在（正常用户对话同样会缓慢累积），建议向上游反馈修复。

### 0.3.0
- 新增消息 id 传递功能，允许用户跳过提示词要求模型引用特定消息回复（需要与 chatluna 主插件 “用 koishi 消息元素渲染”配置项配合使用）
- 新增补建 chatluna room 能力，解决活跃度对话参与用户缺失 chatluna room 而无法正常触发对话的 bug。
- 修改主动触发的对话在 room 间同步的逻辑，只为参与当前活跃度触发的用户同步主动触发消息记录。
- 修复 bot 被用户手动触发后，活跃度对话消息池不重置的 bug，避免 bot 主动发言时对已回应问题重复作答。
- 修复图片文件持久化策略，每一轮活跃度对话消息池会自我维护一个图片文件池。

---

## 许可证

MIT
