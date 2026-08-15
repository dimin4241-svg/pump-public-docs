#!/usr/bin/env python3
import base64,json,struct
from pathlib import Path
import boost_runtime_scan as core
PROGRAM=core.PROGRAM
idl=json.loads(Path('idl/pump_amm.json').read_text())
pdisc=bytes(next(x for x in idl['accounts'] if x['name'].lower()=='pool')['discriminator'])
def dec(r):
 b=base64.b64decode(r['account']['data'][0])
 if len(b)<261:return None
 return {'pool':r['pubkey'],'index':struct.unpack_from('<H',b,9)[0],'creator':core.b58encode(b[11:43]),'baseMint':core.b58encode(b[43:75]),'quoteMint':core.b58encode(b[75:107]),'lpMint':core.b58encode(b[107:139]),'poolBase':core.b58encode(b[139:171]),'poolQuote':core.b58encode(b[171:203]),'lpSupply':struct.unpack_from('<Q',b,203)[0],'virtual':int.from_bytes(b[245:261],'little',signed=True)}
def main():
 url=core.choose_rpc(); filters=[{'dataSize':300},{'memcmp':{'offset':0,'bytes':core.b58encode(pdisc)}}]
 rows=core.rpc_single(url,'getProgramAccounts',[PROGRAM,{'encoding':'base64','commitment':'confirmed','filters':filters}]) or []
 ps=[x for x in (dec(r) for r in rows) if x]
 nz=[x for x in ps if x['virtual']!=0]; pos=sorted([x for x in nz if x['virtual']>0],key=lambda x:x['virtual']); neg=sorted([x for x in nz if x['virtual']<0],key=lambda x:x['virtual'])
 print('SUMMARY',json.dumps({'totalPools':len(ps),'nonzero':len(nz),'positive':len(pos),'negative':len(neg),'minPositive':pos[0]['virtual'] if pos else None,'maxPositive':pos[-1]['virtual'] if pos else None,'mostNegative':neg[0]['virtual'] if neg else None},indent=2))
 print('SMALLEST_POSITIVE',json.dumps(pos[:25],indent=2));print('NEGATIVE',json.dumps(neg[:25],indent=2))
if __name__=='__main__':main()
