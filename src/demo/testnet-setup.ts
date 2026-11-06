/**
 * The testnet demo (Task 15): one DAO per operator, created once through the `sputnik-v2.testnet` factory and
 * reused; proposals are fresh on every run. State: `$KEYHOLE_HOME/testnet-demo.json`, public data only (account ids,
 * the DAO id, its create tx hash and time). Testnet NEAR comes from the faucet. Mainnet is never touched:
 * assertChain("testnet") runs before any other RPC, and signAndSend checks the chain again before it signs.
 *
 * ensureTestnetDemo, in order:
 *   1. KEYHOLE_OPERATOR must be a *.testnet account, and not a Verdict one (Q-015): EnvironmentError before any RPC.
 *   2. assertChain("testnet").
 *   3. A state file for this operator whose DAO verifies is reused, with no send. "Verifies" (verifyDao, shared with
 *      --check) means: code_hash = the sputnik-v2 pack's pin; council = {seat, cosigner}; requiredApprovals = 2
 *      (2-of-2); no per-kind vote policy on the council; and no other role can vote.
 *      A DAO whose create had an unknown fate (the pending file, below) is adopted here once it verifies and its
 *      create tx is known. Another operator's state file or pending record stops the run: neither is ever
 *      overwritten (final sweep, C-T15a), since that operator's next run would then create a second DAO.
 *      When two creates of the pending name went out with unknown fates (txHash and priorTxHash), the DAO is
 *      adopted under txHash only if one `tx` read shows that create returned true (C-T15b).
 *   4. Balance gate: the operator needs >= 6.6 NEAR (view_account); below that, an EnvironmentError and no send.
 *   5. seat / cosigner / grantee: all three are checked before any send. An existing account whose full-access key
 *      is in the keychain (and on chain) is reused; an existing one without it is an EnvironmentError. A new one gets
 *      [CreateAccount, Transfer, AddKey(full access)] from the operator, its key saved (0600) BEFORE the send.
 *   6. The DAO `kh-XXXX.sputnik-v2.testnet` (a name not taken yet) through the factory's `create`: 5 NEAR, 300 TGas.
 *   7. It must verify as in 3.
 *   8. The state file is written.
 *
 * Nothing is ever sent twice in a run: a send whose fate is unknown (SendFateUnknownError) ends it, naming the tx
 * hash. A second run is safe because every create is keyed by an account id that can be created only once:
 * - an account whose key file exists is reused, or created with that same key;
 * - the DAO's name is recorded in `testnet-demo.pending.json` before its create is sent (a run killed during that
 *   send leaves it), so the next run adopts that DAO (if a create landed) or creates that same name again (a
 *   duplicate create fails, and the factory refunds its deposit). It never picks a second name while one is
 *   pending. `txHash` is only ever the hash of the record's own send; an earlier send's hash is kept as
 *   `priorTxHash` and is never adopted as the DAO's create tx.
 */
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { KeyPair, actions } from "near-api-js";
import { NEAR, TGAS, formatNear, networkOfAccount } from "../core/amounts.js";
import { keyholeHome, rpcUrlFor } from "../core/config.js";
import { credentialsDir, loadFullAccessKey, saveAccountKey } from "../core/credentials.js";
import { EnvironmentError, InputError } from "../core/errors.js";
import { assertChain, isNoSuchKey, rpcCall, rpcErrorTextAt, viewAccount } from "../core/rpc.js";
import { SendFateUnknownError, type SentTx, landedFailure, mustSucceed, signAndSend, successValue } from "../core/tx.js";
import type { Network, TargetPack } from "../core/types.js";
import { loadTargetPack } from "../packs/index.js";
import { councilInitArgs } from "../packs/sputnik-setup.js";
import { COUNCIL_ROLE, requiredApprovals } from "../packs/sputnik-v2.js";

export interface TestnetDemoState {
  operator: string;
  seat: string;
  cosigner: string;
  grantee: string;
  dao: string;
  daoCreateTx: string;
  daoCreatedAt: string;
  otherDao: string;
  attacker: string;
}

