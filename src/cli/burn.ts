/**
 * R6 `keyhole burn ID`: DeleteKey (plus DeleteAccount in sub-account mode), then proof that the key is
 * gone. No confirm prompt: a burn only removes privilege.
 *
 * Order (R11b): the chain is read first (is the key live?); the session key pair is resolved and held in memory
 * before signBurn deletes its file, so the PROOF can sign with it; the operator's full-access key is loaded here,
 * so a missing one says the session stays live; then signBurn, the TxLine, the PROOF, the session line.
 *
 * The PROOF is the same key again: the pack's after-burn attempt, signed with the deleted key, and the protocol's
 * refusal parsed from the body (phase `burn`, so no rule strip, C-T6b; and a sub-account's SignerDoesNotExist keeps
 * its PASS line, C-T8d). With no session key left to sign with, the proof is the view_access_key body.
 */
import type { KeyPair } from "near-api-js";
import { LandedUnsettledError, sendAttempt } from "../core/attempt.js";
import { formatNear, parentAccount } from "../core/amounts.js";
import { signBurn } from "../core/burn.js";
import { rpcUrlFor } from "../core/config.js";
import { loadFullAccessKey } from "../core/credentials.js";
import { EnvironmentError } from "../core/errors.js";
import { sessionKeyPair } from "../core/keys.js";
import { type RpcReply, isNoSuchKey, rpcCall, rpcErrorTextAt, viewAccount, viewScopedKey } from "../core/rpc.js";
import { loadSession } from "../core/session.js";
import { SendFateUnknownError } from "../core/tx.js";
import type { Attempt, AttemptInput, DemoStep, Session } from "../core/types.js";
import { loadTargetPack } from "../packs/index.js";
import { renderRawJsonBlock } from "../render/raw-json-block.js";
import { renderRefusalBlock } from "../render/refusal-block.js";
import { ALREADY_BURNED, PASS_KEY_GONE, failExpected } from "../render/strings.js";
import { glyphs, joinAtDots, neutralizeControls, sgr, wrapWords } from "../render/style.js";
import { type TermCaps, termCaps } from "../render/term.js";
import { renderTxLineRows } from "../render/tx-line.js";
import { type Command, type Io, sessionIdArg } from "./args.js";
import { loadOrList, modeLabel } from "./inspect.js";
import { Progress } from "./progress.js";

/**
 * `view_access_key` for the session key, the body kept byte for byte (the proof when no key can sign one), and the URL
 * it came from (an error text from it is printed scrubbed of that URL's path and query).
 */
export async function viewAccessKeyBody(session: Session): Promise<RpcReply & { url: string }> {
  const url = rpcUrlFor(session.network);
  const reply = await rpcCall(url, "query", { request_type: "view_access_key", finality: "final", account_id: session.accountId, public_key: session.publicKey });
  return { ...reply, url };
}

/** The CONTRACT functions burn calls. Tests replace any of them. */
export interface BurnDeps {
  loadSession: typeof loadSession;
  viewScopedKey: typeof viewScopedKey;
  viewAccount: typeof viewAccount;
  viewAccessKeyBody: typeof viewAccessKeyBody;
  sessionKeyPair: typeof sessionKeyPair;
  loadFullAccessKey: typeof loadFullAccessKey;
  signBurn: typeof signBurn;
  sendAttempt: typeof sendAttempt;
  loadTargetPack: typeof loadTargetPack;
}

/** The proof row indent, as renderRefusalBlock's full style prints its rows. */
const ROW = " ".repeat(8);

