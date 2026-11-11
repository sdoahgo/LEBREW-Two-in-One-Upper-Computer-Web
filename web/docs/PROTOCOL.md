# 二合一 0.0.2 通信协议

适用 ESP32-C6 固件 0.0.2 的 2026-10-26 维护构建、配套网页 1.1.26-web。帧协议版本仍为 1，与软件版本独立。旧 0.0.2 是否支持高速扩展必须按 F1/F2 能力应答判断。本文对应本版实际源码，不根据历史说明推测。

## 1. 物理接口与 BLE

网页串口使用 **USB Serial/JTAG**，Web Serial 参数为 115200、8N1、无流控，打开后释放 DTR/RTS。USB 不混入文本日志。硬件 UART0 的历史调试/曲线输出不是网页控制入口，本版默认关闭历史曲线输出。

BLE 名称 `LEBREW DOUBLE TO ONE`，服务 `0000180d-0000-1000-8000-00805f9b34fb`。以下短 UUID 均使用标准蓝牙基址。

| 特征 | 属性/方向 | 线格式 |
| --- | --- | --- |
| 0x2A37 | Notify，设备→主机 | 完整 A5 5A 响应/事件帧 |
| 0x2A38 | Write，主机→设备 | 16B 兼容前缀 + 完整 A5 5A 控制帧 |
| 0x2A39 | Write / Notify | 写：16B 前缀 + OTA 控制；通知：OTA ACK |
| 0x2A40 | WriteWithoutResponse，必要时回退 Write | seq:u16BE + chunk 数据，无前缀 |
| 0x2A24（设备信息服务） | Read | `HW0.0.1SW0.0.2` |

16B 前缀由固件 `user_ble.c/command_parameter` 与网页 `aw_protocol.js/COMMAND_KEY` 定义，使用配套实现，保持一致。先订阅通知再发命令；GATT 写操作须排队，不能并行启动相互冲突的 GATT 操作。

## 2. 通用帧

```text
A5 5A | body_len:u16LE | version:u8=01 | command:u8 | sequence:u16LE | payload[N] | crc16:u16LE
```

`body_len=4+N`，范围 4..132，总长 `10+N`，payload 最多 128B。CRC16-CCITT-FALSE：多项式 0x1021、初值 0xFFFF、不反射、无最终异或；从 **body_len 字段**算到 payload 末尾，不含帧头与 CRC 自身。`123456789` 的 CRC=0x29B1。

普通整数使用小端，float 使用 IEEE754 binary32。**OTA total、chunk、数据包序号和 ACK 序号使用大端**。响应 command=request|0x80，sequence 回显请求；主动事件使用设备自己的非零 sequence，不能替代任务 ID。串口 read 和 BLE notify 都可能拆包/粘包，必须按帧头、长度和 CRC 增量解码。

## 3. 指令表

成功响应的首字节一般为 status。错误通常只含 status；可关联的 START_CAPTURE 错误保留 point/capture_id。事件不统一带 status，按后文各自布局读取。

| 命令 | 名称 | 请求 payload | 成功响应 payload |
| --- | --- | --- | --- |
| 0x01 | GET_INFO | 空 | 37B：status + device_id[20] + firmware[16] |
| 0x02 | GET_PARAMS | 空 | 17B 参数结构 |
| 0x03 | SET_PARAMS | K:f32 + B:f32 | 同 GET_PARAMS |
| 0x04 | RESET_PARAMS | 空 | 同 GET_PARAMS，K=1/B=0 |
| 0x05 | START_CAPTURE | point:u8 + capture_id:u64 | status + point:u8 + capture_id:u64（10B） |
| 0x06 | CANCEL_CAPTURE | 空 | status |
| 0x07 | SET_STREAM | enabled:u8 + interval_ms:u16 | status + enabled + interval_ms（4B） |
| 0x08 | HEARTBEAT | 空 | status |
| 0x09 | OTA_START（串口） | total:u32BE + chunk:u16BE | status；新版成功可附 F2/01/0A 能力，随后切裸包接收 |
| 0x0A / 0x0B | OTA_END / OTA_ABORT | 空（帧控制状态） | status；裸包状态另用转义控制 |
| 0x0C | OTA_ENTER_AP | 空 | status，随后重启热点 |
| 0x0D | BLE_DISCONNECT | 空 | status，随后设备主动断链 |
| 0x0E | GET_FIRMWARE_ID | 空 | status + ELF SHA256[32] + uptime_ms:u32（37B） |
| 0x0F | READ_SN | 空 | status + length:u8 + ASCII SN |
| 0x10 | WRITE_SN | 18B ASCII SN | status |
| 0x11 | MEASUREMENT_CONTROL | 空查询；或 action/bean/mode/0/request_id:u32 | 28B 状态 |
| 0x12 | DEVICE_CONTROL | 空查询；或 action/value/0/0/request_id:u32 | 20B 状态 |
| 0x40 | 水活遥测事件 | — | 25B |
| 0x41 | 采集进度事件 | — | 23B |
| 0x42 | 采集结果事件 | — | 28B |
| 0x43 | 通知事件 | — | notice:u8 |
| 0x44 | 串口 OTA ACK 事件 | — | ok:u8 + seq:u16BE |
| 0x45 | 水分密度遥测事件 | — | 34B |

