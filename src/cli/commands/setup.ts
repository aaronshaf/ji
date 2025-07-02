import { Effect } from 'effect';
import { auth } from './auth.js';

// The init command is an alias for auth, implemented with Effect
export async function initializeSetup() {
  const program = Effect.tryPromise({
    try: () => auth(),
    catch: (error) => new Error(`Setup failed: ${error}`),
  });

  await Effect.runPromise(program);
}
