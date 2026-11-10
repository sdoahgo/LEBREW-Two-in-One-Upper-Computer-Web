# 水活标定串口协议 v1

## 物理通道

设备唯一对外 COM 为 ESP32-C6 USB Serial/JTAG。该通道专用于本协议的双向字节流；ESP-IDF 控制台、Bootloader/Application 文本日志、旧 UART 文本和旧 `AA55` 曲线帧均关闭。USB 通道本身不依赖传统 UART 波特率，但上位机保留波特率选择以兼容串口环境。

## 帧格式

所有多字节整数和 `float32` 均为小端序。

```text
A5 5A | body_length:u16 | version:u8 | command:u8 | sequence:u16 |
payload[body_length-4] | crc16:u16
```

`body_length` 合法范围为 4–132，payload 最大 128 字节。CRC 使用 CRC16-CCITT-FALSE：多项式 `0x1021`、初值 `0xFFFF`，覆盖 `body_length` 两字节至 payload 末尾，不覆盖帧头和 CRC 本身。

完整黄金帧：

```text
GET_INFO, seq=0x1234
A5 5A 04 00 01 01 34 12 17 B2

SET_PARAMS, seq=0x002A, K=1.0, B=0.0
A5 5A 0C 00 01 03 2A 00 00 00 80 3F 00 00 00 00 D0 D4

START_CAPTURE, seq=0x0042, point=3, capture_id=0x0102030405060708
A5 5A 0D 00 01 05 42 00 03 08 07 06 05 04 03 02 01 E2 92

START_CAPTURE BUSY response, seq=0x0042, echoing the same identity
A5 5A 0E 00 01 85 42 00 04 03 08 07 06 05 04 03 02 01 2A 22

TELEMETRY, seq=7, flags=7, sample=1, T=25.0,
raw=38.857, corrected=38.983, unclamped=0.328, final=0.328
A5 5A 1D 00 01 40 07 00 07 01 00 00 00 00 00 C8 41
91 6D 1B 42 98 EE 1B 42 9E EF A7 3E 9E EF A7 3E 33 DF
```

解析器遇到噪声、非法长度、错误版本或错误 CRC 时逐字节重新寻找 `A5 5A`，可在损坏帧后恢复后续合法帧。

## 命令、响应和状态

| 命令 | 值 | 请求 payload |
|---|---:|---|
| GET_INFO | `0x01` | 空 |
| GET_PARAMS | `0x02` | 空 |
| SET_PARAMS | `0x03` | `K:f32, B:f32` |
| RESET_PARAMS | `0x04` | 空 |
| START_CAPTURE | `0x05` | `point_id:u8, capture_id:u64`，点位 0–3，ID 非零 |
| CANCEL_CAPTURE | `0x06` | 空 |
| SET_STREAM | `0x07` | `enabled:u8, interval_ms:u16` |
| HEARTBEAT | `0x08` | 空；上位机连接后每 2 秒发送一次 |

响应命令为 `request | 0x80`，沿用请求 `sequence`，payload 首字节始终为状态：

| 状态 | 值 | 含义 |
|---|---:|---|
| OK | 0 | 成功 |
| UNKNOWN_COMMAND | 1 | 未知命令 |
| BAD_LENGTH | 2 | payload 长度错误 |
| INVALID_PARAMETER | 3 | 参数或取值非法 |
| BUSY | 4 | 正在采集 |
| SENSOR_UNAVAILABLE | 5 | SHT45 不可用 |
| CAPTURE_TIMEOUT | 6 | 采集超时 |
| STORAGE_ERROR | 7 | NVS 操作失败 |
| INTERNAL_ERROR | 8 | 内部错误 |

成功响应的固定 payload：