### 状态码

0=OK；1=UNKNOWN_COMMAND；2=BAD_LENGTH；3=INVALID_PARAMETER；4=BUSY；5=SENSOR_UNAVAILABLE；6=CAPTURE_TIMEOUT；7=STORAGE_ERROR；8=INTERNAL_ERROR；9=SN_LOCKED；10=MD_NOT_CALIBRATED（缺本机空杯基准）。异步命令 OK 只代表接受，不能直接显示测量或校准完成。

GET_INFO 字符串固定宽度、补零/截断，firmware 来源为 ESP app descriptor，值 0.0.2。GET_PARAMS：`status:u8, schema:u16, params_valid:u8, cal_dew_valid:u8, K:f32, B:f32, cal_dew:f32`。schema 是参数结构版本，不是软件版本或写入次数。SET_PARAMS/RESET_PARAMS 使旧露点校准失效；0x43 通知 1=参数变化、2=需要重新做 0.753 校准。

SET_STREAM enabled=0/1，interval_ms=100..1000。建议每秒发送 HEARTBEAT。关闭流不等于断链；BLE 优先发 0x0D 再释放客户端，避免 Windows 保留物理会话与设备图标。

## 4. 四点采集与遥测

point_id：0=0.328、1=0.529、2=0.753、3=水/1.000。capture_id 为主机非零 u64。稳定窗口为 150 样本、100ms 间隔，总体标准差 <0.05 %RH，最长 480s。网页每点 1/2/3 次是主机重复策略，每次使用独立 START_CAPTURE。

- 0x41（23B）：`point:u8, capture_id:u64, sample_count:u16, elapsed_ms:u32, mean_raw:f32, stddev_raw:f32`。
- 0x42（28B）：`point:u8, result_code:u8, capture_id:u64, sample_count:u16, elapsed_ms:u32, mean_raw:f32, mean_corrected:f32, stddev_raw:f32`。
- result_code：0=稳定、1=超时、2=取消、3=传感器错误；非稳定结果的 corrected=0 是不可用哨兵，不可参与拟合。ACK 不是稳定结果，结果必须匹配 point/capture_id。
- 0x40（25B）：`flags:u8, sample_sequence:u32, temperature_C:f32, RH_raw:f32, RH_corrected:f32, AW_unclamped:f32, AW_final:f32`。flags bit0=传感器在线、bit1=K/B 有效、bit2=露点校准有效。
- 0x45（34B）：`flags:u8, bean:u8, sample_sequence:u32, moisture_pct:f32, density_g_L:f32, capacitance_pF:f32, weight_adc:i32, weight_g:f32, empty_capacitance_pF:f32, delta_capacitance_pF:f32`。flags bit0=电容在线、bit1=称重在线、bit2=水分有效、bit3=空杯已校准。旧 26B 版本不含最后两个 float，网页兼容但不伪造缺失实测值。

bean：0=烘焙豆、1=生豆、2=带壳豆、3=干果。ΔC=原始电容−本机空杯电容，保留负值，尚未做温度补偿。实时值不等于最终平均结果，最终结果取 0x11 完成状态/有效位。

## 5. 远程测量 0x11

