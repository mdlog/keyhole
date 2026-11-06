/**
 * DATA CONTRACT #3 `planWrap` and #4 `signWrap` (R2 `keyhole wrap`). The operator's full-access key
 * signs exactly one transaction here and is never written anywhere.
 *
 * The security core: it decides which key is added, to which account, with which scope.
 * - planWrap signs nothing and loads no full-access key. It checks the inputs, reads the receiver's code
 *   hash (the pin), selects the pack by that hash, checks the scope against the pack, dry-runs, mints the
 *   session key in memory, and prints one TX PLAN line per action.
 * - signWrap signs exactly the actions those lines describe: both come from one list (plannedActions), and a
 *   plan whose lines no longer match its draft is refused. Before anything is signed it re-checks the chain
 *   (assertChain), the pin and the scope, then the signer's key is full access on chain. It saves the key file
 *   (0600) and the session file before it signs, so `keyhole burn ID` can always clean up.
 * - Public keys in the AddKey actions come from KeyPair objects (the minted session key, the signer's key), so
 *   they are 32-byte ed25519 keys by construction: no public-key string is ever parsed into an action.
 */
import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
import { type Action, KeyPair, type PublicKey, actions } from "near-api-js";
import { isAccountId, isMethodName } from "../cli/args.js";
import { classifyTools } from "../classify/dry-run.js";
import { listPackIds, loadTargetPack, packForCodeHash } from "../packs/index.js";
import { MAINNET_OUT_OF_SCOPE, noPackHint, noTools, warnInconclusive, warnRuntime } from "../render/strings.js";
import { ALLOWANCE_STEP_YOCTO, SUBACCOUNT_RESERVE, formatNear, minAllowanceYocto, networkOfAccount } from "./amounts.js";
import { sessionsDir } from "./config.js";
import { deleteSessionKey, loadFullAccessKey, saveSessionKey, sessionKeyPath } from "./credentials.js";
import { EXIT_TX_SENT, EnvironmentError, InputError, TxSentError } from "./errors.js";
import { holdSessionKey, sessionKeyPair } from "./keys.js";
import { bodyState } from "./outcome.js";
import { parseRefusal } from "./refusal.js";
import { NO_CODE_HASH, assertChain, isNoSuchKey, rpcCall, rpcErrorName, rpcErrorTextAt, viewCodeHash } from "./rpc.js";
import type { SandboxHandle } from "./sandbox.js";
import { listSessionIds, newSessionId, saveSession, sessionProblems } from "./session.js";
import { SendFateUnknownError, type SentTx, mustSucceed, signAndSend } from "./tx.js";
import type { Network, Session, TargetPack, WrapOptions, WrapPlan } from "./types.js";

/** Draws of newSessionId before planWrap gives up on finding an id with no session file (65536 ids exist). */
const MAX_ID_DRAWS = 64;
/** PRD §7: since protocol 85 (NEP-642), creating an account costs ≈ 0.007 NEAR, paid in gas (R14). */
const CREATION_COST = "account creation ≈0.007 NEAR (gas, NEP-642)";
const NONZERO_ALLOWANCE = "allowance must be explicit and non-zero (T9)";
const ALLOWANCE_STEP_PROBLEM = "allowance must be a whole multiple of 0.0001 NEAR (10^20 yocto): it is printed to 4 decimals and signed exactly";
/** Sub-account mode with no operator. cli/wrap.ts prints the same line before planWrap is asked. */
export const NO_OPERATOR_PROBLEM =
  "sub-account mode needs an operator: set KEYHOLE_OPERATOR to the account that creates the session sub-account, or wrap an existing account with --on-account ACCOUNT";
const EMPTY_METHODS = "an empty method list would let the key call every method of the receiver";
const REPLAN = "nothing was signed: run wrap again and review the new preview";

type Draft = WrapPlan["draft"];

/**
 * #3 planWrap (RPC-live: view_account + near-sandbox). R2 blocks 2–6: pre-flight, the PREVIEW cage
 * card, WARN lines, EXPOSURE and the TX PLAN. Nothing is signed. `deps.classify` defaults to
 * classifyTools; `deps.sandbox` is passed on to it.
 *
 * Order: inputs (no I/O) → assertChain → code hash (the pin) → pack by code hash (near-abi: re-read live) →
 * scope and allowance against the pack → dry-run (timed into dryRunMs) → warnings → a fresh session id → the
 * session key, minted and held in memory only. Every refusal is an InputError or EnvironmentError (exit 2).
 */
