import {bytesToHex} from './comm_link.js';

// Rendering full firmware bursts repeatedly can dominate the transfer itself.
// The caller retains original bytes; only the on-screen preview is bounded.
export function trafficPreview(bytes,hex=true) {
  const preview=bytes.subarray(0,128);
  const body=hex ? bytesToHex(preview) :
    new TextDecoder().decode(preview).replace(/[^\x20-\x7e\n\r\t]/g,'·');
  return body+(bytes.length>preview.length ? ` … [${bytes.length} bytes]` : '');
}
