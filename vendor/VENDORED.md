> **Copied from `project-b/spike/VENDORED.md` on 2026-11-06; the record below is unchanged.** In this repo the files live in `vendor/` (repo root), and `npm run verify-vendored` (from the repo root) writes its read-only testnet responses to `demo/fixtures/sandbox/testnet-readonly/`, where the original run's `fixtures/testnet-readonly/` was copied.

# VENDORED — third-party binaries in `spike/vendor/`

Checked 2026-11-06. Re-check everything below with one read-only command (view calls only, no keys, no transactions):

```bash
npm run verify-vendored      # writes fixtures/testnet-readonly/*.json + analysis.json, exits 0 only if all MATCH
```

## 1. `vendor/sputnikdao2-v2.0.0.wasm` — the vendored Sputnik v2 DAO (used by `npm run spike`)

| Field | Value |
|---|---|
| Project | near-daos/sputnik-dao-contract, crate `sputnikdao2` — https://github.com/near-daos/sputnik-dao-contract |
| Source URL (pinned) | https://raw.githubusercontent.com/near-daos/sputnik-dao-contract/317ea4fb1e6eac8064ef29a78054b0586a3406c3/sputnikdao2/res/sputnikdao2.wasm |
| Commit | `317ea4fb1e6eac8064ef29a78054b0586a3406c3` (2021-06-21, "Fail proposals with incorrect policy (#21)"). This is the commit that introduced these exact bytes at `sputnikdao2/res/sputnikdao2.wasm`. The blob stayed unchanged until `19c9e23ca34b0f980a5cbe32df049aaf149633eb` (2021-11-12). The commit is reachable from `main` and is part of tag `3.0.0`'s history. |
| Git blob SHA-1 | `e4d72b044d5f8fc5d52e374760c83f5f77470f2e` |
| Crate version at that commit | `sputnikdao2` 2.0.0 (near-sdk 3.1.0); the contract's `version()` returns `"2.0.0"` |
| License | MIT, "Copyright (c) 2021 near-daos". The LICENSE file from the same commit is copied to `vendor/LICENSE-sputnik-dao-contract.txt` |
| Size | 469,804 bytes |
| sha256 | `084441471c11099d78e2eecda571dd4d8c29153282807edd415935c97355dd56` |
| NEAR code_hash (base58 of the sha256) | `ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq` |
| `act_proposal` signature | `act_proposal(id: u64, action: Action, memo: Option<String>)`, with no `proposal` kind argument |
| Exports (28) | act_proposal add_proposal bounty_claim bounty_done bounty_giveup delegate delegation_balance_of delegation_total_supply get_available_amount get_bounties get_bounty get_bounty_claims get_bounty_number_of_claims get_config get_last_bounty_id get_last_proposal_id get_policy get_proposal get_proposals get_staking_contract has_blob migrate new register_delegation remove_blob store_blob undelegate version |

