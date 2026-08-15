#!/usr/bin/env python3
import base64, json, struct, time
from pathlib import Path
import boost_runtime_scan as core

VAULT="6Zb2NXg1vDQMDJZkQwo9uR5otMLPwC86R7DF8Yz45FiT"
POOL="GExgczEhUbdNr3V7txqvGrJPu6nt5mbgHXtWFnX8CXeF"
POOL_BASE="EicGBXGjABiPzHaKApYQ6RQyykW5ajNX2WY3mNfCtwKe"
POOL_QUOTE="52UD2WqtcznSoGNjKCcGxQ9KxpYbAD5HTCcr5iMJvUKh"
INIT_SIG="4j8NhV9a97RrZ1Fac6Eeyax3yFoaHwULxd1wy4tEo13QSEDhfLUuLSoEq7sGfxsrMsjgQtbiPPRdkgPrWZeLp5rq"
BOOST_DISC=bytes.fromhex("694406af000723a2")
B58=core.b58decode

idl=json.loads(Path("idl/pump_amm.json").read_text())
event_discs={bytes(e["discriminator"]):e["name"] for e in idl.get("events",[])}
types={t["name"]:t["type"] for t in idl.get("types",[])}

def dec_primitive(buf,off,t):
    if t=="u8": return buf[off],off+1
    if t=="bool": return bool(buf[off]),off+1
    if t=="u16": return struct.unpack_from("<H",buf,off)[0],off+2
    if t=="u32": return struct.unpack_from("<I",buf,off)[0],off+4
    if t=="u64": return struct.unpack_from("<Q",buf,off)[0],off+8
    if t=="i64": return struct.unpack_from("<q",buf,off)[0],off+8
    if t=="u128": return int.from_bytes(buf[off:off+16],"little",signed=False),off+16
    if t=="i128": return int.from_bytes(buf[off:off+16],"little",signed=True),off+16
    if t=="pubkey": return core.b58encode(buf[off:off+32]),off+32
    if t=="string":
        n=struct.unpack_from("<I",buf,off)[0];off+=4;return buf[off:off+n].decode(errors="replace"),off+n
    raise ValueError(f"unsupported primitive {t}")

def decode_type(buf,off,t):
    if isinstance(t,str): return dec_primitive(buf,off,t)
    if isinstance(t,dict):
        if "option" in t:
            present=buf[off];off+=1
            if not present:return None,off
            return decode_type(buf,off,t["option"])
        if "array" in t:
            subtype,n=t["array"]; arr=[]
            for _ in range(n):v,off=decode_type(buf,off,subtype);arr.append(v)
            return arr,off
        if "defined" in t:
            return decode_defined(buf,off,t["defined"])
    raise ValueError(f"unsupported type {t}")

def decode_defined(buf,off,name):
    d=types[name]
    if d["kind"]!="struct": raise ValueError(f"unsupported defined kind {d['kind']}")
    out={}
    for f in d["fields"]:
        # tuple fields are irrelevant for our target events
        if isinstance(f,str): raise ValueError(f"tuple field in {name}")
        out[f["name"]],off=decode_type(buf,off,f["type"])
    return out,off

def decode_event_blob(blob):
    # Anchor log event: [event_discriminator | borsh payload]
    for pos in range(0,min(32,max(0,len(blob)-7))):
        d=blob[pos:pos+8]
        name=event_discs.get(d)
        if not name: continue
        try:
            val,end=decode_defined(blob,pos+8,name)
            return {"name":name,"disc":d.hex(),"prefix_len":pos,"decoded":val,"decoded_end":end,"blob_len":len(blob)}
        except Exception as e:
            return {"name":name,"disc":d.hex(),"prefix_len":pos,"decode_error":str(e),"blob_len":len(blob)}
    return None

def extract_events(tx):
    out=[]
    logs=(tx.get("meta") or {}).get("logMessages") or []
    for i,line in enumerate(logs):
        if "Program data: " in line:
            s=line.split("Program data: ",1)[1].strip()
            try: blob=base64.b64decode(s)
            except Exception: continue
            ev=decode_event_blob(blob)
            if ev: ev.update({"source":"log","log_index":i});out.append(ev)
    keys=core.all_keys(tx)
    for layer,pos,ix in core.instruction_stream(tx):
        pi=ix.get("programIdIndex")
        if pi is None or pi>=len(keys) or keys[pi]!=core.PROGRAM: continue
        try: blob=B58(ix.get("data",""))
        except Exception: continue
        ev=decode_event_blob(blob)
        if ev: ev.update({"source":"instruction","layer":layer,"position":pos});out.append(ev)
    # de-dupe same event often visible in both representations
    unique=[];seen=set()
    for e in out:
        k=(e["name"],json.dumps(e.get("decoded"),sort_keys=True,default=str))
        if k not in seen: seen.add(k);unique.append(e)
    return unique

def token_amount(meta,account_index,which):
    arr=meta.get("preTokenBalances" if which=="pre" else "postTokenBalances") or []
    for x in arr:
        if x.get("accountIndex")==account_index:
            return int(x["uiTokenAmount"]["amount"])
    return None