/** The DAO factory the PRD names: its DAOs run code byte-identical to the vendored sputnikdao2 v2.0.0 wasm. */
export const FACTORY = "sputnik-v2.testnet";
/** The other DAO the demo's out-of-receiver attempt aims at (spike step g3). */
export const OTHER_DAO = "genesis.sputnik-v2.testnet";
/** What the first run needs: 1.55 NEAR of account funding, the DAO's 5 NEAR, and gas. */
export const FIRST_RUN_YOCTO = (66n * NEAR) / 10n;
/** Attached to the factory's create: the DAO's code storage (≈4.7 NEAR for 469,804 bytes) plus room for state. */
export const DAO_DEPOSIT_YOCTO = 5n * NEAR;
export const FACTORY_GAS = 300n * TGAS;
/** The demo accounts, sub-accounts of the operator, in creation order, with the NEAR each one is funded with. */
export const DEMO_ACCOUNTS: ReadonlyArray<{ role: "seat" | "cosigner" | "grantee"; fundingYocto: bigint }> = Object.freeze([
  { role: "seat", fundingYocto: NEAR / 2n },
  { role: "cosigner", fundingYocto: NEAR },
  { role: "grantee", fundingYocto: NEAR / 20n },
]);

const STATE_FIELDS = ["operator", "seat", "cosigner", "grantee", "dao", "daoCreateTx", "daoCreatedAt", "otherDao", "attacker"] as const;
/** Tries at a random unused DAO name before giving up (65,536 names; 78 taken today). */
const NAME_TRIES = 8;
/** One part of an account id, as the factory's `name` (the DAO is NAME.sputnik-v2.testnet). */
const ACCOUNT_LABEL = /^[a-z0-9]+([-_][a-z0-9]+)*$/;
/** A NEAR account id: lowercase parts joined by `.`, `-` or `_`. */
const ACCOUNT_ID = /^[a-z0-9]+([-_][a-z0-9]+)*(\.[a-z0-9]+([-_][a-z0-9]+)*)*$/;
/** The longest demo sub-account prefix, so `cosigner.OPERATOR` still fits NEAR's 64 characters. */
const LONGEST_PREFIX = "cosigner.".length;
const OPERATOR_HINT = "its full-access key must be in ~/.near-credentials/testnet/<account>.json";
/** A Verdict account id (Q-015: Keyhole and the sibling project Verdict share no accounts and no DAOs). */
const VERDICT_ACCOUNT = /(^|[._-])verdict/;
/** The only DAO ids this bootstrap creates, so the only ones a pending record may name. */
const DEMO_DAO_ID = /^kh-[0-9a-f]{4}\.sputnik-v2\.testnet$/;
/** A transaction hash: base58 of 32 bytes. */
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** What a new demo DAO costs when the hint offers to create one. */
const NEW_DAO = "to create a new demo DAO (another 5 NEAR)";
/** What a first bootstrap costs (FIRST_RUN_YOCTO), for a hint that leads to one. */
const FIRST_RUN = "≈6.6 NEAR: the demo accounts and a new DAO";
/** The factory's `create` returned true: base64 of the JSON `true`, the tx's SuccessValue. */
const CREATE_RETURNED_TRUE = "dHJ1ZQ==";
const BOOTSTRAP = "run: npm run bootstrap:testnet";

/** `$KEYHOLE_HOME/testnet-demo.json`. */
export function testnetDemoStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(keyholeHome(env), "testnet-demo.json");
}

/** `$KEYHOLE_HOME/testnet-demo.pending.json`: the DAO name chosen before its create was sent (public data only). */
function pendingPath(env: NodeJS.ProcessEnv): string {
  return join(keyholeHome(env), "testnet-demo.pending.json");
}

interface PendingDao {
  operator: string;
  dao: string;
  seat: string;
  cosigner: string;
  recordedAt: string;
  /** This record's own create tx: its fate was unknown, or it landed before its DAO verified. Never an earlier send's. */
  txHash?: string;
  /** An earlier create of the same name that did not create the DAO when this record was written (fate unknown then). */
  priorTxHash?: string;
}

/** The operator's demo account ids. */
function demoIds(op: string) {
  return { seat: `seat.${op}`, cosigner: `cosigner.${op}`, grantee: `grantee.${op}`, attacker: `attacker.${op}` };
}