export function createBurnCommand(overrides: Partial<BurnDeps> = {}): Command {
  const d: BurnDeps = { loadSession, viewScopedKey, viewAccount, viewAccessKeyBody, sessionKeyPair, loadFullAccessKey, signBurn, sendAttempt, loadTargetPack, ...overrides };
  const cmd: Command = {
    name: "burn",
    args: "ID",
    keys: "operator full-access key, 1 tx",
    async run(argv, io) {
      const id = sessionIdArg(cmd, argv, io);
      if (id === null) return 0;
      const env = io.env ?? process.env;
      const caps = termCaps(io.stdout ?? {}, env);
      const session = await loadOrList(id, io, d.loadSession);
      if (session === null) return 1;
      const sub = session.mode === "subaccount";
      const operator = sub ? parentAccount(session.accountId) : session.accountId; // whose full-access key signs
      io.out(`${sgr(caps, "bold", "KEYHOLE burn")} · ${id} · ${session.network} · ${modeLabel(session)}`);

      const live = (await d.viewScopedKey(session)) !== null;
      // R11b: hold the session key before signBurn deletes its file; the PROOF signs with it. No key, no attempt.
      let sessionKey: KeyPair | null = null;
      try {
        sessionKey = d.sessionKeyPair(session, env);
      } catch (e) {
        if (!(e instanceof EnvironmentError)) throw e;
      }

      let burned: { session: Session; txHashes: string[] };
      if (live) {
        io.out(sgr(caps, "bold", "PLAN"));
        io.out(`- DeleteKey(${session.publicKey}) on ${session.accountId}, signed with ${operator}'s full-access key`);
        if (sub) io.out(`- DeleteAccount ${glyphs(caps).arrow} ${operator} (beneficiary)`);
        let signerKey: KeyPair;
        try {
          signerKey = d.loadFullAccessKey(session.network, operator, env);
        } catch (e) {
          if (e instanceof EnvironmentError) throw new EnvironmentError(`${e.what}; nothing was signed: session ${id} stays live`, `${e.tryThis}; then run keyhole burn ${id} again`);
          throw e;
        }
        // LAYOUT R6, loading state: on a TTY, `waiting for RPC…` in place once DeleteKey has taken a second to reach finality.
        const waiting = new Progress(io, caps);
        waiting.after(`waiting for RPC${glyphs(caps).ellipsis}`);
        try {
          burned = await d.signBurn(session, { signerKey, env });
        } catch (e) {
          throw await explainFailedBurn(e, session, operator, signerKey.getPublicKey().toString(), d);
        } finally {
          waiting.stop();
          waiting.clear();
        }
      } else {
        io.out(ALREADY_BURNED);
        burned = await d.signBurn(session, { env }); // no tx: it records the burn and removes the key file
      }
      if (burned.txHashes.length === 0 && live) io.out(ALREADY_BURNED); // gone between the read and the send
      for (const hash of burned.txHashes) for (const row of renderTxLineRows(hash, session.network, caps)) io.out(row);

      // A PROOF that did not pass never ends on a bare `burned`: the burn is recorded locally, the chain may disagree.
      const qualified = (why: string) => {
        for (const line of joinAtDots([`session ${id}`, "DeleteKey recorded locally", why, `run keyhole inspect ${id}`], caps.width, ROW)) io.out(line);
      };
      let pass: boolean;
      try {
        pass = await proof(io, caps, d, burned.session, sessionKey, sub, operator);
      } catch (e) {
        qualified("PROOF not completed: see the error"); // the proof's error follows on stderr
        throw e;
      }
      if (!pass) {
        qualified("PROOF FAILED: the chain may still accept this key");
        return 1;
      }
      io.out(`session ${id} · burned · ${clock(burned.session.burnedAt)}`);
      return 0;
    },
  };
  return cmd;
}

export const burn: Command = createBurnCommand();

/**
 * The PROOF block; true when it passed. Sub-account mode: an account that is gone gives SignerDoesNotExist; one
 * that remains (only its key was deleted) is said to remain, with how to delete it, and gives AccessKeyNotFound.
 */
