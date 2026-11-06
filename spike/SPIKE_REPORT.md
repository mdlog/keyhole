> **Copied from `project-b/spike/` on 2026-11-06; the report below is unchanged.** Paths in this repo: run everything from the repo root (`npm install`, then `npm run spike`); `vendor/` and `vendor/VENDORED.md` are at the repo root; the original run's `fixtures/` is `demo/fixtures/sandbox/` and its `transcript.md` is `demo/transcript.sandbox.md`; `.sandbox-bin/` and `.sandbox-home/` are at the repo root (gitignored); a new run writes `spike/out/` (gitignored) unless `SPIKE_OUT` is set (resolved against `spike/`, so `SPIKE_OUT=negative-control` still targets `spike/negative-control/`). For the optional modes, use `npx tsx spike/spike.ts` from the repo root.

# Keyhole Real Spike — report

**Verdict:** PASS. **27/27 checks**, exit 0, **12.76 s** wall time. Run on 2026-11-06 in near-sandbox (nearcore 2.14.0, protocol 88 — the same protocol as testnet today).

A function-call (FC) key on `seat` that allows only `act_proposal` voted on a real Sputnik v2 DAO. The DAO runs code byte-identical to what the `sputnik-v2.testnet` factory deploys.

The NEAR protocol itself refused the out-of-scope actions:
- `MethodNameMismatch`, `RequiresFullAccess`, `ReceiverMismatch` and `DepositWithFunctionCall`;
- `AccessKeyNotFound` after the burn;
- `NotEnoughAllowance` with a 1-yocto key.

All six names were parsed from the raw RPC JSON.

**One PRD assumption is wrong; see Gotcha 1.** Since protocol 85, the allowance check buys attached gas at 10× the burn price. A 100 TGas vote therefore needs **0.1009 NEAR** of allowance up front and cannot be sent with the PRD's 0.05 NEAR key. The spike votes with 30 TGas.

## How to run
```bash
cd near/project-b/spike
npm ci                      # near-api-js 7.4.0, near-sandbox 0.3.5, tsx, typescript (~5 s)
npm run spike               # tsx spike.ts — sandbox only; exit 0 iff every check passes
npm run typecheck           # optional: tsc --noEmit (strict)
npm run verify-vendored     # optional, read-only testnet view calls: re-checks VENDORED.md (~80 s)
```

**Requirements:** Node ≥ 22.22.2 (tested on 22.23.1) and Linux x86_64 or macOS arm64.
- The sandbox binary (nearcore 2.14.0, ~35 MB download) goes into `.sandbox-bin/`. npm `near-sandbox` fetches it automatically. Under WARP with IPv6 blackholed this worked from an empty dir in 6.1 s, download included.
- If the download stalls, fetch it yourself:

  ```bash
  mkdir -p .sandbox-bin/near-sandbox-2.14.0 && curl -4 -sS https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.14.0/near-sandbox.tar.gz | tar -xz --strip-components=1 -C .sandbox-bin/near-sandbox-2.14.0
  ```

Optional modes, each using the same script:

| Command | What it proves | Result |
|---|---|---|
| `SPIKE_NEGATIVE_CONTROL=1 SPIKE_OUT=negative-control npx tsx spike.ts` | The harness fails when it should: the key is minted with `[act_proposal, add_proposal]` | **22 PASS, 5 FAIL, exit 1** (`negative-control/transcript.md`) |
| `SPIKE_DAO_WASM=vendor/compat-testnet-fetched/sputnikdao2-sputnikv2.testnet-3.31.wasm SPIKE_EXPECT_CODE_HASH=AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH SPIKE_EXPECT_SOURCE="default DAO code of the sputnikv2.testnet factory (get_default_version [3,31])" SPIKE_OUT=compat-sputnikv2-3.31 npx tsx spike.ts` | The same flow works on the maintained factory's default build | **27 PASS, 0 FAIL, exit 0**, 13.15 s (`compat-sputnikv2-3.31/transcript.md`) |

