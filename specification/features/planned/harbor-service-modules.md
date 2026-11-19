# Harbor service modules

The Harbor CLI uses the Node executable and existing market JSON contract. Harness
owns the incremental service module boundary and its checks.

| Unit | Contract and declared cases |
| --- | --- |
| Service eligibility | Estimate capacity inside the host limits. Cover relay on a small host, confidential capability, Qwen RAM requirements and a resource shortfall. |
| Demand ranking | Rank fresh, priced supply against eligible capacity. Cover expired demand, provider competition and opt-outs. |
| Market supervision | Run a single healthy selected process. Cover readiness, orderly switch, market failure, failed provider cooldown and shutdown. |
| Relay receipt | Bind the recipient signature to the canonical chain, delivery and price fields. Cover tampering, key mismatch and expiry. |
| Relay payment | Submit the matching record and transfer as one reviewed WharfKit transaction. Cover chain/payer mismatch and exact payment bindings. |

Use the existing CLI integration tests to verify the public entry points. Run the
same module checks on the checked-in Node build and verify the contract locally
with CDT and against Harbor testnet. The release package continues to use its
existing executable and compiled JavaScript.
