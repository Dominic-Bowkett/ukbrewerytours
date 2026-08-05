/**
 * Generate an admin login for the voucher dashboard.
 *
 *   node scripts/create-admin.mjs you@ukbrewerytours.com
 *   node scripts/create-admin.mjs you@ukbrewerytours.com "your-own-password"
 *
 * Prints a ready-to-run wrangler command. Password hashing matches
 * functions/_lib/auth.js exactly (PBKDF2-HMAC-SHA256, 150k iterations).
 */
import { webcrypto as crypto } from 'node:crypto';

const ITERATIONS = 150000;
const enc = new TextEncoder();

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/create-admin.mjs <email> [password]');
  process.exit(1);
}

// Readable but strong: 4 words + digits beats a short random string for typing.
function generatePassword() {
  const words = ['amber', 'porter', 'hoppy', 'stout', 'malt', 'brew', 'cask', 'yeast',
    'barrel', 'copper', 'hazy', 'crisp', 'draft', 'grain', 'tapped', 'wheat'];
  const pick = n => {
    const buf = new Uint32Array(n);
    crypto.getRandomValues(buf);
    return [...buf].map(v => words[v % words.length]);
  };
  const digits = new Uint32Array(1);
  crypto.getRandomValues(digits);
  return pick(3).join('-') + '-' + String(digits[0] % 9000 + 1000);
}

const password = process.argv[3] || generatePassword();

const saltBytes = new Uint8Array(16);
crypto.getRandomValues(saltBytes);
const salt = [...saltBytes].map(b => b.toString(16).padStart(2, '0')).join('');

const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
const bits = await crypto.subtle.deriveBits(
  { name: 'PBKDF2', salt: enc.encode(salt), iterations: ITERATIONS, hash: 'SHA-256' },
  key,
  256,
);
const hash = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');

const sql = `INSERT INTO admin_users (email, password_hash, password_salt, iterations) `
  + `VALUES ('${email}', '${hash}', '${salt}', ${ITERATIONS}) `
  + `ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash, `
  + `password_salt=excluded.password_salt, iterations=excluded.iterations;`;

console.log(`
──────────────────────────────────────────────────────────────
  Admin login
──────────────────────────────────────────────────────────────
  Email     ${email}
  Password  ${password}

  Save the password now — it is not stored anywhere in plain text.
──────────────────────────────────────────────────────────────

Run this to create the login (add --local instead of --remote to seed a local dev DB):

npx wrangler d1 execute ukbrewerytours-vouchers --remote --command "${sql.replace(/"/g, '\\"')}"
`);
