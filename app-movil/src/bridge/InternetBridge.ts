import { Buffer } from 'buffer';

import { PB_App } from '../proto/flipper';
import type { FlipperApi } from '../rpc/FlipperApi';
import type { RpcMessage } from '../rpc/RpcClient';

/** Ruta donde se instala la app del Flipper (ver carpeta flipper-app/ del proyecto). */
export const BRIDGE_FAP_PATH = '/ext/apps/Tools/internet_bridge.fap';

/** El FAP guarda como máximo 2048 bytes por mensaje. */
const MAX_REPLY_BYTES = 1900;

export type BridgeLogEntry = { id: number; time: string; direction: 'in' | 'out' | 'info'; text: string };

type Listener = () => void;

/**
 * Lado del celular del "puente de internet".
 * El FAP del Flipper envía "GET <url>" y aquí se hace la petición con el
 * internet del celular; la respuesta se resume y se devuelve como texto.
 */
export class InternetBridge {
  log: BridgeLogEntry[] = [];
  appRunning = false;
  private nextLogId = 1;
  private listeners = new Set<Listener>();
  private unsubscribe: () => void;

  constructor(private api: FlipperApi) {
    this.unsubscribe = api.rpc.onUnsolicited((msg) => this.onMessage(msg));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose() {
    this.unsubscribe();
    this.listeners.clear();
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  private addLog(direction: BridgeLogEntry['direction'], text: string) {
    const time = new Date().toLocaleTimeString();
    this.log = [{ id: this.nextLogId++, time, direction, text }, ...this.log].slice(0, 100);
    this.emit();
  }

  /** Abre el FAP en el Flipper en modo RPC (necesario para que pueda hablar con el celular). */
  async launch(): Promise<void> {
    this.addLog('info', 'Abriendo "Puente Internet" en el Flipper…');
    await this.api.appStart(BRIDGE_FAP_PATH, 'RPC');
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
    this.handleRequest(text).catch((e: Error) => this.addLog('info', `Error al responder: ${e.message}`));
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
      const reply = await fetchForFlipper(url);
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

async function fetchForFlipper(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/plain, application/json;q=0.9, text/html;q=0.8, */*;q=0.5',
        'User-Agent': 'curl/8.5.0 (FlipperPuente)',
      },
    });
    const type = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    let body: string;
    if (type.includes('json')) {
      try {
        body = JSON.stringify(JSON.parse(raw), null, 1);
      } catch {
        body = raw;
      }
    } else if (type.includes('html')) {
      body = htmlToText(raw);
    } else {
      body = raw;
    }
    return `OK ${res.status}\n${truncate(toFlipperText(body))}`;
  } catch (e) {
    const err = e as Error;
    return `ERR ${err.name === 'AbortError' ? 'Tiempo de espera agotado' : err.message}`;
  } finally {
    clearTimeout(timer);
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
