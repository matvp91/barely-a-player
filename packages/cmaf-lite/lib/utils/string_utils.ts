export function decodeBase64(value: string): Uint8Array {
  const str = atob(value);
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i);
  }
  return out;
}