### Why this binary and not a build of `main`
- `main` no longer commits binaries.
  - Commit `fe699d3` (2026-02-25, "Added Global Contracts support (#232)") deleted `sputnikdao2/res/*.wasm` and gitignored `res`. Reproducible builds had been enabled in March 2025 (#220).
  - `main` is crate 2.3.1, built with `cargo near build reproducible-wasm` in the docker image `sourcescan/cargo-near:0.19.0-rust-1.86.0`.
  - Tags `2.0.0` and `3.0.0` have no release assets.

  So the only official prebuilt binaries on GitHub are the historical `res/` blobs.
- This blob is **byte-identical to the DAO code that the PRD's testnet factory deploys** (§2). Vendoring it removes the mismatch risk for that factory entirely.

## 2. Testnet factory `sputnik-v2.testnet` (the one the PRD names) — **MATCH**

**Which views the factory exposes for its default code hash and version.** The current factory source (`sputnikdao-factory2/src/lib.rs` on `main`) has the views `get_dao_list`, `get_number_daos`, `get_daos(from_index, limit)`, `get_owner`, `get_default_code_hash`, `get_default_version`, `get_code(code_hash)` and `get_contracts_metadata`. The deployed `sputnik-v2.testnet` predates all of the version and metadata views:

| Check (read-only, final finality) | Result |
|---|---|
| `view_account` | code_hash `D7dxhAZvwPQ9aUfpXANGXQdWGy9pkQ4UKM4v2YGe7yVE`, 659,264 bytes |
| Exported methods of the deployed factory wasm | **only** `create`, `get_dao_list`, `new`, `on_create` |
| `get_default_code_hash`, `get_default_version`, `get_contracts_metadata`, `get_owner`, `get_number_daos` | `MethodResolveError(MethodNotFound)` (fixtures `testnet-readonly/A-factory-*.json`) |
| Where its DAO code lives | Embedded in the factory's own wasm (the original `include_bytes!` design). A wasm module starting at offset 142,134, 469,804 bytes long, is **byte-identical to `vendor/sputnikdao2-v2.0.0.wasm`** |
| DAOs it created (`get_dao_list`) | **78/78** have code_hash `ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq` (= vendored) |
| `version()` on `genesis.sputnik-v2.testnet` | `"2.0.0"` |

Verdict: the version the factory deploys **matches** the vendored wasm byte for byte. This factory has no view for a default code hash or version, so the match is established by content (the embedded module and the code hash of all 78 DAOs), not by a version string.

## 3. The other testnet factory `sputnikv2.testnet` (maintained, NOT named in the PRD) — different build, compatible

| Check | Result |
|---|---|
| `get_default_code_hash` | `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH` |
| `get_default_version` | `[3,31]` |
| `get_number_daos` | 5,429 (vs 78 on `sputnik-v2.testnet`) |
| `get_contracts_metadata` for the default | commit `7764926cfd3c47f62b5fcde231c251f3c3892887` (2024-08-24, "handle argument gas cost increasing"; crate `sputnikdao2` 2.3.1, near-sdk 4.0.0-pre.4). The contract's `version()` returns `"2.3.1"` |
| vs vendored | **different bytes** (539,647 vs 469,804). The `act_proposal` signature is the same 3-arg `(id, action, memo)`, as are `new(config, policy)` and the threshold math. `add_proposal` requires deposit **==** bond (v2.0.0: `>=`) |
| Note on version strings | Its metadata also lists a `[2,0]` build (commit `c2cf1553`, tag 2.0.0) with code_hash `8RMeZ5cXDap6TENxaJKtigRYf3n139iHmTRe8ZUNey6N`. That is **not** the vendored `ZGdM2T…` build, although both report `"2.0.0"`. Compare code hashes, never version strings. |

`vendor/compat-testnet-fetched/sputnikdao2-sputnikv2.testnet-3.31.wasm` holds that factory's default code. It was fetched read-only with `get_code({"code_hash":"AA4nA45v…"})`: 539,647 bytes, sha256 `880bae9a58c99ec1efe8b10cf834b3f0c0ebc7a05d71206f3c1202c4280952da`, code_hash `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`.
- **Provenance:** testnet factory storage, not GitHub. According to the factory's metadata it is built from the MIT-licensed repo above at `7764926c`; build reproducibility was not verified.
- **Use:** only for the compatibility run in `compat-sputnikv2-3.31/`, where the spike passes 27/27 unchanged.

## 4. Signature drift to watch (`main`, not deployed by either testnet factory as of 2026-11-06)
`main` (2.3.1 after PRs #217 and #221) declares `act_proposal(id, action, proposal: ProposalKind, memo)` with `#[deny_unknown_arguments]`:
- `proposal` is **required**;
- it must equal the stored kind, or the call fails with `ERR_WRONG_KIND`.

Both deployed builds accept the 4-arg form `{id, action, proposal, memo}` and ignore `proposal` (spike step f2, PASS on both). A target pack that always sends the stored kind therefore works on all three generations. Only the 3-arg/4-arg acceptance was tested; `main`'s `ERR_WRONG_KIND` comparison is untested here.

## 5. Not vendored, recorded for completeness
- `near-sandbox` binary: nearcore 2.14.0 (`neard (release 2.14.0) … commit bc4e9e8c…, protocol 88`).
  - Tarball: https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.14.0/near-sandbox.tar.gz (sha256 `a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691`).
  - Binary sha256: `797b9d7a9a23907048d68a427e86a55c94f1de232dbfb8b8a1eec09ecef3bf13`.
  - Cached in the gitignored `.sandbox-bin/`; npm `near-sandbox` downloads it automatically if it is missing.
- npm packages (exact pins in `package.json` / `package-lock.json`): near-api-js 7.4.0, near-sandbox 0.3.5, tsx 4.23.15, typescript 5.9.3, @types/node 22.20.5.
