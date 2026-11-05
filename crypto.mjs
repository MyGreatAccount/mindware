const utf8 = new TextEncoder();
export function base64(bytes) {
  let result = '';
  for (const b of bytes) result += String.fromCharCode(b);
  return btoa(result);
}
export function bytes(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
async function keyFor(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function seal(value, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 600000;
  const key = await keyFor(password, salt, iterations);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8.encode(JSON.stringify(value)));
  return { version: 1, algorithm: 'AES-GCM', iterations, salt: base64(salt), iv: base64(iv), data: base64(new Uint8Array(cipher)) };
}
export async function unseal(box, password) {
  if (box?.version !== 1 || box.algorithm !== 'AES-GCM' || box.iterations !== 600000 || typeof box.data !== 'string') throw new Error('Conteúdo criptografado inválido.');
  const key = await keyFor(password, bytes(box.salt), box.iterations);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(box.iv) }, key, bytes(box.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
export async function deriveHistoryKey(password, normalizedName) {
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode('margem-history-v1:' + normalizedName)));
  return keyFor(password, salt, 600000);
}
export async function sealRecord(value, key, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:utf8.encode(context)},key,utf8.encode(JSON.stringify(value)));
  return {version:1,iv:base64(iv),data:base64(new Uint8Array(cipher))};
}
export async function openRecord(box, key, context) {
  if (box?.version !== 1 || typeof box.iv !== 'string' || typeof box.data !== 'string') throw new Error('Registro criptografado inválido.');
  const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(box.iv),additionalData:utf8.encode(context)},key,bytes(box.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
