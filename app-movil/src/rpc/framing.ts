/**
 * El RPC del Flipper envía mensajes protobuf "length-delimited":
 * un varint con el tamaño seguido de los bytes del mensaje PB.Main.
 */

export function encodeVarint(value: number): Uint8Array {
  const out: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Uint8Array.from(out);
}

export function frame(payload: Uint8Array): Uint8Array {
  const header = encodeVarint(payload.length);
  const result = new Uint8Array(header.length + payload.length);
  result.set(header, 0);
  result.set(payload, header.length);
  return result;
}

/** Acumula bytes recibidos y devuelve los mensajes completos. */
export class FrameDecoder {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const messages: Uint8Array[] = [];
    for (;;) {
      let length = 0;
      let shift = 0;
      let pos = 0;
      let complete = false;
      while (pos < this.buffer.length && pos < 5) {
        const byte = this.buffer[pos++];
        length |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) {
          complete = true;
          break;
        }
        shift += 7;
      }
      if (!complete) break;
      if (this.buffer.length < pos + length) break;
      messages.push(this.buffer.slice(pos, pos + length));
      this.buffer = this.buffer.slice(pos + length);
    }
    return messages;
  }

  reset() {
    this.buffer = new Uint8Array(0);
  }
}