def named_token_delta(tx,pubkey):
    keys=core.all_keys(tx);meta=tx.get("meta") or {}
    try:idx=keys.index(pubkey)
    except ValueError:return {"present":False}
    pre=token_amount(meta,idx,"pre");post=token_amount(meta,idx,"post")
    # closed/created token accounts may be absent on one side => treat absent token amount as zero
    delta=None
    if pre is not None or post is not None: delta=(post or 0)-(pre or 0)
    return {"present":True,"account_index":idx,"pre":pre,"post":post,"delta":delta}

def fetch_tx(url,sig):
    for a in range(8):
        try:
            t=core.rpc_single(url,"getTransaction",[sig,{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}])
            if t:return t
        except Exception as e: print(f"RETRY {sig} {a+1}: {e}",flush=True)
        time.sleep(0.8+a*0.6)
    return None

def boost_args(tx):
    keys=core.all_keys(tx)
    for layer,pos,ix in core.instruction_stream(tx):
        pi=ix.get("programIdIndex")
        if pi is None or pi>=len(keys) or keys[pi]!=core.PROGRAM:continue
        try: raw=B58(ix.get("data",""))
        except Exception:continue
        if raw[:8]==BOOST_DISC and len(raw)>=24:
            return {"layer":layer,"position":pos,"quote_amount_in":struct.unpack_from("<Q",raw,8)[0],"min_base_amount_burned":struct.unpack_from("<Q",raw,16)[0]}
    return None

def main():
    url=core.choose_rpc()
    rows=core.rpc_single(url,"getSignaturesForAddress",[VAULT,{"limit":1000,"commitment":"finalized"}]) or []
    rows=list(reversed(rows)) # chronological
    series=[]
    for n,row in enumerate(rows):
        tx=fetch_tx(url,row["signature"])
        if not tx:continue
        args=boost_args(tx)
        events=extract_events(tx)
        boost_events=[e for e in events if e["name"]=="BoostBuyAndBurnEvent"]
        init_events=[e for e in events if e["name"]=="InitBoostEvent"]
        rec={"n":n,"signature":row["signature"],"slot":tx.get("slot"),"block_time":tx.get("blockTime"),"args":args,"boost_events":boost_events,"init_events":init_events,
             "vault":named_token_delta(tx,VAULT),"pool_quote":named_token_delta(tx,POOL_QUOTE),"pool_base":named_token_delta(tx,POOL_BASE)}
        series.append(rec)
        print("REC",json.dumps(rec,sort_keys=True,default=str),flush=True)
        time.sleep(.3)
    burns=[r for r in series if r["args"]]
    evs=[(r,r["boost_events"][0]["decoded"]) for r in burns if r["boost_events"] and "decoded" in r["boost_events"][0]]
    summary={"vault":VAULT,"history_count":len(series),"burn_count":len(burns),"decoded_boost_event_count":len(evs),"decoded_init_event_count":sum(bool(r["init_events"]) for r in series)}
    if evs:
        names=list(evs[0][1].keys());summary["boost_event_fields"]=names
        for field in ["quote_amount_in_requested","quote_amount_in_used","base_amount_burned","virtual_quote_reserves","real_quote_reserves_after"]:
            vals=[e.get(field) for _,e in evs if isinstance(e.get(field),int)]
            if vals: summary[field]={"first":vals[0],"last":vals[-1],"sum":sum(vals),"min":min(vals),"max":max(vals)}
        checks=[]
        for r,e in evs:
            used=e.get("quote_amount_in_used")
            requested=e.get("quote_amount_in_requested")
            vault_delta=r["vault"].get("delta")
            poolq_delta=r["pool_quote"].get("delta")
            checks.append({"n":r["n"],"signature":r["signature"],"requested":requested,"used":used,"base_burned":e.get("base_amount_burned"),"virtual_quote_reserves":e.get("virtual_quote_reserves"),"vault_delta":vault_delta,"pool_quote_delta":poolq_delta,
                           "used_equals_negative_vault_delta": (used==-vault_delta) if used is not None and vault_delta is not None else None,
                           "used_equals_pool_quote_delta": (used==poolq_delta) if used is not None and poolq_delta is not None else None,
                           "requested_ge_used": (requested>=used) if requested is not None and used is not None else None})
        summary["checks"]=checks
        summary["all_used_match_vault_outflow"]=all(x["used_equals_negative_vault_delta"] is not False for x in checks)
        summary["all_used_match_pool_quote_inflow"]=all(x["used_equals_pool_quote_delta"] is not False for x in checks)
        summary["all_requested_ge_used"]=all(x["requested_ge_used"] is not False for x in checks)
        # consecutive virtual-reserve deltas
        vr=[e.get("virtual_quote_reserves") for _,e in evs]
        if all(isinstance(x,int) for x in vr): summary["virtual_reserve_deltas"]=[vr[i]-vr[i-1] for i in range(1,len(vr))]
    print("SUMMARY",json.dumps(summary,indent=2,sort_keys=True,default=str),flush=True)
    Path("boost_accounting_series_result.json").write_text(json.dumps({"summary":summary,"series":series},indent=2,sort_keys=True,default=str))
if __name__=="__main__":main()
