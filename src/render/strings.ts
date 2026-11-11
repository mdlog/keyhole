/**
 * String contracts (LAYOUT "Reusable components"). Exact strings; the PASS, FAIL and REPLAY tokens are
 * plain ASCII. Styling never changes characters: strip the escape codes and the line is byte-identical.
 * The strings below SIX_OF_EIGHT were locked in Task 1 (Global Constraints → Copy and output).
 */
import type { DemoPhase } from "../core/types.js";
import { joinAtDots, neutralizeControls } from "./style.js";

/**
 * Each refusal step, exactly once. Summaries never repeat it (so `grep -c` equals the refusal count).
 * The name is parsed from an RPC body with JSON.parse, so a hostile body can decode an escape into a real
 * control character; neutralizeControls prints it as visible text. A normal name passes through unchanged.
 */
export const passRefused = (errorName: string): string => `PASS: refused by protocol (${neutralizeControls(errorName)})`;

/** The first token of every replay line, so no excerpt can pass as a live run. */
export const REPLAY = "REPLAY";

export const PASS_IN_SCOPE = "PASS: in scope, landed";

/** Copied from PRD MH4. */
export const NOTE_IN_SCOPE = "NOTE: in scope — the key does not judge votes; the quorum does";

/** A call refused by the code_hash pin (serve), not by the protocol. */
export const REFUSED_SERVER_SIDE = "REFUSED (SERVER-SIDE, not the protocol)";

/** Environment failures (exit 2). */
export const ERROR_ENVIRONMENT = "ERROR (environment)";

/** A parsed error name that does not match the expected one (exit 1). */
export const failExpected = (expected: string, parsed: string): string => `FAIL: expected ${expected}, parsed ${parsed} from the body`;

/** R7 replay suite line. PRD §6: never "all". */
export const SIX_OF_EIGHT = "six of eight InvalidAccessKeyError variants; the two gas-key variants are out of scope";

/** The C3 contrast case: the tx landed and the contract panicked. */
export const PASS_RUNTIME = "PASS: runtime failure in a block, gas charged (contrast: the contract refused, not the protocol)";

/** The chain check after the refusals: nonce and allowance read twice with view_access_key. */
export const passChainCheck = (n: number): string => `PASS: key state unchanged by ${n} refusals`;
export const failChainCheck = (what: string): string => `FAIL: key state changed by refusals (${what})`;

/** After burn: view_access_key finds no key. */
export const PASS_KEY_GONE = "PASS: no such key on chain (view_access_key)";

export const CAPTION = "rejected at validation — never in a block; the RPC response is the evidence";

/**
 * The end of a refusal block's `rpc` row when the run writes no files (`demo --sandbox`; final review M3): the body
 * on screen is this run's, verbatim, and no fixture file holds it. A committed file of the same name is another run's.
 */
export const RPC_NOT_SAVED = "not saved: this run writes no files";

/** Follows the PASS line of a sub-account burn proof (SignerDoesNotExist). */
export const NOTE_SIGNER_GONE = "InvalidTxError: the account itself is gone, not an access-key error (sub-account mode)";

export const OFFLINE_ALTERNATIVE = "offline alternative: npm test (REPLAY)";

export const ALREADY_BURNED = "already burned";

export const MAINNET_OUT_OF_SCOPE = "mainnet is out of scope: CONTRACT must end in .testnet or .sandbox";

export const noTools = (ids: readonly string[]): string => `no tools: no near-abi and no target pack — available packs: ${ids.join(", ")}`;

/**
 * First half of a `not in allowlist` method's evidence: the method is absent from the key's method_names. Written by
 * the wrap-time dry-run (classify/dry-run.ts) and by the cage card for a key read from chain (core/cage.ts), which
 * strips and rewrites it. It lives here, a leaf, so that `serve` (which loads the cage) does not load the classifier
 * and the sandbox with it (C-T18c).
 */
export const ABSENT_EVIDENCE = "absent from the key's method_names (chain)";

/**
 * The hint under noTools: the receiver's code hash and the one each pack pins, so a contract built from other code
 * (e.g. an older DAO from the maintained sputnikv2.testnet factory, on its v2.0 or v3.0 build; its v3.31 default code
 * is pinned by sputnik-v2-331 since C-T20c) is explained where it is refused (README › Limits).
 * The receiver's hash comes from RPC, so its control characters are neutralized. One line when it fits 100 cells; with
 * real code hashes (44 characters each) it does not, so it breaks before a ` · ` (joinAtDots), each continuation hung
 * under the text after `hint: ` (C-T20e). Joined with a space again, the rows are the one-line hint.
 */
