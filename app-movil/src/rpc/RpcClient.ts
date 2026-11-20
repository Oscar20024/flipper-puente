import { PB } from '../proto/flipper';
import type { Transport } from '../transport/Transport';
import { FrameDecoder, frame } from './framing';

/**
 * Un mensaje PB.Main decodificado. Se tipa de forma flexible porque el
 * contenido es un "oneof" con ~70 variantes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RpcMessage = { commandId: number; commandStatus: number; hasNext: boolean; content?: string } & Record<string, any>;

/** Contenido de una petición, p. ej. { storageListRequest: { path: '/ext' } }. */
export type RpcContent = Record<string, unknown>;

export class RpcError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusName: string,
  ) {
    super(describeStatus(statusName));
  }
}

const STATUS_TEXT: Record<string, string> = {
  ERROR: 'Error desconocido',
  ERROR_DECODE: 'El Flipper no pudo leer el comando',
  ERROR_NOT_IMPLEMENTED: 'Comando no soportado por este firmware',
  ERROR_BUSY: 'El Flipper está ocupado',
  ERROR_INVALID_PARAMETERS: 'Parámetros inválidos',
  ERROR_STORAGE_NOT_READY: 'La tarjeta SD no está lista',
  ERROR_STORAGE_EXIST: 'Ya existe',
  ERROR_STORAGE_NOT_EXIST: 'No existe',
  ERROR_STORAGE_DENIED: 'Acceso denegado',
  ERROR_STORAGE_INVALID_NAME: 'Nombre o ruta inválida',
  ERROR_STORAGE_DIR_NOT_EMPTY: 'La carpeta no está vacía',
  ERROR_APP_CANT_START: 'No se pudo abrir la app',
  ERROR_APP_SYSTEM_LOCKED: 'Hay otra app abierta en el Flipper; ciérrala primero',
  ERROR_APP_NOT_RUNNING: 'La app no está corriendo en modo RPC',
  ERROR_APP_CMD_ERROR: 'La app rechazó el comando',
};

function describeStatus(name: string): string {
  return STATUS_TEXT[name] ? `${STATUS_TEXT[name]} (${name})` : name;
}

type Pending = {
  parts: RpcMessage[];
  resolve: (parts: RpcMessage[]) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
};

export class RpcClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(msg: RpcMessage) => void>();
  private timeoutListeners = new Set<() => void>();
  private decoder = new FrameDecoder();
  private closed = false;

  constructor(private transport: Transport) {
    transport.onData((bytes) => {
      for (const raw of this.decoder.push(bytes)) {
        try {
          this.handle(PB.Main.decode(raw) as unknown as RpcMessage);
        } catch (e) {
          console.warn('[rpc] mensaje inválido', e);
        }
      }
    });
    transport.onClose(() => {
      this.closed = true;
      this.pending.forEach((p) => {
        clearTimeout(p.timer);
        p.reject(new Error('Se perdió la conexión con el Flipper'));
      });
      this.pending.clear();
    });
  }

  /** Se llama cada vez que una petición se queda sin respuesta. */
  onTimeout(listener: () => void): () => void {
    this.timeoutListeners.add(listener);
    return () => this.timeoutListeners.delete(listener);
  }

  /** Mensajes que el Flipper envía por su cuenta (pantalla, apps, datos del FAP). */
  onUnsolicited(listener: (msg: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handle(msg: RpcMessage) {
    const pending = msg.commandId ? this.pending.get(msg.commandId) : undefined;
    if (!pending) {
      this.listeners.forEach((l) => l(msg));
      return;
    }
    if (msg.commandStatus && msg.commandStatus !== PB.CommandStatus.OK) {
      clearTimeout(pending.timer);
      this.pending.delete(msg.commandId);
      const name = (PB.CommandStatus as unknown as Record<number, string>)[msg.commandStatus] ?? String(msg.commandStatus);
      pending.reject(new RpcError(msg.commandStatus, name));
      return;
    }
    pending.parts.push(msg);
    if (msg.hasNext) {
      // Respuestas largas (lectura de archivos): reiniciar el temporizador en cada parte.
      clearTimeout(pending.timer);
      pending.timer = this.makeTimer(msg.commandId, pending.timeoutMs);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(msg.commandId);
    pending.resolve(pending.parts);
  }

  private makeTimer(id: number, ms: number) {
    return setTimeout(() => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      p.reject(new Error('El Flipper no respondió a tiempo'));
      this.timeoutListeners.forEach((l) => l());
    }, ms);
  }

  private encode(id: number, content: RpcContent, hasNext: boolean): Uint8Array {
    const message = PB.Main.create({ commandId: id, hasNext, ...content } as never);
    return frame(PB.Main.encode(message).finish());
  }

  /**
   * Envía uno o varios mensajes con el mismo command_id (los varios se usan
   * para escrituras largas) y espera la respuesta completa.
   */
  async request(content: RpcContent | RpcContent[], timeoutMs = 10000): Promise<RpcMessage[]> {
    if (this.closed) throw new Error('No hay conexión con el Flipper');
    const id = this.nextId++;
    const list = Array.isArray(content) ? content : [content];

    const result = new Promise<RpcMessage[]>((resolve, reject) => {
      this.pending.set(id, {
        parts: [],
        resolve,
        reject,
        timeoutMs,
        timer: this.makeTimer(id, timeoutMs + list.length * 500),
      });
    });

    // Las escrituras no se esperan aquí: si el canal se traba, el temporizador
    // termina la petición con error en vez de dejarla colgada para siempre.
    void (async () => {
      try {
        for (let i = 0; i < list.length; i++) {
          if (!this.pending.has(id)) return; // ya terminó (timeout o desconexión)
          await this.transport.write(this.encode(id, list[i], i < list.length - 1));
        }
      } catch (e) {
        const p = this.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(e as Error);
        }
      }
    })();
    return result;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      // Avisar al Flipper, pero sin esperar más de 1,5 s si el canal está trabado.
      const stop = this.transport.write(this.encode(this.nextId++, { stopSession: {} }, false)).catch(() => undefined);
      await Promise.race([stop, new Promise((r) => setTimeout(r, 1500))]);
    }
    await this.transport.close();
  }
}
