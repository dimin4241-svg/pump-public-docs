#!/usr/bin/env python3
import base64,json,struct
from pathlib import Path
import boost_runtime_scan as core
PROGRAM=core.PROGRAM
idl=json.loads(Path('idl/pump_amm.json').read_text()); disc=bytes(next(x for x in idl['accounts'] if x['name'].lower()=='pool')['discriminator'])
def dec(r):
 b=base64.b64decode(r['account']['data'][0])
 if len(b)<261:return None
 return {'pool':r['pubkey'],'index':struct.unpack_from('<H',b,9)[0],'creator':core.b58encode(b[11:43]),'baseMint':core.b58encode(b[43:75]),'quoteMint':core.b58encode(b[75:107]),'coinCreator':core.b58encode(b[211:243]),'isMayhemMode':bool(b[243]),'isCashbackCoin':bool(b[244]),'virtual':int.from_bytes(b[245:261],'little',signed=True)}
def main():
 url=core.choose_rpc(); rows=core.rpc_single(url,'getProgramAccounts',[PROGRAM,{'encoding':'base64','commitment':'confirmed','filters':[{'dataSize':300},{'memcmp':{'offset':0,'bytes':core.b58encode(disc)}}]}]) or []
 ps=[x for x in (dec(r) for r in rows) if x]; cb=[x for x in ps if x['isCashbackCoin']]; cc=[x for x in ps if x['coinCreator']!='11111111111111111111111111111111']
 print('SUMMARY',json.dumps({'totalPools':len(ps),'cashbackPools':len(cb),'coinCreatorNonzero':len(cc),'cashbackWsol':sum(x['quoteMint']=='So11111111111111111111111111111111111111112' for x in cb)},indent=2))
 print('CASHBACK_SAMPLE',json.dumps(cb[:50],indent=2))
if __name__=='__main__':main()
