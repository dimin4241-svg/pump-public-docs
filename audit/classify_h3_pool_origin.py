#!/usr/bin/env python3
import json,time
import boost_runtime_scan as core
POOL='H3yVTyEQWpGCFpR43GMCePDSXpypopTQAqGn6gRiPSjQ'
PROGRAM=core.PROGRAM

def main():
    url=core.choose_rpc()
    before=None; rows=[]
    # Walk complete address history backwards; pool-specific history is low-noise.
    while len(rows)<5000:
        cfg={'limit':1000,'commitment':'finalized'}
        if before: cfg['before']=before
        page=core.rpc_single(url,'getSignaturesForAddress',[POOL,cfg]) or []
        if not page: break
        rows.extend(page); before=page[-1]['signature']
        print('PAGE',len(rows),'oldest_slot',page[-1].get('slot'),flush=True)
        if len(page)<1000: break
        time.sleep(.2)
    print('TOTAL_HISTORY',len(rows),flush=True)
    # Inspect oldest successful txs first; creation should be among the oldest few.
    out=[]
    for row in reversed(rows[-60:]):
        if row.get('err') is not None: continue
        sig=row['signature']
        try:
            tx=core.rpc_single(url,'getTransaction',[sig,{'encoding':'json','commitment':'finalized','maxSupportedTransactionVersion':0}])
        except Exception as e:
            print('TXERR',sig,e,flush=True);continue
        if not tx: continue
        keys=core.all_keys(tx); pump=[]
        for layer,pos,ix in core.instruction_stream(tx):
            pi=ix.get('programIdIndex')
            if pi is None or pi>=len(keys) or keys[pi]!=PROGRAM: continue
            try: raw=core.b58decode(ix.get('data',''))
            except Exception: raw=b''
            pump.append({'layer':layer,'position':pos,'disc':raw[:8].hex(),'data_len':len(raw),'accounts':[keys[i] if i<len(keys) else None for i in ix.get('accounts',[])]})
        names=[x for x in ((tx.get('meta') or {}).get('logMessages') or []) if 'Instruction:' in x]
        rec={'signature':sig,'slot':tx.get('slot'),'block_time':tx.get('blockTime'),'pump':pump,'instruction_names':names}
        out.append(rec); print('OLD_TX',json.dumps(rec,sort_keys=True),flush=True)
        if any(('CreatePool' in x or 'Migrate' in x) for x in names): break
        time.sleep(.08)
    print('ORIGIN_CANDIDATES',json.dumps(out,indent=2,sort_keys=True),flush=True)
if __name__=='__main__':main()
