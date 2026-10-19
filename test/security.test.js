const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveBaileysAuthKey,
  encryptBaileysAuthValue,
  decryptBaileysAuthValue
} = require('../security');

const secret = 'test-only-key-with-at-least-32-characters';

test('Baileys auth values round-trip through AES-256-GCM', () => {
  const plaintext = JSON.stringify({ creds: { token: 'secret' } });
  const encrypted = encryptBaileysAuthValue(plaintext, secret, 'auth_collection:creds');

  assert.match(encrypted, /^enc:v1:/);
  assert.notEqual(encrypted.includes('secret'), true);
  assert.equal(
    decryptBaileysAuthValue(encrypted, secret, 'auth_collection:creds'),
    plaintext
  );
});

test('Baileys auth values reject a different record context', () => {
  const encrypted = encryptBaileysAuthValue('sensitive', secret, 'auth_collection:creds');
  assert.throws(() => decryptBaileysAuthValue(encrypted, secret, 'auth_collection:other'));
});

test('Baileys auth encryption requires a sufficiently long secret', () => {
  assert.throws(() => deriveBaileysAuthKey('short'), /en az 32 karakter/);
});