async function proof(io: Io, caps: TermCaps, d: BurnDeps, session: Session, sessionKey: KeyPair | null, sub: boolean, operator: string): Promise<boolean> {
  let accountGone = false;
  if (sub) {
    const account = await d.viewAccount(session.network, session.accountId);
    accountGone = account === null;
    if (account !== null) {
      // C-T5a: the session key is gone, but the sub-account (the operator's full-access key and its funds) is not.
      const acct = neutralizeControls(session.accountId);
      io.out(`${sgr(caps, "bold", "NOTE")}  the sub-account ${acct} remains: it holds ${operator}'s full-access key and ${formatNear(account.amountYocto)} NEAR`);
      io.out(`      delete it with a DeleteAccount signed with ${operator}'s full-access key, beneficiary ${operator} (near-cli-rs):`);
      io.out(`      near account delete-account ${acct} beneficiary ${operator}`);
    }
  }
  const expected = sub && accountGone ? "SignerDoesNotExist" : "AccessKeyNotFound";
  io.out(sgr(caps, "bold", "PROOF"));

  if (sessionKey === null) {
    // No key to sign with (its file is gone and none is held): the chain's own answer is the proof.
    const reply = await d.viewAccessKeyBody(session);
    io.out(`${sgr(caps, "bold", "VIEW")}  view_access_key  ("no session key left to sign with: the chain is asked instead")`);
    io.out(`${ROW}${sgr(caps, "bold", "rpc")}      response body, verbatim`);
    for (const row of renderRawJsonBlock(reply.raw, caps)) io.out(row);
    // Three answers: no such key (PASS); a key, with its permission (FAIL); anything else is no answer at all (an error).
    if (isNoSuchKey(reply.json)) {
      io.out(ROW + sgr(caps, "pass", PASS_KEY_GONE));
      return true;
    }
    if (reply.json?.result?.permission !== undefined) {
      io.out(ROW + sgr(caps, "fail", "FAIL: view_access_key still finds the session key on chain"));
      return false;
    }
    throw new EnvironmentError(`view_access_key ${session.accountId} ${session.publicKey} failed: ${rpcErrorTextAt(reply.json, reply.url)}`, `the proof could not be read: run keyhole inspect ${session.id}`);
  }

  const { label, input } = await afterBurnAttempt(session, d);
  // The deleted key's attempt may LAND (the burn did not take): sendAttempt then throws LandedUnsettledError when its
  // refund was not seen. It is a landed attempt all the same, so it is judged and shown like one (as driver.ts send does).
  let attempt: Attempt;
  let unsettled: LandedUnsettledError | undefined;
  try {
    attempt = await d.sendAttempt(session, input);
  } catch (e) {
    if (!(e instanceof LandedUnsettledError)) throw e;
    attempt = e.attempt;
    unsettled = e;
  }
  const o = attempt.outcome;
  const pass = unsettled === undefined && o.kind === "Refusal" && o.errorName === expected;
  // C-T8d: phase `burn`, so the block has no rule strip and SignerDoesNotExist keeps its PASS line.
  const step: DemoStep = { n: 1, total: 1, phase: "burn", label, signer: "session", attempt, pass, ...(pass ? {} : { note: failExpected(expected, o.kind === "Refusal" ? o.errorName : o.kind) }) };
  // One proof, not a step of a run: no [01/01] on the header (C-T18a).
  for (const line of renderRefusalBlock(step, caps, "full", { counter: false }).split("\n")) io.out(line);
  // The unsettled note, word for word: it is on chain, so it must not be sent again.
  if (unsettled) for (const line of wrapWords(neutralizeControls(`${unsettled.what} · ${unsettled.tryThis}`), caps.width, ROW, `${ROW}  `)) io.out(line);
  return pass;
}

