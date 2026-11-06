/**
 * R2 `keyhole wrap CONTRACT --allow METHODS --gas AMOUNT [--on-account ACCOUNT]`: cage-card preview,
 * typed confirm, one AddKey transaction. The only command besides burn that reads a full-access key, and it
 * reads it only after `yes` (signWrap loads it); the preview loads none.
 *
 * Output (LAYOUT R2): header, three pre-flight lines, the PREVIEW card, WARN lines, EXPOSURE, TX PLAN, the
 * typed prompt; after `yes` the TxLine, the session line, the full session public key and NEXT.
 *
 * Ctrl-C while signWrap runs cannot recall the AddKey: the result prints whole, then exit 130. A second signal then
 * (src/cli/main.ts: a repeat within 100 ms is the same Ctrl-C) is the hard exit, which first writes stoppedSigning:
 * the session the AddKey may have made live and `keyhole burn ID`.
 */
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWANCE_STEP_YOCTO, networkOfAccount } from "../core/amounts.js";
import { buildCageCard } from "../core/cage.js";
import { sessionsDir } from "../core/config.js";
import { EXIT_TX_SENT, EnvironmentError, InputError } from "../core/errors.js";
import type { TargetPack, WrapOptions, WrapPlan } from "../core/types.js";
import { NO_OPERATOR_PROBLEM, planWrap, sessionFromPlan, signWrap } from "../core/wrap.js";
import { loadTargetPack } from "../packs/index.js";
import { renderCageCard } from "../render/cage-card.js";
import { EXPOSURE_SUBACCOUNT, MAINNET_OUT_OF_SCOPE, exposureOnAccount, exposureVote, warnInconclusive, warnRuntime } from "../render/strings.js";
import { glyphs, neutralizeControls, sgr, wrapWords } from "../render/style.js";
import { type TermCaps, termCaps } from "../render/term.js";
import { renderTxLineRows } from "../render/tx-line.js";
import { type Command, type Io, commandUsage, isAccountId, isMethodName, parseAmountYocto, parseOrThrow } from "./args.js";
import { sessionHint } from "./demo.js";

/** R2 block 7 after the LAYOUT reconciliation: the Terraform-style typed confirm. Only the exact word `yes` signs. */
export const confirmPrompt = (account: string): string => `Sign 1 transaction with ${account}'s full-access key? Only "yes" continues:`;
/** The hard exit's last words while signWrap runs: the AddKey may be on chain, under the plan's session id. */
export const stoppedSigning = (id: string): string => `STOPPED during the AddKey · ${sessionHint(id)}`;
/** Any other input, including Enter, `y` and `n`: exit 1. */
export const NOT_SIGNED = "not signed";
/** stdin is not a TTY: never block, exit 2. */
export const NOT_SIGNED_NON_TTY = "not signed — confirmation needs an interactive terminal; the scripted path is keyhole demo";

/**
 * C-T4b: the allowance is a whole number of 0.0001 NEAR steps (ALLOWANCE_STEP_YOCTO, the step core/wrap.ts enforces,
 * so the figure printed to 4 decimals is the one signed). The CLI says it in NEAR only, before planWrap is asked.
 */
const ALLOWANCE_STEP_PROBLEM = "allowance must be a whole multiple of 0.0001 NEAR: it is printed to 4 decimals and signed exactly";

/** Label column of the pre-flight, EXPOSURE and result lines (`receiver  `, `EXPOSURE  `). */
const LABEL = 10;
/** Hanging indent of a wrapped TX PLAN line. */
const TX_INDENT = 4;

/** The CONTRACT functions wrap calls. Tests replace any of them. */
export interface WrapDeps {
  planWrap: typeof planWrap;
  signWrap: typeof signWrap;
  buildCageCard: typeof buildCageCard;
  loadTargetPack: typeof loadTargetPack;
}

