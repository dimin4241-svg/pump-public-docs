#!/usr/bin/env python3
import base64
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request

PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
TARGET = bytes.fromhex("694406af000723a2")
IDL_NAMES = [
    "pool", "authority", "global_config", "base_mint", "quote_mint",
    "pool_base_token_account", "pool_quote_token_account", "boost_vault_authority",
    "boost_vault", "base_token_program", "quote_token_program", "event_authority", "program",
]
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
ALPHABET_INDEX = {c: i for i, c in enumerate(ALPHABET)}
RPCS = [x.strip() for x in os.getenv(
    "SOLANA_RPCS",
    "https://api.mainnet-beta.solana.com,https://rpc.ankr.com/solana"
).split(",") if x.strip()]
MAX_SIGNATURES = int(os.getenv("MAX_SIGNATURES", "6000"))
BATCH = int(os.getenv("TX_BATCH", "20"))


def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + ALPHABET_INDEX[c]
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    zeros = 0
    for c in s:
        if c == "1": zeros += 1
        else: break
    return b"\x00" * zeros + body


def b58encode(data):
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    zeros = 0
    for b in data:
        if b == 0: zeros += 1
        else: break
    return "1" * zeros + (out or ("" if zeros else "1"))


def http_json(url, payload, tries=7):
    raw = json.dumps(payload).encode()
    for attempt in range(tries):
        req = urllib.request.Request(url, data=raw, headers={
            "content-type": "application/json",
            "user-agent": "pump-boost-authorized-bounty-readonly/1.0",
        })
        try:
            with urllib.request.urlopen(req, timeout=35) as r:
                return json.loads(r.read().decode())
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            if attempt + 1 == tries:
                raise
            delay = min(12, 1.5 * (attempt + 1))
            print(f"RPC retry {attempt+1}/{tries} after {type(e).__name__}: {e}; sleep={delay}s", flush=True)
            time.sleep(delay)


def rpc_single(url, method, params):
    result = http_json(url, {"jsonrpc":"2.0","id":1,"method":method,"params":params})
    if "error" in result:
        raise RuntimeError(f"{method}: {result['error']}")
    return result.get("result")


def rpc_batch(url, calls):
    payload = [
        {"jsonrpc":"2.0","id":i+1,"method":method,"params":params}
        for i, (method, params) in enumerate(calls)
    ]
    resp = http_json(url, payload)
    if not isinstance(resp, list):
        raise RuntimeError(f"batch returned non-list: {resp}")
    byid = {x.get("id"): x for x in resp}
    out = []
    for i in range(1, len(calls)+1):
        x = byid.get(i, {})
        if x.get("error"):
            out.append(None)
        else:
            out.append(x.get("result"))
    return out


def choose_rpc():
    for url in RPCS:
        try:
            v = rpc_single(url, "getVersion", [])
            print(f"RPC_OK {url} {json.dumps(v, sort_keys=True)}", flush=True)
            return url
        except Exception as e:
            print(f"RPC_FAIL {url}: {e}", flush=True)
    raise SystemExit("No configured Solana RPC is reachable")


def all_keys(tx):
    msg = tx["transaction"]["message"]
    static = msg.get("accountKeys", [])
    loaded = (tx.get("meta") or {}).get("loadedAddresses") or {}
    return static + loaded.get("writable", []) + loaded.get("readonly", [])


def key_flags(tx, idx):
    msg = tx["transaction"]["message"]
    static = msg.get("accountKeys", [])
    h = msg.get("header", {})
    nreq = h.get("numRequiredSignatures", 0)
    nros = h.get("numReadonlySignedAccounts", 0)
    nrou = h.get("numReadonlyUnsignedAccounts", 0)
    if idx < len(static):
        signer = idx < nreq
        if signer:
            writable = idx < (nreq - nros)
        else:
            writable = idx < (len(static) - nrou)
        return signer, writable
    loaded = (tx.get("meta") or {}).get("loadedAddresses") or {}
    li = idx - len(static)
    if li < len(loaded.get("writable", [])):
        return False, True
    return False, False


def instruction_stream(tx):
    msg = tx["transaction"]["message"]
    for pos, ix in enumerate(msg.get("instructions", [])):
        yield "top", pos, ix
    for group in (tx.get("meta") or {}).get("innerInstructions") or []:
        for pos, ix in enumerate(group.get("instructions", [])):
            yield f"inner@{group.get('index')}", pos, ix


