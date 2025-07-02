import { auth } from './auth.js';

// The init command is an alias for auth
export async function initializeSetup() {
  await auth();
}
