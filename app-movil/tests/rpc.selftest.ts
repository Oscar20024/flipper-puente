/**
 * Prueba sin hardware: un "Flipper falso" que habla el mismo protocolo
 * (PB.Main delimitado por varint) para verificar el cliente RPC, la API de
 * archivos y el puente de internet. Ejecutar con: npx tsx tests/rpc.selftest.ts
 */
import assert from 'node:assert/strict';

import { InternetBridge, toFlipperText } from '../src/bridge/InternetBridge';
import { phoneHttpGet } from '../src/bridge/phoneHttpGet';
import { PB, PB_App, PB_Storage } from '../src/proto/flipper';
import { FlipperApi } from '../src/rpc/FlipperApi';
import { FrameDecoder, frame } from '../src/rpc/framing';
import { RpcClient } from '../src/rpc/RpcClient';
import type { Transport } from '../src/transport/Transport';
import { frameToBmpUri } from '../src/ui/screenFrame';

type Msg = Record<string, any>;

class FakeFlipper implements Transport {
  name = 'Flipper Falso';
  files = new Map<string, Uint8Array>([
    ['/ext/hola.txt', new TextEncoder().encode('hola mundo')],
    ['/ext/apps/Tools/internet_bridge.fap', new Uint8Array([0x7f, 0x45, 0x4c, 0x46])],
  ]);
  dirs = new Set(['/ext', '/ext/subghz', '/ext/apps/Tools']);
  writes = new Map<number, Uint8Array[]>();
  appData: string[] = [];
  appStarts = 0;
  private onDataCb: (b: Uint8Array) => void = () => {};
  private decoder = new FrameDecoder();

  onData(l: (b: Uint8Array) => void) { this.onDataCb = l; }
  onClose() {}
  async close() {}

  /** Envía respuestas partidas en trozos de 20 bytes, como haría BLE. */
  send(msg: Msg) {
    const bytes = frame(PB.Main.encode(PB.Main.create(msg as never)).finish());
    for (let i = 0; i < bytes.length; i += 20) {
      const chunk = bytes.slice(i, i + 20);
      setTimeout(() => this.onDataCb(chunk), 1);
    }
  }

  async write(bytes: Uint8Array) {
    for (const raw of this.decoder.push(bytes)) this.handle(PB.Main.decode(raw) as unknown as Msg);
  }

  private handle(m: Msg) {
    const id = m.commandId;
    switch (m.content) {
      case 'systemPingRequest':
        return this.send({ commandId: id, systemPingResponse: { data: m.systemPingRequest.data } });
      case 'storageListRequest': {
        const path = m.storageListRequest.path;
        if (!this.dirs.has(path)) return this.send({ commandId: id, commandStatus: PB.CommandStatus.ERROR_STORAGE_NOT_EXIST, empty: {} });
        const entries: Msg[] = [];
        for (const d of this.dirs) if (d !== path && d.startsWith(path + '/') && !d.slice(path.length + 1).includes('/')) entries.push({ type: PB_Storage.File.FileType.DIR, name: d.slice(path.length + 1) });
        for (const [f, data] of this.files) if (f.startsWith(path + '/') && !f.slice(path.length + 1).includes('/')) entries.push({ type: PB_Storage.File.FileType.FILE, name: f.slice(path.length + 1), size: data.length });
        // Partir en dos mensajes con has_next para probar respuestas multiparte
        const half = Math.ceil(entries.length / 2);
        this.send({ commandId: id, hasNext: true, storageListResponse: { file: entries.slice(0, half) } });
        return this.send({ commandId: id, storageListResponse: { file: entries.slice(half) } });
      }
      case 'storageReadRequest': {
        const data = this.files.get(m.storageReadRequest.path)!;
        for (let i = 0; i < data.length; i += 4) {
          this.send({ commandId: id, hasNext: i + 4 < data.length, storageReadResponse: { file: { data: data.slice(i, i + 4) } } });
        }
        return;
      }
      case 'storageWriteRequest': {
        const parts = this.writes.get(id) ?? [];
        parts.push(m.storageWriteRequest.file.data);
        this.writes.set(id, parts);
        if (m.hasNext) return;
        const total = Buffer.concat(parts.map((p) => Buffer.from(p)));
        this.files.set(m.storageWriteRequest.path, new Uint8Array(total));
        return this.send({ commandId: id, empty: {} });
      }
      case 'storageDeleteRequest':
        this.files.delete(m.storageDeleteRequest.path);
        return this.send({ commandId: id, empty: {} });
      case 'appStartRequest':
        assert.equal(m.appStartRequest.args, 'RPC');
        this.appStarts++;
        this.send({ commandId: id, empty: {} });
        this.send({ commandId: 0, appStateResponse: { state: PB_App.AppState.APP_STARTED } });
        // El FAP pide algo al celular
        return this.send({ commandId: 0, appDataExchangeRequest: { data: new TextEncoder().encode('GET example.invalid') } });
      case 'appDataExchangeRequest':
        this.appData.push(new TextDecoder().decode(m.appDataExchangeRequest.data));
        return this.send({ commandId: id, empty: {} });
      default:
        return this.send({ commandId: id, commandStatus: PB.CommandStatus.ERROR_NOT_IMPLEMENTED, empty: {} });
    }
  }
}