空 payload 查询；控制为 8B：`action:u8, bean:u8, mode:u8, reserved=0:u8, request_id:u32`。

| action | 行为 | mode |
| --- | --- | --- |
| 1 | 切换豆种页面并开始测量 | 1=水分密度、2=水活、3=全部 |
| 2 | 取消对应 request_id 的任务 | 使用该任务 bean/mode |
| 3 | 只切换豆种与页面，不测量 | 必须为 0 |

启动/切换 request_id 非零；同 ID 同参数幂等，同 ID 参数冲突或错误取消 ID 被拒绝。28B 状态：`status, phase, bean, mode, result_flags, screen_id, error, availability, request_id:u32, elapsed_ms:u32, moisture:f32, density:f32, aw:f32`，前 8 项各 u8。

phase：0=待机、1=待 UI、2=运行、3=完成、4=取消、5=失败。result_flags bit0=MD 有效、bit1=AW 有效；未置位的 float 不可用。availability bit0=UI 就绪、bit1=设备本地校准忙。全测先报告 MD，再完成 AW；取消保留已完成单项。网页移除单独 AW/取消按钮，兼容协议仍保留。

四种豆种共用动态测量页，screen_id 可能相同，必须结合 bean 判断。建议每秒查询。丢 ACK/超时先查状态，不自动重复启动。

## 6. 设置与本机校准 0x12

空 payload 查询；控制为 8B：`action:u8, value:u8, reserved[2]=0, request_id:u32`。

| action | 动作 | value |
| --- | --- | --- |
| 1 | 保存语言并进入设备设置页 | 0=中文、1=English |
| 2 | 保存待机时间并回读 | 3/5/10 分钟 |
| 3 | 原有水分和密度空杯校准 | 0 |
| 4 | 原有 0.753 水活校准 | 0 |

20B 状态：`status, phase, action, value, language, standby_minutes, screen_id, error, availability, reserved[3]=0, request_id:u32, elapsed_ms:u32`。phase：0=待机、1=待 UI、2=执行、3=完成、4=失败。availability bit0=UI 就绪、bit1=本地忙。启动初期 ready=0、standby=0 表示尚未发布设置，不能误报完成。

设置保存/回读通过才完成，语言仅改 CONFIG 的语言字段；校准等待原有成功界面/保存流程。测量、校准、四点采集、参数/SN 写入与升级互锁。断开上位机不等于取消设备操作。

网页 action=3 前提示“倒空并清洁测量杯，空杯放稳后确认”；action=4 前提示“放入 0.753 标准液并密封，等待温度稳定后确认”。取消/Esc 不发送命令；自行开发主机也须实现准备确认，设备协议不替主机显示弹窗。

## 7. SN

18B SN：`LB + DT01 + YYMMDD + 产线 A-Z + 4 位流水号 + Base36 校验字符`。算法和已知向量见 `user_sn.c`/`sn_code.js`。首次保存于 `aw_identity/device_sn`，同 SN 幂等，覆盖其他 SN 返回 9。写后必须 READ_SN 精确比对，超时不能视为可更换号码重试。二维码直接编码完整 SN，无 URL 或 S/N 前缀；黑底白码，未写 SN 隐藏。

## 8. 三通道 OTA

OTA 只使用应用 `LEBREW_TDS_TEMP.bin`，不要使用合并整片镜像。目标 ESP32-C6，每槽 0x1E0000 字节；先停流并结束冲突操作。chunk 最大 244，按浏览器实际能力协商；数据 seq 从 0 递增，FFFF 保留控制；末包 FF 补齐 chunk，按 total 裁掉填充。

### USB

帧 0x09 请求 `total:u32BE, chunk:u16BE`，成功后裸发 `[seq:u16BE][chunk 数据]`。每 10 包或接满 total 返回 0x44：`ok:u8, seq:u16BE`。ok=1 的 seq 是最后已接收包，ok=0 的 seq 是期望重传包，seq=FFFF NACK 表示 Flash 失败。