export const noPackHint = (codeHash: string, pins: ReadonlyArray<{ id: string; codeHash: string }>): string =>
  joinAtDots([`hint: code_hash ${neutralizeControls(codeHash)} matches no pack`, ...pins.map((p) => `${p.id} pins ${p.codeHash}`), "see README › Limits"], 100, "      ").join("\n");

/** Ctrl-C during a run; `n` is the step number as printed, e.g. "07". */
export const aborted = (n: string, id: string): string => `ABORTED at [${n}] · session ${id} is still live · run: keyhole burn ${id}`;
export const abortedSandbox = (n: string): string => `ABORTED at [${n}] · sandbox stopped; nothing persists`;

export const burnedNothingToServe = (id: string): string => `session ${id} is burned; nothing to serve`;

export const codeChanged = (receiverId: string, pinned: string, now: string): string =>
  `${REFUSED_SERVER_SIDE}: code_hash of ${receiverId} changed since wrap (pinned ${pinned}, now ${now}). Nothing was signed.`;

export const warnRuntime = (method: string): string =>
  `WARN  ${method} — fails-without-deposit (runtime): a function-call key can never attach a deposit, so every call fails on-chain and still costs gas.`;
export const warnInconclusive = (method: string): string => `WARN  ${method} — inconclusive: the dry-run could not classify it; raw panic text below.`;

/**
 * The end of the cage card's VOTE row, from the receiver's get_policy (final review I1): `quorum 2-of-2` for the demo
 * DAO. Never a pack constant: src/packs/sputnik-v2.ts quorumNote builds it from a policy it read.
 */
export const quorumOf = (required: number, size: number): string => `quorum ${required}-of-${size}`;

/** EXPOSURE (R2 block 5). `methods` is already joined for display. */
export const exposureVote = (account: string, method: string, receiverId: string): string =>
  `The agent acts as ${account} for ${method} on ${receiverId} only: any vote on any proposal of this DAO until burn. It cannot transfer, change keys, propose, or reach another contract.`;
export const exposureOnAccount = (account: string, methods: string, receiverId: string): string =>
  `The agent acts as ${account} for ${methods} on ${receiverId} only, with any arguments, until burn. It cannot transfer, change keys, attach a deposit, or reach another contract.`;
export const EXPOSURE_SUBACCOUNT = "The agent controls only the session sub-account: what that account owns in the target, plus its gas.";

/** The command that records the classifier's dry-run fixtures: it logs to the console only, so the banner names it (C-T16b). */
export const CAPTURE_CLASSIFIER = "npm run capture:sandbox -- --classifier";

/**
 * First line of the R7 REPLAY output. `n` is the number of fixture files the lines rest on; `logs` names, per network
 * those files were captured on, the log of the run that captured them (`[network, path]`, in print order). One log
 * reads `capture log PATH`; several read `capture logs PATH (NETWORK), …`; none (no file names a network) adds nothing.
 * `dryRuns`: some of the files are the classifier's recorded dry-runs, which no log file holds, so the command that
 * records them is named after the logs.
 */
export const replayBanner = (n: number, logs: ReadonlyArray<readonly [network: string, path: string]> = [], dryRuns = false): string => {
  const named = logs.length === 0 ? "" : logs.length === 1 ? `; capture log ${logs[0][1]}` : `; capture logs ${logs.map(([network, path]) => `${path} (${network})`).join(", ")}`;
  return `REPLAY — offline: no RPC, no sandbox, no keys · demo/fixtures/ (${n} files, verbatim RPC responses${named}${dryRuns ? `; dry-runs: ${CAPTURE_CLASSIFIER}` : ""})`;
};
export const displayInvariant = (ok: number, total: number): string => `display invariant: raw block on screen equals fixture bytes (${ok}/${total})`;

/** Beat headers (DESIGN §5.3), keyed by phase; chain-check prints under the refusals beat. */
export const BEATS = {
  setup: "SETUP",
  wrap: "1/5 WRAP · one AddKey, scope fixed on chain",
  "in-scope": "2/5 IN SCOPE · the key votes; the quorum decides",
  refusals: "3/5 ASSUME THE INJECTION WORKS · 4 attempts via keyhole_attempt",
  inspect: "4/5 INSPECT · the cage card, read from chain",
  burn: "5/5 BURN · DeleteKey, then the same key again",
  smoke: "SMOKE · sandbox only · counter in sub-account mode",
  result: "RESULT",
} as const satisfies Record<Exclude<DemoPhase, "chain-check"> | "result", string>;
