#!/usr/bin/env python3
import base64
import json
import time
import boost_runtime_scan as core
import init_boost_runtime_probe as p


def main():
    url = core.choose_rpc()
    sigs = core.rpc_single(url, "getSignaturesForAddress", [p.POOL, {
        "limit":1000,"before":p.BOOST_SIG,"commitment":"finalized"
    }]) or []
    successful=[x["signature"] for x in sigs if x.get("err") is None]
    print(f"POOL_HISTORY older_than_boost={len(sigs)} successful={len(successful)}",flush=True)
    found_sig=None; found_tx=None; found=None
    for start in range(0,len(successful),25):
        chunk=successful[start:start+25]
        calls=[("getTransaction",[sig,{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}]) for sig in chunk]
        try: txs=core.rpc_batch(url,calls)
        except Exception as e:
            print(f"BATCH_ERR {start}: {e}",flush=True); txs=[]
            for sig in chunk:
                try: txs.append(core.rpc_single(url,"getTransaction",[sig,{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}]))
                except Exception: txs.append(None)
        for sig,tx in zip(chunk,txs):
            t=p.target(tx)
            if t:
                found_sig=sig; found_tx=tx; found=t; break
        if found_sig: break
        time.sleep(0.12)
    if not found_sig:
        out={"found":False,"pool":p.POOL,"searched":len(successful)}
        print("NO_INIT_BOOST",json.dumps(out),flush=True)
        with open("init_boost_runtime_probe_fast_result.json","w") as f: json.dump(out,f,indent=2)
        return 0
    print("INIT_BOOST_FOUND",json.dumps({"signature":found_sig,"slot":found_tx.get("slot"),"block_time":found_tx.get("blockTime"),**found},indent=2,sort_keys=True),flush=True)

    raw_tx=core.rpc_single(url,"getTransaction",[found_sig,{"encoding":"base64","commitment":"finalized","maxSupportedTransactionVersion":0}])
    raw=bytearray(base64.b64decode(raw_tx["transaction"][0]))
    sig_count,key_count,key_off=p.static_key_layout(raw)
    creator_idx=found["creator_message_index"]
    if creator_idx>=key_count: raise RuntimeError(f"creator loaded index {creator_idx}")
    creator_from_raw=core.b58encode(bytes(raw[key_off+32*creator_idx:key_off+32*(creator_idx+1)]))
    if creator_from_raw!=found["creator"]: raise RuntimeError("creator raw mismatch")

    baseline=p.summarize(p.simulate(url,bytes(raw)))
    print("INIT_BASELINE_SIM",json.dumps(baseline,indent=2,sort_keys=True),flush=True)
    replacement=p.funded_replacement(url,{found["creator"],p.POOL,p.PROGRAM})
    mutated=bytearray(raw)
    mutated[key_off+32*creator_idx:key_off+32*(creator_idx+1)]=core.b58decode(replacement["pubkey"])
    mutated_sim=p.summarize(p.simulate(url,bytes(mutated)))
    print("INIT_MUTATED_CREATOR_SIM",json.dumps(mutated_sim,indent=2,sort_keys=True),flush=True)

    if baseline.get("pump_success") and baseline.get("err") is None:
        if mutated_sim.get("pump_success") and mutated_sim.get("err") is None:
            verdict="ARBITRARY_INIT_CREATOR_ACCEPTED"
        elif mutated_sim.get("constraint_address"):
            verdict="INIT_CREATOR_REJECTED_CONSTRAINT_ADDRESS"
        else:
            verdict="INIT_CREATOR_REJECTED_OTHER"
    else:
        verdict="INCONCLUSIVE_BASELINE_STATE_CHANGED"
    out={"verdict":verdict,"init_signature":found_sig,"init_target":found,"replacement":replacement,"baseline_simulation":baseline,"mutated_creator_simulation":mutated_sim,"simulation_only":True,"broadcast_performed":False}
    print("FINAL_VERDICT",verdict,flush=True)
    with open("init_boost_runtime_probe_fast_result.json","w") as f: json.dump(out,f,indent=2,sort_keys=True)
    return 0

if __name__=="__main__": raise SystemExit(main())