export async function planWrap(opts: WrapOptions, deps?: { sandbox?: SandboxHandle; classify?: typeof classifyTools }): Promise<WrapPlan> {
  const allow = [...new Set(opts.allow ?? [])];
  const problems = inputProblems(opts, allow);
  if (problems.length) throw new InputError(problems);
  const { network, contract } = opts;
  const onAccount = opts.onAccount !== undefined;

  await assertChain(network);
  const codeHashPin = await viewCodeHash(network, contract);
  const pack = await scopedPack(network, contract, codeHashPin, allow, BigInt(opts.allowanceYocto));

  const classify = deps?.classify ?? classifyTools;
  const started = performance.now();
  const tools = await classify(pack, { receiverId: contract, methodNames: [...allow] }, deps?.sandbox ? { sandbox: deps.sandbox } : {});
  const dryRunMs = Math.round(performance.now() - started);

  const warnings: string[] = [];
  for (const method of allow) {
    const label = tools.find((t) => t.kind === "call" && t.method === method)?.classification;
    if (label === "fails-without-deposit (runtime)") warnings.push(warnRuntime(method));
    else if (label === "inconclusive") warnings.push(warnInconclusive(method));
  }

  const id = await freshSessionId();
  const signerId = onAccount ? (opts.onAccount as string) : (opts.operatorId as string);
  const accountId = onAccount ? signerId : `${id}.${signerId}`;
  const keyPair = KeyPair.fromRandom("ed25519");
  const draft: Draft = {
    id,
    mode: onAccount ? "on-account" : "subaccount",
    network,
    accountId,
    receiverId: contract,
    methodNames: allow,
    allowanceYocto: opts.allowanceYocto,
    codeHashPin,
    publicKey: keyPair.getPublicKey().toString(),
    packId: pack.id,
    tools: structuredClone(tools),
  };
  const fundingYocto = onAccount ? null : (BigInt(opts.allowanceYocto) + SUBACCOUNT_RESERVE).toString();
  const plan: WrapPlan = {
    draft,
    txActions: plannedActions(draft, signerId, fundingYocto).map((a) => a.line),
    tools,
    warnings,
    signerId,
    fundingYocto,
    dryRunMs,
  };
  holdSessionKey(sessionFromPlan(plan), keyPair);
  return plan;
}

/**
 * #4 signWrap (RPC-live). R2 block 8: signs the plan with the operator's (on-account: ACCOUNT's)
 * full-access key, writes `$KEYHOLE_HOME/sessions/ID.json` (metadata only), returns the tx hash.
 * `persist` defaults to true; `signerKey` replaces the keychain's key; `env` locates both directories.
 *
 * Order (nothing is signed before every check has passed):
 * 1. the plan itself, with no I/O: a well-formed draft, its mode, its funding, and TX PLAN lines that are
 *    exactly the actions it will sign; the session public key passes the keychain's 32-byte check;
 * 2. assertChain, before any key is read (mainnet is refused here);
 * 3. the pin and the scope: the receiver's code hash still equals the pin, it still selects the plan's pack,
 *    and the methods and allowance still pass that pack;
 * 4. with `persist`: no session file for this id yet (checked before any key is loaded);
 * 5. the session key (held in memory since planWrap) and the signer's key (`signerKey`, else the keychain),
 *    whose public key must be FullAccess on the signer account (view_access_key);
 * 6. with `persist`: the key file (0600), then the session file (status live), both before the send (C-T3c);
 * 7. one transaction; mustSucceed.
 * Only a SendFateUnknownError from tx.ts (sent, or maybe sent, and not found by its hash) keeps both files; the
 * error then names the tx hash and says to run `keyhole burn ID`, which deletes the key if the tx landed or
 * reports already burned. Every other failure removes them before it is rethrown: a failure before the send
 * (signAndSend's own chain check, its nonce read, a key gone before that read), a refusal at validation, or a
 * tx that landed with its receipt failed (all its actions reverted).
 */
