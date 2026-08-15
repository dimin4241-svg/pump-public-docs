#!/usr/bin/env python3
import base64,json,struct,time
from pathlib import Path
import boost_runtime_scan as core
PROGRAM=core.PROGRAM
WSOL='So11111111111111111111111111111111111111112'
idl=json.loads(Path('idl/pump_amm.json').read_text())
pdisc=bytes(next(x for x in idl['accounts'] if x['name'].lower()=='pool')['discriminator'])

def pool(row):
 b=base64.b64decode(row['account']['data'][0])
 if len(b)<261:return None
 return {'pool':row['pubkey'],'index':struct.unpack_from('<H',b,9)[0],'creator':core.b58encode(b[11:43]),'baseMint':core.b58encode(b[43:75]),'quoteMint':core.b58encode(b[75:107]),'lpMint':core.b58encode(b[107:139]),'poolBase':core.b58encode(b[139:171]),'poolQuote':core.b58encode(b[171:203]),'lpSupply':struct.unpack_from('<Q',b,203)[0],'virtual':int.from_bytes(b[245:261],'little',signed=True)}
def rpc_batch_get(url,keys):
 out=[]
 for start in range(0,len(keys),100):
  chunk=keys[start:start+100]
  r=core.rpc_single(url,'getMultipleAccounts',[chunk,{'encoding':'base64','commitment':'confirmed'}]) or {}
  out.extend(r.get('value') or [])
  time.sleep(.12)
 return out
def token_amount(v):
 if not v:return 0
 b=base64.b64decode(v['data'][0]);return struct.unpack_from('<Q',b,64)[0] if len(b)>=72 else 0
def mint_supply(v):
 if not v:return 0
 b=base64.b64decode(v['data'][0]);return struct.unpack_from('<Q',b,36)[0] if len(b)>=44 else 0

def main():
 url=core.choose_rpc()
 filters=[{'dataSize':300},{'memcmp':{'offset':0,'bytes':core.b58encode(pdisc)}},{'memcmp':{'offset':9,'bytes':core.b58encode(b'\x00\x00')}},{'memcmp':{'offset':75,'bytes':WSOL}}]
 rows=core.rpc_single(url,'getProgramAccounts',[PROGRAM,{'encoding':'base64','commitment':'confirmed','filters':filters}]) or []
 ps=[pool(r) for r in rows];ps=[p for p in ps if p and p['index']==0 and p['quoteMint']==WSOL and p['virtual']==0]
 print('INDEX0_WSOL_V0',len(ps),flush=True)
 # First rank by raw quote to avoid fetching every LP mint if enormous.
 qvals=rpc_batch_get(url,[p['poolQuote'] for p in ps])
 ranked=[]
 for p,v in zip(ps,qvals):
  q=token_amount(v)
  if q>1_000_000: ranked.append((q,p))
 ranked.sort(key=lambda x:x[0],reverse=True)
 top=ranked[:800]
 print('QUOTE_ELIGIBLE_TOP',len(top),'largest',top[0][0] if top else 0,flush=True)
 mvals=rpc_batch_get(url,[p['lpMint'] for _,p in top])
 c=[]
 for (q,p),mv in zip(top,mvals):
  s=mint_supply(mv)
  if s>0:
   x=dict(p);x.update({'quoteAmount':q,'circulatingLp':s,'lockedLp':max(0,p['lpSupply']-s)})
   c.append(x)
 print('CIRCULATING_COUNT_IN_TOP',len(c),flush=True)
 print(json.dumps(c[:50],indent=2,sort_keys=True),flush=True)
 Path('index0_circulating_candidates.json').write_text(json.dumps(c,indent=2,sort_keys=True))
if __name__=='__main__':main()