- GET_INFO：`status:u8, device_id[20], firmware_version[16]`。字符串 NUL 结尾并零填充，正文最多 19/15 字节。
- GET/SET/RESET_PARAMS：`status:u8, param_version:u16, params_valid:u8, cal_dew_valid:u8, K:f32, B:f32, cal_dew:f32`。`param_version` 表示持久化参数记录的固定 schema 版本（当前恒为 `1`），不是写入次数或参数修订计数；成功 SET/RESET 不递增该字段。
- START_CAPTURE：`status:u8, point_id:u8, capture_id:u64`。对于长度精确为 9 字节且 `capture_id` 非零的请求，OK 和所有非 OK 状态都必须原样回显请求中的点位和 ID，响应总长固定为 10 字节。
- CANCEL_CAPTURE：`status:u8`。
- SET_STREAM：`status:u8, enabled:u8, interval_ms:u16`；间隔范围 100–1000 ms。
- HEARTBEAT：`status:u8`。配套固件可据此维持标定连接并暂停自动关机；旧固件返回未知命令或未响应时，上位机仅记录诊断，不把心跳失败作为标定操作失败。

除可关联的 START_CAPTURE 外，错误响应只需状态字节。START_CAPTURE 请求长度不是 9 字节或其 `capture_id` 为零时无法可靠关联，允许只返回 `status:u8`；非法点位、BUSY、SENSOR_UNAVAILABLE 及其他针对有效非零 ID 请求的错误必须使用上述 10 字节响应。SET/RESET 成功后先发送响应，再发送参数变化和需要重新执行 0.753 校准的通知。上位机写入后必须 GET_PARAMS 回读，K/B 容差为 `1e-6`，版本和有效标志也必须一致。

## 异步事件

| 事件 | 值 | payload |
|---|---:|---|
| TELEMETRY | `0x40` | `flags:u8, sample_sequence:u32, temperature:f32, humidity_raw:f32, humidity_corrected:f32, aw_unclamped:f32, aw_final:f32` |
| CAPTURE_PROGRESS | `0x41` | `point_id:u8, capture_id:u64, sample_count:u16, elapsed_ms:u32, mean_rh_raw:f32, stddev_rh_raw:f32` |
| CAPTURE_RESULT | `0x42` | `point_id:u8, result_code:u8, capture_id:u64, sample_count:u16, elapsed_ms:u32, mean_rh_raw:f32, mean_rh_corrected:f32, stddev_rh_raw:f32` |
| NOTICE | `0x43` | `notice_code:u8` |

TELEMETRY flags：bit0=SHT45 已连接，bit1=K/B 有效，bit2=`cal_dew` 有效。CAPTURE_RESULT：0=稳定、1=超时、2=取消、3=传感器错误；上位机只接纳 0。NOTICE：1=参数已变化，2=必须重新执行 0.753 校准。

采集身份字段的固定 payload 字节偏移如下；范围端点均包含，所有多字节字段仍为小端序：

| payload | 总长度 | 固定偏移 |
|---|---:|---|
| START_CAPTURE 请求 | 9 | `point_id` 0；`capture_id` 1–8 |
| START_CAPTURE 可关联响应（OK 或非 OK） | 10 | `status` 0；`point_id` 1；`capture_id` 2–9 |
| CAPTURE_PROGRESS | 23 | `point_id` 0；`capture_id` 1–8；`sample_count` 9–10；`elapsed_ms` 11–14；`mean_rh_raw` 15–18；`stddev_rh_raw` 19–22 |
| CAPTURE_RESULT | 28 | `point_id` 0；`result_code` 1；`capture_id` 2–9；`sample_count` 10–11；`elapsed_ms` 12–15；`mean_rh_raw` 16–19；`mean_rh_corrected` 20–23；`stddev_rh_raw` 24–27 |

异步事件使用设备侧非零、循环的 `uint16` 序号；TELEMETRY 另含独立 `uint32` 样本序号。实时流默认关闭，连接流程通过 SET_STREAM 开启。稳定采集与实时流相互独立。

固件以 USB Serial/JTAG 的 SOF 检测判断物理主机连接；SOF 存在只代表连接到主机，并不表示 COM 已打开。`usb_serial_jtag_write_bytes(..., 0)` 成功只表示字节已提交到 ESP-IDF 驱动发送环，不能据此释放响应、通知或采集终态。固件继续持有这类必需帧，且仅在 SOF 仍存在并且 `usb_serial_jtag_wait_tx_done(0)` 确认此前提交的数据已由驱动发送给主机后释放。等待确认期间不重复提交同一帧。