export async function signWrap(plan: WrapPlan, opts?: { persist?: boolean; signerKey?: KeyPair; env?: NodeJS.ProcessEnv }): Promise<{ session: Session; txHash: string }> {
  const persist = opts?.persist ?? true;
  const env = opts?.env ?? process.env;
  const session = sessionFromPlan(plan);
  const planned = checkedPlan(plan, session, env);
  const { network, receiverId, accountId } = session;

  const url = await assertChain(network);
  const codeNow = await viewCodeHash(network, receiverId);
  if (codeNow !== session.codeHashPin) {
    throw new EnvironmentError(`code_hash of ${receiverId} changed since planWrap (pinned ${session.codeHashPin}, now ${codeNow})`, REPLAN);
  }
  const pack = await scopedPack(network, receiverId, codeNow, session.methodNames, BigInt(session.allowanceYocto));
  if (pack.id !== session.packId) throw new InputError([`the code of ${receiverId} selects pack ${pack.id}, not the plan's ${session.packId}; run wrap again`]);

  const file = join(sessionsDir(env), `${session.id}.json`);
  if (persist && (await exists(file))) throw new EnvironmentError(`session file ${file} already exists`, "nothing was signed: run wrap again for a fresh session id");

  const sessionKey = sessionKeyPair(session, env);
  const signerKey = opts?.signerKey ?? loadFullAccessKey(network, plan.signerId, env);
  await requireFullAccess(url, network, plan.signerId, signerKey.getPublicKey().toString());
  const acts = planned.map((a) => a.build({ operator: signerKey.getPublicKey(), session: sessionKey.getPublicKey() }));

  const written = { key: false, file: null as string | null };
  const discard = async () => {
    // Best effort: the error being thrown is the one to report.
    if (written.key) {
      try {
        deleteSessionKey(session, env);
      } catch {
        // a key file for a key that never reached the chain; burn reports it already burned
      }
    }
    if (written.file) await rm(written.file, { force: true }).catch(() => undefined);
  };
  // Past the send a transaction went out, so the error exits 3, never 2 ("nothing was signed": C-T2j). An error that
  // already says so (SendFateUnknownError, LandedUnsettledError) is rethrown untouched, and the CLI names the session
  // to burn; any other gets the session and its burn appended here.
  const kept = (e: EnvironmentError): EnvironmentError => {
    if (e.exitCode === EXIT_TX_SENT) return e;
    return persist
      ? new TxSentError(
          `${e.what} · session ${session.id} kept: the AddKey may be on chain`,
          `${e.tryThis}; then run keyhole burn ${session.id}: it deletes the key if the tx landed, or reports already burned`,
        )
      : new TxSentError(e.what, e.tryThis);
  };

  if (persist) {
    try {
      saveSessionKey(session, sessionKey, env);
      written.key = true;
      written.file = await saveSession(session, env);
    } catch (e) {
      await discard();
      throw e;
    }
  }

  let sent: SentTx;
  try {
    sent = await signAndSend(network, plan.signerId, signerKey, accountId, acts);
  } catch (e) {
    // tx.ts throws SendFateUnknownError for every failure after the send: the AddKey may have landed, so the files
    // stay. Any other error (its chain check, the nonce read, a key gone before that read) came before the send.
    if (e instanceof SendFateUnknownError) throw kept(e);
    await discard();
    throw e;
  }
  try {
    mustSucceed(`wrap ${session.id}`, sent);
  } catch (e) {
    const state = bodyState(sent.raw);
    // C-T4b: discarding on INVALID_TRANSACTION relies on tx.ts sendSigned returning that reply from the single send_tx as
    // settled (it is never polled): the node refused the tx at validation, so it never reached a block and no key was
    // added. If tx.ts ever polled such a reply, a not-in-block body could no longer be read as a refusal here.
    const refused = state === "not-in-block" && (parseRefusal(sent.raw) !== null || rpcErrorName(sent.json) === "INVALID_TRANSACTION");
    if (state === "landed-failed" || refused) {
      await discard(); // refused at validation, or its one receipt failed and reverted: no key was added
      throw e;
    }
    throw e instanceof EnvironmentError ? kept(e) : e;
  }
  return { session, txHash: sent.txHash };
}

