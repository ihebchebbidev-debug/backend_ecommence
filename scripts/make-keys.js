// Prints an ANON_KEY and a SERVICE_ROLE_KEY signed with the current JWT_SECRET.
// Usage: node scripts/make-keys.js   (then paste both into .env)
import { signApiKey } from '../src/lib/jwt.js';

console.log('ANON_KEY=' + signApiKey('anon'));
console.log('SERVICE_ROLE_KEY=' + signApiKey('service_role'));
