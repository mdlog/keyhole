**Keyhole** puts any NEAR contract's methods behind one function-call key, served to an MCP agent as tools. Why not near-mcp: near-mcp signs with whichever keystore key matches the account id ([TOOLS.md](https://cdn.jsdelivr.net/gh/nearai/near-mcp@main/TOOLS.md)), and its `import_account` tool takes a private key from the model ([README](https://github.com/nearai/near-mcp)). With Keyhole the agent holds one key that can call only the methods you allowed, and one `keyhole burn` deletes the key.

| Boundary | Enforced by | Check it with |
|---|---|---|
| method · action · receiver · deposit 0 · gas allowance | **PROTOCOL** — at transaction validation | `view_access_key`; the Verification section |
| the value the agent can move | NOT A KEY LIMIT — only what the session account owns in the target | target views |
| target code unchanged (`code_hash` pin) | KEYHOLE server-side — `serve`, before each pack call (`dao_vote`) | `keyhole inspect` |
| key lifetime | OPERATOR — `keyhole burn`; no protocol expiry | `AccessKeyNotFound` after burn |
| refused attempts | — nothing on-chain; the RPC response is the evidence | `demo/fixtures/` |
| how the agent votes | NOT A KEY LIMIT — the prompt; the DAO's quorum (2-of-2 in the demo DAO) is the control | proposal status |

Next to the NEAR docs Shade-Agent AI-DAO tutorial, which gives an agent its own account, Keyhole gives the member's seat a key that can only vote.\
NEARpedia (what NEAR looks like today, written for agents) is complementary. [near-hydra](https://github.com/nikshepsvn/near-hydra) mints agent keys; Keyhole binds MCP tools to the key's on-chain scope and makes that scope inspectable, testable and burnable.\
Live page: <https://mdlog.github.io/keyhole/>, which reads the judging session's key from testnet in the browser ([`docs/index.html`](docs/index.html)) · X post: `X_POST_URL` · 90 s video: `VIDEO_URL`

The cage card of the live judging session, as `npm run keyhole -- inspect ks-70aa` printed it on the operator's machine, which holds the session file. The key's scope and the target's code hash are read from chain, and the right-hand column names what enforces each row:

```text
KEYHOLE inspect · ks-70aa · testnet · on-account
+- keyhole · cage card · ks-70aa · testnet --------------------------------------------- [LIVE] -+
| RECEIVER   kh-2c19.sputnik-v2.testnet                                   PROTOCOL               |
| SIGNER     seat.kh-op-021e.testnet · on-account                         —                      |
| METHOD     act_proposal ........ callable                               PROTOCOL               |
|            add_proposal ........ not in allowlist                       PROTOCOL               |
| ACTIONS    one FunctionCall per tx; no Transfer, no AddKey              PROTOCOL               |
| DEPOSIT    0 only; methods that demand one fail at runtime              PROTOCOL               |
| GAS        #################### 0.0500 of 0.0500 NEAR left · gas only   PROTOCOL               |
| CODE HASH  ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq · match          KEYHOLE server-side    |
| VOTE       any proposal here, either way, until burn; quorum 2-of-2     NOT A KEY LIMIT        |
| EXPIRY     none in the protocol; ends at keyhole burn ks-70aa           OPERATOR               |
| KEY        ed25519:C4M3YfYSuVQf74MwUqVA2WdNmesZZ8X3ZYzrdy6tQ3Gj         —                      |
| VIEWS      get_proposals, get_policy: read-only, no key needed          —                      |
+---------------------------------- read from chain: view_access_key · 2026-11-06T16:27:10.663Z -+
```

## Try it

Each step is tagged with what it needs, and each "see" quotes the output of a real run. Commands run from the repo root as `npm run keyhole -- COMMAND`: the npm name `keyhole` belongs to an unrelated package, so this one is `private` and never published (`npm link` installs a local `keyhole` command instead).

1. `[offline]` Install the pinned dependencies, then replay the recorded evidence. Needs Node 22.22.2 or newer (`engines` in `package.json`):
   ```sh
   npm ci
   npm test
   ```
   `npm ci` is the only download. `npm test` starts no NEAR node and makes no network request: `test/setup.ts` replaces `fetch` in every test, so a test that reaches for the network fails. Run it plain; a `--reporter` flag replaces the reporter that prints the REPLAY block, and a file filter shortens it to `partial`.\
   See, in the `REPLAY` block just above vitest's summary:
   - seven lines that start `REPLAY [` and end `PASS: refused by protocol (NAME)`, the first `REPLAY [testnet] sputnik-v2.refuse-method` … `PASS: refused by protocol (MethodNameMismatch)`;
   - `display invariant: raw block on screen equals fixture bytes (7/7)`;
   - six classifier labels, ending in `6/6`;
   - `secret scan: 0 keys in repo` and `serve opens exactly 1 private key`.

   No test fails; exit 0, in about 30 s here.
