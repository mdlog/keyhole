# Keyhole demo transcript

- date: `2026-11-06T15:05:56.092Z`
- network: testnet
- mode: live
- RPC: `https://rpc.testnet.near.org`
- operator: `kh-op-021e.testnet`
- session public key: `ed25519:FnG3gzeGxFVGbSZeZre6pht1key6qWYNi1DPNdbhrTe3`
- run: `live-testnet-20261106T150556Z`

> rejected at validation — never in a block; the RPC response is the evidence

## Steps

| step | signer | result | tx |
|---|---|---|---|
| [01/14] DAO kh-2c19.sputnik-v2.testnet (via sputnik-v2.testnet) · council [seat, cosigner] · 2-of-2 | full access | PASS | [Ek1A...X9WT](https://testnet.nearblocks.io/txns/Ek1APr5joscLK3cRL9DPuesjGpvSLZ1cQPs9uRJEX9WT) · created 2026-11-06 |
| [02/14] cosigner adds proposal #0 (grant payout) and #1 (injected description) | cosigner | PASS | [9F3c...5kzX](https://testnet.nearblocks.io/txns/9F3ctuo8a6T1uGNrcp23dLhP4mvH22SY1tbTByEf5kzX)<br>[9713...nq6r](https://testnet.nearblocks.io/txns/97132WVdw8F9BtH84EzRZmhdUKHRnCVJG7uU6VxYnq6r) |
| [03/14] seat.kh-op-021e.testnet signs one AddKey: act_proposal only · gas allowance 0.0500 NEAR | full access | PASS | [3t1x...zVWm](https://testnet.nearblocks.io/txns/3t1xgoYTxaiddjUJCXmkQbqhPECm4UbstKYbMqBxzVWm) |
| [04/14] the session approves #0 (grant payout) | session | PASS: in scope, landed | [9kTG...5T2d](https://testnet.nearblocks.io/txns/9kTGibv726GGerm7Ebk316wFu1qC1sp8CFXXis8Y5T2d) |
| [05/14] the cosigner approves #0 with its own full-access key | cosigner | PASS | [GfzC...tw2Y](https://testnet.nearblocks.io/txns/GfzC2xPK7BNGnGVT7dwWwc4jJZ6LvCKzjq68GzWVtw2Y) |
| [06/14] the session approves #1 (the injected proposal) | session | PASS: in scope, landed | [2qPW...qEVx](https://testnet.nearblocks.io/txns/2qPWeYkeQ6zdhh455gpr2hZx39byKHwbCXzMXphiqEVx) |
| [07/14] open a payout proposal | session | PASS: refused by protocol (MethodNameMismatch) | never in a block |
| [08/14] send NEAR | session | PASS: refused by protocol (RequiresFullAccess) | never in a block |
| [09/14] vote in another DAO | session | PASS: refused by protocol (ReceiverMismatch) | never in a block |
| [10/14] attach the bond | session | PASS: refused by protocol (DepositWithFunctionCall) | never in a block |
| [11/14] chain check: view_access_key before [07] and after [10] | none | PASS: key state unchanged by 4 refusals | — |
| [12/14] inspect ks-16e5: the cage card, read from chain | none | PASS | — |
| [13/14] seat.kh-op-021e.testnet signs DeleteKey of ks-16e5's key | full access | PASS | [5gYF...MjBS](https://testnet.nearblocks.io/txns/5gYFWwJ3qpLBaSUgK6jui9dUFPSoktwyfwo72KtrMjBS) |
| [14/14] vote with the deleted key | session | PASS: refused by protocol (AccessKeyNotFound) | never in a block |

## RPC bodies (never in a block)

### [07/14] open a payout proposal — MethodNameMismatch

```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":{"MethodNameMismatch":{"method_name":"add_proposal"}}}}}},"id":"keyhole-58"}
```

### [08/14] send NEAR — RequiresFullAccess

```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":"RequiresFullAccess"}}}},"id":"keyhole-60"}
```

### [09/14] vote in another DAO — ReceiverMismatch

```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":{"ReceiverMismatch":{"ak_receiver":"kh-2c19.sputnik-v2.testnet","tx_receiver":"genesis.sputnik-v2.testnet"}}}}}},"id":"keyhole-62"}
```

### [10/14] attach the bond — DepositWithFunctionCall

```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":"DepositWithFunctionCall"}}}},"id":"keyhole-64"}
```

### [14/14] vote with the deleted key — AccessKeyNotFound

```json
{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidAccessKeyError":{"AccessKeyNotFound":{"account_id":"seat.kh-op-021e.testnet","public_key":"ed25519:FnG3gzeGxFVGbSZeZre6pht1key6qWYNi1DPNdbhrTe3"}}}}}},"id":"keyhole-73"}
```

## Result

RESULT 14/14 PASS · 5 protocol refusals · 8 tx hashes · 3m23s · exit 0 · transcript demo/transcript.md