**Sandbox library: `near-sandbox` 0.3.5 (npm).** It installed cleanly as 114 packages in about 5 s. Its default nearcore 2.14.0 runs protocol 88 (testnet: 2.14.0-rc.5, protocol 88), and it boots in 0.58 s.

`near-workspaces` 5.0.0 was not used. It was last published in March 2025 and pins `near-api-js ^5.1.0` and `near-sandbox ^0.1.1`, so it would pull in a second near-api-js major. All transactions are built and signed with near-api-js 7.4.0 and sent as raw signed transactions through JSON-RPC `send_tx` (`wait_until: FINAL`).

## Results (from `transcript.md`; sandbox-local tx hashes, not on any explorer)
| Step | Result | Decisive line(s) |
|---|---|---|
| 0 boot | ok | `sandbox … neard 2.14.0 \| protocol 88 \| booted in 0.58 s`; block gas price 1e8 yocto/gas |
| a accounts | ok | `seat`, `cosigner`, `dao`, `attacker` (+ `grantee`, see Deviations) created as sub-accounts of the sandbox genesis account |
| b deploy + `new` | PASS ×2 | `on-chain code_hash ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq = deployed wasm = DAO code deployed by the sputnik-v2.testnet factory (version() = "2.0.0")`<br>`threshold = max(quorum 0, min(1*2/2+1, 2)) = 2 of 2 -> every proposal needs BOTH approvals (only voting role: council; no per-kind overrides)` |
| c proposals | PASS | `add_proposal #0` (Transfer 1 NEAR → grantee) and `#1` (Transfer 5 NEAR → attacker; the description carries the injected instruction), each with the 0.1 NEAR bond read from `get_policy`; the contract returned ids #0 and #1 |
| d FC key | PASS | `chain reports the key's scope: {"allowance":"50000000000000000000000","method_names":["act_proposal"],"receiver_id":"dao.sandbox"}` |
| e vote #0 | PASS ×4 | FC-key vote `tx 8bU9DAkEHc6PX4xErpeAA19tf1ZxKE1zzfLb98tJuD3D` → `#0 … status InProgress \| council approvals 1 of 2`<br>`allowance net consumption = tokens burnt (0.00026015 NEAR)`<br>cosigner `tx 39jC9wyEVpLRnNFb3akGwsEK6gVjjKFHHKVvtCxEb7Gu` → `status Approved \| council approvals 2 of 2`<br>`payout executed: grantee.sandbox 1.000000 -> 2.000000 NEAR (+1.000000 exactly)` |
| f wrong vote #1 | PASS | `tx 68rkUM5tHGME8wjeT9cP1PZei4LsZsfpHuRVjNUvmR9B` → `#1 Transfer 5.00 NEAR -> attacker.sandbox \| status InProgress \| council approvals 1 of 2`, then `NOTE: in scope — the key does not judge votes; the quorum does` |
| f2 extra | PASS | the 4-arg `act_proposal {id, action, proposal, memo}` is accepted (the unknown `proposal` arg is ignored); see VENDORED.md §4 |
| g1 `add_proposal`, 0 deposit | PASS | `PASS: refused by protocol (MethodNameMismatch)`. Raw: `error.data.TxExecutionError.InvalidTxError.InvalidAccessKeyError.MethodNameMismatch.method_name = "add_proposal"` |
| g2 Transfer 1 yocto → attacker | PASS | `PASS: refused by protocol (RequiresFullAccess)` |
| g3 `act_proposal` → `other-dao.sandbox` | PASS | `PASS: refused by protocol (ReceiverMismatch)` (`ak_receiver: dao.sandbox`, `tx_receiver: other-dao.sandbox`) |
| g4 `act_proposal` + 1 yocto | PASS | `PASS: refused by protocol (DepositWithFunctionCall)` |
| g2b extra: Transfer 1 yocto → dao | PASS | `RequiresFullAccess`, also at the key's own receiver |
| g never in a block | PASS ×6 | every refused hash → `tx` status `UNKNOWN_TRANSACTION`; `after 5 refused txs the key's nonce (51000003) and allowance (49218482625579400000000) are unchanged` |
| h inspect | PASS | `receiver_id dao.sandbox`, `method_names ["act_proposal"]`, `allowance 0.04921848 NEAR remaining of 0.050000 (used 0.00078151 NEAR by 3 votes)` |
| i burn | PASS ×2 | `DeleteKey` by seat's full-access key, then `PASS: refused by protocol (AccessKeyNotFound)` |
| j extra: 1-yocto key | PASS ×2 | `PASS: refused by protocol (NotEnoughAllowance)` (`allowance "1"`, `cost "30919159630831000000000"`); the key is cleaned up afterwards, and `seat.sandbox is left with only its own full-access key` |

