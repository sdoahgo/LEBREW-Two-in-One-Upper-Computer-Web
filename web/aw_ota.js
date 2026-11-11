import { Command, StreamDecoder, encodeFrame, unpackOtaAck, buildOtaDataPacket,
  buildBleOtaStart, buildBleOtaControl, parseBleOtaAck, serialOtaBurstSupported, BLE_OTA, OTA_MAX_CHUNK,
  SERIAL_CHUNK, ACK_WINDOW, BLE_FAST_ACK_WINDOW, BLE_PACKET_GAP_MS, SERIAL_PACKET_GAP_MS, AP_SSID, AP_DEVICE_URL } from './aw_protocol.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class OtaError extends Error {}

class Inbox {
  constructor() { this.items = []; this.waiters = []; }
  push(item) {
    const waiter = this.waiters.find(w => w.match(item));
    if (waiter) { this.waiters.splice(this.waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(item); }
    else { this.items.push(item); if (this.items.length > 128) this.items.shift(); }
  }
  next(match, timeoutMs) {
    const index = this.items.findIndex(match);
    if (index >= 0) return Promise.resolve(this.items.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match, resolve, reject };
      w.timer = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new OtaError('设备应答超时')); }, timeoutMs);
      this.waiters.push(w);
    });
  }
  clear() { this.items.length = 0; }
  takeAll(match) {
    const found=this.items.filter(match);
    this.items=this.items.filter(item=>!match(item));
    return found;
  }
  close() { for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(new OtaError('连接已结束')); } this.clear(); }
}
class FrameChannel {
  constructor(transport) {
    this.transport = transport; this.decoder = new StreamDecoder(); this.inbox = new Inbox(); this.seq = 0xe000;
    this.off = transport.on('data', ({bytes, kind}) => { if (kind !== 'ctrl') for (const f of this.decoder.feed(bytes)) this.inbox.push(f); });
  }
  async request(command, payload, timeoutMs = 6000) {
    const seq = this.seq++;
    await this.transport.write(encodeFrame(command, seq, payload));
    return this.inbox.next(f => f.command === (command | 0x80) && f.sequence === seq, timeoutMs);
  }
  async raw(command, op, timeoutMs = 8000) {
    await this.transport.write(Uint8Array.of(0xff, 0xff, op));
    return this.inbox.next(f => f.command === (command | 0x80) && f.sequence === 0, timeoutMs);
  }
  release() { this.off(); this.inbox.close(); }
}
export function validateFirmwareImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 32 || bytes[0] !== 0xe9) throw new OtaError('请选择 ESP32 应用固件 .bin，不能使用空文件或合并烧录文件');
  if ((bytes[12] | (bytes[13] << 8)) !== 13) throw new OtaError('固件芯片型号不是 ESP32-C6');
  if (bytes.length > 0x1e0000) throw new OtaError('固件超过设备 OTA 分区容量（1920 KB）');
}
export async function runWireOta(options) {
  const { transport, bytes, channel, onLog = () => {}, onProgress, onPhase = () => {} } = options;
  if (!['ble', 'serial'].includes(channel) || !bytes?.length) throw new OtaError('升级通道或固件无效');
  let chunk = options.chunkSize ?? (channel === 'ble' ? OTA_MAX_CHUNK : SERIAL_CHUNK);
  let packets = Math.ceil(bytes.length / chunk);
  if (chunk < 1 || chunk > 244 || packets >= 65535) throw new OtaError('固件包数或分包长度超限');
  let gap = options.packetGapMs ?? (channel === 'ble' ? BLE_PACKET_GAP_MS : SERIAL_PACKET_GAP_MS);
  let serialBurst = false;
  const timeout = options.ackTimeoutMs ?? 6000;
  const frames = new FrameChannel(transport), ackInbox = new Inbox();
  const off = transport.on('data', ({bytes,kind}) => { if (kind === 'ctrl') { const ack = parseBleOtaAck(bytes); if (ack) ackInbox.push(ack); } });
  let started = false;
  let phase='preparing';
  const updatePhase=value=>{phase=value;onPhase(value);};
  const startAt = Date.now();
  const stats={dataPackets:0,retransmittedPackets:0,nacks:0,timeouts:0,writeMs:0,ackWaitMs:0,writeCalls:0};
  let highestSent=0;
  let ackWindow=ACK_WINDOW;
  const progress = (sent, transferred=sent) => onProgress?.({sent, transferred, total:bytes.length, percent:Math.floor(sent * 100 / bytes.length), detail:`${(transferred/1024).toFixed(1)} / ${(bytes.length/1024).toFixed(1)} KB`});
  const prefix = ack => ack.ok ? ack.seq+1 : ack.seq;
  const ackMatches = (ack,begin,end) => (!ack.ok && ack.seq===0xffff) ||
    (ack.ok ? ack.seq>=begin && ack.seq<end : ack.seq>=begin && ack.seq<=end);
  const takeAcks = match => channel==='ble' ? ackInbox.takeAll(match) :
    frames.inbox.takeAll(f=>f.command===Command.OTA_ACK && match(unpackOtaAck(f.payload))).map(f=>unpackOtaAck(f.payload));
  const waitAck = async (begin,end) => {
    const match=ack=>ackMatches(ack,begin,end);
    const first=channel==='ble' ? await ackInbox.next(match,timeout) :
      unpackOtaAck((await frames.inbox.next(f=>f.command===Command.OTA_ACK&&match(unpackOtaAck(f.payload)),timeout)).payload);
    // A missing packet can generate a NACK for every later packet already in
    // flight. Let that short burst drain before starting one recovery attempt.
    if(!first.ok && first.seq!==0xffff)await sleep(options.nackSettleMs??Math.min(250,timeout));
    const acks=[first,...takeAcks(match)];
    if(acks.some(a=>!a.ok&&a.seq===0xffff))throw new OtaError('设备写入 Flash 失败，升级已中止');
    return acks.reduce((best,a)=>prefix(a)>prefix(best)||(prefix(a)===prefix(best)&&a.ok)?a:best);
  };
  try {
    updatePhase('preparing');
    onLog(`开始${channel === 'ble' ? '蓝牙' : '串口'}升级：${bytes.length} 字节`); progress(0);
    const stopped = await frames.request(Command.SET_STREAM, Uint8Array.of(0,100,0),timeout);
    if (stopped.payload[0] !== 0) throw new OtaError('设备拒绝停止实时流');
    started = true;
    if (channel === 'ble') {
      if(typeof transport.prepareOtaData==='function') {
        onLog('检测蓝牙单包长度与写入模式…');
        await transport.writeControl(buildBleOtaControl(BLE_OTA.ABORT));
        const stopped=await ackInbox.next(a=>a.seq===0,timeout);
        if(!stopped.ok)throw new OtaError('设备未确认停止旧升级会话');
        if (stopped.fastWindow === BLE_FAST_ACK_WINDOW && options.preferFastBle !== false)
          ackWindow = BLE_FAST_ACK_WINDOW;
        ackInbox.clear();
        chunk=await transport.prepareOtaData(chunk);
        if(!Number.isInteger(chunk)||chunk<1||chunk>OTA_MAX_CHUNK)throw new OtaError('蓝牙协商包长无效');
        packets=Math.ceil(bytes.length/chunk);
        if(packets>=65535)throw new OtaError('蓝牙协商包长导致包数超限');
        onLog(`蓝牙数据模式：${transport.otaWriteMode}，固件载荷 ${chunk} 字节/包，共 ${packets} 包`);
      }
      onLog(`蓝牙确认窗口：${ackWindow} 包${ackWindow === ACK_WINDOW ? '（兼容模式）' : '（高速模式）'}`);
      await transport.writeControl(buildBleOtaStart(bytes.length,chunk,ackWindow === BLE_FAST_ACK_WINDOW));
      const ack = await ackInbox.next(a => a.seq === 0,timeout);
      if (!ack.ok) throw new OtaError('设备拒绝 START（请确认配套固件及 OTA 分区）');
    } else {
      const n=bytes.length;
      const frame = await frames.request(Command.OTA_START,Uint8Array.of(n>>>24,(n>>>16)&255,(n>>>8)&255,n&255,chunk>>8,chunk&255),timeout);
      if (frame.payload[0] !== 0) throw new OtaError('设备拒绝 START，status='+frame.payload[0]);
      serialBurst = serialOtaBurstSupported(frame.payload) && options.preferFastSerial !== false &&
        (options.packetGapMs === undefined || options.packetGapMs === 0);
      if (serialBurst) gap = 0;
      onLog(serialBurst ? '串口高速模式：每 10 包合并写入，按设备 ACK 流控，无逐包延时' :
        `串口兼容模式：逐包写入，包间隔 ${gap}ms`);
    }
    started = true; onLog('START 已确认，开始发送数据');
    updatePhase('sending');
    let seq = 0, nextToSend = 0, retries = 0;
    while (seq < packets) {
      const begin=seq,end=Math.min(seq+ackWindow,packets);
      // Discard cumulative confirmations of an already known prefix before
      // retransmitting. Old NACKs must not trigger repeated recovery bursts.
      takeAcks(a=>a.seq!==0xffff && prefix(a)<=begin);
      const burst = serialBurst ? new Uint8Array((end-nextToSend)*(chunk+2)) : null;
      for (let i=nextToSend;i<end;i++) {
        const piece=new Uint8Array(chunk).fill(0xff);piece.set(bytes.subarray(i*chunk,Math.min((i+1)*chunk,bytes.length)));
        const packet=buildOtaDataPacket(i,piece);
        const writeAt=performance.now();
        if (burst) burst.set(packet,(i-nextToSend)*(chunk+2));
        else {
          if (channel==='ble') await transport.writeData(packet); else await transport.write(packet);
          stats.writeCalls++;
        }
        stats.writeMs+=performance.now()-writeAt;stats.dataPackets++;
        if(i<highestSent)stats.retransmittedPackets++;
        highestSent=Math.max(highestSent,i+1);
        if (gap) await sleep(gap);
      }
      if (burst?.length) {
        const writeAt=performance.now();
        await transport.write(burst);
        stats.writeMs+=performance.now()-writeAt;stats.writeCalls++;
      }
      nextToSend=end;
      try {
        const ackAt=performance.now();
        const ack=await waitAck(begin,end);
        stats.ackWaitMs+=performance.now()-ackAt;
        seq=ack.ok ? ack.seq+1 : ack.seq;
        // A partial positive ACK does not mean the rest of this burst was
        // lost. Fill only the newly available window space; rewind on NACK.
        if(!ack.ok)nextToSend=seq;
        if (seq <= begin) { if (++retries>8) throw new OtaError('设备重复拒绝同一窗口'); }
        else retries=0;
        if (!ack.ok) {stats.nacks++;onLog('设备请求从 seq='+seq+' 重传');}
        progress(Math.min(seq*chunk,bytes.length-1),Math.min(seq*chunk,bytes.length));
      } catch (error) {
        if(error.message.includes('写入 Flash 失败'))throw error;
        stats.timeouts++;
        if (++retries>8) throw new OtaError('窗口连续失败：'+error.message);
        onLog('窗口应答未确认，重传 seq='+begin);seq=begin;nextToSend=begin;
      }
    }
    updatePhase('validating');
    options.onStats?.({...stats,ackWindow,serialBurst});
    if(channel==='ble'&&transport.otaWriteMode)onLog(`本次蓝牙数据写入：${transport.otaWriteMode}`);
    onLog(`传输统计：发送 ${stats.dataPackets} 包，重传 ${stats.retransmittedPackets} 包，NACK ${stats.nacks} 次，超时 ${stats.timeouts} 次；写包累计 ${(stats.writeMs/1000).toFixed(1)} 秒，等待窗口确认 ${(stats.ackWaitMs/1000).toFixed(1)} 秒`);
    ackInbox.clear();
    if (channel==='ble') {
      await transport.writeControl(buildBleOtaControl(BLE_OTA.END));
      const ack=await ackInbox.next(a=>a.seq===0,timeout);
      if (!ack.ok) throw new OtaError('设备校验固件失败，未切换启动分区');
    } else {
      const frame=await frames.raw(Command.OTA_END,BLE_OTA.END,timeout);
      if(frame.payload[0]!==0) throw new OtaError('设备校验固件失败，未切换启动分区');
    }
    progress(bytes.length);
    onLog(`传输完成，设备已确认校验通过，即将重启（${((Date.now()-startAt)/1000).toFixed(1)}s）。请重连核对版本。`);
  } catch(error) {
    error.otaResultUnknown=phase==='validating'&&!error.message.includes('设备校验固件失败');
    onLog((error.otaResultUnknown?'未收到最终校验确认，结果待核对：':'升级失败：')+error.message);
    if(started) {
      try {
        if(channel==='ble') await transport.writeControl(buildBleOtaControl(BLE_OTA.ABORT));
        else await frames.raw(Command.OTA_ABORT,BLE_OTA.ABORT,1500);
      } catch { onLog('ABORT 未确认；设备通信恢复后再重试'); }
    }
    throw error;
  } finally { off();ackInbox.close();frames.release(); }
}
export async function requestApMode(transport) {
  const frames=new FrameChannel(transport);
  try { return (await frames.request(Command.OTA_ENTER_AP,new Uint8Array(),6000)).payload[0]===0; }
  finally { frames.release(); }
}
export function startApProbe(onState,onReady,timeoutMs=300000,onTimeout=()=>{}) {
  let stopped=false,timer,request;const start=Date.now();
  const stop=()=>{stopped=true;clearTimeout(timer);request?.abort();};
  const probe=async()=>{
    if(stopped)return;
    if(Date.now()-start>timeoutMs) { stop();onState('等待热点超时，请连接 LEBREW-AW 后重试上传');onTimeout();return; }
    request=new AbortController();const abort=setTimeout(()=>request.abort(),1500);
    try {
      const response=await fetch(AP_DEVICE_URL+'/info',{mode:'cors',cache:'no-store',signal:request.signal});
      const info=await response.json();
      if(!response.ok||info.device!=='LEBREW-AW'||info.ota!==true)throw new Error('not our device');
      if(!stopped) { stop();await onReady(); } return;
    } catch { /* 未连接热点或浏览器尚未授权本地网络 */ }
    finally {clearTimeout(abort);}
    if(!stopped)timer=setTimeout(probe,2000);
  };
  onState('请使用设备配套密码连接 LEBREW-AW，并允许浏览器访问本地网络。');
  timer=setTimeout(probe,1000);return stop;
}
export function uploadToFirmware(bytes,onProgress) {
  validateFirmwareImage(bytes);
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('POST',AP_DEVICE_URL+'/ota');xhr.timeout=180000;
    xhr.setRequestHeader('Content-Type','application/octet-stream');
    xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress?.(e.loaded,e.total);};
    xhr.onload=()=>xhr.status===200&&xhr.responseText.startsWith('OK')?resolve():reject(new OtaError('HTTP '+xhr.status+' '+xhr.responseText.slice(0,120)));
    xhr.onerror=()=>reject(new OtaError('上传失败：请连接 LEBREW-AW，并允许浏览器访问本地网络；也可直接打开设备升级页。'));
    xhr.ontimeout=()=>reject(new OtaError('热点上传超时，请重试'));xhr.send(bytes);
  });
}