/** KEYHOLE_OPERATOR, which must be a testnet account id short enough to have the demo sub-accounts. */
function operatorOf(env: NodeJS.ProcessEnv): string {
  const op = env.KEYHOLE_OPERATOR ?? "";
  if (networkOfAccount(op) !== "testnet" || !ACCOUNT_ID.test(op) || op.length + LONGEST_PREFIX > 64) {
    throw new EnvironmentError("set KEYHOLE_OPERATOR=<account>.testnet", OPERATOR_HINT);
  }
  if (VERDICT_ACCOUNT.test(op)) {
    throw new EnvironmentError(`KEYHOLE_OPERATOR ${op} is a Verdict account: Keyhole and Verdict share no accounts (Q-015)`, "use a Keyhole operator (kh-op-XXXX.testnet, created through the faucet)");
  }
  return op;
}

/** Arguments for the factory's `create`: the DAO name, and its init args (base64 JSON of councilInitArgs). */
export function factoryCreateArgs(pack: TargetPack, name: string, seat: string, cosigner: string): { name: string; args: string } {
  if (!ACCOUNT_LABEL.test(name)) throw new InputError([`DAO name ${JSON.stringify(name)} is not one account-id part (lowercase letters, digits, - and _)`]);
  return { name, args: Buffer.from(JSON.stringify(councilInitArgs(pack, seat, cosigner))).toString("base64") };
}

// ---------------------------------------------------------------------------------------------------
// Local files (public data only)

const errno = (e: unknown): string => String((e as NodeJS.ErrnoException)?.code ?? "unknown error");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** A JSON file's parsed contents, or null when there is no file. */
async function readJson(path: string, fix: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if (errno(e) === "ENOENT") return null;
    throw new EnvironmentError(`cannot read ${path} (${errno(e)})`, "check KEYHOLE_HOME and its permissions");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new EnvironmentError(`${path} is not JSON`, fix);
  }
}

/** Writes `value` as JSON through a temp file and a rename, so a reader never sees half a file. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new EnvironmentError(`cannot write ${path} (${errno(e)})`, "check KEYHOLE_HOME and its permissions");
  }
}

async function readState(env: NodeJS.ProcessEnv): Promise<TestnetDemoState | null> {
  const path = testnetDemoStatePath(env);
  const fix = `restore it, or remove it to create a new demo DAO (≈6.6 NEAR): ${BOOTSTRAP}`;
  const v = await readJson(path, fix);
  if (v === null) return null;
  if (!isObj(v) || !STATE_FIELDS.every((k) => isStr(v[k]))) throw new EnvironmentError(`${path} is not a testnet demo state (fields ${STATE_FIELDS.join(", ")})`, fix);
  return Object.fromEntries(STATE_FIELDS.map((k) => [k, v[k]])) as unknown as TestnetDemoState;
}

async function readPending(env: NodeJS.ProcessEnv): Promise<PendingDao | null> {
  const path = pendingPath(env);
  const fix = "it names a DAO whose create was sent: look that DAO up on chain before removing the file";
  const v = await readJson(path, fix);
  if (v === null) return null;
  if (!isObj(v) || !["operator", "dao", "seat", "cosigner", "recordedAt"].every((k) => isStr(v[k]))) {
    throw new EnvironmentError(`${path} is not a pending DAO record`, fix);
  }
  const p = v as unknown as PendingDao;
  // The dao becomes the name of a create (sliced to kh-XXXX); seat and cosigner its council; the hashes a daoCreateTx.
  if (!DEMO_DAO_ID.test(p.dao)) throw new EnvironmentError(`${path}: dao ${JSON.stringify(p.dao)} is not a kh-XXXX.${FACTORY} id`, fix);
  if (p.seat !== `seat.${p.operator}` || p.cosigner !== `cosigner.${p.operator}`) throw new EnvironmentError(`${path}: seat and cosigner are not ${p.operator}'s demo accounts`, fix);
  if ([p.txHash, p.priorTxHash].some((h) => h !== undefined && !(typeof h === "string" && TX_HASH.test(h)))) {
    throw new EnvironmentError(`${path}: txHash and priorTxHash must be base58 tx hashes`, fix);
  }
  return p;
}

/** True when the state names exactly this operator's demo accounts. */
function stateMatches(state: TestnetDemoState, op: string): boolean {
  const ids = demoIds(op);
  return state.operator === op && state.seat === ids.seat && state.cosigner === ids.cosigner && state.grantee === ids.grantee;
}

