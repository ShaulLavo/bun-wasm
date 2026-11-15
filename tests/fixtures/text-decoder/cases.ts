export const decoderInputKinds = ["DataView", "Uint16Array", "Uint8Array", "ArrayBuffer"] as const;

export function decoderInputView(buffer: ArrayBuffer, kind: typeof decoderInputKinds[number]) {
  if (kind === "DataView") return new DataView(buffer, 1, 2);
  if (kind === "Uint16Array") return new Uint16Array(buffer, 2, 1);
  if (kind === "Uint8Array") return new Uint8Array(buffer, 1, 2);
  return buffer;
}

export const singleByteCases: readonly [string, number[], string][] = [
  ["ibm866", [0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2], "Привет"],
  ["iso-8859-3", [0xa1, 0x65, 0x6c, 0x6c, 0x6f], "Ħello"],
  ["iso-8859-6", [0xc7], "ا"],
  ["iso-8859-7", [0xc3, 0xe5, 0xe9, 0xdc], "Γειά"],
  ["iso-8859-8", [0xf9, 0xec, 0xe5, 0xed], "שלום"],
  ["iso-8859-8-i", [0xf9, 0xec, 0xe5, 0xed], "שלום"],
  ["windows-874", [0xca, 0xc7, 0xd1, 0xca, 0xb4, 0xd5], "สวัสดี"],
  ["windows-1253", [0xca, 0xe1, 0xeb, 0xe7, 0xec, 0xdd, 0xf1, 0xe1], "Καλημέρα"],
  ["windows-1255", [0xf9, 0xec, 0xe5, 0xed], "שלום"],
  ["windows-1257", [0x4c, 0x61, 0x62, 0x61, 0x73], "Labas"],
  ["koi8-u", [0xf0, 0xd2, 0xc9, 0xd7, 0xa6, 0xd4], "Привіт"],
  ["x-user-defined", [0x41, 0x80, 0x81, 0xff], "A\uF780\uF781\uF7FF"],
  ["iso-8859-5", [0xbf, 0xe0, 0xd8, 0xd2, 0xd5, 0xe2], "Привет"],
];
