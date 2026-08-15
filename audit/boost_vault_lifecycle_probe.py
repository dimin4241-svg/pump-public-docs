#!/usr/bin/env python3
import base64, json, time
import boost_runtime_scan as core
import init_boost_runtime_probe as p

VAULT="6Zb2NXg1vDQMDJZkQwo9uR5otMLPwC86R7DF8Yz45FiT"


def main():
    url=core.choose_rpc()
    sigrows=core.rpc_single(url,"getSignaturesForAddress",[VAULT,{"limit":100,"commitment":"finalized"}]) or []
    print("VAULT_HISTORY",json.dumps(sigrows,indent=2,sort_keys=True),flush=True)
    ok=[x["signature"] for x in sigrows if x.get("err") is None]
    calls=[("getTransaction",[sig,{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}]) for sig in ok]
    txs=core.rpc_batch(url,calls) if calls else []
    found_sig=None; found_tx=None; found=None
    decoded=[]
    for sig,tx in zip(ok,txs):
        t=p.target(tx)
        decoded.append({"signature":sig,"slot":(tx or {}).get("slot"),"block_time":(tx or {}).get("blockTime"),"is_init_boost":bool(t)})
        if t and not found_sig: found_sig=sig; found_tx=tx; found=t
    print("VAULT_TX_CLASSIFICATION",json.dumps(decoded,indent=2,sort_keys=True),flush=True)
    if not found_sig:
        out={"found_init":False,"vault":VAULT,"history":decoded}
        with open("boost_vault_lifecycle_probe_result.json","w") as f: json.dump(out,f,indent=2)
        print("NO_INIT_FOR_VAULT",flush=True); return 0
    print("INIT_BOOST_FOUND",json.dumps({"signature":found_sig,"slot":found_tx.get("slot"),"block_time":found_tx.get("blockTime"),**found},indent=2,sort_keys=True),flush=True)

    rawtx=core.rpc_single(url,"getTransaction",[found_sig,{"encoding":"base64","commitment":"finalized","maxSupportedTransactionVersion":0}])
    raw=bytearray(base64.b64decode(rawtx["transaction"][0]))
    _,key_count,key_off=p.static_key_layout(raw)
    creator_idx=found["creator_message_index"]
    creator_raw=core.b58encode(bytes(raw[key_off+32*creator_idx:key_off+32*(creator_idx+1)])) if creator_idx<key_count else None
    print("RAW_CREATOR",json.dumps({"creator_idx":creator_idx,"static_key_count":key_count,"decoded":creator_raw,"expected":found["creator"]}),flush=True)
    baseline=p.summarize(p.simulate(url,bytes(raw)))
    print("INIT_BASELINE_SIM",json.dumps(baseline,indent=2,sort_keys=True),flush=True)

    replacement=None; mutated_sim=None
    if creator_idx<key_count and creator_raw==found["creator"]:
        replacement=p.funded_replacement(url,{found["creator"],p.POOL,p.PROGRAM})
        mutated=bytearray(raw)
        mutated[key_off+32*creator_idx:key_off+32*(creator_idx+1)]=core.b58decode(replacement["pubkey"])
        mutated_sim=p.summarize(p.simulate(url,bytes(mutated)))
        print("INIT_MUTATED_CREATOR_SIM",json.dumps(mutated_sim,indent=2,sort_keys=True),flush=True)

    if baseline.get("pump_success") and baseline.get("err") is None and mutated_sim:
        if mutated_sim.get("pump_success") and mutated_sim.get("err") is None: verdict="ARBITRARY_INIT_CREATOR_ACCEPTED"
        elif mutated_sim.get("constraint_address"): verdict="INIT_CREATOR_REJECTED_CONSTRAINT_ADDRESS"
        else: verdict="INIT_CREATOR_REJECTED_OTHER"
    elif baseline.get("pump_success") and baseline.get("err") is None:
        verdict="INIT_BASELINE_REPLAYABLE_CREATOR_MUTATION_NOT_RUN"
    else:
        verdict="INCONCLUSIVE_BASELINE_STATE_CHANGED"
    out={"verdict":verdict,"vault":VAULT,"history":decoded,"init_signature":found_sig,"init_target":found,"baseline_simulation":baseline,"replacement":replacement,"mutated_creator_simulation":mutated_sim,"simulation_only":True,"broadcast_performed":False}
    print("FINAL_VERDICT",verdict,flush=True)
    with open("boost_vault_lifecycle_probe_result.json","w") as f: json.dump(out,f,indent=2,sort_keys=True)
    return 0

if __name__=="__main__": raise SystemExit(main())
