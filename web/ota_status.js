// Persistent OTA result. Progress reaches 100 only after the device validates the image.
export const OTA_RESULT_KEY = 'aw_ota_result_v1';
const ACTIVE = ['preparing','sending','validating','waiting_ap'];
export function firmwareIdentity(bytes) {
  // ESP image header (24) + first segment header (8) + esp_app_desc_t.
  if (bytes.length < 288 || new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(32,true)!==0xabcd5432) {
    return {version:'',sha256:''};
  }
  const text = new TextDecoder().decode(bytes.subarray(48,80)).split('\0')[0];
  const sha256=Array.from(bytes.subarray(176,208),b=>b.toString(16).padStart(2,'0')).join('');
  return {version:text,sha256:/^0+$/.test(sha256)?'':sha256};
}
export class OtaResult {
  constructor(storage, clock=()=>Date.now()) {
    this.storage=storage;this.clock=clock;this.lastSave=0;
    this.value={phase:'idle',percent:0};
    try {
      const saved=JSON.parse(storage?.getItem(OTA_RESULT_KEY)||'null');
      if(saved&&typeof saved.phase==='string')this.value=saved;
    } catch { /* Storage may be unavailable on a local file page. */ }
    if(ACTIVE.includes(this.value.phase))this.set('unconfirmed','页面在升级期间被刷新，结果尚未确认。请重连设备后核对固件。');
    else if(this.value.phase==='verifying'||this.value.phase==='restarting')this.set('awaiting_reconnect','写入已成功，请连接设备核对运行固件。');
  }
  save(force=false) {
    if(!force&&this.clock()-this.lastSave<1000)return;
    this.lastSave=this.clock();
    try{this.storage?.setItem(OTA_RESULT_KEY,JSON.stringify(this.value));}catch{}
  }
  start(file,channel,bytes) {
    this.value={phase:'preparing',percent:0,fileName:file,channel,...firmwareIdentity(bytes),
      startedAt:this.clock(),writeConfirmed:false,detail:'正在请求设备开始升级，请保持供电。'};
    this.save(true);
  }
  set(phase,detail) {this.value={...this.value,phase,detail};this.save(true);}
  progress(percent,detail) {
    this.value.percent=Math.min(99,Math.max(0,Math.floor(percent)));
    this.value.detail=detail;this.save();
  }
  confirmed() {
    this.value={...this.value,percent:100,writeConfirmed:true,confirmedAt:this.clock()};
    this.set('restarting','设备已确认固件校验通过。等待重启后，请重新连接以核对运行固件。');
  }
  get canVerify() {return ['restarting','awaiting_reconnect','verifying','unconfirmed','mismatch'].includes(this.value.phase);}
  disconnected() {if(this.value.writeConfirmed&&this.canVerify)this.set('awaiting_reconnect','已断开，等待设备重启。请点击连接蓝牙或连接串口，系统将自动核对固件。');}
  verify(identity) {
    if(!this.canVerify)return false;
    this.value.actualSha256=identity.sha256;
    if(!this.value.sha256){this.set('unconfirmed','所选文件没有可识别的固件指纹，无法自动确认；请核对设备版本。');return false;}
    if(identity.sha256!==this.value.sha256){this.set('mismatch','设备运行的固件与所选文件不一致。请确认连接的是目标设备，再重新升级。');return false;}
    this.value.percent=100;this.value.completedAt=this.clock();this.value.uptimeMs=identity.uptimeMs;
    this.set('completed',this.value.verifyOnly?'设备当前运行的固件与所选文件一致，无需重复升级。':'运行固件指纹与所选文件一致，升级已完成。可以正常使用设备。');return true;
  }
}
export function otaPresentation(result) {
  const titles={idle:'尚未开始升级',preparing:'准备升级…',sending:'正在传输固件…',validating:'传输完成，正在校验…',
    waiting_ap:'等待连接设备热点…',restarting:'写入成功，等待设备重启',awaiting_reconnect:'写入成功，请重连确认',
    verifying:'正在核对运行固件…',completed:'✓ 升级完成，固件已核对',failed:'✕ 升级失败',
    mismatch:'✕ 运行固件不一致',unconfirmed:'结果待确认',cancelled:'已停止等待热点',mock_completed:'模拟演练完成（未烧录设备）'};
  const tone=result.phase==='completed'?'success':['failed','mismatch'].includes(result.phase)?'error':
    ['restarting','awaiting_reconnect','unconfirmed','cancelled'].includes(result.phase)?'warn':'info';
  return {title:result.phase==='completed'&&result.verifyOnly?'✓ 当前固件已核对':titles[result.phase]??'结果待确认',tone};
}
