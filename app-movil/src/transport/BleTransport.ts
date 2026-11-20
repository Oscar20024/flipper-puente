import { Buffer } from 'buffer';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device, State, Subscription } from 'react-native-ble-plx';

import type { Transport } from './Transport';

/**
 * UUIDs del "Serial Service" del Flipper Zero, tomados del firmware oficial
 * (targets/f7/ble_glue/services/serial_service_uuid.inc). Los nombres RX/TX
 * en el firmware son desde el punto de vista del Flipper:
 *   - RX (…62): el celular ESCRIBE aquí.
 *   - TX (…61): el Flipper envía datos por "indicate".
 *   - Flow control (…63): espacio libre del buffer del Flipper (uint32 big-endian).
 *   - RPC status (…64): 1 cuando la sesión RPC está activa.
 */
export const FLIPPER_SERIAL_SERVICE = '8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000';
export const FLIPPER_CHAR_WRITE = '19ed82ae-ed21-4c9d-4145-228e62fe0000';
export const FLIPPER_CHAR_NOTIFY = '19ed82ae-ed21-4c9d-4145-228e61fe0000';
export const FLIPPER_CHAR_FLOW = '19ed82ae-ed21-4c9d-4145-228e63fe0000';
export const FLIPPER_CHAR_RPC_STATUS = '19ed82ae-ed21-4c9d-4145-228e64fe0000';

/** Máximo de bytes que el firmware acepta en una sola escritura. */
const FIRMWARE_MAX_WRITE = 486;

export const bleManager = new BleManager();

export type FoundFlipper = { id: string; name: string; rssi: number | null };

export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);
  if (apiLevel >= 31) {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(result).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
  }
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export async function isBluetoothOn(): Promise<boolean> {
  return (await bleManager.state()) === State.PoweredOn;
}

/** Busca Flippers cercanos. Devuelve una función para detener la búsqueda. */
export function scanFlippers(onFound: (f: FoundFlipper) => void, onError: (msg: string) => void): () => void {
  const seen = new Set<string>();
  bleManager
    .startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        onError(error.message);
        return;
      }
      if (!device) return;
      const name = device.name ?? device.localName ?? '';
      if (!name.toLowerCase().includes('flipper') || seen.has(device.id)) return;
      seen.add(device.id);
      onFound({ id: device.id, name, rssi: device.rssi });
    })
    .catch((e: Error) => onError(e.message));
  return () => {
    bleManager.stopDeviceScan().catch(() => undefined);
  };
}

function readU32BE(base64: string): number {
  const b = Buffer.from(base64, 'base64');
  if (b.length < 4) return 0;
  return b.readUInt32BE(0);
}

export class BleTransport implements Transport {
  readonly name: string;
  private subscriptions: Subscription[] = [];
  private available = 0;
  private bufferWaiters: Array<() => void> = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private chunkSize = 20;
  private dataListeners: Array<(bytes: Uint8Array) => void> = [];
  private closeListeners: Array<(reason?: string) => void> = [];
  private closed = false;

  private constructor(private device: Device) {
    this.name = device.name ?? device.localName ?? 'Flipper';
  }

  static async connect(deviceId: string): Promise<BleTransport> {
    await bleManager.stopDeviceScan().catch(() => undefined);
    let device = await bleManager.connectToDevice(deviceId, { requestMTU: 512, timeout: 20000 });
    device = await device.discoverAllServicesAndCharacteristics();
    const transport = new BleTransport(device);
    await transport.init();
    return transport;
  }

  private async init(): Promise<void> {
    const mtu = this.device.mtu ?? 23;
    this.chunkSize = Math.max(20, Math.min(mtu - 3, FIRMWARE_MAX_WRITE));

    this.subscriptions.push(
      this.device.monitorCharacteristicForService(FLIPPER_SERIAL_SERVICE, FLIPPER_CHAR_FLOW, (error, ch) => {
        if (!error && ch?.value) this.setAvailable(readU32BE(ch.value));
      }),
    );

    this.subscriptions.push(
      this.device.monitorCharacteristicForService(FLIPPER_SERIAL_SERVICE, FLIPPER_CHAR_NOTIFY, (error, ch) => {
        if (error) {
          if (!this.closed) this.emitClose(error.message);
          return;
        }
        if (!ch?.value) return;
        const bytes = new Uint8Array(Buffer.from(ch.value, 'base64'));
        this.dataListeners.forEach((l) => l(bytes));
      }),
    );

    this.subscriptions.push(
      bleManager.onDeviceDisconnected(this.device.id, (error) => {
        this.emitClose(error?.message ?? 'Desconectado');
      }),
    );

    // Leer el espacio libre inicial. Esta lectura también dispara el
    // emparejamiento (PIN en la pantalla del Flipper) si aún no están vinculados.
    const flow = await this.device.readCharacteristicForService(FLIPPER_SERIAL_SERVICE, FLIPPER_CHAR_FLOW);
    if (flow.value) this.setAvailable(readU32BE(flow.value));
  }

  private setAvailable(value: number) {
    this.available = value;
    if (value > 0) {
      const waiters = this.bufferWaiters;
      this.bufferWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  private waitForBuffer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        // Si se perdió la notificación, volver a leer el valor.
        try {
          const flow = await this.device.readCharacteristicForService(FLIPPER_SERIAL_SERVICE, FLIPPER_CHAR_FLOW);
          if (flow.value) this.setAvailable(readU32BE(flow.value));
          if (this.available > 0) resolve();
          else reject(new Error('El Flipper no liberó su buffer (timeout)'));
        } catch (e) {
          reject(e as Error);
        }
      }, 8000);
      this.bufferWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    const job = this.writeQueue.then(() => this.writeNow(bytes));
    this.writeQueue = job.catch(() => undefined);
    return job;
  }

  private async writeNow(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.closed) throw new Error('Conexión cerrada');
      while (this.available <= 0) await this.waitForBuffer();
      const size = Math.min(this.chunkSize, this.available, bytes.length - offset);
      const chunk = bytes.subarray(offset, offset + size);
      await this.device.writeCharacteristicWithoutResponseForService(
        FLIPPER_SERIAL_SERVICE,
        FLIPPER_CHAR_WRITE,
        Buffer.from(chunk).toString('base64'),
      );
      this.available -= size;
      offset += size;
    }
  }

  onData(listener: (bytes: Uint8Array) => void): void {
    this.dataListeners.push(listener);
  }

  onClose(listener: (reason?: string) => void): void {
    this.closeListeners.push(listener);
  }

  private emitClose(reason?: string) {
    if (this.closed) return;
    this.closed = true;
    this.subscriptions.forEach((s) => s.remove());
    this.subscriptions = [];
    this.closeListeners.forEach((l) => l(reason));
  }

  async close(): Promise<void> {
    const id = this.device.id;
    this.emitClose('Cerrado por el usuario');
    await bleManager.cancelDeviceConnection(id).catch(() => undefined);
  }
}