export function createWrapCommand(overrides: Partial<WrapDeps> = {}): Command {
  const d: WrapDeps = { planWrap, signWrap, buildCageCard, loadTargetPack, ...overrides };
  const cmd: Command = {
    name: "wrap",
    args: "CONTRACT --allow METHODS --gas AMOUNT [--on-account ACCOUNT]",
    keys: "operator full-access key, 1 tx",
    async run(argv, io) {
      const { values, positionals } = parseOrThrow(argv, {
        allow: { type: "string" },
        gas: { type: "string" },
        "on-account": { type: "string" },
        help: { type: "boolean", short: "h" },
      });
      if (values.help) {
        io.out(commandUsage(cmd));
        return 0;
      }
      // R2 block 2: one line per problem, exit 2, nothing signed.
      const problems: string[] = [];
      if (positionals.length !== 1) problems.push("wrap takes exactly one CONTRACT (the receiver account id)");
      else if (!isAccountId(positionals[0])) problems.push(`CONTRACT ${JSON.stringify(positionals[0])} is not a NEAR account id`);
      const allow = (values.allow ?? "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      if (allow.length === 0) problems.push("--allow METHODS is required: comma-separated method names, e.g. act_proposal");
      for (const m of allow) if (!isMethodName(m)) problems.push(`--allow: ${JSON.stringify(m)} is not a method name`);
      const allowance = values.gas === undefined ? undefined : parseAmountYocto(values.gas);
      if (allowance === undefined || allowance === 0n) problems.push("allowance must be explicit and non-zero (T9)");
      else if (allowance === null) problems.push(`--gas ${JSON.stringify(values.gas)} is not an amount: NEAR with up to 24 decimals, e.g. 0.05N`);
      else if (allowance % ALLOWANCE_STEP_YOCTO !== 0n) problems.push(`--gas ${values.gas}: ${ALLOWANCE_STEP_PROBLEM}`);
      const onAccount = values["on-account"];
      if (onAccount !== undefined && !isAccountId(onAccount)) problems.push(`--on-account ${JSON.stringify(onAccount)} is not a NEAR account id`);
      if (problems.length) throw new InputError(problems);

      // C-T1c: only a well-formed CONTRACT gets here, so the mainnet line never sits on top of another problem.
      const contract = positionals[0];
      const network = networkOfAccount(contract);
      if (network === null) throw new InputError([MAINNET_OUT_OF_SCOPE]);
      const env = io.env ?? process.env;
      const base = { contract, allow, allowanceYocto: String(allowance), network };
      let opts: WrapOptions;
      if (onAccount !== undefined) {
        opts = { ...base, onAccount };
      } else {
        const operatorId = env.KEYHOLE_OPERATOR;
        if (!operatorId) throw new InputError([NO_OPERATOR_PROBLEM]);
        opts = { ...base, operatorId };
      }

      const caps = termCaps(io.stdout ?? {}, env);
      // C-T18d: read the signal BEFORE the dry-run, which boots a near-sandbox for seconds. processIo installs its SIGINT
      // handler on first use, so a Ctrl-C (or SIGTERM) during the dry-run is the soft abort, and a second one is the hard
      // exit through the exit hooks, which stop that sandbox; it is never Node's default kill, which would leave it running.
      const signal = io.signal;
      const plan = await progress(io, caps, `dry-run  booting near-sandbox${glyphs(caps).ellipsis}`, () => d.planWrap(opts));
      if (signal?.aborted) {
        // The dry-run could not be cut short and has finished (the sandbox is stopped); nothing was read from a key or signed.
        io.out(NOT_SIGNED);
        return 130;
      }
      await printPreview(io, caps, d, plan);

      // R2 block 7: the typed confirm. A non-interactive stdin is never read.
      if (io.stdinIsTTY !== true || io.readLine === undefined) {
        io.out(NOT_SIGNED_NON_TTY);
        return 2;
      }
      // `signal` was read before the dry-run, so processIo's SIGINT handler is installed before the prompt waits too
      // (main.ts sigintSignal): read after readLine, a Ctrl-C at the prompt would get Node's default exit instead.
      const prompt = `${confirmPrompt(plan.signerId)} `;
      if (io.write) io.write(prompt);
      else io.out(prompt);
      const answer = await io.readLine();
      if (io.write && !caps.tty) io.out(""); // a captured stdout gets no echo of the Enter: end the prompt line here
      if (signal?.aborted) {
        io.out(NOT_SIGNED);
        return 130;
      }
      if (answer !== "yes") {
        io.out(NOT_SIGNED);
        return 1;
      }

      // R2 blocks 8-9. signWrap's errors reach main verbatim, except one that says a transaction was sent (C-T2j): its
      // line as it is, then the session to burn (its files are kept), exit 3. Nothing is sent again.
      let signed: Awaited<ReturnType<typeof signWrap>>;
      const id = plan.draft.id;
      io.lastWords?.(() => stoppedSigning(id));
      try {
        signed = await d.signWrap(plan, { env });
      } catch (e) {
        if (!(e instanceof EnvironmentError) || e.exitCode !== EXIT_TX_SENT) throw e;
        io.err(e.line());
        if (env.DEBUG && e.stack) io.err(e.stack);
        if (!e.line().includes(`keyhole burn ${id}`)) io.err(sessionHint(id));
        return e.exitCode;
      } finally {
        io.lastWords?.(undefined);
      }
      const { session, txHash } = signed;
      for (const row of renderTxLineRows(txHash, session.network, caps)) io.out(row);
      io.out(`session ${session.id} · live · ${homeRelative(join(sessionsDir(env), `${session.id}.json`))}`);
      io.out(`${label(caps, "key")}${session.publicKey} · function-call key on ${session.accountId}`);
      io.out("");
      io.out(sgr(caps, "bold", "NEXT"));
      io.out(`  keyhole serve ${session.id}`);
      io.out(`  attach: node ${join(repoRoot(), "bin", "keyhole.mjs")} serve ${session.id} (see examples/, optional)`);
      io.out(`  keyhole inspect ${session.id}`);
      io.out(`  keyhole burn ${session.id}`);
      // A Ctrl-C while signing cannot recall the transaction already sent: the result above is printed whole, then 130.
      return signal?.aborted ? 130 : 0;
    },
  };
  return cmd;
}

export const wrap: Command = createWrapCommand();

/** R2 blocks 1-6: everything the user reviews before the prompt. Reads no key. */
async function printPreview(io: Io, caps: TermCaps, d: WrapDeps, plan: WrapPlan): Promise<void> {
  const draft = plan.draft;
  const sub = draft.mode === "subaccount";
  const pack = await d.loadTargetPack(draft.packId).catch((): TargetPack | null => null);
  const source = pack ? ` (${pack.abiSource})` : "";
  io.out(`${sgr(caps, "bold", "KEYHOLE wrap")} · ${draft.network} · ${sub ? "sub-account" : "on-account"} · pack ${draft.packId}${source}`);

  // Pre-flight. C-T5b: the count is planWrap's tools, never the card's rows (which can be synthetic chain rows).
  const classified = plan.tools.filter((t) => t.kind === "call" && t.method !== null && t.classification !== undefined).length;
  io.out(`${label(caps, "receiver")}${draft.receiverId} · code_hash ${draft.codeHashPin} (view_account) — will be pinned`);
  io.out(`${label(caps, "signer")}${plan.signerId} full-access key (keychain) — signs this 1 tx; serve never sees it`);
  io.out(`${label(caps, "dry-run")}near-sandbox · ${classified} method${classified === 1 ? "" : "s"} classified · ${(plan.dryRunMs / 1000).toFixed(1)} s`);
  io.out("");

  const card = await d.buildCageCard(sessionFromPlan(plan), "preview");
  io.out(renderCageCard(card, "full", caps));

  // WARN lines: the string planWrap wrote, then the raw panic text it rests on.
  if (plan.warnings.length) io.out("");
  for (const warning of plan.warnings) {
    io.out(warning.startsWith("WARN") ? `${sgr(caps, "runtime", "WARN")}${warning.slice(4)}` : warning);
    const tool = plan.tools.find((t) => t.kind === "call" && t.method !== null && (warnRuntime(t.method) === warning || warnInconclusive(t.method) === warning));
    if (tool?.evidence) io.out(`      ${neutralizeControls(tool.evidence)}`);
  }

  io.out("");
  const methods = draft.methodNames.join(", ");
  const exposure = sub
    ? EXPOSURE_SUBACCOUNT
    : pack?.exposure?.label === "VOTE"
      ? exposureVote(draft.accountId, methods, draft.receiverId)
      : exposureOnAccount(draft.accountId, methods, draft.receiverId);
  const [first, ...rest] = wrapWords(exposure, caps.width, `${"EXPOSURE".padEnd(LABEL)}`, " ".repeat(LABEL));
  io.out(`${sgr(caps, "bold", "EXPOSURE")}${first.slice("EXPOSURE".length)}`);
  for (const line of rest) io.out(line);

  io.out("");
  io.out(sgr(caps, "bold", "TX PLAN"));
  const arrow = glyphs(caps).arrow;
  for (const action of plan.txActions) for (const line of wrapWords(action.split("→").join(arrow), caps.width, "", " ".repeat(TX_INDENT))) io.out(line);
  io.out("");
}

/** `receiver  `: a bold label padded to the label column. */
function label(caps: TermCaps, text: string): string {
  return sgr(caps, "bold", text) + " ".repeat(Math.max(1, LABEL - text.length));
}

/** A path under the home directory as `~/…`. */
function homeRelative(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** The repository root (bin/keyhole.mjs runs src/cli/index.ts through tsx, so this file sits at src/cli/). */
function repoRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

/** On a TTY, a progress line while `work` runs, erased afterwards (LAYOUT: progress lines only on a TTY). */
async function progress<T>(io: Io, caps: TermCaps, text: string, work: () => Promise<T>): Promise<T> {
  if (!caps.tty || !io.write) return work();
  io.write(text);
  try {
    return await work();
  } finally {
    io.write("\r\x1b[2K");
  }
}
