const NativeDecoder = globalThis.TextDecoder;

// Source-host controls model only the Rust streams codec boundary. The loader,
// Web installer and TextDecoder state machine still execute production source.
export function nativeTextDecoderCodec() {
  const handles = new Map<number, TextDecoder>();
  let next = 0;
  const streams = {
    decoder(label: string, fatal: boolean, ignoreBOM: boolean) {
      const decoder = new NativeDecoder(label, { fatal, ignoreBOM });
      const id = ++next;
      handles.set(id, decoder);
      return { id, encoding: decoder.encoding };
    },
    push(id: number, bytes: Uint8Array, last: boolean) {
      const decoder = handles.get(id);
      if (!decoder) throw new TypeError("Stream is closed");
      return decoder.decode(bytes, { stream: !last });
    },
    release(id: number) { handles.delete(id); },
  };
  return { streams, handles };
}