/** The Session a plan describes (its draft, made live), so the session key can be held before anything is signed. */
export function sessionFromPlan(plan: WrapPlan): Session {
  const d = plan.draft;
  return {
    id: d.id,
    mode: d.mode,
    network: d.network,
    accountId: d.accountId,
    receiverId: d.receiverId,
    methodNames: [...d.methodNames],
    allowanceYocto: d.allowanceYocto,
    codeHashPin: d.codeHashPin,
    publicKey: d.publicKey,
    createdAt: new Date().toISOString(),
    status: "live",
    packId: d.packId,
    tools: structuredClone(d.tools),
  };
}

// ---------------------------------------------------------------------------------------------------
// Checks

/** The account an id is on, by suffix. The bare network root (`sandbox`, `testnet`) counts as on it (C-T3c). */
const onNetwork = (accountId: string, network: Network) => accountId === network || networkOfAccount(accountId) === network;

/** planWrap step 1, no I/O: the network suffix, account ids, the mode's accounts, the allow list, the allowance. */
function inputProblems(opts: WrapOptions, allow: string[]): string[] {
  const p: string[] = [];
  const { network, contract } = opts;
  if (network !== "sandbox" && network !== "testnet") return [`network ${JSON.stringify(network)} is not sandbox or testnet`];
  const contractNet = typeof contract === "string" ? networkOfAccount(contract) : null;
  if (contractNet === null) p.push(MAINNET_OUT_OF_SCOPE);
  else if (!isAccountId(contract)) p.push(`CONTRACT ${JSON.stringify(contract)} is not a NEAR account id`);
  else if (contractNet !== network) p.push(`CONTRACT ${contract} is a ${contractNet} account, not ${network}`);
  if (opts.onAccount !== undefined) {
    if (!isAccountId(opts.onAccount)) p.push(`--on-account ${JSON.stringify(opts.onAccount)} is not a NEAR account id`);
    else if (networkOfAccount(opts.onAccount) !== network) p.push(`--on-account ${opts.onAccount} must be a ${network} account (*.${network})`);
  } else if (opts.operatorId === undefined || opts.operatorId === "") {
    p.push(NO_OPERATOR_PROBLEM);
  } else if (!isAccountId(opts.operatorId)) {
    p.push(`KEYHOLE_OPERATOR ${JSON.stringify(opts.operatorId)} is not a NEAR account id`);
  } else if (!onNetwork(opts.operatorId, network)) {
    p.push(`KEYHOLE_OPERATOR ${opts.operatorId} must be a ${network} account (*.${network} or ${network} itself)`);
  } else if (`ks-0000.${opts.operatorId}`.length > 64) {
    p.push(`KEYHOLE_OPERATOR ${opts.operatorId} is too long: the session sub-account ks-XXXX.${opts.operatorId} must be at most 64 characters`);
  }
  if (allow.length === 0) p.push(`--allow needs at least one method: ${EMPTY_METHODS}`);
  // A method name never holds ", " or " · ", so each TX PLAN line reads one way only.
  for (const m of allow) if (typeof m !== "string" || !isMethodName(m)) p.push(`--allow: ${JSON.stringify(m)} is not a method name`);
  if (typeof opts.allowanceYocto !== "string" || !/^[0-9]+$/.test(opts.allowanceYocto) || BigInt(opts.allowanceYocto) === 0n) p.push(NONZERO_ALLOWANCE);
  else if (BigInt(opts.allowanceYocto) % ALLOWANCE_STEP_YOCTO !== 0n) p.push(ALLOWANCE_STEP_PROBLEM);
  return p;
}

/**
 * The pack the receiver's code selects, after the scope checks (planWrap steps 2–4; signWrap repeats them):
 * at least one method (its own layer: an empty method_names allows every method), the code exists, a pack pins
 * it (near-abi packs are re-read live, R17a), every method is one of the pack's call tools or out-of-scope
 * methods, and the allowance pays for one call at the largest gas those call tools attach (minAllowanceYocto).
 */
