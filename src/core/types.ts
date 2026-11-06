/**
 * Shared types: PRD §7b entities plus the LAYOUT_SPEC "DATA CONTRACT" supporting types and entity
 * additions (Session.packId, Session.tools, ToolSchema.evidence, DemoStep).
 *
 * Conventions:
 * - Amounts are decimal strings in yoctoNEAR (`...Yocto`), because sessions and DemoRuns are JSON.
 * - Gas is a number in TGas (`gasTGas`).
 * - Every chain fact on screen comes from RPC or from a committed fixture, never from these files.
 */

export type Network = "sandbox" | "testnet";
export type SessionMode = "subaccount" | "on-account";
export type SessionStatus = "live" | "burned";

/** Dry-run classification of a method (PRD MH3). */
export type Classification = "callable" | "fails-without-deposit (runtime)" | "not in allowlist" | "inconclusive";
export type ToolKind = "view" | "call" | "meta";

/** A JSON Schema object, as served in an MCP tool's input schema. */
export type JsonSchema = { [key: string]: unknown };

export interface ToolSchema {
  name: string;
  kind: ToolKind;
  /** Contract method behind the tool; null for meta tools (keyhole_inspect, keyhole_attempt). */
  method: string | null;
  argsSchema: JsonSchema;
  /** Gas attached per call. 30 TGas for a Sputnik vote (PRD §7: 100 TGas is refused under 0.05 NEAR). */
  gasTGas: number;
  /** Set for call tools once classifyTools has run (at wrap); absent on pack templates. */
  classification?: Classification;
  /** LAYOUT entity addition 2: raw panic text for `inconclusive` / `fails-without-deposit (runtime)`. */
  evidence?: string;
}

export interface Session {
  /** Fixed at scaffold: `ks-` plus 4 lowercase hex digits (src/core/session.ts). */
  id: string;
  mode: SessionMode;
  network: Network;
  /** Account that holds the session key: the member's seat (on-account) or the session sub-account. */
  accountId: string;
  receiverId: string;
  methodNames: string[];
  allowanceYocto: string;
  /** base58 code_hash of receiverId, read at wrap (the SERVER-SIDE pin, PRD MH1). */
  codeHashPin: string;
  /** Public half of the session's function-call key, `ed25519:...`. The private half is never in this file. */
  publicKey: string;
  createdAt: string;
  burnedAt?: string;
  status: SessionStatus;
  /** LAYOUT entity addition 1. */
  packId: string;
  /** LAYOUT entity addition 1: the tool list, fixed at wrap. */
  tools: ToolSchema[];
  /** Gap filler (LAYOUT R5 "BURNED" block reads the DeleteKey tx from the session file). */
  burnTxHashes?: string[];
}

/** Always read from `view_access_key`; never from local state. */
export interface ScopedKey {
  publicKey: string;
  accountId: string;
  receiverId: string;
  methodNames: string[];
  /** null would mean an unlimited allowance; Keyhole never mints one (T9). */
  allowanceRemainingYocto: string | null;
  nonce: number;
}

export type AttemptAction =
  | "FunctionCall"
  | "Transfer"
  | "AddKey"
  | "DeleteKey"
  | "CreateAccount"
  | "DeleteAccount"
  | "DeployContract"
  | "Stake";

/** The single key rule an attempt breaks. RuleStrip order: method · action · receiver · deposit · allowance. */
export type Violation = "method" | "action" | "receiver" | "deposit" | "allowance" | "none";

export const INVALID_ACCESS_KEY_ERRORS = [
  "AccessKeyNotFound",
  "ReceiverMismatch",
  "MethodNameMismatch",
  "RequiresFullAccess",
  "NotEnoughAllowance",
  "DepositWithFunctionCall",
] as const;
/** The six plain-key InvalidAccessKeyError variants (PRD §6: "six of eight"). */
export type InvalidAccessKeyErrorName = (typeof INVALID_ACCESS_KEY_ERRORS)[number];
/** Names a negative test may expect. SignerDoesNotExist is InvalidTxError (sub-account burn), not an access-key error. */
export type RefusalName = InvalidAccessKeyErrorName | "SignerDoesNotExist";

/** Rejected at validation: never in a block. The name is parsed from the body, never written by Keyhole. */
export interface Refusal {
  kind: "Refusal";
  /** Parsed from rawRpcJson. Usually a RefusalName; any other InvalidTxError variant is passed through as parsed. */
  errorName: string;
  family: "InvalidTxError::InvalidAccessKeyError" | "InvalidTxError";
  /** e.g. ["InvalidTxError", "InvalidAccessKeyError", "MethodNameMismatch"] */
  path: string[];
  /** The variant payload as received (e.g. NotEnoughAllowance { allowance, cost, ... }). */
  detail: unknown;
  /** The RPC response body, byte for byte. */
  rawRpcJson: string;
  reachedBlock: false;
}

export interface TxSuccess {
  kind: "TxSuccess";
  txHash: string;
  rawRpcJson: string;
}

/** Landed in a block, failed at runtime, gas charged (the C3 contrast case). */
export interface ContractPanic {
  kind: "ContractPanic";
  txHash: string;
  message: string;
  rawRpcJson: string;
}

export type AttemptOutcome = TxSuccess | Refusal | ContractPanic;

export interface Attempt {
  sessionId: string;
  receiverId: string;
  action: AttemptAction;
  method?: string;
  args: Record<string, unknown>;
  depositYocto: string;
  gasTGas: number;
  violates: Violation;
  outcome: AttemptOutcome;
}