2. `[network]` Run the scripted demo on a local near-sandbox:
   ```sh
   npm run keyhole -- demo --sandbox
   ```
   The first run downloads the near-sandbox binary (nearcore 2.14.0, about 90 MB) into `.sandbox-bin/`. The run boots a private node, creates the DAO from the vendored wasm, wraps a key, votes, makes four out-of-scope attempts, burns the key, then smoke-tests a counter contract in sub-account mode. It writes nothing under `demo/`, and the node stops when the run ends.\
   See: steps `[01/20]` to `[20/20]`, among them the lines `PASS: refused by protocol (MethodNameMismatch)`, `PASS: refused by protocol (RequiresFullAccess)`, `PASS: refused by protocol (ReceiverMismatch)`, `PASS: refused by protocol (DepositWithFunctionCall)` and `PASS: key state unchanged by 4 refusals`. Then `RESULT 20/20 PASS`, whose line ends with the wall time and `exit 0` (24 s in the committed run, [`demo/capture.sandbox.md`](demo/capture.sandbox.md)), and `six of eight InvalidAccessKeyError variants; the two gas-key variants are out of scope`. Exit 0.
3. `[network + funded testnet account in env]` Run the same demo on testnet:
   ```sh
   export KEYHOLE_OPERATOR=YOUR-ACCOUNT.testnet
   export KEYHOLE_DEMO_OUT=./my-run
   npm run keyhole -- demo --testnet
   ```
   `KEYHOLE_OPERATOR` names a testnet account whose full-access key is in near-cli-rs's legacy keychain, at `~/.near-credentials/testnet/YOUR-ACCOUNT.testnet.json` (`KEYHOLE_CREDENTIALS_DIR` moves the keychain). near-cli-rs writes it with `near account create-account sponsor-by-faucet-service … save-to-legacy-keychain`. The first run creates the seat, cosigner and grantee sub-accounts and the DAO through the `sputnik-v2.testnet` factory, which needs about 6.6 NEAR on the operator (the DAO's code storage is about 4.7 NEAR). Later runs reuse them; `npm run bootstrap:testnet -- --check` prints them and signs nothing. `KEYHOLE_DEMO_OUT` sends the run's transcript, run file and fixtures to `./my-run/demo`, so the committed `demo/transcript.md` and fixtures that this README's hashes point to stay as they are; without it, the run rewrites them.\
   The default RPC, `https://rpc.testnet.near.org`, can answer HTTP 429; `KEYHOLE_TESTNET_RPC=https://rpc.testnet.fastnear.com` points Keyhole at another testnet RPC. If the burn step does not finish, the note on step 14 prints `npm run keyhole -- burn ID`, the command that deletes the key that may still be on chain.\
   See (quoted from the committed run, [`demo/transcript.md`](demo/transcript.md), not re-run for this README): 14 steps, each landed transaction linked as `https://testnet.nearblocks.io/txns/HASH`, and five `PASS: refused by protocol (NAME)` lines, the last `PASS: refused by protocol (AccessKeyNotFound)` after the burn. Then `RESULT 14/14 PASS`, exit 0, in 3m23s.