async function scopedPack(network: Network, contract: string, codeHash: string, methods: string[], allowance: bigint): Promise<TargetPack> {
  if (methods.length === 0) throw new InputError([`no method to allow: ${EMPTY_METHODS}`]);
  if (codeHash === NO_CODE_HASH) throw new InputError([`CONTRACT ${contract} has no code`]);
  let pack = await packForCodeHash(codeHash);
  if (!pack) {
    // The hint names each pack's pinned code hash next to the receiver's (README › Limits): a DAO from another
    // factory build is refused here, and this is where its operator looks.
    const ids = await listPackIds();
    const pins: Array<{ id: string; codeHash: string }> = [];
    for (const id of ids) {
      const pinned = (await loadTargetPack(id)).sandboxFixture?.codeHash;
      if (pinned) pins.push({ id, codeHash: pinned });
    }
    throw new InputError([noTools(ids)], noPackHint(codeHash, pins));
  }
  if (pack.abiSource === "near-abi") pack = await loadTargetPack(pack.id, { network, receiverId: contract });

  const callTools = pack.tools.filter((t) => t.kind === "call" && t.method !== null);
  const callMethods = callTools.map((t) => t.method as string);
  const outOfScope = pack.outOfScope.map((m) => m.method);
  const list = (ms: string[]) => (ms.length ? ms.join(", ") : "none");
  const problems: string[] = [];
  for (const m of methods) {
    if (!callMethods.includes(m) && !outOfScope.includes(m)) problems.push(`method ${m} is not in pack ${pack.id} (tools: ${list(callMethods)}; out of scope: ${list(outOfScope)})`);
  }
  const gasTGas = Math.max(0, ...callTools.filter((t) => methods.includes(t.method as string)).map((t) => t.gasTGas));
  const minimum = minAllowanceYocto(gasTGas);
  if (allowance < minimum) {
    problems.push(`allowance ${formatNear(allowance)} NEAR is below the minimum ${formatNear(minimum)} NEAR for one ${gasTGas} TGas call (gas is bought up front at ≥10⁹ yocto/gas)`);
  }
  if (problems.length) throw new InputError(problems);
  return pack;
}

/**
 * signWrap step 1, no I/O: the plan is one planWrap could have made, and its TX PLAN lines are exactly the
 * actions to sign. Returns those actions.
 */
function checkedPlan(plan: WrapPlan, session: Session, env: NodeJS.ProcessEnv): PlannedAction[] {
  const problems = sessionProblems(session).map((p) => `the plan's draft is malformed: ${p}`);
  if (problems.length) throw new InputError(problems);
  // The keychain's check (credentials.ts): ids valid for the network, and the public key ed25519 with exactly
  // 32 bytes. Its error never echoes the value (a 64-byte one would be a private key's shape, C-T2b).
  sessionKeyPath(session, env);
  const { network, mode, accountId, receiverId, methodNames, allowanceYocto, id } = session;
  if (!onNetwork(plan.signerId, network) || !isAccountId(plan.signerId)) problems.push(`signer ${JSON.stringify(plan.signerId)} is not a ${network} account`);
  if (networkOfAccount(receiverId) !== network || !isAccountId(receiverId)) problems.push(`receiver ${JSON.stringify(receiverId)} is not a ${network} account`);
  if (methodNames.length === 0) problems.push(`the plan allows no method: ${EMPTY_METHODS}`);
  if (new Set(methodNames).size !== methodNames.length) problems.push("the plan lists a method twice");
  if (BigInt(allowanceYocto) % ALLOWANCE_STEP_YOCTO !== 0n) problems.push(ALLOWANCE_STEP_PROBLEM);
  if (mode === "on-account") {
    if (plan.signerId !== accountId) problems.push(`on-account mode signs with the account itself (${accountId}), not ${plan.signerId}`);
    if (plan.fundingYocto !== null) problems.push("on-account mode moves no NEAR (fundingYocto must be null)");
  } else {
    if (accountId !== `${id}.${plan.signerId}`) problems.push(`the session sub-account must be ${id}.${plan.signerId}, not ${accountId}`);
    const funding = (BigInt(allowanceYocto) + SUBACCOUNT_RESERVE).toString();
    if (plan.fundingYocto !== funding) problems.push(`the session sub-account is funded with the allowance plus the ${formatNear(SUBACCOUNT_RESERVE)} NEAR reserve (${funding} yocto)`);
  }
  if (problems.length) throw new InputError(problems);
  const planned = plannedActions(plan.draft, plan.signerId, plan.fundingYocto);
  const lines = planned.map((a) => a.line);
  if (lines.length !== plan.txActions.length || lines.some((line, i) => line !== plan.txActions[i])) {
    throw new InputError(["the plan's TX PLAN lines do not match the actions its draft would sign (the plan was changed after planWrap); run wrap again"]);
  }
  return planned;
}

