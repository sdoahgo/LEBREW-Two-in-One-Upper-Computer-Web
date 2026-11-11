// aw_ble.js — 二合一水活标定机专用的四特征 BLE 传输层（扩展自 comm_link 基座，不改基座）
// 服务 0x180D（沿用固件现有服务，固件侧已扩展为四特征）：
//   0x2A37 Notify           A5 5A 上行帧（固件调试文本会混入，帧解码器按魔数自动丢弃）
//   0x2A38 Write            [16B 密钥][A5 5A 完整帧] —— 命令通道（B+混合方案）
//   0x2A39 Write + Notify   OTA 控制与窗口 ACK（smoke 字节格式）
//   0x2A40 WriteNoResponse  OTA 数据包 [seq:2B BE][chunk ≤244B]

import { Transport, TransportState, transportError } from './comm_link.js';
import { AW_BLE, Command, StreamDecoder, encodeFrame, buildBleCommand } from './aw_protocol.js';

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

export class AwBleTransport extends Transport {
  constructor(options = {}) {
    super(options.name ?? 'BLE');
    this.bluetooth = options.bluetooth ?? globalThis.navigator?.bluetooth ?? null;
    this.filters = options.filters ?? [{ namePrefix: AW_BLE.namePrefix }];
    this.serviceUuid = options.serviceUuid ?? AW_BLE.serviceUuid;
    this.uuids = options.uuids ?? AW_BLE;
    this.commandKey = options.commandKey?.slice() ?? null;
    /** 预置设备（诊断/自动重连用）：跳过 requestDevice 选择框 */
    this.presetDevice = options.presetDevice ?? null;
    this.connectRetryCount = options.connectRetryCount ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.gattTimeoutMs = options.gattTimeoutMs ?? 10000;
    this.disconnectTimeoutMs = options.disconnectTimeoutMs ?? 1000;
    this._disconnectPromise = null;
    this._disconnecting = false;
    this._generation = 0;
    this.device = null;
    this.server = null;
    this.service = null;
    this.chars = null;
    /* GATT 写串行队列：Chrome 的蓝牙栈不支持并发 GATT 操作
     * （并发直接抛 NetworkError: GATT operation already in progress），
     * 连接成功瞬间页面会连发多条命令，必须排队执行 */
    this._writeChain = Promise.resolve();
    this._notifyHandlers = new Map();
    this._onGattDisconnected = () => {
      this._removeListeners();
      this.server = null;
      this.service = null;
      this.chars = null;
      this._setState(TransportState.DISCONNECTED);
      this.emit('disconnected', { transport: this, device: this.device });
    };
  }