2026-10-26 USB 批量写入扩展（网页 1.1.26-web）：成功 START 的 payload 为 `00 F2 01 0A` 时，表示扩展 F2、版本 1，接收缓冲支持一个 10 包窗口。新网页可将最多 10 个完整 `[seq][chunk]` 连成一次 Web Serial 写入，等待窗口 ACK 后再发下一组，不再逐包固定等待。普通 START payload 只有 status、未知扩展或失败应答时，必须保留原有逐包兼容模式。设备 USB RX 缓冲为 4096 字节、单次读取最多 1024 字节；包/ACK/END/ABORT/Flash 校验格式不变。能力仅在成功 START 应答中返回，旧网页只读取 status 仍可使用。

裸包结束用 **FF FF 12**，中止用 **FF FF 13**。不能只发 12/13，也不能在裸包内插普通帧替代转义。0x1200/0x1300 是正常数据包号，不能误当控制。普通帧 0x12 是设备设置命令，与裸包转义处于不同解析状态。

### BLE

0x2A39 写 16B 前缀后再加 START=`11 total:u32BE chunk:u16BE`、END=`12`、ABORT=`13`。Notify ACK=`A0 ok:u8 seq:u16BE`，不含前缀/A5 5A。0x2A40 数据同串口数据包，无前缀。必须使用实际协商 chunk，不能逐包截断来伪装长度兼容。

2026-10-26 高速扩展（配套网页 1.1.25-web，必须按能力判断，不能只看软件版本号）：

- 新固件成功 ABORT 的通知为 `A0 00 00 00 F1 01 20`，最后三字节表示扩展标记 F1、扩展版本 1、32 包窗口（20 为十六进制）。其前四字节保留旧 ACK 格式，旧网页可继续读取。
- 网页只有收到准确的上述能力，才发送 `START_FAST=14 total:u32BE chunk:u16BE`（仍为 7 字节控制载荷）。此会话每 32 包或收到 total 时提交 Flash 并发送 ACK；ACK 序号仍是最后已成功提交的包，NACK 是期望重传包，FFFF 仍表示致命 Flash 失败。
- 普通 `START=11` 始终为 10 包窗口；旧固件未返回能力时，新网页继续发送 11。串口格式和 10 包窗口不变。
- 接收队列 40 项，缓冲最大 32×244 字节；只有 Flash 写入成功才确认前缀，最终校验/启动分区切换不变。不得向旧固件直接发送高速开始命令或仅在网页擅自扩大窗口。
- BLE 升级准备/启动时请求连接间隔 7.5–15 ms、零延迟、DLE 251 和 2M PHY。请求不保证被电脑接受，实际连接参数/PHY 输出到 `BLE_OTA_LINK` 日志。

### WiFi 热点

帧 0x0C 成功后重启为 `LEBREW-AW`，使用设备配套接入口令连接后访问 `http://192.168.4.1`。

- GET `/info`：`{"device":"LEBREW-AW","ota":true,"chip":"esp32c6"}`。
- POST `/ota`：Content-Type=`application/octet-stream`，body 为完整应用 bin；成功 `OK-rebooting` 后重启，错误 HTTP 400/500 与 ERR:*。
- 支持 OPTIONS/CORS；浏览器本地网络策略拦截时，可在热点内置页面选择应用文件。

### 完成验证

100% 只代表传输进度，需等校验/重启，重连后用 0x0E 对比运行 ELF SHA256 与所选应用 app descriptor 的指纹。文件整体 SHA256 与 ELF SHA256 是不同校验值，不能混用；GET_INFO 显示版本不能代替指纹核对。应用 OTA 不清 NVS。

## 9. 编码器生成的 USB 完整帧示例

```text
GET_INFO，sequence=1：
A5 5A 04 00 01 01 01 00 04 7A
HEARTBEAT，sequence=2：
A5 5A 04 00 01 08 02 00 C6 B1
生豆 MD 测量，sequence=3，request_id=1：
A5 5A 0C 00 01 11 03 00 01 01 01 00 01 00 00 00 CC 4C
English，sequence=4，request_id=2：
A5 5A 0C 00 01 12 04 00 01 01 00 00 02 00 00 00 B0 F6
```

BLE 普通命令需再加 16B 前缀。实现依据：`user_calibration_protocol.h`、`user_calibration_service_core.c`、`user_measurement_control.*`、`user_device_control.*`、`user_aw_ota.c` 及配套网页协议/测试。
