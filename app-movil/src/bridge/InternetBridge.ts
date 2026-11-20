import { Buffer } from 'buffer';

import { PB_App } from '../proto/flipper';
import type { FlipperApi } from '../rpc/FlipperApi';
import { RpcError, type RpcMessage } from '../rpc/RpcClient';

/** Ruta donde se instala la app del Flipper (ver carpeta app-flipper/ del proyecto). */
export const BRIDGE_FAP_PATH = '/ext/apps/Tools/internet_bridge.fap';

/** El FAP guarda como máximo 2048 bytes por mensaje. */
const MAX_REPLY_BYTES = 1900;

export type BridgeLogEntry = { id: number; time: string; direction: 'in' | 'out' | 'info'; text: string };

type Listener = () => void;

/** Resultado de una descarga hecha por la PC (proceso principal de Electron). */
export type HttpResult = { status: number; contentType: string; text: string };
export type HttpGet = (url: string) => Promise<HttpResult>;

/**
 * Lado de la PC del "puente de internet".
 * El FAP del Flipper envía "GET <url>" y aquí se hace la petición con el
 * internet de la PC; la respuesta se resume y se devuelve como texto.
 */
export class InternetBridge {
  log: BridgeLogEntry[] = [];
  appRunning = false;
  /** true mientras se está abriendo la app en el Flipper (evita abrirla dos veces). */
  launching = false;
  private warnedMismatch = false;
  private nextLogId = 1;
  private listeners = new Set<Listener>();
  private unsubscribe: () => void;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private api: FlipperApi,
    private httpGet: HttpGet,
  ) {
    this.unsubscribe = api.rpc.onUnsolicited((msg) => this.onMessage(msg));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.helloTimer);
    this.unsubscribe();
    this.listeners.clear();
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  /** Anota un aviso en la actividad del puente. */
  note(text: string) {
    this.addLog('info', text);
  }

  private addLog(direction: BridgeLogEntry['direction'], text: string) {
    const time = new Date().toLocaleTimeString();
    this.log = [{ id: this.nextLogId++, time, direction, text }, ...this.log].slice(0, 100);
    this.emit();
  }

  /** Abre el FAP en el Flipper en modo RPC (necesario para que pueda hablar con la PC o el celular). */
  async launch(): Promise<void> {
    if (this.appRunning) {
      this.addLog('info', 'El puente ya está abierto en el Flipper.');
      return;
    }
    if (this.launching) return;
    this.launching = true;
    this.emit();
    try {
      await this.doLaunch();
    } finally {
      this.launching = false;
      this.emit();
    }
  }

  private async doLaunch(): Promise<void> {
    const slash = BRIDGE_FAP_PATH.lastIndexOf('/');
    const dir = BRIDGE_FAP_PATH.slice(0, slash);
    const name = BRIDGE_FAP_PATH.slice(slash + 1);
    const files = await this.api.list(dir).catch(() => []);
    if (!files.some((f) => f.name === name)) {
      const msg =
        `La app "Puente Internet" no está instalada en el Flipper (falta ${BRIDGE_FAP_PATH}). ` +
        'Compílala con ufbt para el firmware del Flipper y súbela con el botón "Instalar/actualizar .fap" (app de la PC o del celular).';
      this.addLog('info', msg);
      throw new Error(msg);
    }
    this.addLog('info', 'Abriendo "Puente Internet" en el Flipper…');
    // Si el Flipper muestra un aviso (p. ej. versión de firmware distinta), espera a que el usuario lo acepte.
    const hint = setTimeout(() => {
      if (!this.disposed && !this.appRunning) this.addLog('info', 'Si el Flipper muestra un aviso en pantalla, presiona Continuar en el Flipper.');
    }, 3000);
    try {
      await this.startApp();
    } finally {
      clearTimeout(hint);
    }
    clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => {
      if (this.disposed || this.appRunning) return;
      this.addLog(
        'info',
        'La app no respondió. Mira la pantalla del Flipper: si dice "API mismatch" o "Outdated app", ' +
          'la .fap se compiló para otro firmware; vuelve a compilarla con el SDK de tu firmware.',
      );
    }, 6000);
  }

  /** appStart con un reintento si hay otra app abierta en el Flipper. */
  private async startApp(): Promise<void> {
    try {
      await this.api.appStart(BRIDGE_FAP_PATH, 'RPC', 45000);
      return;
    } catch (e) {
      if (!(e instanceof RpcError) || e.statusName !== 'ERROR_APP_SYSTEM_LOCKED') {
        this.addLog('info', `No se pudo abrir: ${(e as Error).message}`);
        throw e;
      }
    }
    if (this.appRunning) return; // la app abierta es el propio puente
    this.addLog('info', 'Hay otra app abierta en el Flipper: intentando cerrarla…');
    await this.api.appExit().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1200));
    if (this.appRunning) return;
    try {
      await this.api.appStart(BRIDGE_FAP_PATH, 'RPC', 45000);
    } catch (e) {
      this.addLog('info', `No se pudo abrir: ${(e as Error).message}. Cierra la app abierta en el Flipper con el botón Atrás y vuelve a intentarlo.`);
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.api.appExit();
  }

  /** Envía un mensaje libre que aparecerá en la pantalla del Flipper. */
  async sendMessage(text: string): Promise<void> {
    await this.send(`MSG ${toFlipperText(text)}`);
    this.addLog('out', `Mensaje: ${text}`);
  }

  private async send(text: string) {
    const full = new Uint8Array(Buffer.from(text, 'utf8'));
    await this.api.appSendData(full.length > MAX_REPLY_BYTES ? full.slice(0, MAX_REPLY_BYTES) : full);
  }

  private onMessage(msg: RpcMessage) {
    if (msg.content === 'appStateResponse') {
      const state = msg.appStateResponse?.state;
      this.appRunning = state === PB_App.AppState.APP_STARTED;
      this.addLog('info', this.appRunning ? 'App del Flipper abierta' : 'App del Flipper cerrada');
      return;
    }
    if (msg.content !== 'appDataExchangeRequest') return;
    const data: Uint8Array = msg.appDataExchangeRequest?.data ?? new Uint8Array(0);
    const text = Buffer.from(data).toString('utf8').trim();
    this.handleRequest(text).catch((e: Error) => {
      this.addLog('info', `Error al responder: ${e.message}`);
      if (e instanceof RpcError && e.statusName === 'ERROR_APP_CMD_ERROR' && !this.warnedMismatch) {
        this.warnedMismatch = true;
        this.addLog(
          'info',
          'El Flipper no reconoce la respuesta. Casi siempre es porque la app del Flipper se compiló ' +
            'para otro firmware: recompílala con el SDK de tu firmware (ver PROBLEMAS-Y-REQUISITOS.md).',
        );
      }
    });
  }

  private async handleRequest(text: string) {
    if (text === 'HELLO') {
      this.appRunning = true;
      this.addLog('in', 'El Flipper está listo para usar internet');
      return;
    }
    if (text.startsWith('GET ')) {
      const url = normalizeUrl(text.slice(4).trim());
      this.addLog('in', `Pide: ${url}`);
      const reply = await fetchForFlipper(url, this.httpGet);
      await this.send(reply);
      this.addLog('out', reply.split('\n')[0] + ` (${reply.length} car.)`);
      return;
    }
    this.addLog('in', `Comando desconocido: ${text}`);
    await this.send(`ERR Comando desconocido: ${text.slice(0, 40)}`);
  }
}