  async connect() {
    if (!(this.commandKey instanceof Uint8Array) || this.commandKey.length !== 16) {
      throw transportError('BLE_PREFIX_REQUIRED', '请先输入 16 字节蓝牙命令前缀');
    }
    this._otaWriteWithResponse = false;
    this._disconnectPromise = null;
    this._disconnecting = false;
    this._generation++;
    if (!this.bluetooth?.requestDevice) {
      throw transportError('BLE_UNSUPPORTED', 'Web Bluetooth is not available（请用 Chrome / Edge）');
    }
    this._setState(TransportState.CONNECTING);

    let device;
    if (this.presetDevice) {
      device = this.presetDevice;
    } else {
      try {
        // Windows 可能在客户端关闭后仍保留物理连接，此时设备不广播。
        // 已授权且唯一匹配的二合一可直接重连，不依赖扫描选择框。
        if (this.bluetooth.getDevices) {
          try {
            const devices = await this.bluetooth.getDevices();
            const matches = devices.filter(d => this.filters.some(filter =>
              (filter.name && d.name === filter.name) ||
              (filter.namePrefix && d.name?.startsWith(filter.namePrefix))));
            if (matches.length === 1) device = matches[0];
          } catch { /* 不支持已授权设备枚举时继续使用选择框 */ }
        }
        device ??= await this.bluetooth.requestDevice({
          filters: this.filters,
          optionalServices: [this.serviceUuid],
        });
      } catch (error) {
        this._setState(TransportState.DISCONNECTED);
        throw transportError(
          error?.name === 'NotFoundError' ? 'DEVICE_NOT_SELECTED' : 'BLE_DEVICE_REQUEST_FAILED',
          error?.name === 'NotFoundError' ? '未选择蓝牙设备，请选择 LEBREW DOUBLE TO ONE' :
            '无法打开蓝牙设备选择：' + (error?.message || error), error);
      }
    }

    this.device = device;
    this.emit('log', { transport: this, text: `连接设备：${device.name || '未命名设备'}` });
    for (let attempt = 0; attempt <= this.connectRetryCount; attempt++) {
      device.addEventListener('gattserverdisconnected', this._onGattDisconnected);
      this._setState(TransportState.CONNECTING);

      try {
        if (!device.gatt) {
          // 浏览器记住了失效设备并跳过选择框：清记忆后让用户重点一次
          let forgot = false;
          try {
            if (typeof device.forget === 'function') {
              await device.forget();
              forgot = true;
            }
          } catch (_) { /* forget 失败不影响提示 */ }
          throw transportError(
            'BLE_CONNECT_FAILED',
            '浏览器记住了之前失效的设备（未弹选择框直接失败）'
            + (forgot ? '，已自动清除记忆——请再点一次「连接蓝牙」重新选择设备' : '——请在地址栏左侧的站点设置里清除该网站数据后重试'),
          );
        }
        this.server = await this._gatt(() => device.gatt.connect(), '建立 GATT 连接');
        this.emit('log', { transport: this, text: 'GATT 已连接，正在发现标定服务' });
        this.service = await this._gatt(() => this.server.getPrimaryService(this.serviceUuid), '发现标定服务');
        const { telemetryUuid, commandUuid, transferCtrlUuid, transferDataUuid } = this.uuids;
        // 服务发现也是 GATT 操作，必须与订阅、写入一样串行执行。
        const telemetry = await this._gatt(() => this.service.getCharacteristic(telemetryUuid), '发现实时数据特征');
        const command = await this._gatt(() => this.service.getCharacteristic(commandUuid), '发现命令特征');
        const optionalCharacteristic = async (uuid) => {
          try { return await this._gatt(() => this.service.getCharacteristic(uuid), '发现升级特征'); }
          catch (error) {
            if (error?.name === 'NotFoundError') return null;
            throw error; // 断连/权限/栈错误不能误报为旧固件
          }
        };
        const ctrl = await optionalCharacteristic(transferCtrlUuid);
        const data = await optionalCharacteristic(transferDataUuid);
        if (!ctrl || !data) {
          // 出厂固件只有 0x2A37/0x2A38（密钥校验后丢弃载荷，不做任何协议处理）：
          // 蓝牙通道必须配套 OTA 版固件。清掉浏览器对该设备的记忆，刷机后重连能拿到新特征表。
          let forgot = false;
          try {
            if (typeof device.forget === 'function') {
              await device.forget();
              forgot = true;
            }
          } catch (_) { /* forget 失败不影响提示 */ }
          throw transportError(
            'BLE_FIRMWARE_TOO_OLD',
            '设备蓝牙已连上，但固件缺少 0x2A39/0x2A40 传输特征——当前出厂固件的蓝牙不会处理任何命令。'
            + '请先用 USB 有线刷入配套固件（分区表已改双 OTA 槽，首次必须有线刷），再点「连接蓝牙」'
            + (forgot ? '（已清除浏览器设备记忆，刷机后重新选择即可）' : ''),
          );
        }
        this.chars = { telemetry, command, ctrl, data };
        await this._subscribe(telemetry, 'telemetry');
        await this._subscribe(ctrl, 'ctrl');
        if (!device.gatt.connected) throw new DOMException('GATT disconnected during setup', 'NetworkError');
        this._setState(TransportState.CONNECTED);
        this.emit('log', { transport: this, text: '特征就绪：0x2A37/0x2A38/0x2A39/0x2A40' });
        return this;
      } catch (error) {
        // 连接失败必须断开 GATT：否则链路挂着、设备蓝牙图标常亮，占住下一次连接
        try {
          if (this.device?.gatt?.connected) this.device.gatt.disconnect();
        } catch (_) { /* 断开失败不改变结论 */ }
        this._removeListeners();
        this.server = null;
        this.service = null;
        this.chars = null;
        if (attempt < this.connectRetryCount && error?.name === 'NetworkError') {
          this.emit('log', { transport: this, text: `蓝牙服务发现中断，正在重新连接 ${attempt + 1}/${this.connectRetryCount}` });
          await new Promise(resolve => setTimeout(resolve, this.retryDelayMs));
          continue;
        }
        this._setState(TransportState.DISCONNECTED);
        throw typeof error?.code === 'string' ? error : transportError('BLE_CONNECT_FAILED', 'BLE connect failed: ' + (error?.message || error), error);
      }
    }
  }

