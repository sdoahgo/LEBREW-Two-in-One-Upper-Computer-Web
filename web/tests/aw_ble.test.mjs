import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AwBleTransport } from '../aw_ble.js';
import { AW_BLE, StreamDecoder, buildBleCommand, encodeFrame, Command, parseBleCommandKey } from '../aw_protocol.js';

const commandKey = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

test('command prefix accepts raw hex or copied byte literals', () => {
  assert.deepEqual(parseBleCommandKey('0102030405060708090A0B0C0D0E0F10'), commandKey);
  assert.deepEqual(parseBleCommandKey([...commandKey].map(n => '0x' + n.toString(16).padStart(2, '0')).join(', ')), commandKey);
  assert.equal(parseBleCommandKey('0102'), null);
  assert.throws(() => buildBleCommand(Uint8Array.of(0x13), null), /16 字节/);
});

test('missing prefix is rejected before opening the Bluetooth picker', async () => {
  const transport = new AwBleTransport({ bluetooth: { requestDevice: () => assert.fail('unexpected picker') } });
  await assert.rejects(transport.connect(), { code: 'BLE_PREFIX_REQUIRED' });
});

function fixture({ missing = [], failUuid, subscribeFails = false, serviceDisconnects = 0 } = {}) {
  const operations = [];
  let busy = false;
  const gattOperation = async (name, result) => {
    assert.equal(busy, false, `concurrent GATT operation: ${name}`);
    busy = true;
    operations.push(name);
    try {
      await new Promise(resolve => setImmediate(resolve));
      return result();
    } finally { busy = false; }
  };
  const characteristics = new Map();
  for (const uuid of [AW_BLE.telemetryUuid, AW_BLE.commandUuid, AW_BLE.transferCtrlUuid, AW_BLE.transferDataUuid]) {
    const characteristic = new EventTarget();
    characteristic.startNotifications = () => gattOperation(`subscribe:${uuid}`, () => {
      if (subscribeFails) throw new DOMException('subscription failed', 'NetworkError');
      return characteristic;
    });
    characteristic.writes = [];
    characteristic.writeValueWithResponse = bytes => gattOperation(`write:${uuid}`, () => characteristic.writes.push(bytes.slice()));
    characteristic.writeValueWithoutResponse = characteristic.writeValueWithResponse;
    characteristics.set(uuid, characteristic);
  }
  const device = new EventTarget();
  device.forgot = 0;
  device.forget = async () => { device.forgot++; };
  const service = { getCharacteristic: uuid => gattOperation(`discover:${uuid}`, () => {
    if (uuid === failUuid) throw new DOMException('link lost', 'NetworkError');
    if (missing.includes(uuid)) throw new DOMException('missing', 'NotFoundError');
    return characteristics.get(uuid);
  }) };
  device.gatt = {
    connected: false,
    connect: () => gattOperation('connect', () => { device.gatt.connected = true; return device.gatt; }),
    getPrimaryService: () => gattOperation('service', () => {
      if (serviceDisconnects-- > 0) {
        device.gatt.disconnect();
        throw new DOMException('disconnected during discovery', 'NetworkError');
      }
      return service;
    }),
    disconnect: () => { device.gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
  };
  const transport = new AwBleTransport({ commandKey, bluetooth: { requestDevice: async () => device }, retryDelayMs: 0, disconnectTimeoutMs: 15 });
  return { transport, device, characteristics, operations };
}

test('discovery, subscriptions and concurrent command/OTA writes are serialized', async () => {
  const { transport, characteristics } = fixture();
  await transport.connect();
  assert.equal(transport.isConnected, true);
  const frame = encodeFrame(Command.GET_INFO, 1);
  await Promise.all([transport.write(frame), transport.writeControl(Uint8Array.of(0x13)), transport.writeData(Uint8Array.of(0, 1, 2))]);
  assert.deepEqual(characteristics.get(AW_BLE.commandUuid).writes, [Uint8Array.of(...commandKey, ...frame)]);
  assert.deepEqual(characteristics.get(AW_BLE.transferCtrlUuid).writes, [Uint8Array.of(...commandKey, 0x13)]);
  assert.deepEqual(characteristics.get(AW_BLE.transferDataUuid).writes, [Uint8Array.of(0, 1, 2)]);
  await transport.disconnect();
});

test('OTA data falls back to response writes when the browser cannot send a full packet without response', async () => {
  const { transport, characteristics } = fixture();
  await transport.connect();
  const data = characteristics.get(AW_BLE.transferDataUuid);
  data.properties = {write:true};let attempts=0;
  data.writeValueWithoutResponse = async()=>{attempts++;throw new DOMException('MTU limit','InvalidModificationError');};
  const packet=new Uint8Array(246);
  await transport.writeData(packet);await transport.writeData(packet);
  assert.equal(attempts,1);assert.equal(data.writes.length,2);
  await transport.disconnect();
});

test('normal disconnect preserves permission and removes notification handlers', async () => {
  const { transport, device, characteristics } = fixture();
  await transport.connect();
  let received = 0;
  transport.on('data', () => received++);
  const telemetry = characteristics.get(AW_BLE.telemetryUuid);
  telemetry.value = new DataView(Uint8Array.of(1, 2).buffer);
  telemetry.dispatchEvent(new Event('characteristicvaluechanged'));
  assert.equal(received, 1);
  await transport.disconnect();
  telemetry.dispatchEvent(new Event('characteristicvaluechanged'));
  assert.equal(received, 1);
  assert.equal(device.forgot, 0);
});

for(const [packetLimit,expectedChunk] of [[246,242],[244,242],[20,18]]) {
  test(`OTA packet probe chooses ${expectedChunk} payload bytes for browser limit ${packetLimit}`,async()=>{
    const {transport,characteristics}=fixture();await transport.connect();
    const data=characteristics.get(AW_BLE.transferDataUuid);data.properties={write:true,writeWithoutResponse:true};
    const sizes=[];
    data.writeValueWithoutResponse=async bytes=>{
      sizes.push(bytes.length);
      if(bytes.length>packetLimit)throw new DOMException('MTU limit','InvalidModificationError');
      data.writes.push(bytes.slice());
    };
    try {
      const chunk=await transport.prepareOtaData(244);
      assert.equal(chunk,expectedChunk);assert.equal(transport.otaWriteMode,'无响应写');
      assert.ok(sizes.every(size=>size<=244),'sequence bytes count toward the packet limit');
      assert.ok(data.writes.every(p=>p[0]===255&&p[1]===255));
      await transport.writeData(new Uint8Array(chunk+2));
      assert.equal(sizes.at(-1),expectedChunk+2);
    }finally{await transport.disconnect();}
  });
}

test('OTA negotiation preserves connection errors instead of treating them as packet size limits',async()=>{
  const {transport,characteristics}=fixture();await transport.connect();
  const data=characteristics.get(AW_BLE.transferDataUuid);
  data.writeValueWithoutResponse=async()=>{throw new DOMException('radio failure','NetworkError');};
  try{await assert.rejects(transport.prepareOtaData(244),/radio failure/);assert.equal(data.writes.length,0);}
  finally{await transport.disconnect();}
});

test('a stuck OTA write times out and invalidates queued writes before releasing the UI', async () => {
  const { transport, device, characteristics } = fixture();
  await transport.connect();transport.gattTimeoutMs = 5;
  characteristics.get(AW_BLE.transferCtrlUuid).writeValueWithResponse = ()=>new Promise(()=>{});
  const results = await Promise.allSettled([
    transport.writeControl(Uint8Array.of(0x11)), transport.writeData(new Uint8Array(246)),
  ]);
  assert.equal(results[0].status,'rejected');assert.match(results[0].reason.message,/超时/);
  assert.equal(results[1].status,'rejected');assert.equal(device.gatt.connected,false);
  assert.equal(characteristics.get(AW_BLE.transferDataUuid).writes.length,0);
});

test('missing OTA characteristics are reported separately from a lost GATT link', async () => {
  const { transport } = fixture({ missing: [AW_BLE.transferCtrlUuid] });
  await assert.rejects(transport.connect(), { code: 'BLE_FIRMWARE_TOO_OLD' });
  assert.equal(transport.isConnected, false);
});

test('discovery NetworkError is preserved and does not revoke permission', async () => {
  const { transport, device } = fixture({ failUuid: AW_BLE.transferCtrlUuid });
  await assert.rejects(transport.connect(), { code: 'BLE_CONNECT_FAILED', message: /link lost/ });
  assert.equal(device.gatt.connected, false);
  assert.equal(device.forgot, 0);
  assert.equal(transport._notifyHandlers.size, 0);
});

test('subscription failure cleans up partially attached listeners', async () => {
  const { transport } = fixture({ subscribeFails: true });
  await assert.rejects(transport.connect(), { code: 'BLE_CONNECT_FAILED' });
  assert.equal(transport._notifyHandlers.size, 0);
});

test('device chooser errors retain their real cause', async () => {
  const transport = new AwBleTransport({ commandKey, bluetooth: { requestDevice: async () => {
    throw new DOMException('user gesture required', 'SecurityError');
  } } });
  await assert.rejects(transport.connect(), { code: 'BLE_DEVICE_REQUEST_FAILED', message: /user gesture required/ });
});

test('transient disconnect during discovery reconnects and rebuilds subscriptions', async () => {
  const { transport, operations } = fixture({ serviceDisconnects: 1 });
  await transport.connect();
  assert.equal(transport.isConnected, true);
  assert.equal(operations.filter(x => x === 'connect').length, 2);
  assert.equal(transport._notifyHandlers.size, 2);
  await transport.disconnect();
});

test('discovery reconnect attempts are bounded', async () => {
  const { transport, operations } = fixture({ serviceDisconnects: 9 });
  await assert.rejects(transport.connect(), { code: 'BLE_CONNECT_FAILED' });
  assert.equal(operations.filter(x => x === 'connect').length, 3);
  assert.equal(transport.isConnected, false);
});

test('unique previously granted matching device reconnects without scanning', async () => {
  const { transport, device } = fixture();
  device.name = 'LEBREW DOUBLE TO ONE';
  transport.bluetooth.getDevices = async () => [device, { name: 'LEBREW TEMP' }];
  transport.bluetooth.requestDevice = () => { throw new Error('should reuse granted device'); };
  await transport.connect();
  assert.equal(transport.device, device);
  await transport.disconnect();
});

test('multiple granted calibrators still require explicit device selection', async () => {
  const { transport, device } = fixture();
  transport.bluetooth.getDevices = async () => [{ name: 'LEBREW DOUBLE TO ONE A' }, { name: 'LEBREW DOUBLE TO ONE B' }];
  let selected = false;
  transport.bluetooth.requestDevice = async options => {
    selected = true;
    assert.equal(options.filters[0].namePrefix, 'LEBREW DOUBLE TO ONE');
    return device;
  };
  await transport.connect();
  assert.equal(selected, true);
  await transport.disconnect();
});

test('a hung discovery operation times out and releases the connecting state', async () => {
  const { transport, device } = fixture();
  transport.gattTimeoutMs = 5;
  transport.connectRetryCount = 0;
  device.gatt.getPrimaryService = () => new Promise(() => {});
  await assert.rejects(transport.connect(), { code: 'BLE_CONNECT_FAILED', message: /超时/ });
  assert.equal(device.gatt.connected, false);
  assert.equal(transport.isConnected, false);
});

test('disconnect asks peripheral to terminate and waits for its disconnection event', async () => {
  const { transport, device, characteristics } = fixture();
  transport.disconnectTimeoutMs = 500;
  await transport.connect();
  let requested = false;
  const command = characteristics.get(AW_BLE.commandUuid);
  const original = command.writeValueWithResponse;
  command.writeValueWithResponse = async bytes => {
    await original(bytes);
    const [frame] = new StreamDecoder().feed(bytes.slice(16));
    assert.equal(frame.command, Command.BLE_DISCONNECT);
    assert.equal(frame.payload.length, 0);
    requested = true;
    setTimeout(() => device.gatt.disconnect(), 5);
  };
  const first = transport.disconnect();
  assert.equal(first, transport.disconnect());
  await first;
  assert.equal(requested, true);
  assert.equal(device.gatt.connected, false);
  await assert.rejects(transport.write(encodeFrame(Command.HEARTBEAT, 2)), { code: 'NOT_CONNECTED' });
});