async function main() {
  const fake = new FakeFlipper();
  const rpc = new RpcClient(fake);
  const api = new FlipperApi(rpc);

  assert.ok((await api.ping()) >= 0);

  const list = await api.list('/ext');
  assert.deepEqual(list.map((f) => f.name), ['subghz', 'hola.txt']);
  assert.equal(list[0].isDir, true);

  assert.equal(new TextDecoder().decode(await api.read('/ext/hola.txt')), 'hola mundo');

  const big = new Uint8Array(1500).map((_, i) => i % 251);
  await api.write('/ext/grande.bin', big);
  assert.deepEqual(Array.from(fake.files.get('/ext/grande.bin')!), Array.from(big));
  assert.equal([...fake.writes.values()].at(-1)!.length, 3, 'debe partir en bloques de 512');

  await api.remove('/ext/grande.bin');
  assert.equal(fake.files.has('/ext/grande.bin'), false);

  await assert.rejects(api.list('/ext/no-existe'), /No existe/);
  await assert.rejects(api.powerInfo(), /no soportado/);

  // Puente: abrir el FAP, el FAP pide una URL y el celular contesta
  globalThis.fetch = (async () => new Response('<html><title>Prueba</title><p>Canción ñandú</p></html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch;
  const bridge = new InternetBridge(api, phoneHttpGet);
  await bridge.launch();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(bridge.appRunning, true);
  assert.equal(fake.appData.length, 1);
  // Abrir otra vez con el puente abierto no debe mandar otro appStart.
  const startsBefore = fake.appStarts;
  await bridge.launch();
  assert.equal(fake.appStarts, startsBefore, 'no abre el puente dos veces');
  assert.match(fake.appData[0], /^OK 200\n\[Prueba\]\nCancion nandu$/);

  await bridge.sendMessage('¡Hola!');
  assert.equal(fake.appData[1], 'MSG ?Hola!');
  assert.equal(toFlipperText('Ñoño “x”'), 'Nono "x"');

  // Pantalla: un píxel encendido en (0,0) produce un BMP válido
  const frameData = new Uint8Array(1024);
  frameData[0] = 1;
  const uri = frameToBmpUri(frameData);
  const bmp = Buffer.from(uri.split(',')[1], 'base64');
  assert.equal(bmp.toString('ascii', 0, 2), 'BM');
  assert.equal(bmp.readUInt32LE(2), bmp.length);

  console.log('OK: todas las pruebas pasaron');
  console.log('Log del puente:', bridge.log.map((l) => `${l.direction} ${l.text}`));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
