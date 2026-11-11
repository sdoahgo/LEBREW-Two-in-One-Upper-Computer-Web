import {SerialTransport} from './comm_link.js';
import {Command,StreamDecoder,encodeFrame,unpackDeviceInfo} from './aw_protocol.js';
// Only previously authorized ESP USB Serial/JTAG ports. Match identity with a read-only command.
export async function connectAuthorizedSerial(expectedId,{serial=globalThis.navigator?.serial,timeoutMs=2500}={}) {
  if(!serial?.getPorts) return null;
  const ports=(await serial.getPorts()).filter(p=>{const i=p.getInfo();return i.usbVendorId===0x303a && i.usbProductId===0x1001;});
  for(const port of ports) {
    const transport=new SerialTransport({name:'SERIAL',serial,presetPort:port,bufferSize:16384});let keep=false;
    try {
      await transport.connect();
      try {await port.setSignals({dataTerminalReady:false,requestToSend:false,breakpoint:false});} catch {}
      const decoder=new StreamDecoder();let off,timer;
      const info=await new Promise((resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('设备身份读取超时')),timeoutMs);
        off=transport.on('data',({bytes})=>{
          for(const frame of decoder.feed(bytes)) if(frame.command===(Command.GET_INFO|0x80) && frame.sequence===0xe130) {
            try {if(frame.payload[0]!==0) throw new Error('设备身份查询失败');resolve(unpackDeviceInfo(frame.payload));}catch(error){reject(error);}
          }
        });
        transport.write(encodeFrame(Command.GET_INFO,0xe130,new Uint8Array())).catch(reject);
      }).finally(()=>{clearTimeout(timer);off?.();});
      if(expectedId ? info.deviceId===expectedId : /^LBDT01/.test(info.deviceId)) {keep=true;return transport;}
    } catch { /* A busy/unrelated authorized port is never chosen as the target. */ }
    finally {if(!keep) await transport.disconnect();}
  }
  return null;
}