若确认前发生物理断连，固件在该断连边沿清除驱动软件环和硬件 FIFO、丢弃陈旧 TELEMETRY/未发送进度、清除半帧接收状态，并将仍持有的必需帧复位到帧首；恢复成功后重连会提交完整帧。这个边界提供驱动层 at-least-once 重放，不是应用层 ACK，也不保证 exactly-once：主机可能已收到原帧但设备尚未来得及观察 TX 完成，因此重连后可能收到相同命令/序号的完整重复帧。

因此上位机必须作为幂等消费者处理采集事件。默认 capture ID 生成器以随机 64 位状态和随机奇数步长开始，在模 `2^64` 空间中推进并跳过零；它在线程锁保护下遍历整个周期，不保存历史，也不会在一个完整周期内重复任何非零 ID。显式注入的测试/自定义工厂仍单独保留重复检测。生成器在控制器状态锁内调用，待处理 START 同时保存当前连接 generation、点位和 ID。

START 响应必须在通用状态消费前关联。只有长度精确为 10 字节、状态合法、回显点位和 `capture_id` 都匹配当前 pending 的响应才有关联性：匹配 OK 建立 active capture，匹配非 OK 消费 pending 并报告正常命令错误。无论状态是 OK 还是错误，旧响应只要点位或 ID 不匹配就仅产生诊断并保留当前 pending。状态单字节、错误长度、未知状态或零 ID 等畸形 START 响应同样视为不可关联，只产生诊断并保留 pending；pending 仅由后续匹配响应完成，或在原定 deadline 到期时超时。

从 `v2026.10.13` 起，普通命令单次应答等待为 5 秒。GET_INFO、GET_PARAMS（含写后回读）及 SET_STREAM 可在总计 15 秒内使用完全相同的请求帧最多重试 2 次；SET_PARAMS、RESET_PARAMS 和 START_CAPTURE 不自动重发。START_CAPTURE 确认未到时额外保留 pending 10 秒，总计最多 15 秒；有效的匹配 START 响应，或具有当前 generation、点位、非零采集 ID 的合法进度/终态，均可确认该 pending 并建立 active capture。这个恢复例外只针对本连接仍未过期的 START 请求，不能恢复已超时、旧连接或其他点位/ID 的采集。

`CAPTURE_PROGRESS` 和 `CAPTURE_RESULT` 必须同时匹配当前连接 generation、active 点位和 `capture_id`。第一个合法的稳定、超时、取消或传感器错误终态会在同一状态锁内先原子关闭 active capture，再进入会话、界面和导出记录。重复、无归属、旧 ID、错点位或错 generation 的进度/终态均只产生诊断，不得关闭当前 active、增加重复次数、生成报告或进入导出。断线会清除 active 关联；`CANCEL_CAPTURE` 的 OK 仅确认命令，不能关闭 active 或合成终态，仍须等待带匹配 ID 的 `CAPTURE_RESULT`。

上位机不再保存固定大小的终态帧指纹缓存，也不把异步事件 `sequence` 当作采集身份。因而旧终态即使从未见过，只要 ID 不匹配也无法占用新的 active；新的真实采集即使复用旧事件序号且测量字段逐字节相同，只要使用新的匹配 ID，仍会被正常接纳。

## 上位机响应超时

上位机为每个请求建立独立的默认 2.0 秒响应期限。响应必须在期限之前到达，且命令和 `sequence` 都与待处理请求一致；恰好在期限时到达也按超时处理。超时后该请求会从待处理表移除并产生用户可见的超时事件，之后到达的同序号响应只记为“迟到/未知响应”诊断，不再改变参数、采集或界面状态。

SET_PARAMS 成功响应后触发的 GET_PARAMS 回读是一个新的请求，也有自己的 2.0 秒期限；若回读失败或超时，整次写入验证按失败显示，并关联回原写入操作。

这个 2.0 秒是主机命令—响应超时，不是标准液稳定等待时间。设备端稳定采集可持续最长 480 秒，其间通过 CAPTURE_PROGRESS 异步报告进度，最终以 CAPTURE_RESULT 给出稳定、超时、取消或传感器错误结果。
