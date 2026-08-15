#!/usr/bin/env python3
import base64
import json
import time
import boost_runtime_scan as core

PROGRAM = core.PROGRAM
POOL = "GExgczEhUbdNr3V7txqvGrJPu6nt5mbgHXtWFnX8CXeF"
BOOST_SIG = "2miN1VAguLkvXX71cUyVKWhppjRmnuf36kwKCFwoYL1uxLNZDvuXpF7JAcacTSt4gneG9ZachaXHekzQtABtjUGT"
INIT_DISC = bytes.fromhex("8ce9215e845ac28f")
SYSTEM_PROGRAM = "11111111111111111111111111111111"
INIT_NAMES = [
    "pool","global_config","creator","base_mint","quote_mint",
    "pool_base_token_account","pool_quote_token_account","boost_vault_authority",
    "boost_vault","quote_token_program","system_program","associated_token_program",
    "event_authority","program"
]


def shortvec(buf, off):
    value = 0; shift = 0
    while True:
        b = buf[off]; off += 1
        value |= (b & 0x7f) << shift
        if not (b & 0x80): return value, off
        shift += 7


def static_key_layout(serialized):
    sig_count, off = shortvec(serialized, 0)
    off += sig_count * 64
    msg_start = off
    header = msg_start + 1 if serialized[msg_start] & 0x80 else msg_start
    key_count, key_off = shortvec(serialized, header + 3)
    return sig_count, key_count, key_off


def target(tx):
    if not tx or not tx.get("meta") or tx["meta"].get("err") is not None:
        return None
    keys = core.all_keys(tx)
    for layer, pos, ix in core.instruction_stream(tx):
        if "programIdIndex" not in ix or "data" not in ix:
            continue
        if ix["programIdIndex"] >= len(keys) or keys[ix["programIdIndex"]] != PROGRAM:
            continue
        try: raw = core.b58decode(ix["data"])
        except Exception: continue
        if raw[:8] != INIT_DISC: continue
        mapped = []
        for j, ai in enumerate(ix.get("accounts", [])):
            signer, writable = core.key_flags(tx, ai)
            mapped.append({
                "idl_index": j,
                "idl_name": INIT_NAMES[j] if j < len(INIT_NAMES) else f"remaining_{j-len(INIT_NAMES)}",
                "message_index": ai,
                "pubkey": keys[ai],
                "signer": signer,
                "writable": writable,
            })
        if len(mapped) < 9: continue
        return {
            "layer": layer, "position": pos, "accounts": mapped,
            "pool": mapped[0]["pubkey"], "global_config": mapped[1]["pubkey"],
            "creator": mapped[2]["pubkey"], "creator_message_index": mapped[2]["message_index"],
            "boost_vault": mapped[8]["pubkey"],
        }
    return None


def simulate(url, raw):
    return core.rpc_single(url, "simulateTransaction", [base64.b64encode(raw).decode(), {
        "encoding":"base64", "sigVerify":False, "replaceRecentBlockhash":True,
        "commitment":"processed"
    }])


def summarize(sim):
    v = (sim or {}).get("value") or {}
    logs = v.get("logs") or []
    s = "\n".join(logs)
    return {
        "err": v.get("err"), "units_consumed": v.get("unitsConsumed"),
        "saw_init_boost": "Instruction: InitBoost" in s,
        "pump_success": f"Program {PROGRAM} success" in s,
        "pump_failed": f"Program {PROGRAM} failed" in s,
        "constraint_address": "ConstraintAddress" in s or "A raw constraint was violated" in s,
        "anchor_error": "AnchorError" in s,
        "logs": logs,
    }


