import { Buffer } from 'buffer';

const WIDTH = 128;
const HEIGHT = 64;
const SCALE = 4;

/**
 * Convierte un frame de pantalla del Flipper (1024 bytes, formato u8g2:
 * cada byte son 8 píxeles verticales, páginas de 128 bytes) en un BMP
 * monocromo escalado, listo para <Image source={{ uri }} />.
 */
export function frameToBmpUri(data: Uint8Array): string {
  const w = WIDTH * SCALE;
  const h = HEIGHT * SCALE;
  const rowBytes = Math.ceil(w / 32) * 4; // filas alineadas a 4 bytes
  const pixelBytes = rowBytes * h;
  const headerSize = 14 + 40 + 8; // file header + info header + paleta de 2 colores
  const buf = Buffer.alloc(headerSize + pixelBytes);

  // BITMAPFILEHEADER
  buf[0] = 0x42; // 'B'
  buf[1] = 0x4d; // 'M'
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(headerSize, 10);
  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22); // positivo = filas de abajo hacia arriba
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(1, 28); // 1 bit por píxel
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeUInt32LE(2, 46);
  // Paleta (B, G, R, 0): 0 = fondo naranja, 1 = píxel negro
  buf.writeUInt32LE(0x00ff8200, 54);
  buf.writeUInt32LE(0x00000000, 58);

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const on = (data[(y >> 3) * WIDTH + x] >> (y & 7)) & 1;
      if (!on) continue;
      for (let dy = 0; dy < SCALE; dy++) {
        const row = h - 1 - (y * SCALE + dy);
        const rowStart = headerSize + row * rowBytes;
        for (let dx = 0; dx < SCALE; dx++) {
          const px = x * SCALE + dx;
          buf[rowStart + (px >> 3)] |= 0x80 >> (px & 7);
        }
      }
    }
  }
  return `data:image/bmp;base64,${buf.toString('base64')}`;
}