export function normalizeUrl(raw: string): string {
  const url = raw.replace(/\s+/g, '');
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** Descarga una URL con el internet de la PC y la deja lista para la pantalla del Flipper. */
export async function fetchForFlipper(url: string, httpGet: HttpGet): Promise<string> {
  try {
    const res = await httpGet(url);
    const type = res.contentType.toLowerCase();
    let body: string;
    if (type.includes('json')) {
      try {
        body = JSON.stringify(JSON.parse(res.text), null, 1);
      } catch {
        body = res.text;
      }
    } else if (type.includes('html')) {
      body = htmlToText(res.text);
    } else {
      body = res.text;
    }
    return `OK ${res.status}\n${truncate(toFlipperText(body))}`;
  } catch (e) {
    return `ERR ${toFlipperText((e as Error).message).slice(0, 200)}`;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<title>([\s\S]*?)<\/title>/i, '[$1]\n')
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/^ +| +$/gm, '')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** La fuente del Flipper solo dibuja ASCII: quitar tildes y símbolos raros. */
export function toFlipperText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ñ/g, 'n')
    .replace(/Ñ/g, 'N')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\n\x20-\x7e]/g, '?');
}

function truncate(text: string): string {
  const limit = MAX_REPLY_BYTES - 40;
  return text.length > limit ? `${text.slice(0, limit)}\n...(recortado)` : text;
}
