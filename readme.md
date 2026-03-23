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
- **room 自动补建**
  - 参与活跃度消息积累的群成员会按需补建 chatluna room
  - activity 触发执行时仍使用最后发言者的 room
- **参与者级同步**
  - 主动发言后的历史同步只面向本轮参与者
  - 不再向群内所有 room 扩散
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
- 数据库服务（用于 room 查询、补建与历史同步）

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

## 4. room 自动补建

在群聊中，只要某位用户的消息被纳入活跃度历史池，插件就会按需确保：

- 该用户在当前群下存在对应 chatluna room
- 后续 activity 触发、参与者同步和历史写入都能正常进行

### 执行 room 规则
activity 触发时：
- 固定使用**最后发言者**的 room
- 如果最后发言者没有 room，会先尝试补建，再执行触发

---

## 5. 主动发言后的同步范围

主动发言成功后：

- **只同步给本轮参与者**
- 不再同步给群内所有用户

这可以减少：
- 无关 room 的上下文污染
- 每用户独立 room 场景下的语义错位

> 注意：`syncToAllRooms` 这个历史命名仍保留在配置中，但当前行为语义更接近“启用参与者同步”。

---

## 6. 图片缓存与图片标记

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
| `syncToAllRooms` | 启用主动发言后的参与者历史同步 |
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

## 为什么有些用户会自动获得 chatluna room？
因为参与群聊活跃度消息积累的用户会按需补建 room。  
这是为了保证：
- activity 触发时最后发言者一定能有执行 room
- 主动发言后的参与者同步也能正常工作

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

### 0.3.0
- 新增消息 id 传递功能，允许用户跳过提示词要求模型引用特定消息回复（需要与 chatluna 主插件 “用 koishi 消息元素渲染”配置项配合使用）
- 新增补建 chatluna room 能力，解决活跃度对话参与用户缺失 chatluna room 而无法正常触发对话的 bug。
- 修改主动触发的对话在 room 间同步的逻辑，只为参与当前活跃度触发的用户同步主动触发消息记录。
- 修复 bot 被用户手动触发后，活跃度对话消息池不重置的 bug，避免 bot 主动发言时对已回应问题重复作答。
- 修复图片文件持久化策略，每一轮活跃度对话消息池会自我维护一个图片文件池。

---

## 许可证

MIT
