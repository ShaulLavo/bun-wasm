declare namespace BunWasm {
  type FormDataEncoding = { kind: "urlencoded" } | { kind: "multipart"; boundary: Uint8Array };
  type FormDataBodyDeps = {
    FormData: typeof FormData;
    File: typeof File;
    URLSearchParams: typeof URLSearchParams;
    mimeByExtension(extension: string): string | undefined;
    blobBytes(blob: Blob): Uint8Array;
  };
  interface Native {
    randomBytes(length: number): Uint8Array;
  }
  interface Internal {
    concatBytes(chunks: Uint8Array[]): Uint8Array;
    require(name: "form_data_body"): {
      encoding(contentType: string | null | undefined): FormDataEncoding | null;
      parse(bytes: Uint8Array<ArrayBuffer>, encoding: FormDataEncoding, deps: FormDataBodyDeps, fail: (reason: string) => Error): FormData;
      serialize(form: FormData, deps: FormDataBodyDeps): { bytes: Uint8Array; type: string };
    };
  }
}
