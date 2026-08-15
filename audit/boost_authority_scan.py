#!/usr/bin/env python3
import json
import time
import boost_runtime_scan as core

GLOBAL_CONFIG = "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw"
LIMIT = 1000


def main():
    url = core.choose_rpc()
    current = core.decode_current_boost_authority(url, GLOBAL_CONFIG)
    print("CURRENT_GLOBAL_CONFIG", json.dumps(current, indent=2, sort_keys=True), flush=True)
    authority = current.get("boost_authority")
    if not authority:
        raise SystemExit("Could not decode current boost_authority")

    sigs = core.rpc_single(url, "getSignaturesForAddress", [authority, {
        "limit": LIMIT,
        "commitment": "finalized",
    }]) or []
    successful = [x["signature"] for x in sigs if x.get("err") is None]
    print(f"AUTHORITY_HISTORY authority={authority} signatures={len(sigs)} successful={len(successful)}", flush=True)

    for start in range(0, len(successful), core.BATCH):
        chunk = successful[start:start + core.BATCH]
        calls = [("getTransaction", [sig, {
            "encoding": "json",
            "commitment": "finalized",
            "maxSupportedTransactionVersion": 0,
        }]) for sig in chunk]
        try:
            txs = core.rpc_batch(url, calls)
        except Exception as e:
            print(f"BATCH_ERROR {e}; falling back to individual requests", flush=True)
            txs = []
            for sig in chunk:
                try:
                    txs.append(core.rpc_single(url, "getTransaction", [sig, {
                        "encoding": "json",
                        "commitment": "finalized",
                        "maxSupportedTransactionVersion": 0,
                    }]))
                except Exception as ie:
                    print(f"TX_ERROR {sig}: {ie}", flush=True)
                    txs.append(None)
                time.sleep(0.08)
        for sig, tx in zip(chunk, txs):
            found = core.inspect_tx(sig, tx)
            if found:
                found["current_global_config"] = current
                found["authority_equals_current_boost_authority"] = (
                    found["authority"] == authority
                )
                found["search_basis"] = "current_boost_authority_history"
                print("BOOST_BUY_AND_BURN_FOUND", flush=True)
                print(json.dumps(found, indent=2, sort_keys=True), flush=True)
                with open("boost_authority_scan_result.json", "w") as f:
                    json.dump(found, f, indent=2, sort_keys=True)
                return 0
        print(f"AUTHORITY_SCAN_PROGRESS checked={min(start + core.BATCH, len(successful))}", flush=True)
        time.sleep(0.15)

    result = {
        "found": False,
        "search_basis": "current_boost_authority_history",
        "global_config": GLOBAL_CONFIG,
        "current_global_config": current,
        "signatures": len(sigs),
        "successful": len(successful),
    }
    print("NO_MATCH_IN_AUTHORITY_HISTORY", json.dumps(result, sort_keys=True), flush=True)
    with open("boost_authority_scan_result.json", "w") as f:
        json.dump(result, f, indent=2, sort_keys=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