/** The pack's after-burn negative test as an attempt on the session's receiver; a plain call to the first method if the pack has none. */
async function afterBurnAttempt(session: Session, d: BurnDeps): Promise<{ label: string; input: AttemptInput }> {
  const test = await d
    .loadTargetPack(session.packId)
    .then((pack) => pack.negativeTests.find((t) => t.keyState === "after-burn"))
    .catch(() => undefined);
  const base = { sessionId: session.id, receiverId: session.receiverId, depositYocto: "0", violates: "none" as const };
  if (test) {
    return {
      label: test.label,
      input: { ...base, action: test.action, ...(test.method === undefined ? {} : { method: test.method }), args: test.args, depositYocto: test.depositYocto, gasTGas: test.gasTGas },
    };
  }
  return { label: "call with the deleted key", input: { ...base, action: "FunctionCall", method: session.methodNames[0], args: {}, gasTGas: 30 } };
}

/**
 * signBurn failed. The chain decides what to say (C-T5a, C-T2l): a tx that failed in a block is followed by a
 * re-read of the key. Live: the failure undid the burn; run it again. Gone: say so, and for a sub-account whose
 * beneficiary (the operator) does not exist on chain, that its balance was burnt; running burn again records it with
 * no transaction. Unreadable: fail closed, never claim either. Nothing signed (a refusal at validation, or the
 * keychain's operator key not on chain, which signAndSend refuses before signing): the session stays live.
 * A send whose fate is unknown, and anything else, is passed on as it is.
 */
async function explainFailedBurn(e: unknown, session: Session, operator: string, signerPublicKey: string, d: BurnDeps): Promise<unknown> {
  if (e instanceof SendFateUnknownError || !(e instanceof EnvironmentError)) return e;
  const id = session.id;
  const again = `run keyhole burn ${id} again`;
  if (e.what.startsWith(`burn ${id}: refused at validation`)) {
    return new EnvironmentError(`${e.what} · session ${id} stays live`, `${e.tryThis}; then ${again}`);
  }
  // signAndSend's refusal to sign with a key the signer account does not have (tx.ts chainSend "refuse").
  if (e.what === `${session.accountId} has no access key ${signerPublicKey} on ${session.network}`) {
    return new EnvironmentError(`${e.what} (the keychain's full-access key for ${operator}); nothing was signed: session ${id} stays live`, `${e.tryThis}; then ${again}`);
  }
  if (!e.what.startsWith(`burn ${id}: failed in a block`)) return e;

  let key: Awaited<ReturnType<typeof viewScopedKey>>;
  try {
    key = await d.viewScopedKey(session);
  } catch (readError) {
    const why = readError instanceof EnvironmentError ? readError.what : String(readError);
    return new EnvironmentError(`${e.what} · the session key could not be read back after the failure (${why})`, `run keyhole inspect ${id} to read the chain, then keyhole burn ${id}`);
  }
  if (key !== null) return new EnvironmentError(`${e.what} · the session key is still live on chain`, `${again}: the failed tx did not delete it`);
  const acct = session.accountId;
  if (session.mode === "subaccount" && (await accountGone(d, session.network, operator)) && (await accountGone(d, session.network, acct))) {
    // Chain facts (no error text is parsed): the sub-account is gone (its DeleteAccount ran) and so is its beneficiary, so the transfer of its
    // balance failed, and nearcore burns a failed balance transfer.
    return new EnvironmentError(
      `${e.what} · the sub-account ${acct} was deleted with its session key, but its balance was burnt: the beneficiary ${operator} did not exist`,
      `${again} to record the burn locally (no transaction is sent)`,
    );
  }
  return new EnvironmentError(`${e.what} · the session key is gone on chain`, `${again} to record the burn locally (no transaction is sent)`);
}

/** True only when view_account says the account does not exist; an unreadable answer is not taken as gone. */
async function accountGone(d: BurnDeps, network: Session["network"], accountId: string): Promise<boolean> {
  try {
    return (await d.viewAccount(network, accountId)) === null;
  } catch {
    return false;
  }
}

/** `14:06:52Z` from an ISO time. */
function clock(iso: string | undefined): string {
  return iso !== undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(iso) ? `${iso.slice(11, 19)}Z` : "time not recorded";
}
