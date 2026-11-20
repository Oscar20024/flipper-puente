import { PB_Gui, PB_Storage, PB_System } from '../proto/flipper';
import { RpcClient, RpcContent } from './RpcClient';

export type FlipperFile = { name: string; isDir: boolean; size: number };

export type InputKey = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'OK' | 'BACK';

/** Tamaño máximo de datos por mensaje de escritura (storage.options del protocolo). */
const WRITE_CHUNK = 512;

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

export function parentPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/** Funciones de alto nivel sobre el RPC oficial del Flipper. */
export class FlipperApi {
  constructor(readonly rpc: RpcClient) {}

  // ---------------- Sistema ----------------

  async ping(): Promise<number> {
    const start = Date.now();
    await this.rpc.request({ systemPingRequest: { data: Uint8Array.from([1, 2, 3, 4]) } });
    return Date.now() - start;
  }

  private async keyValues(content: RpcContent, field: string): Promise<Record<string, string>> {
    const parts = await this.rpc.request(content);
    const out: Record<string, string> = {};
    for (const p of parts) {
      const kv = p[field];
      if (kv?.key) out[kv.key] = kv.value ?? '';
    }
    return out;
  }

  deviceInfo() {
    return this.keyValues({ systemDeviceInfoRequest: {} }, 'systemDeviceInfoResponse');
  }

  powerInfo() {
    return this.keyValues({ systemPowerInfoRequest: {} }, 'systemPowerInfoResponse');
  }

  async protobufVersion(): Promise<string> {
    const [r] = await this.rpc.request({ systemProtobufVersionRequest: {} });
    const v = r.systemProtobufVersionResponse;
    return `${v?.major ?? 0}.${v?.minor ?? 0}`;
  }

  async reboot(mode: 'OS' | 'DFU' = 'OS'): Promise<void> {
    // El Flipper se reinicia sin responder: no esperar la respuesta.
    this.rpc
      .request({ systemRebootRequest: { mode: PB_System.RebootRequest.RebootMode[mode] } }, 3000)
      .catch(() => undefined);
  }

  async playAlert(): Promise<void> {
    await this.rpc.request({ systemPlayAudiovisualAlertRequest: {} });
  }

  async syncDateTime(date = new Date()): Promise<void> {
    await this.rpc.request({
      systemSetDatetimeRequest: {
        datetime: {
          hour: date.getHours(),
          minute: date.getMinutes(),
          second: date.getSeconds(),
          day: date.getDate(),
          month: date.getMonth() + 1,
          year: date.getFullYear(),
          weekday: date.getDay() === 0 ? 7 : date.getDay(),
        },
      },
    });
  }

  // ---------------- Archivos ----------------

  async storageInfo(path: string): Promise<{ total: number; free: number }> {
    const [r] = await this.rpc.request({ storageInfoRequest: { path } });
    return { total: Number(r.storageInfoResponse?.totalSpace ?? 0), free: Number(r.storageInfoResponse?.freeSpace ?? 0) };
  }

  async list(path: string): Promise<FlipperFile[]> {
    const parts = await this.rpc.request({ storageListRequest: { path } }, 15000);
    const files: FlipperFile[] = [];
    for (const p of parts) {
      for (const f of p.storageListResponse?.file ?? []) {
        files.push({ name: f.name, isDir: f.type === PB_Storage.File.FileType.DIR, size: f.size ?? 0 });
      }
    }
    return files.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  }

  async read(path: string): Promise<Uint8Array> {
    const parts = await this.rpc.request({ storageReadRequest: { path } }, 15000);
    const chunks: Uint8Array[] = parts.map((p) => p.storageReadResponse?.file?.data ?? new Uint8Array(0));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const messages: RpcContent[] = [];
    if (data.length === 0) {
      messages.push({ storageWriteRequest: { path, file: { data: new Uint8Array(0) } } });
    }
    for (let i = 0; i < data.length; i += WRITE_CHUNK) {
      messages.push({ storageWriteRequest: { path, file: { data: data.subarray(i, i + WRITE_CHUNK) } } });
    }
    await this.rpc.request(messages, 20000);
  }

  async remove(path: string, recursive = true): Promise<void> {
    await this.rpc.request({ storageDeleteRequest: { path, recursive } }, 30000);
  }

  async mkdir(path: string): Promise<void> {
    await this.rpc.request({ storageMkdirRequest: { path } });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.rpc.request({ storageRenameRequest: { oldPath, newPath } });
  }

  async md5(path: string): Promise<string> {
    const [r] = await this.rpc.request({ storageMd5sumRequest: { path } }, 30000);
    return r.storageMd5sumResponse?.md5sum ?? '';
  }

  // ---------------- Apps ----------------

  async appStart(name: string, args = ''): Promise<void> {
    await this.rpc.request({ appStartRequest: { name, args } });
  }

  async appExit(): Promise<void> {
    await this.rpc.request({ appExitRequest: {} });
  }

  async appLocked(): Promise<boolean> {
    const [r] = await this.rpc.request({ appLockStatusRequest: {} });
    return Boolean(r.appLockStatusResponse?.locked);
  }

  /** Envía bytes a la app que corre en modo RPC (nuestro FAP "Puente Internet"). */
  async appSendData(data: Uint8Array): Promise<void> {
    await this.rpc.request({ appDataExchangeRequest: { data } });
  }

  // ---------------- Pantalla y botones ----------------

  async startScreenStream(): Promise<void> {
    await this.rpc.request({ guiStartScreenStreamRequest: {} });
  }

  async stopScreenStream(): Promise<void> {
    await this.rpc.request({ guiStopScreenStreamRequest: {} });
  }

  private async input(key: InputKey, type: keyof typeof PB_Gui.InputType): Promise<void> {
    await this.rpc.request({ guiSendInputEventRequest: { key: PB_Gui.InputKey[key], type: PB_Gui.InputType[type] } });
  }

  /** Simula una pulsación como lo hace qFlipper: PRESS → SHORT/LONG → RELEASE. */
  async pressButton(key: InputKey, long = false): Promise<void> {
    await this.input(key, 'PRESS');
    await this.input(key, long ? 'LONG' : 'SHORT');
    await this.input(key, 'RELEASE');
  }
}
