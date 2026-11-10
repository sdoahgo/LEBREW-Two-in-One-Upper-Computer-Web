# ESP32-C6 水活标定上位机

本项目提供 Windows 水活标定上位机、结构化串口协议、模拟设备模式和可重复构建脚本。上位机用于采集 0.328、0.529、0.753、水/1.000 四个标准点，计算两端点与四点锚定最小二乘修正，并把选定的 `K/B` 写入 ESP32-C6。

本仓库收录桌面版 `v2026.10.13-r2` 的源码和 APP 协议说明，源快照为 `58c47ab`。可以在 Windows 上从源码运行，也可以构建 EXE。

Android / iOS 开发请直接查看下方的 [BLE 蓝牙协议（APP 对接）](#ble-蓝牙协议)。桌面程序通过串口连接设备。BLE 协议适用于 APP 与配套二合一固件直连。

## Windows 构建

在 Windows 10/11 上安装 64 位 Python 3.12（含 Tcl/Tk），下载或克隆本仓库，在根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

构建完成后运行 `releases\latest\AwCalibrator.exe`，或使用脚本生成的 **启动水活上位机** 快捷方式。分发时保留整个 `releases\latest` 目录及其中的 `_internal`，成品可直接运行。也可以跳到[快速运行](#快速运行)，先用模拟设备验证源码。

## 本地目录

| 目录 | 内容 |
|---|---|
| `aw_calibrator/` | 上位机源码 |
| `docs/`、`tests/`、`tools/` | 文档、测试和通信验证工具 |
| `releases/latest/` | 本地构建生成的可运行程序，日志在 `logs/`，从快捷方式启动时默认导出到 `exports/` |
| `releases/archive/` | 本地构建归档的旧程序及其数据与日志 |
| `build/` | 本地构建中间文件 |
| `.venv/` | 开发运行环境 |

`v2026.10.13-r2` 补齐实际串口写入、收到的命令应答及 CRC 错误诊断，成品优先在 EXE 同目录的 `logs\communication.log` 保存日志。源码运行或该目录不可写时，使用 `%LOCALAPPDATA%\AwCalibrator\logs\communication.log`。遇到实时数据正常但采集/取消应答间歇超时，请核对设备固件是否包含 `usbfix-1013` 或后续构建中的 USB 通信修复。

命令恢复延续上一版：单次应答等待为 5 秒；读取设备信息、读取参数、写后回读和开启实时流最多自动重试 2 次。重试保留原请求序号，迟到的有效应答在总等待期限内仍可完成请求。K/B 写入和恢复命令不会被自动重复发送。

开始采集确认缺失时额外等待最多 10 秒，并可通过同一点位、同一采集 ID 的进度或结果确认采集已经开始，不重复启动采集。若仍无法确认，界面提示先取消当前采集后重试，避免两次采集重叠。实时 RH 数据本身不作为开始采集的确认。

程序保留更大、更明显的操作按钮、带颜色标识的曲线图例，以及采集超时或传感器错误后的自动重试。重试仍遵循设备原有稳定条件，可通过“取消当前采集”停止。每个标准点仍需要至少 3 次稳定采集才能写入拟合参数。

连接后，上位机每 2 秒发送一次心跳；设备是否暂停自动关机取决于配套固件对该命令的支持。

通信诊断日志记录命令序号、实际串口写入、应答内容、应答耗时和最终超时，用于区分迟到应答与未收到有效应答。日志不参与测量或标定计算，请勿把包含实机编号的日志提交到公开仓库。[开发者通信验证工具](tools/README.md)可在不上界面的情况下复测命令成功率。

## 快速运行

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m aw_calibrator.main --simulate
```

连接实机时省略 `--simulate`，在界面中选择 COM 口和波特率后连接。ESP32-C6 的 USB Serial/JTAG 是纯二进制双向协议口，不能同时作为文本日志口使用。实机必须先烧录本项目配套固件；仅构建上位机不会自动更新设备。

上位机按 ESP-IDF 的无复位 DTR/RTS 顺序打开串口，避免 Windows `usbser.sys` 在连接时触发 ESP32-C6 复位。遇到“串口写入超时”时，请关闭占用 COM 口的其他程序，重新插拔并刷新 COM 口，同时确认设备运行兼容的配套固件。[实机连接说明](docs/build.md#实机连接)

## 标定流程

1. 读取设备参数；新设备先恢复 `K=1、B=0`。
2. 按 0.328、0.529、0.753、水的顺序采集，每点至少获得 3 次设备判定为稳定的结果。
3. 对比两种拟合的修正 RH、残差和 RMSE；默认选中 RMSE 更小者。
4. 写入 K/B。上位机会等待成功响应，再读取设备参数校验版本、有效标志和数值。
5. K/B 写入或恢复后，旧 `cal_dew` 自动失效，必须重新执行设备原有的 0.753 标准液校准。
6. 导出本次设备编号、原始采集、拟合参数和误差结果。

稳定条件由设备执行且保持原逻辑：150 个原始 RH 样本、100 ms 间隔、总体标准差小于 0.05 %RH、最长 480 秒。超时、取消、传感器错误以及被上下限截断的 AW 不能作为拟合点。

## 文档

- [串口协议](docs/protocol.md)
- [BLE 蓝牙协议（APP 对接）](#ble-蓝牙协议)
- [标定原理与操作](docs/calibration.md)
- [开发、测试与 Windows 构建](docs/build.md)

Windows 成品通过 `build.ps1` 生成到 `releases\latest\AwCalibrator.exe`。构建脚本只生成上位机，不刷写硬件。

## BLE 蓝牙协议

本节按 ESP32-C6 二合一 **固件 0.0.2（2026-10-26 提速维护构建）**、**网页版 1.1.26-web** 整理。帧协议版本为 `0x01`。同为 0.0.2 的旧构建可能缺少指令或 OTA 高速窗口，分别按 `UNKNOWN_COMMAND`、遥测长度和 OTA 能力应答处理。

### 1. 扫描、连接与订阅

设备是 BLE Peripheral，APP 作为 Central，按广播名 `LEBREW DOUBLE TO ONE` 发现设备，再核对 GATT 服务。固件同一时间支持一个 BLE 连接。所有短 UUID 用蓝牙标准基址 `0000xxxx-0000-1000-8000-00805f9b34fb` 展开。

| 服务 | 特征 | GATT 操作 | 特征值 |
| --- | --- | --- | --- |
| `180D` | `2A37` | Notify | 设备返回普通响应及事件。收到的通知字节流交给增量解码器 |
| `180D` | `2A38` | Write With Response | `PREFIX[16] + 完整 A5 5A 帧` |
| `180D` | `2A39` | Write With Response / Notify | 写入 `PREFIX[16] + OTA 控制载荷`，收到独立的 `A0` OTA ACK |
| `180D` | `2A40` | Write Without Response，支持时可用 Write With Response | `seq:u16BE + 固件分包` |
| `180A`（设备信息） | `2A24` / `2A29` | Read | 型号 `TDS` / 厂商 `LEBREW`。固件版本用 `GET_INFO` 读取 |

- 发现服务后先订阅 `2A37`，使用 OTA 时再订阅 `2A39`。Android 写入相应 CCCD `2902` 的 Notify 值 `01 00` 并等待完成。iOS 调用 `setNotifyValue(true, for:)` 并等待订阅回调。各次 GATT 操作顺序执行。
- `PREFIX[16]` 是配套网页版 `aw_protocol.js` 中 `COMMAND_KEY` 的 16 个原始字节，实机联调前请向项目维护者获取。两类写入共用该前缀，按原顺序作为二进制发送。CRC 只覆盖后面的帧字段。
- 每个普通请求作为一次完整的特征写入。实际写入上限要容纳前缀和整帧，例如空请求需 26 B、SN 写入需 44 B。Android 根据实际协商 MTU 和写入方式确认容量，iOS 按写入类型查询 `maximumWriteValueLength(for:)`。如果容量不足，先解决链路写入能力。
- 连通后先发 `GET_INFO`、`GET_PARAMS`，按需开启 `SET_STREAM`。保持连接时可每秒发一次 `HEARTBEAT`。主动断开时可发 `0x0D`，等待应答或设备断开事件，再释放 APP 的连接句柄。
- Write With Response 的完成回调只表示 GATT 写入完成。普通命令的业务应答来自 `2A37`，OTA 控制应答来自 `2A39`。重连后重新发现/订阅、清空旧解码缓冲与待应答队列、查询设备当前状态。

### 2. 普通帧与 CRC

```text
A5 5A | body_len:u16LE | 01 | command:u8 | sequence:u16LE | payload[N] | crc16:u16LE
```

`body_len=4+N`，取值 4～132，完整帧长 `10+N`，payload 最多 128 B。命令在帧偏移 5，序号在 6，payload 从 8 开始。CRC16-CCITT-FALSE 使用多项式 `0x1021`、初值 `0xFFFF`、不反射、最终异或 `0x0000`。从 `body_len` 第一个字节算到 payload 末尾，结果按小端写入。ASCII `123456789` 的 CRC 为 `0x29B1`。

- 普通多字节字段均为小端，`f32` 为 IEEE 754 binary32。仅 OTA 的 `total`、`chunk`、数据包序号与 ACK 序号使用大端。下文的偏移从 payload 首字节算起。
- 响应命令为 `request_command | 0x80`，序号回显请求。APP 用命令和序号关联响应，用独立的 `capture_id` / `request_id` 关联异步任务。主动事件有独立的序号。
- `2A37` 的一条通知可能只包含部分帧。缓存通知字节，搜索 `A5 5A`，检查长度、版本和 CRC 后才派发完整帧。长度或 CRC 错误时向后重新找帧头，保留可能跨通知的帧头字节。`2A39` 的 OTA ACK 由单独的解析器处理。

### 3. 命令与响应

下表为写 `2A38` 的普通命令。成功响应首字节为 `status=0`。先检查状态，再按成功长度解码。大多数拒绝响应仅 1 B。可关联的 `START_CAPTURE` 拒绝响应保留点位和采集 ID。

| 请求 → 响应 | 名称 | 请求 payload | 成功响应 payload |
| --- | --- | --- | --- |
| `01 → 81` | GET_INFO | 空 | 37 B：`status:u8, device_id[20], firmware[16]`。两个字符串定长补零，按首个 NUL 截断 |
| `02 → 82` | GET_PARAMS | 空 | 17 B：`status:u8, schema:u16, params_valid:u8, cal_dew_valid:u8, K:f32, B:f32, cal_dew:f32` |
| `03 → 83` | SET_PARAMS | 8 B：`K:f32, B:f32` | 同 GET_PARAMS |
| `04 → 84` | RESET_PARAMS | 空 | 同 GET_PARAMS，恢复 `K=1、B=0` |
| `05 → 85` | START_CAPTURE | 9 B：`point:u8, capture_id:u64` | 10 B：`status:u8, point:u8, capture_id:u64` |
| `06 → 86` | CANCEL_CAPTURE | 空 | 1 B：`status`。采集终态见 `0x42` |
| `07 → 87` | SET_STREAM | 3 B：`enabled:u8, interval_ms:u16`，开关为 0/1，周期 100～1000 ms | 4 B：`status:u8, enabled:u8, interval_ms:u16` |
| `08 → 88` | HEARTBEAT | 空 | 1 B：`status` |
| `0C → 8C` | OTA_ENTER_AP | 空 | 1 B：`status`。成功后设备重启进入 WiFi 热点升级模式 |
| `0D → 8D` | BLE_DISCONNECT | 空 | 1 B：`status`。设备随后主动断开 |
| `0E → 8E` | GET_FIRMWARE_ID | 空 | 37 B：`status:u8, elf_sha256[32], uptime_ms:u32` |
| `0F → 8F` | READ_SN | 空 | `status:u8, length:u8, sn[length]`，SN 用 ASCII，未写入时 length 为 0 |
| `10 → 90` | WRITE_SN | 18 B ASCII SN | 1 B：`status` |
| `11 → 91` | MEASUREMENT_CONTROL | 空查询或 8 B 控制 | 28 B 测量状态，见第 5 节 |
| `12 → 92` | DEVICE_CONTROL | 空查询或 8 B 控制 | 20 B 设置/校准状态，见第 6 节 |

`09/0A/0B` 和事件 `44` 是 USB OTA 使用的普通帧编号。BLE OTA 使用第 8 节的特征和控制码。APP 可通过 `0C` 请求切换到配套固件的 WiFi OTA 模式，设备随后重启并断开 BLE。

| status | 名称 | 处理含义 |
| --- | --- | --- |
| 0 | OK | 成功或已接收任务，异步任务还需等终态 |
| 1 | UNKNOWN_COMMAND | 固件未实现该命令 |
| 2 | BAD_LENGTH | 请求长度不符 |
| 3 | INVALID_PARAMETER | 参数、保留位或任务 ID 不符 |
| 4 | BUSY | 等待现有测量、采集、校准或升级结束后再查询/操作 |
| 5 | SENSOR_UNAVAILABLE | 所需传感器不可用 |
| 6 | CAPTURE_TIMEOUT | 采集或设备任务超时 |
| 7 | STORAGE_ERROR | 保存失败 |
| 8 | INTERNAL_ERROR | 设备内部错误 |
| 9 | SN_LOCKED | 已保存其他 SN |
| 10 | MD_NOT_CALIBRATED | 本机缺少水分测量所需的空杯校准基准 |

参数结构中 `schema` 位于偏移 1，两个有效位分别在 3、4，三个 float 在 5、9、13。K 和 B 均须为有限值，范围分别是 `0.25～4.0` 和 `-100～100`（含端点）。写入/恢复 K/B 后，用 GET_PARAMS 回读确认参数。原露点校准会失效，设备发送参数变化和重做 0.753 校准的通知。

### 4. 通知与四点采集

| 事件 | 长度 | payload 字段及字节偏移 |
| --- | --- | --- |
| `40` 水活遥测 | 25 B | `flags:u8@0, sample_sequence:u32@1, temperature_C:f32@5, RH_raw:f32@9, RH_corrected:f32@13, AW_unclamped:f32@17, AW_final:f32@21` |
| `41` 采集进度 | 23 B | `point:u8@0, capture_id:u64@1, sample_count:u16@9, elapsed_ms:u32@11, mean_raw:f32@15, stddev_raw:f32@19` |
| `42` 采集结果 | 28 B | `point:u8@0, result_code:u8@1, capture_id:u64@2, sample_count:u16@10, elapsed_ms:u32@12, mean_raw:f32@16, mean_corrected:f32@20, stddev_raw:f32@24` |
| `43` 通知 | 1 B | `notice:u8@0`，1=参数变化，2=需要重新执行 0.753 校准 |
| `45` 水分/密度遥测 | 26 或 34 B | `flags:u8@0, bean:u8@1, sample_sequence:u32@2, moisture_pct:f32@6, density_g_L:f32@10, capacitance_pF:f32@14, weight_adc:i32@18, weight_g:f32@22`。34 B 版另有 `empty_capacitance_pF:f32@26, delta_capacitance_pF:f32@30` |

- `40.flags` 的 bit0=传感器在线，bit1=K/B 有效，bit2=露点校准有效。RH 单位 %RH，AW 是 0～1 的比值。显示水活用 `AW_final`，并根据有效位标注校准状态。
- `45.flags` 的 bit0=电容在线，bit1=称重在线，bit2=水分有效，bit3=空杯已校准。豆种为 0=烘焙豆、1=生豆、2=带壳豆、3=干果。ΔC 是温度补偿前的原始电容减空杯电容，可为负。26 B 旧版的两个末尾字段应显示为缺失。实时遥测和正式测量结果分别展示，后者取第 5 节的有效结果。
- 点位 `point` 为 0=0.328、1=0.529、2=0.753、3=水/1.000。每次 `START_CAPTURE` 分配独立的非零 `capture_id`，用 64 位整数编码。重复采集由 APP 发起，每次单独等待对应 `42`。
- 采集稳定条件由设备判定：150 样本、100 ms 间隔、总体标准差 <0.05 %RH、最长 480 秒。`42.result_code` 为 0=稳定、1=超时、2=取消、3=传感器错误。只取 `point/capture_id` 匹配且结果码为 0 的稳定结果参与拟合。应答丢失时，可用匹配的进度/结果确认采集已开始。

### 5. 测量与切换豆种（0x11）

空 payload 查询当前状态。控制 payload 为 `action:u8, bean:u8, mode:u8, reserved:u8=0, request_id:u32`（8 B）。

| action | 用途 | 参数 |
| --- | --- | --- |
| 1 | 切到对应豆种页面并启动测量 | `mode=1` 水分与密度，`2` 水活，`3` 全部 |
| 2 | 取消当前远程测量 | 填当前任务的 `request_id`，可沿用该任务的 `bean/mode` |
| 3 | 只切换豆种和页面 | `mode=0` |

`0x91` 成功状态 28 B。偏移 0～7 依次为 `status, phase, bean, mode, result_flags, screen_id, error, availability`（各 1 B）。后续为 `request_id:u32@8, elapsed_ms:u32@12, moisture_pct:f32@16, density_g_L:f32@20, aw:f32@24`。

- `phase`：0=待机，1=等待界面处理，2=执行中，3=完成，4=取消，5=失败。`error` 使用第 3 节状态码，表示设备执行结果。`availability` bit0=界面就绪，bit1=设备本地操作忙。
- `result_flags` bit0=水分和密度有效，bit1=水活有效。全测可以先得到水分和密度，等水活完成后才有完整结果。取消后可保留已完成的单项。豆种判断使用 `bean`，四种豆可能使用相同的 `screen_id`。
- 新任务使用非零、当前未使用的 `request_id`。发送成功后可每秒用空 payload 查询，按 `request_id` 确认任务并读终态。命令超时时先查询，避免重复开任务。当前 ID 和原参数一致时，重复启动/切换请求按幂等处理。断开连接后可重连查询仍在执行或已完成的任务。

### 6. 设置与本机校准（0x12）

空 payload 查询。控制 payload 为 `action:u8, value:u8, reserved[2]=00 00, request_id:u32`（8 B，ID 非零）。

| action | 操作 | value |
| --- | --- | --- |
| 1 | 保存语言并进入设置页 | 0=中文，1=English |
| 2 | 保存待机时间 | 3 / 5 / 10 分钟 |
| 3 | 水分与密度空杯校准 | 0 |
| 4 | 水活 0.753 标准液校准 | 0 |

`0x92` 成功状态 20 B。偏移 0～8 依次为 `status, phase, action, value, language, standby_minutes, screen_id, error, availability`（各 1 B）。偏移 9～11 保留为 0，后续为 `request_id:u32@12, elapsed_ms:u32@16`。

- `phase`：0=待机，1=等待界面处理，2=执行中，3=完成，4=失败。`error` 使用第 3 节状态码。`availability` bit0=界面就绪，bit1=设备本地操作忙。开机初期如果尚未就绪且待机时间为 0，应继续查询。以同一 `request_id` 的终态和回读值作为设置或校准结果。
- APP 对空杯校准先提示倒空、清洁并放稳测量杯。对水活校准先提示放入 0.753 标准液、密封并等待温度稳定。用户确认后才发送对应命令。测量、采集、校准、参数/SN 写入和升级需顺序操作。

### 7. SN 读写

写入格式为 `LB + DT01 + YYMMDD + 产线字母 A–Z + 4 位流水号 + 校验字符`，共 18 个 ASCII 字节。日期须为有效日历日期，年份按 2000～2099 解释，流水号 0001～9999。校验算法为：

1. 取前 17 字符，用字母表 `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ` 映射为 0～35。
2. 从首字符开始按 `1, 3, 7` 循环加权求和。
3. 取字母表索引 `(36 - (sum % 36)) % 36` 作为末位。合成测试向量为 `LBDT01260101Z9999Q`。

使用 `0F` 先读后写，写入后再次回读逐字节核对。同一 SN 可重复核对，写入不同 SN 会返回 9。应答超时时先回读现有 SN。设备二维码的内容为完整 SN。

### 8. 蓝牙 OTA（0x2A39 / 0x2A40）

选择配套的 ESP32-C6 **应用镜像** `LEBREW_TDS_TEMP.bin`。单槽大小 `0x1E0000`（1920 KiB）。先结束冲突的设备操作，发 `SET_STREAM` 关闭实时流并等应答。停流后进入专用升级流程，将 OTA ACK 与普通业务消息分开。

| 方向 | 线格式 | 含义 |
| --- | --- | --- |
| 写 `2A39` | `PREFIX[16] 13` | ABORT，结束旧会话并读取能力 |
| 写 `2A39` | `PREFIX[16] 11 total:u32BE chunk:u16BE` | START，10 包窗口 |
| 写 `2A39` | `PREFIX[16] 14 total:u32BE chunk:u16BE` | START_FAST，32 包窗口，需先确认能力 |
| 写 `2A40` | `seq:u16BE data[chunk]` | 从包序号 0 开始，末包用 `FF` 补到 chunk，设备按 total 裁去补齐字节 |
| 写 `2A39` | `PREFIX[16] 12` | END，校验并切换启动分区 |
| 通知 `2A39` | `A0 status:u8 seq:u16BE` | **线上的 `00` 成功，`01` 拒绝或 NACK**。控制应答 seq=0 |

1. **确认能力。** 发送 ABORT 并等成功 ACK。精确收到 `A0 00 00 00 F1 01 20` 才可选择 START_FAST。后三字节依次是能力标记、扩展版本和十六进制窗口数。仅收到普通 ACK `A0 00 00 00` 或无法识别扩展时用 START（10 包）。ABORT 失败或超时先恢复通信。
2. **选择分包。** `chunk` 只计固件数据，协议上限为 244 B。特征值还需加 2 B 包序号，必须适合实际单包写入上限。网页使用 `chunk≤242`（特征值 ≤244 B），并在 START 之前按写入能力尝试更小的包。原生 APP 也需按平台上限及 ATT 单包容量选定长度，例如保守取 `min(242, ATT_MTU - 5, 单次特征写入上限 - 2)`。若使用此固件的探测机制，可在 START 前试写以 `FF FF` 开头的探测包，设备忽略该保留序号。检查 `chunk≥1`、`ceil(total/chunk)<65535`，整个会话使用同一 chunk。
3. **启动并按窗口发送。** START/START_FAST 成功 ACK 为 `A0 00 00 00`。然后顺序发送当前窗口的包，优先无响应写并遵守系统发送队列流控。发送满窗口或到文件末尾后等待通知。正向 ACK 的 seq 是已提交到 Flash 的最后一包，下一包为 `seq+1`。例如 `A0 00 00 09` 确认了首个 10 包窗口。GATT 写完成回调和平台队列就绪事件用于流控，Flash 写入进度以设备 ACK 为准。
4. **恢复。** `A0 01 00 05` 请求从序号 5 重传。`A0 01 FF FF` 表示 Flash 写入失败，结束本次升级。丢失 ACK 可从最后确认的前缀重发，忽略已确认的旧 ACK，保留有限次数重试。网页版默认单次等待 6 秒，允许同一窗口最多 8 次重试；设备会话约 15 秒无活动会清理。断链后建议重新连接、ABORT 并从头启动。
5. **结束并验证。** 收到最后一个数据 ACK 后发 END。成功 ACK 为 `A0 00 00 00`，随后重启。重连后发 `0E`，取 payload 的 1～32 字节（含两端）与目标应用镜像的 ELF SHA256 比对。对于该 ESP-IDF 应用格式，可核对文件偏移 32 的小端 magic `0xABCD5432`，然后取偏移 `176..207` 的 32 B。对比的是 app descriptor 的 ELF 指纹。整个 .bin 的 SHA256 用于文件完整性核对。若 END ACK 丢失，先重连核对运行指纹，再决定是否重试。

升级准备时固件可请求 2M PHY、DLE 251 和 7.5～15 ms 连接间隔。APP 的发送节奏以系统实际写入容量和设备窗口 ACK 为准。

### 9. APP 联调示例

下面是完整 **A5 5A 帧**，写到 `2A38` 前拼接 16 B 前缀。将 `2A37` 的通知值直接交给帧解码器。

```text
GET_INFO，seq=1
A5 5A 04 00 01 01 01 00 04 7A

SET_STREAM 开启，周期 200 ms，seq=2
A5 5A 07 00 01 07 02 00 01 C8 00 B7 35
对应成功响应
A5 5A 08 00 01 87 02 00 00 01 C8 00 91 7D

生豆全测，seq=3，request_id=1
A5 5A 0C 00 01 11 03 00 01 01 03 00 01 00 00 00 8C C7
查询测量状态，seq=4
A5 5A 04 00 01 11 04 00 92 C6

BLE_DISCONNECT，seq=5
A5 5A 04 00 01 0D 05 00 A1 C3

0.753 采集，seq=6，capture_id=1
A5 5A 0D 00 01 05 06 00 02 01 00 00 00 00 00 00 00 4A 67
对应已接受响应，等 42 事件取得结果
A5 5A 0E 00 01 85 06 00 00 02 01 00 00 00 00 00 00 00 B1 BF
```

参考联调顺序是订阅 `2A37` → 读设备信息 → 开启遥测 → 核对 `40/45` → 发起测量 → 查询 `91`，直到匹配 ID 的终态。OTA 单独验证 ABORT 能力、START、数据窗口和 END，然后重连检查 `8E`。普通帧编码与 CRC 可参考桌面版实现。[Python 帧编码器](aw_calibrator/protocol.py) · [串口协议测试](tests/test_protocol.py)
