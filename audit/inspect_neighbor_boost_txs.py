#!/usr/bin/env python3
import json
import boost_runtime_scan as core
SIGS=[
"36APNq3iduj5LQS2ugnChaPKcQVUJQBPJts8qHJm2HVYwChpdShVNdCGRzns32gCWz37EGYzNECaGEmHXPZ4ZVwq",
"2miN1VAguLkvXX71cUyVKWhppjRmnuf36kwKCFwoYL1uxLNZDvuXpF7JAcacTSt4gneG9ZachaXHekzQtABtjUGT",
"3mtycUdA7zdzp8ELwxupNiskjBUdxceeUH8qY3gTsW74HGXkUSjfk1ysHZNKM5aWrVhr8wyon1dDDxoa9yUqi1pP",
]

def main():
 url=core.choose_rpc(); out=[]
 for sig in SIGS:
  tx=core.rpc_single(url,"getTransaction",[sig,{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}])
  keys=core.all_keys(tx); ins=[]
  for layer,pos,ix in core.instruction_stream(tx):
   p=keys[ix["programIdIndex"]] if "programIdIndex" in ix and ix["programIdIndex"]<len(keys) else None
   try: raw=core.b58decode(ix.get("data",""))
   except Exception: raw=b""
   ins.append({"layer":layer,"position":pos,"program":p,"disc":raw[:8].hex(),"data_len":len(raw),"accounts":[keys[i] if i<len(keys) else None for i in ix.get("accounts",[])]})
  out.append({"signature":sig,"slot":tx.get("slot"),"block_time":tx.get("blockTime"),"err":tx.get("meta",{}).get("err"),"instructions":ins,"logs":tx.get("meta",{}).get("logMessages",[])})
 print(json.dumps(out,indent=2,sort_keys=True),flush=True)
 with open("inspect_neighbor_boost_txs_result.json","w") as f: json.dump(out,f,indent=2,sort_keys=True)
if __name__=="__main__": main()