def inspect_tx(signature, tx):
    if not tx or not tx.get("meta") or tx["meta"].get("err") is not None:
        return None
    keys = all_keys(tx)
    for layer, pos, ix in instruction_stream(tx):
        if "programIdIndex" not in ix or "data" not in ix:
            continue
        pidx = ix["programIdIndex"]
        if pidx >= len(keys) or keys[pidx] != PROGRAM:
            continue
        try:
            raw = b58decode(ix["data"])
        except Exception:
            continue
        if raw[:8] != TARGET:
            continue
        accts = ix.get("accounts", [])
        if len(accts) < 3:
            continue
        mapped = []
        for j, ai in enumerate(accts):
            if ai >= len(keys):
                pub = None; signer = False; writable = False
            else:
                pub = keys[ai]; signer, writable = key_flags(tx, ai)
            mapped.append({
                "idl_index": j,
                "idl_name": IDL_NAMES[j] if j < len(IDL_NAMES) else f"remaining_{j-len(IDL_NAMES)}",
                "message_index": ai,
                "pubkey": pub,
                "signer": signer,
                "writable": writable,
            })
        args = {}
        if len(raw) >= 24:
            args["quote_amount_in"] = struct.unpack_from("<Q", raw, 8)[0]
            args["min_base_amount_burned"] = struct.unpack_from("<Q", raw, 16)[0]
        return {
            "signature": signature,
            "slot": tx.get("slot"),
            "block_time": tx.get("blockTime"),
            "instruction_layer": layer,
            "instruction_position": pos,
            "discriminator_hex": raw[:8].hex(),
            "args": args,
            "pool": mapped[0]["pubkey"],
            "authority": mapped[1]["pubkey"],
            "global_config": mapped[2]["pubkey"],
            "accounts": mapped,
            "log_messages": tx["meta"].get("logMessages", []),
        }
    return None


def decode_current_boost_authority(url, global_config):
    r = rpc_single(url, "getAccountInfo", [global_config, {"encoding":"base64","commitment":"finalized"}])
    if not r or not r.get("value"):
        return {"error":"global_config account unavailable"}
    value = r["value"]
    data = base64.b64decode(value["data"][0])
    # Current official IDL GlobalConfig is Borsh-packed. Including 8-byte Anchor discriminator,
    # boost_authority occupies bytes [907:939]. See audit notes in workflow output.
    if len(data) < 940:
        return {"error":f"unexpected GlobalConfig size {len(data)}"}
    expected_disc = bytes([149,8,156,202,160,252,176,217])
    return {
        "owner": value.get("owner"),
        "lamports": value.get("lamports"),
        "data_len": len(data),
        "discriminator_hex": data[:8].hex(),
        "discriminator_ok": data[:8] == expected_disc,
        "boost_authority": b58encode(data[907:939]),
        "boost_enabled": bool(data[939]),
    }


def main():
    url = choose_rpc()
    before = None
    scanned = 0
    page = 0
    while scanned < MAX_SIGNATURES:
        limit = min(1000, MAX_SIGNATURES - scanned)
        cfg = {"limit": limit, "commitment":"finalized"}
        if before:
            cfg["before"] = before
        sigs = rpc_single(url, "getSignaturesForAddress", [PROGRAM, cfg]) or []
        if not sigs:
            break
        page += 1
        successful = [x["signature"] for x in sigs if x.get("err") is None]
        print(f"PAGE {page}: signatures={len(sigs)} successful={len(successful)} scanned_before={scanned}", flush=True)
        for start in range(0, len(successful), BATCH):
            chunk = successful[start:start+BATCH]
            calls = [("getTransaction", [sig, {
                "encoding":"json",
                "commitment":"finalized",
                "maxSupportedTransactionVersion":0,
            }]) for sig in chunk]
            try:
                txs = rpc_batch(url, calls)
            except Exception as e:
                print(f"BATCH_ERROR start={start}: {e}; retrying individually", flush=True)
                txs = []
                for sig in chunk:
                    try:
                        txs.append(rpc_single(url, "getTransaction", [sig, {
                            "encoding":"json", "commitment":"finalized", "maxSupportedTransactionVersion":0,
                        }]))
                    except Exception as ie:
                        print(f"TX_ERROR {sig}: {ie}", flush=True)
                        txs.append(None)
                    time.sleep(0.08)
            for sig, tx in zip(chunk, txs):
                found = inspect_tx(sig, tx)
                if found:
                    current = decode_current_boost_authority(url, found["global_config"])
                    found["current_global_config"] = current
                    found["authority_equals_current_boost_authority"] = (
                        found["authority"] == current.get("boost_authority")
                    )
                    print("BOOST_BUY_AND_BURN_FOUND", flush=True)
                    print(json.dumps(found, indent=2, sort_keys=True), flush=True)
                    with open("boost_runtime_scan_result.json", "w") as f:
                        json.dump(found, f, indent=2, sort_keys=True)
                    return 0
            time.sleep(0.22)
        scanned += len(sigs)
        before = sigs[-1]["signature"]
        print(f"PROGRESS scanned={scanned} oldest_slot={sigs[-1].get('slot')} oldest_block_time={sigs[-1].get('blockTime')}", flush=True)
        if len(sigs) < limit:
            break
    result = {"found":False, "program":PROGRAM, "discriminator_hex":TARGET.hex(), "scanned":scanned}
    print("NO_MATCH_IN_WINDOW", json.dumps(result, sort_keys=True), flush=True)
    with open("boost_runtime_scan_result.json", "w") as f:
        json.dump(result, f, indent=2, sort_keys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
