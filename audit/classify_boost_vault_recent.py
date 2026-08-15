#!/usr/bin/env python3
import json, time
import boost_runtime_scan as core

VAULT="6Zb2NXg1vDQMDJZkQwo9uR5otMLPwC86R7DF8Yz45FiT"
KNOWN={
 "694406af000723a2":"boost_buy_and_burn",
 "8ce9215e845ac28f":"init_boost",
}

def main():
    url=core.choose_rpc()
    rows=core.rpc_single(url,"getSignaturesForAddress",[VAULT,{"limit":20,"commitment":"finalized"}]) or []
    out=[]
    for row in rows:
        sig=row["signature"]
        try:
            tx=core.rpc_single(url,"getTransaction",[sig,{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}])
        except Exception as e:
            out.append({"signature":sig,"rpc_error":str(e)}); continue
        if not tx:
            out.append({"signature":sig,"tx":None}); continue
        keys=core.all_keys(tx); pump=[]
        for layer,pos,ix in core.instruction_stream(tx):
            if "programIdIndex" not in ix or ix["programIdIndex"]>=len(keys) or keys[ix["programIdIndex"]]!=core.PROGRAM: continue
            try: raw=core.b58decode(ix.get("data",""))
            except Exception: continue
            d=raw[:8].hex()
            pump.append({"layer":layer,"position":pos,"disc":d,"known":KNOWN.get(d),"data_len":len(raw),"account_count":len(ix.get("accounts",[]))})
        logs=(tx.get("meta") or {}).get("logMessages") or []
        interesting=[x for x in logs if "Instruction:" in x or core.PROGRAM in x or "associated" in x.lower() or "AccountNotInitialized" in x]
        out.append({"signature":sig,"slot":tx.get("slot"),"block_time":tx.get("blockTime"),"err":(tx.get("meta") or {}).get("err"),"pump_instructions":pump,"interesting_logs":interesting})
        time.sleep(.06)
    print(json.dumps(out,indent=2,sort_keys=True),flush=True)
    with open("classify_boost_vault_recent_result.json","w") as f: json.dump(out,f,indent=2,sort_keys=True)
if __name__=="__main__": main()