// ---------------------------------------------------------------------------------------------------
// Chain reads

/** A testnet contract view at final finality, its result bytes parsed as JSON. */
async function viewJson(accountId: string, method: string, network: Network): Promise<unknown> {
  const url = rpcUrlFor(network);
  const reply = await rpcCall(url, "query", { request_type: "call_function", finality: "final", account_id: accountId, method_name: method, args_base64: "e30=" });
  const bytes = reply.json?.result?.result;
  if (reply.json?.error || typeof reply.json?.result?.error === "string" || !Array.isArray(bytes)) {
    throw new EnvironmentError(`view ${accountId}.${method} failed: ${rpcErrorTextAt(reply.json, url)}`, "check the RPC endpoint and that the account is a Sputnik DAO");
  }
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new EnvironmentError(`view ${accountId}.${method} returned ${bytes.length} bytes that are not JSON`, "check that the account is a Sputnik DAO");
  }
}

/** What a verified DAO is: its code hash, its council (as the contract lists it) and the approvals it needs. */
interface DaoCheck {
  codeHash: string;
  council: string[];
  required: number;
}

type Verdict = { ok: true; check: DaoCheck } | { ok: false; missing: boolean; why: string };

/**
 * The demo DAO's checks, read at final finality: it exists, its code_hash is the pack's pin, its council Group is
 * {seat, cosigner} (the contract lists a Group sorted, so order is not compared) and it needs 2 approvals
 * (requiredApprovals, the pack's threshold math). A failed check is a verdict; an RPC failure throws. `network`
 * (default testnet) is where it reads: the demo driver checks its sandbox DAO by the same rule.
 */
export async function verifyDao(pack: TargetPack, dao: string, seat: string, cosigner: string, network: Network = "testnet"): Promise<Verdict> {
  const pin = pack.sandboxFixture?.codeHash;
  if (!pin) throw new EnvironmentError(`target pack ${pack.id} pins no code hash`, "use the sputnik-v2 pack");
  const account = await viewAccount(network, dao);
  if (!account) return { ok: false, missing: true, why: `${dao} does not exist` };
  if (account.codeHash !== pin) return { ok: false, missing: false, why: `its code_hash is ${account.codeHash}, not the pinned ${pin}` };
  const policy = await viewJson(dao, "get_policy", network);
  let required: number;
  try {
    required = requiredApprovals(policy);
  } catch (e) {
    if (e instanceof EnvironmentError) return { ok: false, missing: false, why: e.what };
    throw e;
  }
  // requiredApprovals has checked that the council role exists and is a Group of accounts.
  const roles = (policy as { roles: Array<{ name?: unknown; kind?: { Group?: unknown }; permissions?: unknown; vote_policy?: unknown }> }).roles;
  const councilRole = roles.find((r) => r.name === COUNCIL_ROLE);
  const council = councilRole?.kind?.Group as string[];
  if (council.length !== 2 || [...council].sort().join() !== [seat, cosigner].sort().join()) {
    return { ok: false, missing: false, why: `its council is [${council.join(", ")}], not [${seat}, ${cosigner}]` };
  }
  // A per-kind vote policy would override the 2-of-2 default for that kind (requiredApprovals reads the default).
  const overrides = isObj(councilRole?.vote_policy) ? Object.keys(councilRole.vote_policy) : ["(not an object)"];
  if (overrides.length) return { ok: false, missing: false, why: `the council has per-kind vote policies (${overrides.join(", ")}): the demo needs 2-of-2 on every kind` };
  // Only the council may vote: another role with a Vote* (or *) action could pass a proposal without the quorum.
  for (const role of roles) {
    if (role === councilRole) continue;
    const perms = Array.isArray(role.permissions) ? role.permissions : ["(unreadable permissions)"];
    const votes = perms.filter((p) => typeof p !== "string" || canVote(p));
    if (votes.length) return { ok: false, missing: false, why: `role ${String(role.name)} can vote (${votes.join(", ")}): only the council may` };
  }
  if (required !== 2) return { ok: false, missing: false, why: `it needs ${required} of ${council.length} approvals, not 2-of-2` };
  return { ok: true, check: { codeHash: account.codeHash, council, required } };
}