All six plain-key `InvalidAccessKeyError` variants in PRD §6 are reproduced, each by a transaction that breaks exactly one rule.

The parser reads `error.data`. `error.cause` is only `{"name":"INVALID_TRANSACTION","info":{}}`. The script compares each parsed name with the expected one, and only the parsed name is printed.

**Negative control (`negative-control/`).** Here the same `add_proposal` attempt, with a key that also lists `add_proposal`:
- **landed in a block** (`final_execution_status: FINAL`);
- was rejected by the contract (`Smart contract panicked: … 'ERR_MIN_BOND'`);
- burnt 2.29 TGas = 0.000207 NEAR and consumed a nonce.

The run printed 5 FAIL lines and exited 1. This is the C3 contrast case: without `method_names`, the only protection left is a runtime check in the contract, and it costs gas.

## Wall time
| Run | Total | Sandbox boot | Flow | Raw RPC responses |
|---|---|---|---|---|
| main (`npm run spike`) | **12.76 s** | 0.58 s | 12.18 s | 93 (`fixtures/`) |
| compat (`sputnikv2.testnet` [3,31]) | 13.15 s | 0.58 s | 12.57 s | 93 |
| negative control | 13.66 s | 0.58 s | 13.08 s | 93 |

PRD §6 targets ≤ 5 min. Each transaction waits for `FINAL` (~0.5 s in the sandbox at ~8 blocks/s).

## Gas per vote vs the 0.05 NEAR allowance (measured)
| Call | Gas burnt | Tokens burnt | Allowance used (settled) |
|---|---|---|---|
| FC vote #0 (1 of 2) | 2.825 TGas | 0.00026015 NEAR | 0.00026015 NEAR |
| FC vote #1 (1 of 2) | 2.863 TGas | 0.00026394 NEAR | 0.00026394 NEAR |
| FC vote #2 (1 of 2, 4-arg form) | 2.797 TGas | 0.00025741 NEAR | 0.00025741 NEAR |
| cosigner vote #0 (2 of 2, executes payout + bond refund) | 4.232 TGas | 0.00035627 NEAR | (full-access key) |

Up-front allowance the protocol requires per `act_proposal`. These figures are the `cost` field of `NotEnoughAllowance`, so the protocol computed them:

| Attached gas | 5 TGas | 10 | 30 (spike) | 48 | 50 | 100 (PRD) |
|---|---|---|---|---|---|---|
| Up-front cost (NEAR) | 0.005919 | 0.010919 | **0.030919** | 0.048919 | 0.050919 ✗ | **0.100919 ✗** |

That is `cost = attached TGas × 0.001 + 0.000919` NEAR for this transaction shape.

**With a 0.05 NEAR allowance:**
- at most about **49 TGas** can be attached to one call;
- at 30 TGas, **1 vote can be in flight**;
- **≈ 73 sequential votes** fit before the remaining allowance drops below one vote's up-front cost. Each vote settles at ≤ 0.000264 NEAR, and the next needs 0.0309 NEAR of headroom.