4. `[optional]` Attach `keyhole serve` to an MCP client. First wrap a key. Here the seat's full-access key signs one AddKey after a typed `yes`; the DAO and the seat are the ones `bootstrap:testnet -- --check` prints:
   ```sh
   npm run keyhole -- wrap DAO --allow act_proposal \
     --gas 0.05N --on-account SEAT
   ```
   `wrap` accepts a DAO whose code a Sputnik pack pins. `sputnik-v2` pins the vendored v2.0.0 build: the DAO `demo --testnet` creates, or any DAO from the `sputnik-v2.testnet` factory (note the hyphen). `sputnik-v2-331` pins the default code that recent DAOs from the maintained `sputnikv2.testnet` factory (v3.31) run; the demo runs on `sputnik-v2`, and `sputnik-v2-331` is checked on near-sandbox (`npm run test:sandbox`). Older DAOs from that factory may run another build, such as v2.0 `8RMeZ5…` or v3.0 `783vth3F…`; one that no pack pins is refused with `no tools: no near-abi and no target pack`, then a `hint:` line with its `code_hash` and the one each pack pins (see Limits).\
   Then copy [`examples/claude-code.mcp.json`](examples/claude-code.mcp.json) into a project's `.mcp.json` (Claude Code), or merge [`examples/codex-config.toml`](examples/codex-config.toml) into `~/.codex/config.toml` (Codex), with the repo's absolute path and the session id that `wrap` printed filled in. The repo root deliberately has no `.mcp.json`. Delete the key afterwards with `npm run keyhole -- burn ID`.\
   See (from a `tools/list` handshake through the `examples/claude-code.mcp.json` command, not a first-hand `/mcp` screen): five tools, `keyhole_inspect`, `dao_list_proposals`, `dao_get_policy`, `dao_vote` and `keyhole_attempt`; Claude Code shows a server's tools under `/mcp`. On stderr, `serve` reports `1 private key loaded (session)` and `5 tools`.

## Verification — negative tests

Negative tests — the protocol is expected to reject the following. Rows 1–5 each break exactly one rule of the key that signs them; rows 6 and 7 follow a burn. Rows 1–4 and 6 come from the testnet run in [`demo/transcript.md`](demo/transcript.md): a key on `seat.kh-op-021e.testnet` scoped to receiver `kh-2c19.sputnik-v2.testnet`, method `act_proposal` and a 0.05 NEAR gas allowance. Rows 5 and 7 come from a near-sandbox run in [`demo/capture.sandbox.md`](demo/capture.sandbox.md): the session sub-account `ks-b328.sandbox`, scoped to `counter.sandbox`. Attempts that carry value attach 1 yoctoNEAR, so the allowance check cannot fire first. Each evidence file is the RPC response body, byte for byte, and `npm test` replays all seven (step 1).

| Attempt (signed with the session key) | Rule it breaks | Expected error | Evidence file |
|---|---|---|---|
| `add_proposal` on the DAO | method | `MethodNameMismatch` | [testnet.sputnik-v2.refuse-method.json](demo/fixtures/testnet.sputnik-v2.refuse-method.json) |
| Transfer of 1 yoctoNEAR to `attacker.kh-op-021e.testnet` | action | `RequiresFullAccess` | [testnet.sputnik-v2.refuse-action.json](demo/fixtures/testnet.sputnik-v2.refuse-action.json) |
| `act_proposal` on `genesis.sputnik-v2.testnet`, another DAO | receiver | `ReceiverMismatch` | [testnet.sputnik-v2.refuse-receiver.json](demo/fixtures/testnet.sputnik-v2.refuse-receiver.json) |
| `act_proposal` with 1 yoctoNEAR attached | deposit | `DepositWithFunctionCall` | [testnet.sputnik-v2.refuse-deposit.json](demo/fixtures/testnet.sputnik-v2.refuse-deposit.json) |
| `increment` from a second key whose 0.0100 NEAR allowance is below the up-front cost of 30 TGas (0.0309 NEAR) | allowance | `NotEnoughAllowance` | [sandbox.counter.refuse-allowance.json](demo/fixtures/sandbox.counter.refuse-allowance.json) |
| `act_proposal` after the key was deleted (burn, on-account mode) | none: the key is gone | `AccessKeyNotFound` | [testnet.sputnik-v2.after-burn.json](demo/fixtures/testnet.sputnik-v2.after-burn.json) |
| `increment` after the session sub-account was deleted (burn, sub-account mode) | none: the account is gone | `SignerDoesNotExist` (InvalidTxError) | [sandbox.counter.after-burn.json](demo/fixtures/sandbox.counter.after-burn.json) |

Session public key `ed25519:C4M3YfYSuVQf74MwUqVA2WdNmesZZ8X3ZYzrdy6tQ3Gj` on `seat.kh-op-021e.testnet` — anyone can verify the scope with `view_access_key`. This is the judging session `ks-70aa` ([`demo/judging-session.json`](demo/judging-session.json)), which stays un-burned through judging; the session burned in the transcript is a different one. One way to read it:

```sh
curl -s https://rpc.testnet.near.org \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{
    "request_type":"view_access_key","finality":"final",
    "account_id":"seat.kh-op-021e.testnet",
    "public_key":"ed25519:C4M3YfYSuVQf74MwUqVA2WdNmesZZ8X3ZYzrdy6tQ3Gj"}}'
```

