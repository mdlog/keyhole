# Keyhole demo transcript

- date: `2026-11-06T11:56:02.305Z`
- network: sandbox
- mode: live
- RPC: `http://127.0.0.1:36951`
- operator: `sandbox`
- session public key: `ed25519:BvfnbXcu6LZGC1XrAjzpyVJF8wX7kwwu584dWcSfxXcE`
- run: `live-sandbox-20261106T115602Z`

> rejected at validation — never in a block; the RPC response is the evidence

## Steps

| step | signer | result | tx |
|---|---|---|---|
| [01/20] DAO dao.sandbox (vendored sputnikdao2 v2.0.0 + new) · council [seat, cosigner] · 2-of-2 | operator | PASS | `7Gm4Qt7hoJ4tDaWXMpvSrnwrjcU9uVchxE2m3guAeHgA` |
| [02/20] cosigner adds proposal #0 (grant payout) and #1 (injected description) | cosigner | PASS | `ECGf5bMQT53q3JTvoco2XSQAB4FgFwHXC7V24dsHoxLS`<br>`8xfziUxSwP627D5HR7kcizHPJefibaNr89ZFuWP6rtoF` |
| [03/20] seat.sandbox signs one AddKey: act_proposal only · gas allowance 0.0500 NEAR | operator | PASS | `2FZVNGRCAVybkeLQd4qB97uUtqHnwFFf3cLjhc1x3Eq1` |
| [04/20] the session approves #0 (grant payout) | session | PASS: in scope, landed | `2if3FBW23BzV5H8dwqEtUzob2g3pNA72GG2C7LSqyJGB` |
| [05/20] the cosigner approves #0 with its own full-access key | cosigner | PASS | `6sBp3gFkHodJXzK3KV4BrZdaHJ5gV2chmivtz3G6mTrm` |
| [06/20] the session approves #1 (the injected proposal) | session | PASS: in scope, landed | `5DzYWdrTTn21MdaHVaLGT4YH5WzQ5TF5C616q16Rurez` |
| [07/20] open a payout proposal | session | PASS: refused by protocol (MethodNameMismatch) | never in a block |
| [08/20] send NEAR | session | PASS: refused by protocol (RequiresFullAccess) | never in a block |
| [09/20] vote in another DAO | session | PASS: refused by protocol (ReceiverMismatch) | never in a block |
| [10/20] attach the bond | session | PASS: refused by protocol (DepositWithFunctionCall) | never in a block |
| [11/20] chain check: view_access_key before [07] and after [10] | none | PASS: key state unchanged by 4 refusals | — |
| [12/20] inspect ks-f298: the cage card, read from chain | none | PASS | — |
| [13/20] seat.sandbox signs DeleteKey of ks-f298's key | operator | PASS | `8PAQ6K59uMo2HMLNdtCQDPkDcn3HHzQdo8cm2W7Q5PVF` |
| [14/20] vote with the deleted key | session | PASS: refused by protocol (AccessKeyNotFound) | never in a block |
| [15/20] sandbox deploys counter.sandbox and wraps it in a sub-account: increment, reset | operator | PASS | `HQVTi15145RXQCmSki6gdRad8boHCmCKvmZM9Uy6sC16`<br>`FJhj7y711A7SbLxSUSCu5xzqitdbZ3AMgiLW1WTRXUdk` |
| [16/20] the session (ks-b328.sandbox) calls increment | session | PASS: in scope, landed | `DcuYn5NF4eLKN8RLPDxoocyKYJSSHJSy8Mcpzq2ptY3m` |
| [17/20] the session (ks-b328.sandbox) calls reset with no deposit (it needs exactly 1 yocto) | session | PASS: runtime failure in a block, gas charged (contrast: the contract refused, not the protocol) | `BnLNQu14Y7BrEbQUuYKin6wQHPm1DY9bQkK256E6YCuV` |
| [18/20] call with a key whose allowance is below the prepaid gas | session | PASS: refused by protocol (NotEnoughAllowance) | never in a block |
| [19/20] ks-b328.sandbox signs DeleteKey + DeleteAccount (to sandbox) with the operator key | operator | PASS | `A2jRaPNEqDsJLEvG4WMPDUU2JX87hW4BRNSqKbudMkRX` |
| [20/20] call after the session sub-account is deleted | session | PASS: refused by protocol (SignerDoesNotExist) | never in a block |

## RPC bodies (never in a block)

### [07/20] open a payout proposal — MethodNameMismatch

```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":{"MethodNameMismatch":{"method_name":"add_proposal"}}}}}},"id":"keyhole-63"}
```

### [08/20] send NEAR — RequiresFullAccess

```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":"RequiresFullAccess"}}}},"id":"keyhole-65"}
```

### [09/20] vote in another DAO — ReceiverMismatch

```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":{"ReceiverMismatch":{"ak_receiver":"dao.sandbox","tx_receiver":"other-dao.sandbox"}}}}}},"id":"keyhole-67"}
```

### [10/20] attach the bond — DepositWithFunctionCall

```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":"DepositWithFunctionCall"}}}},"id":"keyhole-69"}
```

### [14/20] vote with the deleted key — AccessKeyNotFound

```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":{"AccessKeyNotFound":{"account_id":"seat.sandbox","public_key":"ed25519:BvfnbXcu6LZGC1XrAjzpyVJF8wX7kwwu584dWcSfxXcE"}}}}}},"id":"keyhole-78"}
```

### [18/20] call with a key whose allowance is below the prepaid gas — NotEnoughAllowance

```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":{"NotEnoughAllowance":{"account_id":"ks-b328.sandbox","allowance":"10000000000000000000000","cost":"30918942497360500000000","public_key":"ed25519:B5birpA4pQfbM63HT4bKD7648GmsTAwdenPKRpMzWBTT"}}}}}},"id":"keyhole-121"}
```

### [20/20] call after the session sub-account is deleted — SignerDoesNotExist

InvalidTxError: the account itself is gone, not an access-key error (sub-account mode)

```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"SignerDoesNotExist":{"signer_id":"ks-b328.sandbox"}}}}},"id":"keyhole-131"}
```

## Result

RESULT 20/20 PASS · 7 protocol refusals · 14 tx hashes · 24s · exit 0 · transcript demo/capture.sandbox.md

six of eight InvalidAccessKeyError variants; the two gas-key variants are out of scope
