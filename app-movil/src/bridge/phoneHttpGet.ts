import type { HttpResult } from './InternetBridge';

const MAX_TEXT = 512 * 1024;

/**
 * Descarga una URL con el internet del celular (datos o Wi‑Fi).
 * Es el equivalente de window.pc.httpGet de la app de PC.
 */
export async function phoneHttpGet(url: string): Promise<HttpResult> {
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
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get('content-type') ?? '', text: text.slice(0, MAX_TEXT) };
  } catch (e) {
    const err = e as Error;
    throw new Error(err.name === 'AbortError' ? 'Tiempo de espera agotado' : err.message);
  } finally {
    clearTimeout(timer);
  }
}