/**
 * Whether a sputnikdao2 permission (`KIND:ACTION`, e.g. `*:AddProposal`, `transfer:VoteApprove`) lets its role vote:
 * its action is a Vote* action, or `*` (every action). Stricter than the `*:Vote*` / `Vote*` patterns alone, since
 * a per-kind `transfer:VoteApprove` or a blanket `*:*` votes as well.
 */
function canVote(permission: string): boolean {
  const action = permission.slice(permission.lastIndexOf(":") + 1);
  return action === "*" || action.startsWith("Vote");
}

/** `DAO <dao> · code_hash <hash> · council [<seat>, <cosigner>] · 2-of-2`. */
function daoLine(state: TestnetDemoState, check: DaoCheck): string {
  return `DAO ${state.dao} · code_hash ${check.codeHash} · council [${state.seat}, ${state.cosigner}] · ${check.required}-of-${check.council.length}`;
}

/** EnvironmentError unless `key` is a full-access key of `accountId` on chain. */
async function assertFullAccessKey(accountId: string, key: KeyPair): Promise<void> {
  const url = rpcUrlFor("testnet");
  const publicKey = key.getPublicKey().toString();
  const reply = await rpcCall(url, "query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
  const fix = `the keychain's key for ${accountId} must be one of its full-access keys: import the right one (near-cli-rs save-to-legacy-keychain)`;
  if (isNoSuchKey(reply.json)) throw new EnvironmentError(`${accountId} exists on testnet, but the key in the keychain (${publicKey}) is not on it`, fix);
  const permission = reply.json?.result?.permission;
  if (permission === undefined) throw new EnvironmentError(`view_access_key ${accountId} failed: ${rpcErrorTextAt(reply.json, url)}`, "check the RPC endpoint");
  if (permission !== "FullAccess") throw new EnvironmentError(`the key in the keychain for ${accountId} (${publicKey}) is not a full-access key on chain`, fix);
}

/**
 * One `tx` read of a factory create (C-T15b): null when it landed, nothing in it failed, and the factory returned
 * true (that create made the DAO); else why not. A read that fails is a why, never a pass.
 */
async function createMadeTheDao(txHash: string, signerId: string): Promise<string | null> {
  const url = rpcUrlFor("testnet");
  let reply: Awaited<ReturnType<typeof rpcCall>>;
  try {
    reply = await rpcCall(url, "tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "FINAL" });
  } catch (e) {
    return `reading it failed: ${e instanceof EnvironmentError ? e.what : "no answer"}`;
  }
  const status = reply.json?.result?.status;
  if (!status) return `reading it failed: ${rpcErrorTextAt(reply.json, url)}`;
  const failure = landedFailure(reply.json);
  if (failure) return "it failed in a block";
  return status.SuccessValue === CREATE_RETURNED_TRUE ? null : "the factory did not return true";
}

// ---------------------------------------------------------------------------------------------------
// The bootstrap

interface AccountPlan {
  id: string;
  fundingYocto: bigint;
  exists: boolean;
  /** The key in the keychain, if a file is there: the account's key, or the key an earlier run saved before its send. */
  key: KeyPair | null;
}

/** Is there an entry at the account's key file path? Only the path is checked here; loadFullAccessKey reads it. */
function keyFileExists(accountId: string, env: NodeJS.ProcessEnv): boolean {
  try {
    lstatSync(join(credentialsDir(env), "testnet", `${accountId}.json`));
    return true;
  } catch (e) {
    if (errno(e) === "ENOENT" || errno(e) === "ENOTDIR") return false;
    throw new EnvironmentError(`cannot read the keychain entry for ${accountId} (${errno(e)})`, "check KEYHOLE_CREDENTIALS_DIR and its permissions");
  }
}

/** Step 5's reads for one demo account: does it exist, and is its key in the keychain (and, if it exists, on it)? */
async function planAccount(id: string, fundingYocto: bigint, env: NodeJS.ProcessEnv): Promise<AccountPlan> {
  const exists = (await viewAccount("testnet", id)) !== null;
  const key = keyFileExists(id, env) ? loadFullAccessKey("testnet", id, env) : null;
  if (exists && !key) {
    throw new EnvironmentError(
      `${id} exists on testnet, but its full-access key is not in ${join(credentialsDir(env), "testnet")}`,
      `import it (near account import-account … save-to-legacy-keychain), or use another KEYHOLE_OPERATOR`,
    );
  }
  if (exists && key) await assertFullAccessKey(id, key);
  return { id, fundingYocto, exists, key };
}

async function freshDaoName(): Promise<string> {
  for (let i = 0; i < NAME_TRIES; i++) {
    const name = `kh-${randomBytes(2).toString("hex")}`;
    if ((await viewAccount("testnet", `${name}.${FACTORY}`)) === null) return name;
  }
  throw new EnvironmentError(`no unused kh-XXXX.${FACTORY} name after ${NAME_TRIES} random tries`, `${BOOTSTRAP} again`);
}

/**
 * The operator's demo accounts and DAO: verified and reused when the state file matches, else created (see the
 * module comment for the order). `opts.log` receives one line per account and per DAO step; no line carries a key.
 */
export async function ensureTestnetDemo(env: NodeJS.ProcessEnv = process.env, opts: { log?: (line: string) => void } = {}): Promise<{ state: TestnetDemoState; created: boolean }> {
  const log = opts.log ?? (() => undefined);
  const op = operatorOf(env); // 1
  await assertChain("testnet"); // 2
  const pack = await loadTargetPack("sputnik-v2");
  const ids = demoIds(op);
  const statePath = testnetDemoStatePath(env);
  const stateOf = (dao: string, daoCreateTx: string, daoCreatedAt: string): TestnetDemoState => ({
    operator: op,
    seat: ids.seat,
    cosigner: ids.cosigner,
    grantee: ids.grantee,
    dao,
    daoCreateTx,
    daoCreatedAt,
    otherDao: OTHER_DAO,
    attacker: ids.attacker,
  });

  // 3: the state file, when it is this operator's and its DAO still verifies. Any other state file stops the run
  // before anything is read or sent (C-T15a): writing this operator's state over it would lose the only record of
  // that DAO, and the next run for its operator would create a second one.
  const saved = await readState(env);
  if (saved && !stateMatches(saved, op)) {
    const whose = saved.operator === op ? `names demo accounts that are not ${op}'s` : `records operator ${saved.operator}'s demo DAO ${saved.dao}`;
    throw new EnvironmentError(
      `${statePath} ${whose}; it is never overwritten`,
      saved.operator === op
        ? `restore it, or move it aside to bootstrap ${op} again (${FIRST_RUN})`
        : `set KEYHOLE_OPERATOR=${saved.operator} to reuse it, or move it aside (e.g. to testnet-demo.${saved.operator}.json) to bootstrap ${op} (${FIRST_RUN})`,
    );
  }
  if (saved) {
    const verdict = await verifyDao(pack, saved.dao, saved.seat, saved.cosigner);
    if (verdict.ok) {
      log(`reused DAO ${saved.dao} · created ${saved.daoCreatedAt} · tx ${saved.daoCreateTx}`);
      log(daoLine(saved, verdict.check));
      return { state: saved, created: false };
    }
    log(`state ${statePath}: DAO ${saved.dao} no longer verifies (${verdict.why}); creating a new demo DAO`);
  }

  // 3, continued: a DAO whose create was sent by an earlier run that stopped before writing the state.
  const pending = await readPending(env);
  if (pending && pending.operator !== op) {
    // Overwriting it would lose the only record of that operator's DAO name, and its next run would create a second DAO.
    throw new EnvironmentError(
      `${pendingPath(env)} records operator ${pending.operator}'s DAO ${pending.dao}, whose create was sent and not confirmed`,
      `finish it with that operator (KEYHOLE_OPERATOR=${pending.operator} npm run bootstrap:testnet), or look that DAO up on chain and then remove the file deliberately`,
    );
  }
  const ownPending = pending; // readPending checked that its seat and cosigner are its operator's: this operator's
  if (ownPending) {
    const verdict = await verifyDao(pack, ownPending.dao, ids.seat, ids.cosigner);
    if (verdict.ok) {
      if (!ownPending.txHash) {
        const prior = ownPending.priorTxHash ? ` (an earlier create of this name, tx ${ownPending.priorTxHash}, may or may not be it)` : "";
        throw new EnvironmentError(
          `DAO ${ownPending.dao} exists and verifies, but its create tx was never recorded${prior}`,
          `add its create tx as "txHash" in ${pendingPath(env)} and run again; or remove that file ${NEW_DAO}`,
        );
      }
      if (ownPending.priorTxHash) {
        // Two creates of this name went out with unknown fates (C-T15b): the DAO came from one of them. It is adopted
        // under txHash only if that create returned true; the other one is never adopted.
        const why = await createMadeTheDao(ownPending.txHash, op);
        if (why !== null) {
          throw new EnvironmentError(
            `DAO ${ownPending.dao} exists and verifies, but its recorded create tx ${ownPending.txHash} did not make it (${why}); an earlier create of this name, tx ${ownPending.priorTxHash}, may be the one`,
            `look both txs up on chain, put the one that returned true as "txHash" in ${pendingPath(env)} and remove "priorTxHash", then run again; or remove that file ${NEW_DAO}`,
          );
        }
      }
      const state = stateOf(ownPending.dao, ownPending.txHash, ownPending.recordedAt);
      await writeJson(statePath, state);
      await rm(pendingPath(env), { force: true });
      log(`adopted DAO ${state.dao} · its create tx ${state.daoCreateTx} landed after an earlier run stopped`);
      log(daoLine(state, verdict.check));
      return { state, created: false };
    }
    if (!verdict.missing) {
      throw new EnvironmentError(`DAO ${ownPending.dao} (named before its create was sent) exists, but ${verdict.why}`, `remove ${pendingPath(env)} ${NEW_DAO}`);
    }
  }

  // 4: the balance gate, before anything is written or sent.
  const operator = await viewAccount("testnet", op);
  if (!operator) {
    throw new EnvironmentError(`operator ${op} does not exist on testnet`, "create it: near account create-account sponsor-by-faucet-service … save-to-legacy-keychain");
  }
  if (BigInt(operator.amountYocto) < FIRST_RUN_YOCTO) {
    throw new EnvironmentError(
      `operator ${op} has ${formatNear(operator.amountYocto, 2)} NEAR; the first testnet run needs ≈6.6 NEAR (DAO code storage ≈4.7)`,
      "fund a second faucet account and transfer, or run: npm run keyhole -- demo --sandbox",
    );
  }

  // 5: every demo account is read before the first send; an existing one without its key stops the run here.
  const plans: AccountPlan[] = [];
  for (const { role, fundingYocto } of DEMO_ACCOUNTS) plans.push(await planAccount(`${role}.${op}`, fundingYocto, env));
  const opKey = loadFullAccessKey("testnet", op, env);
  for (const plan of plans) {
    if (plan.exists) {
      log(`reused ${plan.id} · its full-access key is in the keychain`);
      continue;
    }
    const key = plan.key ?? KeyPair.fromRandom("ed25519");
    if (!plan.key) saveAccountKey("testnet", plan.id, key, env); // before the send: a key that reaches the chain is never lost
    const acts = [actions.createAccount(), actions.transfer(plan.fundingYocto), actions.addFullAccessKey(key.getPublicKey())];
    const sent = mustSucceed(`create ${plan.id}`, await signAndSend("testnet", op, opKey, plan.id, acts));
    log(`created ${plan.id} · ${formatNear(plan.fundingYocto, 2)} NEAR · tx ${sent.txHash}`);
  }

  // 6: the DAO, under the pending name if an earlier create of it did not land, else a fresh unused one.
  const name = ownPending ? ownPending.dao.slice(0, -`.${FACTORY}`.length) : await freshDaoName();
  const dao = `${name}.${FACTORY}`;
  const prior = ownPending?.txHash ?? ownPending?.priorTxHash;
  if (ownPending) log(`DAO ${dao}: an earlier create${prior ? ` (tx ${prior})` : ""} did not create it; creating it again under the same name`);
  const record: PendingDao = { operator: op, dao, seat: ids.seat, cosigner: ids.cosigner, recordedAt: new Date().toISOString() };
  if (prior) record.priorTxHash = prior; // txHash comes only from this send, below
  await writeJson(pendingPath(env), record); // before the send: a run killed during it (SIGINT, no catch) leaves the name
  const create = actions.functionCall("create", factoryCreateArgs(pack, name, ids.seat, ids.cosigner), FACTORY_GAS, DAO_DEPOSIT_YOCTO);
  let sent: SentTx;
  try {
    sent = await signAndSend("testnet", op, opKey, FACTORY, [create]);
  } catch (e) {
    if (e instanceof SendFateUnknownError) await writeJson(pendingPath(env), { ...record, txHash: e.txHash });
    throw e;
  }
  mustSucceed(`create DAO ${dao} through ${FACTORY}`, sent);
  if (successValue(sent) === false) {
    throw new EnvironmentError(`${FACTORY} create ${name} returned false: the DAO was not created (tx ${sent.txHash})`, `the factory refunds the deposit; ${BOOTSTRAP} again`);
  }
  const createdAt = new Date().toISOString();
  await writeJson(pendingPath(env), { ...record, recordedAt: createdAt, txHash: sent.txHash });
  log(`DAO ${dao} created · tx ${sent.txHash}`);

  // 7 and 8.
  const verdict = await verifyDao(pack, dao, ids.seat, ids.cosigner);
  if (!verdict.ok) {
    throw new EnvironmentError(`DAO ${dao} was created (tx ${sent.txHash}), but ${verdict.why}`, `remove ${pendingPath(env)} ${NEW_DAO}`);
  }
  const state = stateOf(dao, sent.txHash, createdAt);
  log(daoLine(state, verdict.check));
  await writeJson(statePath, state);
  await rm(pendingPath(env), { force: true });
  return { state, created: true };
}

/**
 * `bootstrap:testnet --check`: signs nothing. Reads the state file, verifies its DAO as ensureTestnetDemo does, and
 * reads the operator's balance. `line` is `DAO <dao> · code_hash <hash> · council [<seat>, <cosigner>] · 2-of-2 ·
 * operator balance <n> NEAR`.
 */
export async function checkTestnetDemo(env: NodeJS.ProcessEnv = process.env): Promise<{ state: TestnetDemoState; line: string }> {
  const op = operatorOf(env);
  await assertChain("testnet");
  const path = testnetDemoStatePath(env);
  const state = await readState(env);
  // C-T15d: each hint that leads to a bootstrap says what that bootstrap costs.
  if (!state) throw new EnvironmentError(`no testnet demo state at ${path}`, `${BOOTSTRAP} (${FIRST_RUN})`);
  if (!stateMatches(state, op)) {
    throw new EnvironmentError(`${path} is operator ${state.operator}'s demo, not ${op}'s`, `set KEYHOLE_OPERATOR=${state.operator}, or move that file aside and ${BOOTSTRAP} for ${op} (${FIRST_RUN})`);
  }
  const verdict = await verifyDao(await loadTargetPack("sputnik-v2"), state.dao, state.seat, state.cosigner);
  if (!verdict.ok) throw new EnvironmentError(`DAO ${state.dao} does not verify: ${verdict.why}`, `${BOOTSTRAP} (it creates a new demo DAO: another 5 NEAR)`);
  const operator = await viewAccount("testnet", op);
  if (!operator) throw new EnvironmentError(`operator ${op} does not exist on testnet`, "check KEYHOLE_OPERATOR");
  return { state, line: `${daoLine(state, verdict.check)} · operator balance ${formatNear(operator.amountYocto, 2)} NEAR` };
}