def funded_replacement(url, forbidden):
    # Use a recent unrelated PumpSwap fee payer that is a funded system account.
    sigs = core.rpc_single(url, "getSignaturesForAddress", [PROGRAM, {"limit":100,"commitment":"finalized"}]) or []
    ok = [x["signature"] for x in sigs if x.get("err") is None]
    for sig in ok:
        try:
            tx = core.rpc_single(url, "getTransaction", [sig, {"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}])
        except Exception:
            continue
        keys = ((tx or {}).get("transaction") or {}).get("message",{}).get("accountKeys",[])
        if not keys: continue
        p = keys[0]
        if p in forbidden: continue
        try: info = core.rpc_single(url, "getAccountInfo", [p,{"encoding":"base64","commitment":"finalized"}])
        except Exception: continue
        val = (info or {}).get("value")
        if val and val.get("owner") == SYSTEM_PROGRAM and int(val.get("lamports",0)) > 5_000_000:
            return {"pubkey":p,"lamports":val["lamports"],"source_signature":sig}
    raise RuntimeError("no funded replacement")


def main():
    url = core.choose_rpc()
    sigs = core.rpc_single(url, "getSignaturesForAddress", [POOL, {
        "limit":1000,"before":BOOST_SIG,"commitment":"finalized"
    }]) or []
    print(f"POOL_HISTORY older_than_boost={len(sigs)}", flush=True)
    found_sig = None; found_tx = None; found = None
    for x in sigs:
        if x.get("err") is not None: continue
        sig = x["signature"]
        try:
            tx = core.rpc_single(url, "getTransaction", [sig,{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}])
        except Exception as e:
            print(f"TX_ERR {sig}: {e}", flush=True); time.sleep(0.05); continue
        t = target(tx)
        if t:
            found_sig=sig; found_tx=tx; found=t
            print("INIT_BOOST_FOUND", json.dumps({"signature":sig,"slot":tx.get("slot"),"block_time":tx.get("blockTime"),**t},indent=2,sort_keys=True), flush=True)
            break
        time.sleep(0.04)
    if not found_sig:
        out={"found":False,"pool":POOL,"searched":len(sigs)}
        print("NO_INIT_BOOST", json.dumps(out), flush=True)
        with open("init_boost_runtime_probe_result.json","w") as f: json.dump(out,f,indent=2)
        return 0

    raw_tx = core.rpc_single(url, "getTransaction", [found_sig,{"encoding":"base64","commitment":"finalized","maxSupportedTransactionVersion":0}])
    raw = bytearray(base64.b64decode(raw_tx["transaction"][0]))
    sig_count,key_count,key_off = static_key_layout(raw)
    creator_idx = found["creator_message_index"]
    if creator_idx >= key_count:
        raise RuntimeError(f"creator is loaded address index {creator_idx}, not static")
    creator_raw = bytes(raw[key_off+32*creator_idx:key_off+32*(creator_idx+1)])
    creator_from_raw = core.b58encode(creator_raw)
    if creator_from_raw != found["creator"]:
        raise RuntimeError(f"raw creator mismatch {creator_from_raw} != {found['creator']}")

    baseline = summarize(simulate(url, bytes(raw)))
    print("INIT_BASELINE_SIM", json.dumps(baseline,indent=2,sort_keys=True), flush=True)

    replacement = funded_replacement(url, {found["creator"], POOL, PROGRAM})
    replacement_raw = core.b58decode(replacement["pubkey"])
    mutated = bytearray(raw)
    mutated[key_off+32*creator_idx:key_off+32*(creator_idx+1)] = replacement_raw
    mutated_sim = summarize(simulate(url, bytes(mutated)))
    print("INIT_MUTATED_CREATOR_SIM", json.dumps(mutated_sim,indent=2,sort_keys=True), flush=True)

    if baseline.get("pump_success") and baseline.get("err") is None:
        if mutated_sim.get("pump_success") and mutated_sim.get("err") is None:
            verdict="ARBITRARY_INIT_CREATOR_ACCEPTED"
        elif mutated_sim.get("constraint_address"):
            verdict="INIT_CREATOR_REJECTED_CONSTRAINT_ADDRESS"
        else:
            verdict="INIT_CREATOR_REJECTED_OTHER"
    else:
        verdict="INCONCLUSIVE_BASELINE_STATE_CHANGED"

    out={
        "verdict":verdict,"init_signature":found_sig,"init_target":found,
        "replacement":replacement,"baseline_simulation":baseline,
        "mutated_creator_simulation":mutated_sim,"simulation_only":True,"broadcast_performed":False
    }
    print("FINAL_VERDICT", verdict, flush=True)
    with open("init_boost_runtime_probe_result.json","w") as f: json.dump(out,f,indent=2,sort_keys=True)
    return 0

if __name__ == "__main__": raise SystemExit(main())
