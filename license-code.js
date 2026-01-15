// license-code.js
// Generación y validación de códigos de licencia en formato: XXXX-XXXX-XXXX

const crypto = require('crypto');

// Alfabeto sin caracteres confusos: no 0/1, no O/I/L
// A–Z excepto: O, I, L  |  2–9
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

/**
 * Normaliza un código escrito por el usuario.
 * - Trim
 * - Uppercase
 * - Quita espacios
 */
function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Valida el formato exacto XXXX-XXXX-XXXX con el alfabeto permitido.
 */
function isValidCodeFormat(code) {
  return CODE_RE.test(normalizeCode(code));
}

/**
 * Devuelve un string aleatorio (criptográficamente seguro) de longitud `len`
 * usando ALPHABET.
 */
function randomFromAlphabet(len) {
  const out = [];
  const n = ALPHABET.length;

  // Rejection sampling para no introducir sesgo
  const max = Math.floor(256 / n) * n; // <= 256

  while (out.length < len) {
    const buf = crypto.randomBytes(len); // suficiente y rápido
    for (let i = 0; i < buf.length && out.length < len; i++) {
      const v = buf[i];
      if (v >= max) continue;
      out.push(ALPHABET[v % n]);
    }
  }

  return out.join('');
}

/**
 * Genera un código nuevo en formato XXXX-XXXX-XXXX
 */
function generateLicenseCode() {
  const raw = randomFromAlphabet(12);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

module.exports = {
  ALPHABET,
  normalizeCode,
  isValidCodeFormat,
  generateLicenseCode,
};
