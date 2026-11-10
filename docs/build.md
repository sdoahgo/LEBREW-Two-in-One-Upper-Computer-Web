# 开发、测试与 Windows 构建

## 环境

- Windows 10/11，64 位 Python 3.12（包含 Tk 8.6）
- 运行依赖：`pyserial==3.5`
- 打包依赖：`pyinstaller==6.15.0`

## 源码运行

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m aw_calibrator.main --simulate
```

实机模式：

```powershell
.\.venv\Scripts\python.exe -m aw_calibrator.main
```

若系统 Python 报 `Can't find a usable init.tcl`，请安装带 Tcl/Tk 的官方 Python，并删除后重建 `.venv`。

## 上位机测试

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -m aw_calibrator.main --simulate --smoke-test
```

冒烟测试会创建真实 Tk 窗口，通过模拟帧完成设备信息、参数和遥测检查，成功时最后输出 `SMOKE_TEST_OK` 并自动退出。

## 构建 EXE

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

脚本会创建或复用 `.venv`、安装锁定依赖、执行全部测试、运行 PyInstaller，并对成品执行模拟模式冒烟测试。输出为：

```text
releases\latest\AwCalibrator.exe
```

这是 one-folder、无控制台窗口的包；请分发整个 `releases\latest` 目录，并保留 `_internal`。

构建中间文件固定放在 `build\work`，候选程序放在 `build\package`，Python 缓存放在 `build\cache`。候选程序通过模拟启动验证后，旧版自动归档到 `releases\archive`，再发布到 `releases\latest`；旧版数据与日志随目录保留，`exports` 复制到新版。构建会更新根目录的“启动水活上位机”快捷方式，默认导出位置为最新版目录下的 `exports`。

若运行和打包依赖已经安装，可使用 `powershell -ExecutionPolicy Bypass -File .\build.ps1 -SkipDependencyInstall` 跳过重复安装。更新前请先导出需要保留的会话数据并关闭上位机。

## 实机连接

实机须运行支持水活标定串口协议的 ESP32-C6 配套固件。如需升级，请向项目维护者获取与设备型号匹配的固件和操作说明。

在设备管理器中找到 VID:PID 为 `303A:1001` 的 ESP32-C6 USB Serial/JTAG 端口。关闭 IDF Monitor、串口助手等占用该端口的程序，然后在上位机刷新并选择对应的 COM 口。

常见故障：

- 点击连接时设备重启：使用最新上位机。旧版本直接采用 pySerial 默认 DTR/RTS 状态，可能触发 USB Serial/JTAG 复位。
- “串口写入超时”：确认设备运行配套结构化协议固件，并关闭其他串口程序。
- COM 号变化：USB 重枚举后属于正常现象，点击“刷新 COM”并重新选择，不要继续使用旧 COM 号。