A vote burns about 2.8 TGas, so 30 TGas is a 10× margin. The number of in-flight votes is set by the attached gas; the 0.05 NEAR figure itself is fine.

## Gotchas
1. **Gas is bought at `min_gas_purchase_price` (protocol ≥ 85, nearcore 2.13, NEP-642).**
   - **Mechanism:** attached gas is bought at `max(gas_price, 1e9 yocto/gas)` = 0.001 NEAR/TGas, which is 10× the 1e8 burn price. The FC-key allowance must cover that purchase at validation. After execution the unspent gas and the price difference are refunded to the allowance. The spike verified that net consumption equals tokens burnt exactly.
   - **PRD §7 is wrong** where it says "0.05 NEAR covers at least 3 plain votes at ≤100 TGas each (≈0.01 NEAR per vote at 10⁸ yocto/gas)". One 100 TGas vote needs 0.1009 NEAR up front and is refused with `NotEnoughAllowance`.
   - **Fix:** use per-tool gas budgets of ≤ 30 TGas per vote, and size the allowance as `max single-call up-front cost + N × settled cost`. `inspect` should show both the in-flight capacity and the votes left.
   - **Sources:** nearcore `docs/RuntimeSpec/Refunds.md`, CHANGELOG (NEP-642), `core/primitives/src/fees.rs::calculate_tx_cost`, and `core/parameters/res/runtime_configs/parameters.yaml` (`min_gas_purchase_price: 1_000_000_000`), all on master.
2. **Successive FC transactions must wait for the refund.** Until the previous vote's refund receipt lands (about 2 blocks after execution), the remaining allowance is about 0.019 NEAR, below one vote's 0.0309 NEAR up-front cost. The spike waits for the complete receipt tree before reading the allowance or sending again.
3. **Block hashes go stale quickly in the sandbox.** `transaction_validity_period` = 100 blocks, and the sandbox makes about 8 blocks/s, so a cached block hash expires in about 12 s. The spike takes a fresh hash from the same `view_access_key` call that supplies the nonce.
4. **Two testnet factories exist.**
   - `sputnik-v2.testnet` is the one the PRD names. It is legacy: 78 DAOs, the DAO wasm embedded in its own code, and only `create`, `get_dao_list`, `new` and `on_create` exported. It has **no** default-code-hash or version view.
   - `sputnikv2.testnet` is the maintained factory, with 5,429 DAOs and a default build `[3,31]`, commit `7764926c`.

   Both default builds pass the spike unchanged. Version strings are ambiguous (two different builds report "2.0.0"), so compare code hashes. Full details are in VENDORED.md.
5. **`act_proposal` signatures drift.** Both deployed builds take `(id, action, memo)` and ignore an extra `proposal` argument. Sputnik `main` 2.3.1 *requires* `proposal` (with `#[deny_unknown_arguments]` and `ERR_WRONG_KIND`). The target pack should always send `{id, action, proposal: <stored kind>, memo}`. That form passed on both deployed builds; it was not tested against `main`.
6. **A Transfer is refused regardless of receiver.** nearcore checks receiver, method and deposit only for FunctionCall actions. A Transfer is `RequiresFullAccess` whatever its receiver: g2b shows the same error at the key's own receiver.
7. **A refused transaction leaves no trace.** It consumes no nonce and no allowance, `tx` status returns `UNKNOWN_TRANSACTION`, and explorers show nothing. The verbatim RPC response is the only evidence, which is why `fixtures/` exists.
8. **The RPC error shape varies by variant.** Unit variants are strings (`"InvalidAccessKeyError": "RequiresFullAccess"`), and struct variants are one-key objects. `view_access_key` for a deleted key returns `result.error` (a string), not `error`.
9. **near-sandbox writes keys to `os.tmpdir()`.** That includes its genesis key file and validator keys. The spike sets `TMPDIR=spike/.sandbox-home`, which is gitignored; the home dir is deleted on teardown and only empty port `.lock` files remain.
10. **`npm audit` reports 1 critical and 1 moderate advisory.** Both come from `tar@7.5.13`, which `near-sandbox` 0.3.5 pins to unpack the sandbox binary tarball from NEAR's S3. npm's suggested fix is a downgrade to near-sandbox 0.0.6, which is not acceptable. Add an `overrides` pin for `tar` in the scaffold once a fixed version is confirmed.
11. **`rpc.testnet.near.org` rate-limits bursts.** 34 of 78 back-to-back `view_account` calls failed. `verify-vendored` uses FastNEAR for the loop, with 120 ms spacing and retries.