  async _gatt(operation, label) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new DOMException(`${label}超时（浏览器蓝牙栈未返回）`, 'NetworkError');
            error.gattTimedOut = true;
            reject(error);
          }, this.gattTimeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  /** 清除浏览器对该设备的记忆（权限 + 缓存的属性句柄表），下次连接重新发现服务 */
  async _forgetDevice() {
    try {
      if (this.device && typeof this.device.forget === 'function') {
        await this.device.forget();
      }
    } catch (_) { /* forget 失败不影响主流程 */ }
  }

  /** 对外：命令全超时（GATT 属性缓存过期典型症状）时主动清缓存 */
  async recoverStaleCache() {
    try {
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    } catch { /* 忽略 */ }
    await this._forgetDevice();
    this._setState(TransportState.DISCONNECTED);
    this.emit('disconnected', { transport: this, device: this.device });
  }

  async _subscribe(characteristic, kind) {
    const handler = (event) => {
      this.emit('data', { transport: this, bytes: toBytes(event.target.value), kind });
    };
    const previous = this._notifyHandlers.get(kind);
    if (previous) previous.characteristic.removeEventListener('characteristicvaluechanged', previous.handler);
    characteristic.addEventListener('characteristicvaluechanged', handler);
    this._notifyHandlers.set(kind, { characteristic, handler });
    await this._gatt(() => characteristic.startNotifications(), '订阅设备通知');
  }

  _removeListeners() {
    for (const { characteristic, handler } of this._notifyHandlers.values()) {
      characteristic.removeEventListener('characteristicvaluechanged', handler);
    }
    this._notifyHandlers.clear();
    this.device?.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
  }

  _requireChar(name) {
    const characteristic = this.chars?.[name];
    if (!characteristic || !this.device?.gatt?.connected) {
      throw transportError('NOT_CONNECTED', this.name + ' is not connected');
    }
    return characteristic;
  }

  async _write(characteristic, bytes, withoutResponse) {
    try {
      await this._gatt(() => {
        if (withoutResponse && typeof characteristic.writeValueWithoutResponse === 'function') {
          return characteristic.writeValueWithoutResponse(bytes);
        } else if (typeof characteristic.writeValueWithResponse === 'function') {
          return characteristic.writeValueWithResponse(bytes);
        }
        return characteristic.writeValue(bytes);
      }, '蓝牙写入');
    } catch (error) {
      if (error.gattTimedOut) {
        this._generation++;
        try { this.device?.gatt?.disconnect(); } catch { /* Windows 已断开 */ }
      }
      throw error;
    }
  }

  /** 所有 GATT 写入统一排队，杜绝并发 */
  _queueWrite(operation) {
    const generation = this._generation;
    const run = () => {
      if (generation !== this._generation) throw transportError('NOT_CONNECTED', 'BLE session ended');
      return operation();
    };
    const next = this._writeChain.then(run, run);
    this._writeChain = next.catch(() => {});
    return next;
  }

  /** 参数命令 → 0x2A38：控制器给的是裸 A5 5A 帧，设备要求 [16B 密钥][帧]（带响应写） */
  async writeCommand(bytes) {
    if (this._disconnecting) throw transportError('NOT_CONNECTED', 'BLE is disconnecting');
    return this._queueWrite(() => this._write(this._requireChar('command'), bytes, false));
  }

  /** OTA 控制（START/END/ABORT）→ 0x2A39：同样要求密钥前缀（固件侧校验后剥离） */
  async writeControl(bytes) {
    if (this._disconnecting) throw transportError('NOT_CONNECTED', 'BLE is disconnecting');
    return this._queueWrite(() => this._write(this._requireChar('ctrl'), buildBleCommand(bytes, this.commandKey), false));
  }

  /** OTA 数据包（[seq:2B BE][chunk]）→ 0x2A40，无响应写（高频通道，不走密钥） */
  get otaWriteMode() { return this._otaWriteWithResponse ? '带响应写' : '无响应写'; }

  /* Called only after an acknowledged ABORT, before START. FFFF is reserved
   * and the matching firmware treats it as a no-op even during a session. */
  async prepareOtaData(maxChunk=244) {
    return this._queueWrite(async () => {
      const data=this._requireChar('data');
      // Include the two-byte sequence in the 244-byte characteristic value.
      // A resolved browser write promise does not prove an oversized command
      // reached the peripheral; do not probe beyond this single-PDU limit.
      const safeChunk=Math.min(maxChunk,242);
      if(typeof data.writeValueWithoutResponse==='function' && data.properties?.writeWithoutResponse!==false) {
        const candidates=[...new Set([safeChunk,Math.min(safeChunk,180),Math.min(safeChunk,120),Math.min(safeChunk,18)])];
        for(const chunk of candidates) {
          const probe=new Uint8Array(chunk+2).fill(0xff);
          try {
            await this._write(data,probe,true);
            this._otaWriteWithResponse=false;
            return chunk;
          } catch(error) {
            if(!['InvalidModificationError','DataError','NotSupportedError'].includes(error.name))throw error;
          }
        }
      }
      if(data.properties?.write===false)throw transportError('BLE_OTA_WRITE_UNAVAILABLE','浏览器不支持设备所需的蓝牙写入方式');
      this._otaWriteWithResponse=true;
      return Math.min(maxChunk,242);
    });
  }

  async writeData(bytes) {
    if (this._disconnecting) throw transportError('NOT_CONNECTED', 'BLE is disconnecting');
    return this._queueWrite(async () => {
      const data = this._requireChar('data');
      try { await this._write(data, bytes, !this._otaWriteWithResponse); }
      catch (error) {
        if (this._otaWriteWithResponse || !data.properties?.write || !this.device?.gatt?.connected) throw error;
        this._otaWriteWithResponse = true;
        this.emit('log', { transport: this, text: '蓝牙无响应写不可用，升级数据切换为带响应写' });
        await this._write(data, bytes, false);
      }
    });
  }

  /** 基座 Link 通用出口：自动补 16B 密钥后走命令特征 */
  async write(bytes) {
    return this.writeCommand(buildBleCommand(bytes, this.commandKey));
  }

  disconnect() {
    if (!this._disconnectPromise) {
      this._disconnecting = true;
      this._generation++; // 未开始的旧会话写入不再发送
      this._disconnectPromise = this._disconnectLink();
    }
    return this._disconnectPromise;
  }

  async _disconnectLink() {
    const device = this.device;
    const command = this.chars?.command;
    if (command && device?.gatt?.connected) {
      // gatt.disconnect() 只释放当前网页客户端；让外设终止 Windows 保留的物理链路。
      const sequence = 0xfffd;
      const decoder = new StreamDecoder();
      let finish;
      const closed = new Promise(resolve => { finish = resolve; });
      const offDisconnected = this.on('disconnected', () => finish());
      const offData = this.on('data', ({ bytes, kind }) => {
        if (kind === 'ctrl') return;
        for (const frame of decoder.feed(bytes)) {
          if (frame.command === (Command.BLE_DISCONNECT | 0x80) && frame.sequence === sequence &&
              frame.payload[0] !== 0) finish(); // 旧固件不支持时仍释放网页客户端
        }
      });
      const timer = setTimeout(() => finish(), this.disconnectTimeoutMs);
      try {
        this._queueWrite(() => this._write(command,
          buildBleCommand(encodeFrame(Command.BLE_DISCONNECT, sequence), this.commandKey), false))
          .catch(() => finish());
        await closed;
      } finally {
        clearTimeout(timer);
        offData();
        offDisconnected();
      }
    }
    try { if (device?.gatt?.connected) device.gatt.disconnect(); } catch { /* 已断开 */ }
    this.server = null;
    this.service = null;
    this.chars = null;
    this._setState(TransportState.DISCONNECTED);
    this._removeListeners();
    return this;
  }
}