/** The signer's key must be a full-access key of the signer account, read from the chain at the verified URL. */
async function requireFullAccess(url: string, network: Network, signerId: string, publicKey: string): Promise<void> {
  const reply = await rpcCall(url, "query", { request_type: "view_access_key", finality: "final", account_id: signerId, public_key: publicKey });
  if (isNoSuchKey(reply.json)) {
    throw new EnvironmentError(`${signerId} has no access key ${publicKey} on ${network}`, "nothing was signed: sign with the account's own full-access key (keychain NETWORK/ACCOUNT.json)");
  }
  const permission = reply.json?.result?.permission;
  // C-T2l: scrubbed of the URL's path and query, so a gateway that echoes the request URL never prints an API key.
  if (permission === undefined) throw new EnvironmentError(`view_access_key ${signerId} failed: ${rpcErrorTextAt(reply.json, url)}`, "check the RPC endpoint");
  if (permission !== "FullAccess") {
    throw new EnvironmentError(`the key ${publicKey} on ${signerId} is not a full-access key`, "nothing was signed: wrap signs with the account's full-access key");
  }
}

/** An id with no session file under `$KEYHOLE_HOME/sessions` (R2b: re-roll on collision). */
async function freshSessionId(): Promise<string> {
  const taken = new Set(await listSessionIds());
  for (let i = 0; i < MAX_ID_DRAWS; i++) {
    const id = newSessionId();
    if (!taken.has(id)) return id;
  }
  throw new EnvironmentError(`no free session id after ${MAX_ID_DRAWS} draws (${taken.size} session files in ${sessionsDir()})`, "burn and remove old sessions, or point KEYHOLE_HOME at another directory");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new EnvironmentError(`cannot read ${path} (${(e as NodeJS.ErrnoException).code ?? "error"})`, "check KEYHOLE_HOME and file permissions");
  }
}

// ---------------------------------------------------------------------------------------------------
// The TX PLAN: one list gives both the printed lines and the signed actions

interface PlannedAction {
  /** The R2 TX PLAN line (`→` is replaced by the glyph arrow when printed). */
  line: string;
  build(keys: { operator: PublicKey; session: PublicKey }): Action;
}

/**
 * The actions of a wrap tx, signed by `signerId` with receiver `draft.accountId`:
 * - on-account: AddKey(session key, FunctionCall: receiver, methods, allowance);
 * - sub-account: CreateAccount, Transfer(funding), AddKey(operator key, FullAccess), then the same AddKey.
 */
function plannedActions(draft: Draft, signerId: string, fundingYocto: string | null): PlannedAction[] {
  const { accountId, receiverId, methodNames, allowanceYocto } = draft;
  const allowance = BigInt(allowanceYocto);
  const addFunctionCallKey: PlannedAction = {
    line: `+ AddKey FunctionCall → ${accountId} · receiver ${receiverId} · methods ${methodNames.join(", ")} · allowance ${formatNear(allowance)} NEAR`,
    build: (keys) => actions.addFunctionCallAccessKey(keys.session, receiverId, [...methodNames], allowance),
  };
  if (draft.mode === "on-account") return [addFunctionCallKey];
  const funding = BigInt(fundingYocto ?? "0");
  return [
    { line: `+ CreateAccount ${accountId} (sub-account of ${signerId}) · ${CREATION_COST}`, build: () => actions.createAccount() },
    {
      line: `+ Transfer ${formatNear(funding)} NEAR → ${accountId} · gas allowance ${formatNear(allowance)} + reserve ${formatNear(SUBACCOUNT_RESERVE)} (storage)`,
      build: () => actions.transfer(funding),
    },
    {
      line: `+ AddKey FullAccess (operator) → ${accountId} · ${signerId}'s full-access key; keyhole burn deletes the account with it`,
      build: (keys) => actions.addFullAccessKey(keys.operator),
    },
    addFunctionCallKey,
  ];
}
