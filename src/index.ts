/**
 * The DATA CONTRACT surface (LAYOUT_SPEC "## DATA CONTRACT"). These 16 names bind the build; a
 * renderer whose function is missing counts as a build error. test/contract.test.ts checks the list.
 * Below them: the rest of the surface locked in Task 1 (Global Constraints → "Interfaces locked in Task 1").
 *
 * All of them are built: unbuiltNames() is empty (the demo-ready gate), and test/contract.test.ts still calls any
 * function that registers a stub.
 */
export { loadSession } from "./core/session.js"; //                      #1  local
export { loadTargetPack } from "./packs/index.js"; //                    #2  local (+ RPC-live for near-abi packs)
export { planWrap, signWrap } from "./core/wrap.js"; //                  #3, #4  RPC-live
export { classifyTools } from "./classify/dry-run.js"; //                #5  RPC-live (near-sandbox)
export { labelMethod } from "./classify/label.js"; //                    #6  pure
export { viewScopedKey, viewCodeHash, callView } from "./core/rpc.js"; // #7, #8, #12  RPC-live
export { buildCageCard } from "./core/cage.js"; //                       #9  RPC-live
export { sendAttempt } from "./core/attempt.js"; //                      #10 RPC-live
export { parseRefusal } from "./core/refusal.js"; //                     #11 pure
export { proposalStatus } from "./packs/sputnik-v2.js"; //               #13 RPC-live
export { signBurn } from "./core/burn.js"; //                            #14 RPC-live
export { runDemo } from "./demo/driver.js"; //                           #15 RPC-live
export { loadDemoRunFixture } from "./demo/replay.js"; //                #16 fixture-replay

// src/core
export { ALLOWANCE_MARGIN, MIN_GAS_PRICE, NEAR, SUBACCOUNT_RESERVE, TGAS, formatNear, minAllowanceYocto, networkOfAccount, parentAccount } from "./core/amounts.js";
export { saveSession } from "./core/session.js";
export { NO_CODE_HASH, assertChain, viewAccount } from "./core/rpc.js";
export { type SentTx, mustSucceed, settle, signAndSend, successValue } from "./core/tx.js";
export { type SandboxHandle, startSandbox } from "./core/sandbox.js";
export { predictViolation } from "./core/attempt.js";
export {
  type KeyRef,
  credentialsDir,
  deleteSessionKey,
  fullAccessKeyLoadCount,
  loadFullAccessKey,
  readSessionKey,
  saveAccountKey,
  saveSessionKey,
} from "./core/credentials.js";
export { sessionFromPlan } from "./core/wrap.js";

// src/classify, src/packs
export type { ClassifyOptions } from "./classify/dry-run.js";
export { packForCodeHash } from "./packs/index.js";
export { actProposalArgs, requiredApprovals } from "./packs/sputnik-v2.js";
export { type PackHooks, packHooks } from "./packs/hooks.js";
export { addProposal, councilInitArgs, deployDaoSandbox } from "./packs/sputnik-setup.js";
export { readContractAbi, toolsFromAbi } from "./packs/near-abi.js";

// src/demo
export { writeRunArtifacts } from "./demo/artifacts.js";
export { type TestnetDemoState, ensureTestnetDemo, factoryCreateArgs } from "./demo/testnet-setup.js";

// src/render
export { type TermCaps, termCaps } from "./render/term.js";
export { renderTxLine } from "./render/tx-line.js";
export { renderRuleStrip } from "./render/rule-strip.js";
export { renderRawJsonBlock } from "./render/raw-json-block.js";
export { type StepStyle, renderRefusalBlock } from "./render/refusal-block.js";
export { type CageCardVariant, renderCageCard } from "./render/cage-card.js";
export { type StepPrinter, createStepPrinter } from "./render/demo-log.js";
export { renderTranscript } from "./render/transcript.js";

export type {
  Attempt,
  AttemptAction,
  AttemptInput,
  AttemptOutcome,
  CageCard,
  CageCardSource,
  Classification,
  ContractPanic,
  DemoPhase,
  DemoRun,
  DemoSigner,
  DemoStep,
  DryRunInput,
  Exposure,
  InvalidAccessKeyErrorName,
  JsonSchema,
  NegativeTest,
  Network,
  PackTool,
  Refusal,
  RefusalName,
  SandboxFixture,
  ScopedKey,
  Session,
  SessionMode,
  SessionStatus,
  TargetPack,
  ToolKind,
  ToolSchema,
  TxSuccess,
  Violation,
  WrapOptions,
  WrapPlan,
} from "./core/types.js";
export { INVALID_ACCESS_KEY_ERRORS } from "./core/types.js";
export { EnvironmentError, InputError, KeyholeError, NotImplementedError, UnknownSessionError, registerStub, unbuiltNames } from "./core/errors.js";
