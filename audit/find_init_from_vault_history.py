#!/usr/bin/env python3
import json, time
import boost_runtime_scan as core

VAULT = "6Zb2NXg1vDQMDJZkQwo9uR5otMLPwC86R7DF8Yz45FiT"
INIT = bytes.fromhex("8ce9215e845ac28f")
BOOST = core.TARGET


def fetch_tx(url, sig):
    for attempt in range(10):
        try:
            tx = core.rpc_single(url, "getTransaction", [sig, {
                "encoding":"json",
                "commitment":"finalized",
                "maxSupportedTransactionVersion":0,
            }])
            if tx is not None:
                return tx
        except Exception as e:
            print(f"GETTX_RETRY sig={sig} attempt={attempt+1} err={e}", flush=True)
        time.sleep(min(8.0, 1.2 + attempt * 0.8))
    return None


def classify(tx):
    keys = core.all_keys(tx)
    out=[]
    for layer,pos,ix in core.instruction_stream(tx):
        pidx=ix.get("programIdIndex")
        if pidx is None or pidx >= len(keys): continue
        program=keys[pidx]
        try: raw=core.b58decode(ix.get("data",""))
        except Exception: raw=b""
        item={"layer":layer,"position":pos,"program":program,"disc":raw[:8].hex(),"data_len":len(raw)}
        if program==core.PROGRAM:
            if raw[:8]==INIT: item["known"]="init_boost"
            elif raw[:8]==BOOST: item["known"]="boost_buy_and_burn"
            else: item["known"]="other_pumpswap"
        out.append(item)
    logs=(tx.get("meta") or {}).get("logMessages") or []
    names=[x for x in logs if "Instruction:" in x]
    return out,names


def main():
    url=core.choose_rpc()
    rows=core.rpc_single(url,"getSignaturesForAddress",[VAULT,{"limit":1000,"commitment":"finalized"}]) or []
    print(f"VAULT_SIGNATURE_COUNT {len(rows)}", flush=True)
    print("OLDEST_ROW", json.dumps(rows[-1] if rows else None, sort_keys=True), flush=True)
    print("NEWEST_ROW", json.dumps(rows[0] if rows else None, sort_keys=True), flush=True)
    results=[]; init_hits=[]
    # oldest -> newest so creation is inspected first
    for idx,row in enumerate(reversed(rows)):
        sig=row["signature"]
        tx=fetch_tx(url,sig)
        if tx is None:
            rec={"history_index_oldest_first":idx,"signature":sig,"slot":row.get("slot"),"fetch":None}
            results.append(rec); print("TX_UNAVAILABLE", json.dumps(rec,sort_keys=True), flush=True); continue
        ins,names=classify(tx)
        pump=[x for x in ins if x["program"]==core.PROGRAM]
        rec={
            "history_index_oldest_first":idx,"signature":sig,"slot":tx.get("slot"),"block_time":tx.get("blockTime"),
            "err":(tx.get("meta") or {}).get("err"),"pump_instructions":pump,"instruction_names":names,
        }
        results.append(rec)
        print("TX",json.dumps(rec,sort_keys=True),flush=True)
        if any(x.get("known")=="init_boost" for x in pump):
            init_hits.append(rec)
        time.sleep(0.75)
    out={"vault":VAULT,"rows":len(rows),"init_hits":init_hits,"history":results}
    print("INIT_HIT_COUNT",len(init_hits),flush=True)
    if init_hits: print("FIRST_INIT",json.dumps(init_hits[0],indent=2,sort_keys=True),flush=True)
    with open("find_init_from_vault_history_result.json","w") as f: json.dump(out,f,indent=2,sort_keys=True)

if __name__=="__main__": main()