On 2026-11-06 the reply held `"permission":{"FunctionCall":{"allowance":"50000000000000000000000","method_names":["act_proposal"],"receiver_id":"kh-2c19.sputnik-v2.testnet"}}`. Account page: <https://testnet.nearblocks.io/address/seat.kh-op-021e.testnet>

The refusals cover six of eight InvalidAccessKeyError variants; the two gas-key variants are out of scope ([nearcore `errors.rs`](https://github.com/near/nearcore/blob/master/core/primitives/src/errors.rs)). `SignerDoesNotExist` is an InvalidTxError outside that enum: after a sub-account burn the signer itself is gone.

`npm test` passes every evidence file through `parseRefusal`, the parser the live path uses, and checks that the bytes the demo prints equal the file. In the Day-1 spike, the `tx` status lookups of the refused transactions returned `UNKNOWN_TRANSACTION`: no block holds them.

## Evidence

- [`demo/transcript.md`](demo/transcript.md): the testnet run of `npm run keyhole -- demo --testnet` on 2026-11-06, `RESULT 14/14 PASS · 5 protocol refusals · 8 tx hashes · 3m23s · exit 0`. It holds the five refusal bodies verbatim and links each landed transaction, among them:
  - the DAO creation, [`Ek1APr5joscLK3cRL9DPuesjGpvSLZ1cQPs9uRJEX9WT`](https://testnet.nearblocks.io/txns/Ek1APr5joscLK3cRL9DPuesjGpvSLZ1cQPs9uRJEX9WT);
  - the session key's vote, [`9kTGibv726GGerm7Ebk316wFu1qC1sp8CFXXis8Y5T2d`](https://testnet.nearblocks.io/txns/9kTGibv726GGerm7Ebk316wFu1qC1sp8CFXXis8Y5T2d);
  - the DeleteKey that burned the key, [`5gYFWwJ3qpLBaSUgK6jui9dUFPSoktwyfwo72KtrMjBS`](https://testnet.nearblocks.io/txns/5gYFWwJ3qpLBaSUgK6jui9dUFPSoktwyfwo72KtrMjBS).
- [`demo/run.testnet.json`](demo/run.testnet.json): the same run as data.
- [`demo/fixtures/`](demo/fixtures/): flat `NETWORK.PACK.TEST.json` files, each an RPC response body byte for byte: the refusals, the classifier's recorded dry-runs and the counter's ABI view (`npm run capture:sandbox`). [`manifest.json`](demo/fixtures/manifest.json) lists the seven refusals `npm test` replays.
- [`demo/capture.sandbox.md`](demo/capture.sandbox.md): a near-sandbox run of the demo, `RESULT 20/20 PASS · 7 protocol refusals · 14 tx hashes · 24s · exit 0`, the source of the two sandbox refusals.
- [`demo/judging-session.json`](demo/judging-session.json): the public fields of the live judging session `ks-70aa`.
- [`demo/screeners/`](demo/screeners/): [`prompt.txt`](demo/screeners/prompt.txt), the neutral prompt for a clean-copy run of `claude -p`. See [`claude-p.log`](demo/screeners/claude-p.log) for that run (Claude Code 2.1.322, 2026-11-11, from a copy with no `node_modules`): steps 1 and 2 of "Try it" (`npm ci`, `npm test`, `npm run keyhole -- demo --sandbox`) all exit 0. The log's header holds the command and the copy method. No Codex run is included: `codex exec` was not run.
- [`demo/transcript.sandbox.md`](demo/transcript.sandbox.md) and [`demo/fixtures/sandbox/`](demo/fixtures/sandbox/): the Day-1 spike on near-sandbox 0.3.5 (nearcore 2.14.0, protocol 88), 27 PASS, 0 FAIL, exit 0; 93 raw RPC responses plus `index.json`, the request log with every signed transaction.
- [`spike/negative-control/`](spike/negative-control/): the same spike with `add_proposal` added to the key's methods. That attempt lands and the contract panics (`ERR_MIN_BOND`): 22 PASS, 5 FAIL, exit 1. The harness fails when it should.
- [`spike/compat-sputnikv2-3.31/`](spike/compat-sputnikv2-3.31/): the spike against the DAO code that the maintained `sputnikv2.testnet` factory deploys (version 3.31): 27 PASS, 0 FAIL.
- [`spike/SPIKE_REPORT.md`](spike/SPIKE_REPORT.md): what the spike measured, and its gotchas.
- The 90 s video: `VIDEO_URL`.

## How it works

The privilege split:
- `wrap` and `burn` read one operator full-access key, `~/.near-credentials/NETWORK/ACCOUNT.json` in near-cli-rs's legacy keychain, for one transaction each.
- `serve` loads one private key, the session's function-call key. It comes from the keychain file `wrap` wrote, `~/.near-credentials/NETWORK/ACCOUNT/ed25519_PUBKEY.json` (mode 0600), or from `KEYHOLE_SESSION_KEY` when that is set, which then takes precedence. `serve` loads no full-access key.
- `inspect` loads no key.
- The RPC node validates every transaction before anything reaches a block.

`KEYHOLE_CREDENTIALS_DIR` moves the keychain. `KEYHOLE_HOME` (default `~/.keyhole`) holds session metadata, `sessions/ID.json`, and never a key.

Before `wrap` signs, it dry-runs each method on a near-sandbox copy of the target, built from the pack's pinned wasm, and labels it `callable`, `fails-without-deposit (runtime)`, `not in allowlist` or `inconclusive`; the cage card shows these labels. `serve` re-reads the target's `code_hash` before each `dao_vote` and refuses server-side, signing nothing, if it changed since wrap.

The validator's check order, verified against nearcore master `runtime/runtime/src/verifier.rs` on 2026-11-05:
1. the signer exists;
2. the key exists;
3. nonce;
4. balance;
5. allowance (the total cost includes any attached deposit or transfer amount);
6. storage;
7. function-call permission: exactly one action, a FunctionCall, zero deposit, the receiver, the method name.

The rule order on screen (method · action · receiver · deposit · allowance) is only the order of presentation.

| Path | What it is |
|---|---|
| `src/core/` | RPC and signing, the attempt path and `parseRefusal`, keys, sessions, `wrap`, `burn` and the cage card's data |
| `src/classify/` | the differential dry-run classifier |
| `src/packs/` | the target packs: `sputnik-v2` and `sputnik-v2-331` (pack JSON, one per pinned DAO build) and `counter` (its embedded near-abi) |
| `src/render/` | the cage card, refusal block, rule strip and transcript, as plain strings |
| `src/demo/` | the demo driver, the artifact writers, the replay loader and the testnet setup |
| `src/cli/` | one file per command |
| `test/`, `test-sandbox/` | `npm test` (offline) and `npm run test:sandbox` (near-sandbox) |
| `contracts/counter/` | the smoke-test contract, in Rust (`npm run build:counter`) |
| `spike/`, `vendor/` | the Day-1 spike and the vendored DAO wasm |
| `scripts/` | the secret scan, the testnet bootstrap, the sandbox captures, the video staging and the hosted page's data (`npm run site:html`) |
| `docs/` | the hosted page (GitHub Pages, branch `main`, folder `/docs`): a live `view_access_key` inspector and the refusal ledger, built from `demo/` |

## Limits

- No value cap. The allowance pays for gas only; the agent can move whatever the session account owns inside the target, up to what the operator put there.
- Three target packs today: `sputnik-v2`, `sputnik-v2-331` and `counter`. `wrap` picks the pack by the receiver's `code_hash`, and refuses a contract that no pack pins with `no tools: no near-abi and no target pack` and a `hint:` line naming each pack's pinned `code_hash`. `sputnik-v2-331` pins the v3.31 build that recent DAOs from the maintained `sputnikv2.testnet` factory (version 3.31) run; only `sputnik-v2` ran on testnet, and `sputnik-v2-331` is checked on near-sandbox. The factory's older DAOs may run another build, such as v2.0 (`8RMeZ5…`) or v3.0 (`783vth3F…`); one that no pack pins is refused that way.
- The key limits the method, not the vote. The control is the DAO's quorum (2-of-2 in the demo DAO), which the cage card reads from the DAO's `get_policy`. Where the policy gives no single council quorum (another role can vote, or the council has per-kind policies), the card states none.
- No protocol expiry. Burning is an operator action: `keyhole burn`.
- The `code_hash` pin is Keyhole's check, in `serve`, before each pack call (`dao_vote`). `keyhole_attempt` does not check it, by design: its attempts must reach the chain so that the protocol does the refusing, and the key's on-chain scope still bounds them.
- The allowance is charged for the up-front gas purchase. In the spike, a vote attaching 30 TGas needed 0.030919 NEAR of allowance up front, and one attaching 100 TGas needed 0.100919 NEAR, more than a 0.05 NEAR key holds. Votes therefore attach 30 TGas, and `wrap` refuses an allowance below the cost of one call (0.031 NEAR at 30 TGas).
- A `callable` label is observed by dry-running the method from a council seat's full-access key on a sandbox copy of the target. A sub-account session (`ks-XXXX.OPERATOR`) is not itself a council member, so a real vote from it can still panic in the contract. The label over-states success, in the safe direction: it never hides a capability.
- The Sputnik packs find the voting group by the role name `council`. A DAO whose voting role has another name, or whose policy is TokenWeight, gets no proposal status line after a vote (an environment error). sputnikdao2 `main`'s `ERR_WRONG_KIND` path is untested (`main` is not the default code of either testnet factory); the stored kind is sent back verbatim, `msg: null` included. The kind echo goes through `JSON.parse`, so a u64 JSON number above 2^53 (`BountyDone.bounty_id`, Ratio thresholds inside a `ChangePolicy` kind) would lose precision; the demo never reaches one.
- Output is laid out for a 100-column terminal, and paths are never broken. The default `~/.keyhole` fits; a `KEYHOLE_HOME` path of about 69 characters or more can make a `demo` row wrap.
- Testnet and near-sandbox only. No mainnet, Chain Signatures, Intents or Trezu.

## Roadmap

- A target-pack registry, for contracts that embed no ABI.
- Upstreaming the key-scoped tool binding into near-mcp's successor.
- An operator-side daemon, self-hosted only. Never a hosted, multi-tenant service, which would hold operators' full-access keys.
- A proposal filter ("only the proposals I listed"), labelled server-side, because the protocol cannot enforce it.
- A NEP-611 gas-key adapter: the same FunctionCall scope with a different gas payer.
- Sublet: leasing a scoped key through Agent Market.
- Keytree: nested sessions.

## Disclosures

- Sibling project: **Verdict**, prediction markets resolved by a cross-contract view call on NEAR state (`VERDICT_REPO_URL`). It is a separate repo and product with no shared mechanism; the two share no code, accounts or DAO. A shared near-workspaces harness would be listed in both READMEs.
- AI use: the code, tests and docs were written with Claude Code.
- Vendored code: `vendor/sputnikdao2-v2.0.0.wasm` is Sputnik DAO `sputnikdao2` 2.0.0 from [near-daos/sputnik-dao-contract](https://github.com/near-daos/sputnik-dao-contract), commit `317ea4fb`. It is MIT-licensed, "Copyright (c) 2021 near-daos", with the license in [`vendor/LICENSE-sputnik-dao-contract.txt`](vendor/LICENSE-sputnik-dao-contract.txt), and byte-identical to the DAO code the `sputnik-v2.testnet` factory embeds. `vendor/compat-testnet-fetched/` holds the `sputnikv2.testnet` factory's default DAO code (version 3.31), fetched read-only for the compat run; it is also the `sputnik-v2-331` pack's pinned dry-run code. It has no licence file of its own: its licence basis is the factory's metadata, which names the same MIT-licensed repo at commit `7764926c`, and its build was not reproduced from that source. Provenance and checks: [`vendor/VENDORED.md`](vendor/VENDORED.md) (`npm run verify-vendored`).
- The counter contract (`contracts/counter/`, MIT) is written and built in this repo, with near-sdk 5.30.1 and cargo-near 0.22.0.
- Libraries: near-api-js 7.4.0, near-sandbox 0.3.5 (nearcore 2.14.0, binary downloaded on first use), the MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.2, for `serve`), tsx, TypeScript, vitest and @noble/curves (the secret scan). Exact pins are in `package.json` and `package-lock.json`.
- The team's own Mezodot MCP server code, from before the window, is not reused.
- No Keyhole code exists from before the hackathon window. The Day-1 spike dates from 2026-11-06.
- Private keys live only in near-cli-rs's legacy keychain (`~/.near-credentials`) or in process memory; never in this repo. Session files hold metadata only, and `npm run scan:secrets` finds 0 `ed25519:` private keys in the repo.
- License: MIT ([`LICENSE`](LICENSE)).
- Tracks: `security`, `open` and `social`. Track-hint tech: FUNCTION CALL KEYS and SPUTNIK DAO.
