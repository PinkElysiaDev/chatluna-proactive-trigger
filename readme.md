# koishi-plugin-chatluna-proactive-trigger

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-proactive-trigger?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-proactive-trigger)

为 chatluna 主插件提供主动发言能力的扩展插件。

## 功能特性

- **活跃度触发**
  - 基于群聊消息时间戳计算活跃分数（多时间窗口 + 平滑）
  - 支持动态阈值（可配置为越聊越热情 / 越聊越克制）
  - 支持消息计数兜底触发，避免长期不触发

- **空闲触发**
  - 群聊长时间无人发言后主动发起话题
  - 支持随机抖动，降低触发可预测性

- **历史上下文注入**
  - 主动发言时可附带近期群聊文本与图片
  - 图片在历史文本中会压缩为 `[图片:n]` 标记，避免长 URL 膨胀输入长度
  - 实际图片仍通过 `image_url` 注入，保证多模态能力不变
  - 可控制注入条数与会话缓存上限

- **触发节流与状态持久化**
  - 支持统一冷却时间，控制触发频率
  - 会话状态与历史缓存定时落盘，重启后可恢复

- **群内多 room 历史同步**
  - 可将主动发言同步写入同群其他用户 room 历史（适配每用户独立 room）

- **调试可观测性**
  - 可开启详细日志，输出完整触发请求快照用于排障

## 安装

```bash
npm install koishi-plugin-chatluna-proactive-trigger
```

## 依赖

- koishi ^4.18.7
- koishi-plugin-chatluna ^1.0.0
- 数据库服务（用于 room 查询与历史同步）

## 配置项总览

### 应用范围

| 配置项 | 说明 |
|--------|------|
| `applyGroup` | 应用到的群组 ID 列表（为空则不触发群聊） |
| `applyPrivateUsers` | 应用到的私聊用户 ID 列表（为空则不触发私聊） |

### 活跃度触发

| 配置项 | 说明 |
|--------|------|
| `enableActivityTrigger` | 是否启用活跃度触发 |
| `activityThreshold.lowerLimit` | 活跃度阈值下限（0~1） |
| `activityThreshold.upperLimit` | 活跃度阈值上限（0~1） |
| `messageInterval` | 消息计数兜底触发间隔（0 表示关闭） |

### 空闲触发

| 配置项 | 说明 |
|--------|------|
| `enableIdleTrigger` | 是否启用空闲触发 |
| `idleTrigger.intervalMinutes` | 空闲触发间隔（分钟） |
| `idleTrigger.enableJitter` | 是否启用随机抖动 |

### 历史与频率控制

| 配置项 | 说明 |
|--------|------|
| `includeChatHistory` | 是否在主动发言时注入近期群聊历史 |
| `maxHistoryMessages` | 单次触发最多注入的历史消息条数 |
| `historyBufferSize` | 每个会话的历史缓存上限（历史池容量） |
| `cooldownSeconds` | 两次触发之间的冷却时间（秒） |

### 同步与调试

| 配置项 | 说明 |
|--------|------|
| `syncToAllRooms` | 主动发言后是否同步到同群其他用户 room 历史（仅每用户独立 room 模式下有效） |
| `verboseLog` | 是否打印完整触发请求日志 |

## 关键参数配置方法（简练版）

1. **先定触发风格（最重要）**
   - `activityThreshold.lowerLimit = upperLimit`：固定灵敏度
   - `lowerLimit < upperLimit`：越聊越不容易触发（更克制）
   - `lowerLimit > upperLimit`：越聊越容易触发（更积极）

2. **用计数触发做兜底**
   - 设置 `messageInterval > 0` 后，即使活跃分数没过线，也会在累计消息达到间隔时触发一次。

3. **用空闲触发补齐“冷场场景”**
   - 开启 `enableIdleTrigger`，并设置 `idleTrigger.intervalMinutes` 为你希望的冷场等待时长。
   - 建议同时开启 `idleTrigger.enableJitter`，避免触发时间过于固定。

4. **用冷却时间控频**
   - `cooldownSeconds` 是全局触发节流阀。觉得“太爱说话”时优先增大此值。

5. **分清“注入条数”和“缓存容量”**
   - `maxHistoryMessages`：每次真正注入给模型的条数（影响 prompt 长度）
   - `historyBufferSize`：插件内部可保留的历史池上限（影响可选上下文范围）

6. **群多用户一致性**
   - 每用户独立 room 的场景下，建议开启 `syncToAllRooms`，让主动发言写入同群其他 room 历史，减少上下文割裂。

7. **排障时再开详细日志**
   - `verboseLog` 会输出完整请求快照，便于定位问题；生产常态建议关闭。

## 触发优先级与行为说明

- 触发前会检查冷却状态与响应锁，避免并发重复触发。
- 活跃度触发与消息计数触发属于“活跃场景触发”。
- 空闲触发属于“冷场补位触发”。
- 空闲触发在达到间隔后会重置下一轮计时锚点，不会仅按 `cooldownSeconds` 高频重复触发。
- 活跃触发默认会注入近期历史；空闲触发默认不注入历史。

## 许可证

MIT
