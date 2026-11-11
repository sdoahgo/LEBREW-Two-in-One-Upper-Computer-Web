export const DeviceAction=Object.freeze({LANGUAGE:1,STANDBY:2,CAL_MD:3,CAL_AW:4});
export const deviceControlActive=s=>!!s && [1,2].includes(s.phase);
export function validDeviceValue(action,value) {
  return Number.isInteger(value) && (action===1 ? [0,1].includes(value) : action===2 ? [3,5,10].includes(value) : [3,4].includes(action) && value===0);
}
export function packDeviceControl(action,value,requestId) {
  if(!validDeviceValue(action,value) || !Number.isInteger(requestId) || requestId<=0 || requestId>0xffffffff) throw new Error('设备操作参数无效');
  const b=Uint8Array.of(action,value,0,0,0,0,0,0);new DataView(b.buffer).setUint32(4,requestId,true);return b;
}
export function unpackDeviceState(b) {
  if(!(b instanceof Uint8Array) || b.length!==20 || b[0]!==0 || b[1]>4 || b[2]>4 || b[4]>1 ||
    (![3,5,10].includes(b[5]) && ((b[8]&1) || b[5]!==0)) || (b[8]&~3) || b[9] || b[10] || b[11] ||
    (b[1]!==0 && (!validDeviceValue(b[2],b[3]) || new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(12,true)===0))) throw new Error('设备设置状态字段无效');
  if(b[1]===3 && ((b[2]===1 && b[4]!==b[3]) || (b[2]===2 && b[5]!==b[3]) || b[7])) throw new Error('设备设置回读不一致');
  const v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  return {phase:b[1],action:b[2],value:b[3],language:b[4],standbyMinutes:b[5],screenId:b[6],error:b[7],ready:!!(b[8]&1),busy:!!(b[8]&2),requestId:v.getUint32(12,true),elapsedMs:v.getUint32(16,true)};
}
export function packDeviceState(s) {
  const b=Uint8Array.of(0,s.phase??0,s.action??0,s.value??0,s.language??0,s.standbyMinutes??3,s.screenId??0,s.error??0,(s.ready?1:0)|(s.busy?2:0),0,0,0,0,0,0,0,0,0,0,0);
  const v=new DataView(b.buffer);v.setUint32(12,s.requestId??0,true);v.setUint32(16,s.elapsedMs??0,true);unpackDeviceState(b);return b;
}
export function deviceStatusText(s) {
  if(!s) return '连接后读取设备语言与待机设置。';
  const name=['','设备语言','待机时间','水分和密度校准','水活校准'][s.action];
  if(!s.ready) return '设备正在启动，请稍候。';
  if(s.phase===0) return s.busy ? '设备正在操作，请等待完成。' : '设备设置已读取。';
  if(s.phase===1) return `${name}：指令已接收，等待设备执行。`;
  if(s.phase===2) return `${name}：进行中（${Math.floor(s.elapsedMs/1000)} 秒）。请保持样品与设备状态。`;
  if(s.phase===3) return `${name}：${s.action<=2?'已保存并回读核对':'校准完成'}。`;
  return `${name}：未完成${s.error===6?'，等待传感器或保存超时':s.error===7?'，参数保存失败':s.error===4?'，设备正忙':'，操作被中断或设备异常'}。`;
}
