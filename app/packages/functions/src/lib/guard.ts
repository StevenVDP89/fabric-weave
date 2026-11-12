import { UserDataFunctionError, UserThrownError } from '@microsoft/fabric-user-data-functions';
import type { Ctx } from './runtime.js';
import { audit } from './store.js';

const MAX_MESSAGE = 1000;

/**
 * The Functions runtime replaces the message of every error that is not a UserDataFunctionError with
 * "An internal execution error occured during function execution". That hides the actual reason from
 * the person using the app, so handlers run inside `guarded`, which surfaces a cleaned-up message.
 */
export function publicMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'Unexpected error';
  const cleaned = raw
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '[token]')
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [token]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .trim();
  const message = cleaned || 'Unexpected error';
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}...` : message;
}

export async function guarded<T>(name: string, ctx: Ctx, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof UserDataFunctionError) throw e;
    const message = publicMessage(e);
    console.error(`${name} failed`, e instanceof Error ? (e.stack ?? e.message) : String(e));
    await audit(ctx, { action: 'function.error', details: `${name}: ${message}`, outcome: 'error' });
    throw new UserThrownError(message);
  }
}
