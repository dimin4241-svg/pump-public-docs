#!/usr/bin/env python3
import json
import boost_runtime_scan as core

SIG="4j8NhV9a97RrZ1Fac6Eeyax3yFoaHwULxd1wy4tEo13QSEDhfLUuLSoEq7sGfxsrMsjgQtbiPPRdkgPrWZeLp5rq"
INIT=bytes.fromhex("8ce9215e845ac28f")
NAMES=["pool","global_config","creator","base_mint","quote_mint","pool_base_token_account","pool_quote_token_account","boost_vault_authority","boost_vault","quote_token_program","system_program","associated_token_program","event_authority","program"]

def main():
 url=core.choose_rpc()
 tx=core.rpc_single(url,"getTransaction",[SIG,{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}])
 keys=core.all_keys(tx)
 out=[]
 for layer,pos,ix in core.instruction_stream(tx):
  pidx=ix.get("programIdIndex")
  if pidx is None or pidx>=len(keys) or keys[pidx]!=core.PROGRAM: continue
  try: raw=core.b58decode(ix.get("data",""))
  except Exception: continue
  if raw[:8]!=INIT: continue
  mapped=[]
  for j,ai in enumerate(ix.get("accounts",[])):
   signer,writable=core.key_flags(tx,ai)
   mapped.append({"idl_index":j,"name":NAMES[j] if j<len(NAMES) else f"remaining_{j-len(NAMES)}","message_index":ai,"pubkey":keys[ai],"signer":signer,"writable":writable})
  out.append({"layer":layer,"position":pos,"accounts":mapped})
 result={"signature":SIG,"slot":tx.get("slot"),"block_time":tx.get("blockTime"),"init_hits":out,"top_level_fee_payer":tx["transaction"]["message"]["accountKeys"][0],"logs":tx.get("meta",{}).get("logMessages",[])}
 print(json.dumps(result,indent=2,sort_keys=True),flush=True)
 with open("inspect_init_boost_accounts_result.json","w") as f:json.dump(result,f,indent=2,sort_keys=True)
if __name__=="__main__":main()
