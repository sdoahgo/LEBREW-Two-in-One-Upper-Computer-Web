// Same weighted Base36 check character as the coffee-scale upper computer.
const ALPHABET='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function snCheckCharacter(body) {
  if(typeof body!=='string'||!/^[0-9A-Z]{17}$/.test(body))return null;
  const sum=[...body].reduce((n,c,i)=>n+ALPHABET.indexOf(c)*[1,3,7][i%3],0);
  return ALPHABET[(36-sum%36)%36];
}
function validDate(text) {
  if(!/^\d{6}$/.test(text))return false;
  const y=2000+Number(text.slice(0,2)),m=Number(text.slice(2,4)),d=Number(text.slice(4,6));
  const date=new Date(y,m-1,d);
  return date.getFullYear()===y&&date.getMonth()===m-1&&date.getDate()===d;
}
export function snValidate(sn) {
  return typeof sn==='string'&&/^LBDT01\d{6}[A-Z]\d{4}[0-9A-Z]$/.test(sn)&&
    validDate(sn.slice(6,12))&&Number(sn.slice(13,17))>0&&snCheckCharacter(sn.slice(0,17))===sn[17];
}
export function snGenerate({date=new Date(),line='A',sequence=1}={}) {
  if(!(date instanceof Date)||!Number.isFinite(date.getTime())||date.getFullYear()<2000||date.getFullYear()>2099||
    !/^[A-Z]$/.test(line)||!Number.isInteger(sequence)||sequence<1||sequence>9999)return null;
  const day=`${String(date.getFullYear()%100).padStart(2,'0')}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
  const body=`LBDT01${day}${line}${String(sequence).padStart(4,'0')}`;
  return body+snCheckCharacter(body);
}
export function unpackSn(payload) {
  if(payload.length<2||payload[0]!==0||payload[1]>19||payload.length!==payload[1]+2)throw new Error('SN 应答长度或状态无效');
  if([...payload.slice(2)].some(b=>b<33||b>126))throw new Error('SN 应答不是有效 ASCII');
  return {sn:new TextDecoder().decode(payload.slice(2))};
}
