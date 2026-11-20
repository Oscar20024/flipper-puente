/**
 * Canal de bytes crudo hacia el Flipper. Hoy solo existe BLE; si más adelante
 * se agrega USB-OTG basta con otra clase que cumpla esta interfaz.
 */
export interface Transport {
  readonly name: string;
  write(bytes: Uint8Array): Promise<void>;
  onData(listener: (bytes: Uint8Array) => void): void;
  onClose(listener: (reason?: string) => void): void;
  close(): Promise<void>;
}