## Deviations from the brief
- **Extra account `grantee`** as the payout receiver. It sends no transactions, so "payout executed" is an exact +1.000000 NEAR balance delta; the balances of `seat` and `cosigner` move with gas.
- **FC votes attach 30 TGas, not 100.** The reason is Gotcha 1. The allowance stays at the PRD's 0.05 NEAR.
- **The vendored wasm is a historical committed binary.** It is the 2021 `res/` blob of `sputnikdao2` 2.0.0, not a fresh reproducible build of `main`. It is byte-identical to what the PRD's factory deploys, and `main` is not deployed by either testnet factory.
- **Additions beyond the spec:**
  - f2: the 4-arg signature check;
  - g2b: a Transfer to the key's own receiver;
  - a "never in a block" check and a nonce/allowance-unchanged check for every refusal;
  - j: the up-front cost table and cleanup of the second key;
  - the negative-control and compat modes;
  - `verify-vendored.ts`.
- **One compat file is not from GitHub.** `vendor/compat-testnet-fetched/` holds bytes read from testnet factory storage with a read-only `get_code` call. It is labelled as such and is used only for the compat run.
- **Every transaction uses `send_tx`** (`wait_until: FINAL`), never `broadcast_tx_commit`.

## Open risks
- **Testnet is untested.** It is the next step and needs a funded testnet account, which was out of scope (no faucet). The factory `create` path was not exercised. A factory-created v2.0.0 DAO must also fund about 4.7 NEAR of code storage (469,804 bytes), so budget the attached deposit.
- **Sputnik `main` 2.3.1 is untested** (no deployed instance and no prebuilt binary). If a testnet factory moves to it, `proposal` becomes mandatory, and the stored-kind equality check (`ERR_WRONG_KIND`) is unverified.
- **The PRD text needs correcting before MH1/MH4 are coded:** allowance sizing (§7, "≤100 TGas per vote"), the factory choice (consider `sputnikv2.testnet`), and the "check the factory's version" step, which does not exist on `sputnik-v2.testnet`.
- **The near-sandbox `tar` advisories** are dev-only and need an override in the scaffold.

## Files
| Path | What |
|---|---|
| `spike.ts` | the spike (Node 22 + TS via tsx, near-api-js 7.4.0, near-sandbox 0.3.5) |
| `verify-vendored.ts` | read-only testnet check of VENDORED.md |
| `VENDORED.md` | wasm sources, commits, licence, sha256 and factory comparison |
| `transcript.md` | full console output of the main run (written by the script) |
| `fixtures/NNN-<step>.json` | 93 raw JSON-RPC responses, verbatim. `fixtures/index.json` maps file → method, params (signed tx base64; the deploy tx is summarised) and latency |
| `fixtures/testnet-readonly/` | raw read-only testnet responses plus the derived `analysis.json` |
| `negative-control/`, `compat-sputnikv2-3.31/` | transcript and fixtures of the two optional runs |
| `vendor/sputnikdao2-v2.0.0.wasm`, `vendor/LICENSE-sputnik-dao-contract.txt` | vendored DAO + licence |
| `vendor/compat-testnet-fetched/sputnikdao2-sputnikv2.testnet-3.31.wasm` | compat-run wasm (fetched from testnet) |
| `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore` | project files. `.sandbox-home/`, `.sandbox-bin/` and `node_modules/` are gitignored |
