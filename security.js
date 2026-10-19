const crypto = require('crypto');

const BAILEYS_AUTH_PREFIX = 'enc:v1:';

function deriveBaileysAuthKey(secret) {
  const value = String(secret || '');
  if (value.length < 32) {
    throw new Error('BAILEYS_AUTH_ENCRYPTION_KEY en az 32 karakter olmalıdır.');
  }
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function encryptBaileysAuthValue(plaintext, secret, context) {
  const key = deriveBaileysAuthKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(context || ''), 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return `${BAILEYS_AUTH_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptBaileysAuthValue(storedValue, secret, context) {
  const value = String(storedValue || '');
  if (!value.startsWith(BAILEYS_AUTH_PREFIX)) return null;
  const parts = value.split(':');
  if (parts.length !== 5) throw new Error('Şifreli Baileys auth verisi biçimi geçersiz.');

  const key = deriveBaileysAuthKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64'));
  decipher.setAAD(Buffer.from(String(context || ''), 'utf8'));
  decipher.setAuthTag(Buffer.from(parts[3], 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[4], 'base64')),
    decipher.final()
  ]).toString('utf8');
}

module.exports = {
  BAILEYS_AUTH_PREFIX,
  deriveBaileysAuthKey,
  encryptBaileysAuthValue,
  decryptBaileysAuthValue
};