/** "Attempt without outcome": the keyhole_attempt tool input and sendAttempt's second argument. */
export type AttemptInput = Omit<Attempt, "outcome">;

export interface WrapOptions {
  contract: string;
  allow: string[];
  /** Explicit and non-zero (T9). */
  allowanceYocto: string;
  onAccount?: string;
  network: Network;
  /** Sub-account mode: the account that creates ID.OPERATOR and signs with its full-access key (KEYHOLE_OPERATOR). */
  operatorId?: string;
}

export interface WrapPlan {
  draft: Omit<Session, "createdAt" | "status" | "burnedAt" | "burnTxHashes">;
  /** One human-readable line per action to be signed (R2 TX PLAN). */
  txActions: string[];
  tools: ToolSchema[];
  warnings: string[];
  /** The account whose full-access key signs the wrap tx: ACCOUNT (on-account) or the operator (sub-account). */
  signerId: string;
  /** NEAR moved into a new session sub-account, in yocto; null in on-account mode. */
  fundingYocto: string | null;
  /** Wall time of the sandbox dry-run (classifyTools), in ms. */
  dryRunMs: number;
}

/**
 * What a key can do that the protocol does not limit (the cage card's VOTE / VALUE row, NOT A KEY LIMIT).
 * VOTE: the key casts votes (Sputnik). VALUE: whatever the signer owns inside the receiver.
 */
export interface Exposure {
  label: "VOTE" | "VALUE";
  value: string;
}

export type CageCardSource = "preview" | "chain" | "replay";

export interface CageCard {
  session: Session;
  /** null when view_access_key finds no key (burned). */
  key: ScopedKey | null;
  tools: ToolSchema[];
  codeHashNow: string | null;
  source: CageCardSource;
  readAt: string;
  /** From the session's pack (TargetPack.exposure); default `{ label: "VALUE", … }`. */
  exposure: Exposure;
}

export type DemoPhase = "setup" | "wrap" | "in-scope" | "refusals" | "chain-check" | "inspect" | "burn" | "smoke";
export type DemoSigner = "operator" | "cosigner" | "session" | "none";

/** LAYOUT entity addition 3: one line group of the R4 step log. */
export interface DemoStep {
  n: number;
  total: number;
  phase: DemoPhase;
  label: string;
  signer: DemoSigner;
  attempt?: Attempt;
  txHash?: string;
  card?: CageCard;
  pass: boolean;
  note?: string;
  /**
   * The fixture file of this step's RPC body, relative to the fixture dir. Replay: the file it was read
   * from. Live: the file name the body is saved under (writeRunArtifacts).
   */
  fixture?: string;
  /** Further tx hashes of the same step ([02] signs two proposals). */
  moreTxHashes?: string[];
  /** The proposal a step voted on, read back from the DAO (proposalStatus). */
  proposal?: { id: number; status: string; approvals: number; required: number };
  /** The chain-check step: the key as view_access_key returned it before and after the refusals. */
  chainCheck?: { before: ScopedKey; after: ScopedKey };
}

export interface DemoRun {
  id: string;
  network: Network;
  mode: "live" | "replay";
  steps: DemoStep[];
  durationMs: number;
  exitCode: number;
  transcriptPath: string;
}

/** Dry-run inputs a pack declares for one method (PRD MH3: 0 deposit, then the declared deposit). */
export interface DryRunInput {
  args: Record<string, unknown>;
  /** Deposit for the second dry-run call; null when the method takes none. */
  depositYocto: string | null;
}

export type PackTool = ToolSchema & { dryRun?: DryRunInput };

/** Which key state a negative test needs (sets up the single rule it breaks). */
export type NegativeTestKeyState = "session-key" | "tiny-allowance-key" | "after-burn";

/** Resolved against the run at attempt time: the pack's receiver, another DAO id, or the attacker account. */
export type NegativeTestReceiver = "receiver" | "other-receiver" | "attacker";

export interface NegativeTest {
  /** Fixture TEST id: demo/fixtures/NETWORK.PACK.TEST.json */
  id: string;
  /** The injected intent in plain words, e.g. "open a payout proposal". */
  label: string;
  violates: Violation;
  keyState: NegativeTestKeyState;
  receiver: NegativeTestReceiver;
  action: AttemptAction;
  method?: string;
  args: Record<string, unknown>;
  depositYocto: string;
  gasTGas: number;
  /** The only place an expected error name lives (LAYOUT R4 (e)). */
  expected: RefusalName;
}

export interface SandboxFixture {
  /** Relative to the repo root. */
  wasmPath: string;
  sha256: string;
  /** NEAR code_hash = base58(sha256(wasm)). */
  codeHash: string;
  init: { method: string; args: Record<string, unknown> };
  /** Calls made after init, before the dry-run (e.g. a proposal for act_proposal {id: 0} to find). */
  setup?: Array<{ signer: "seat" | "cosigner"; method: string; args: Record<string, unknown>; depositYocto: string }>;
}

export interface TargetPack {
  id: string;
  abiSource: "near-abi" | "pack-json";
  description: string;
  /** Pack tools. serve adds the meta tools keyhole_inspect and keyhole_attempt. */
  tools: PackTool[];
  /** Methods the pack declares but never serves; the cage card lists them as `not in allowlist`. */
  outOfScope: Array<{ method: string; dryRun?: DryRunInput }>;
  sandboxFixture: SandboxFixture | null;
  negativeTests: NegativeTest[];
  /** CageCard footer "not enforced" line, set per pack. */
  notEnforced: string;
  /** The cage card's VOTE / VALUE row. Absent: buildCageCard uses `{ label: "VALUE", … }`. */
  exposure?: Exposure;
}
