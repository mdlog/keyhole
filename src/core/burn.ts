/**
 * DATA CONTRACT #14 `signBurn` (RPC-live). R6 blocks 2–3 and R4 phases 6–7. No confirm prompt:
 * a burn only removes privilege. DeleteAccount always names the operator as beneficiary (MH1).
 *
 * - on-account: one DeleteKey(session key), signed as the account with the account's own full-access key;
 * - sub-account: DeleteKey + DeleteAccount(beneficiary = the operator, the sub-account's parent) in one tx,
 *   signed as the sub-account with the operator's full-access key (the sub-account holds it as a key).
 *
 * The chain is read first (viewScopedKey). A key it does not have is already burned: no transaction, no
 * operator key asked for, txHashes []. A send whose fate is unknown raises T2's EnvironmentError, whose hint
 * says to look the tx up; it is never retried here. Local files change only after the chain confirms:
 * the session file is marked burned, then the session key file is deleted. A key already held in memory is
 * never dropped (R11a).
 */
import { type KeyPair, PublicKey, actions } from "near-api-js";
import { parentAccount } from "./amounts.js";
import { assertSessionPublicKey } from "./cage.js";
import { deleteSessionKey, loadFullAccessKey } from "./credentials.js";
import { EnvironmentError, InputError } from "./errors.js";
import { viewScopedKey } from "./rpc.js";
import { saveSession, sessionProblems } from "./session.js";
import { mustSucceed, signAndSend } from "./tx.js";
import type { Session } from "./types.js";

/**
 * `persist` defaults to true: it governs every local write (the session file, the key file); `false` touches
 * no file. `signerKey` replaces the keychain's key; `env` locates both directories.
 * Returns the burned session (not mutated: `session` is left as it was) and the hashes of the txs it sent.
 */
export async function signBurn(session: Session, opts: { persist?: boolean; signerKey?: KeyPair; env?: NodeJS.ProcessEnv } = {}): Promise<{ session: Session; txHashes: string[] }> {
  const persist = opts.persist ?? true;
  const env = opts.env ?? process.env;

  // Everything that can be refused locally is refused before the chain is touched.
  assertSessionPublicKey(session);
  const subaccount = session.mode === "subaccount";
  const operator = subaccount ? parentAccount(session.accountId) : session.accountId; // whose full-access key signs
  if (persist) {
    const problems = sessionProblems(session);
    if (problems.length > 0) throw new InputError([`cannot burn session ${JSON.stringify(session.id)} with a malformed session file: ${problems.join(", ")}`]);
  }

  let txHashes: string[] = [];
  if ((await viewScopedKey(session)) !== null) {
    // Only a live key needs the operator's key, so a burn that is already done never asks for it.
    const signerKey = opts.signerKey ?? loadFullAccessKey(session.network, operator, env);
    const burn = [actions.deleteKey(PublicKey.fromString(session.publicKey))];
    if (subaccount) burn.push(actions.deleteAccount(operator));
    const sent = mustSucceed(`burn ${session.id}`, await signAndSend(session.network, session.accountId, signerKey, session.accountId, burn));
    txHashes = [sent.txHash];
  }

  // The chain has no such key now. A burn that was already recorded keeps its time and its hashes.
  const recorded = txHashes.length === 0 && session.status === "burned" && session.burnedAt !== undefined;
  const burned: Session = {
    ...session,
    status: "burned",
    burnedAt: recorded ? session.burnedAt : new Date().toISOString(),
    burnTxHashes: recorded ? (session.burnTxHashes ?? []) : txHashes,
  };
  if (persist) await recordLocally(session, burned, txHashes, env);
  return { session: burned, txHashes };
}

/**
 * The session file first (it holds the tx hashes, which nothing else keeps), then the key file. A local
 * failure after the chain burned the key says so and what to do: running the burn again sends nothing.
 */
async function recordLocally(session: Session, burned: Session, txHashes: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const onChain = txHashes.length > 0 ? `the key is burned on chain (tx ${txHashes.join(", ")})` : "the key is not on chain";
  const again = `${onChain}; run keyhole burn ${session.id} again to finish the local cleanup (no transaction is sent)`;
  try {
    await saveSession(burned, env);
    deleteSessionKey(session, env);
  } catch (e) {
    if (e instanceof EnvironmentError) throw new EnvironmentError(`${e.what}; ${onChain}`, again);
    throw e;
  }
}
