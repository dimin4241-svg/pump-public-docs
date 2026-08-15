import base64, json, struct, time, urllib.request

RPCS=[
 'https://solana-rpc.publicnode.com',
 'https://solana-mainnet.public.blastapi.io',
 'https://api.mainnet-beta.solana.com',
]
BASE_MINT='7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump'
POOL_BASE=642_628_051_491_186
POST_INIT_REAL=46_054_525_433
POST_INIT_VIRTUAL=82_815_481_362
LP_FEE_BPS=20

ALPH='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58e(b: bytes):
    n=int.from_bytes(b,'big'); out=''
    while n:
        n,r=divmod(n,58); out=ALPH[r]+out
    z=0
    for x in b:
        if x: break
        z+=1
    return '1'*z + (out or '')

def rpc(method, params):
    last=None
    body=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode()
    for endpoint in RPCS:
        for i in range(2):
            try:
                req=urllib.request.Request(endpoint,data=body,headers={'content-type':'application/json','user-agent':'pump-boost-audit/1.0'})
                with urllib.request.urlopen(req,timeout=8) as r:
                    obj=json.load(r)
                if 'error' in obj: raise RuntimeError(obj['error'])
                print('RPC_OK', endpoint, method)
                return obj['result']
            except Exception as e:
                last=e; print('RPC_FAIL', endpoint, method, repr(e)); time.sleep(.25*(i+1))
    raise last

E=POST_INIT_REAL+POST_INIT_VIRTUAL
def unsafe(b):
    q=(E*b)//(POOL_BASE+b)
    lp=(q*LP_FEE_BPS)//10_000
    return q-lp>POST_INIT_REAL
lo,hi=0,10**18
while lo+1<hi:
    mid=(lo+hi)//2
    if unsafe(mid): hi=mid
    else: lo=mid
threshold=hi
print('BOUNDARY',json.dumps({'poolBase':POOL_BASE,'postInitReal':POST_INIT_REAL,'postInitVirtual':POST_INIT_VIRTUAL,'effectiveQuote':E,'lpFeeBps':LP_FEE_BPS,'minBaseToExceedRealAfterLpFee':threshold,'thresholdVsPoolBaseBps':threshold*10000//POOL_BASE},indent=2))

largest=rpc('getTokenLargestAccounts',[BASE_MINT,{'commitment':'processed'}])['value']
keys=[x['address'] for x in largest[:20]]
infos=rpc('getMultipleAccounts',[keys,{'encoding':'base64','commitment':'processed'}])['value']
rows=[]
for ent,info in zip(largest[:20],infos):
    if not info: continue
    d=base64.b64decode(info['data'][0]); owner=b58e(d[32:64]); amount=struct.unpack_from('<Q',d,64)[0]
    rows.append({'tokenAccount':ent['address'],'owner':owner,'amount':amount,'uiAmountString':ent.get('uiAmountString'),'meetsBoundary':amount>=threshold,'boundaryPct':round(amount*100/threshold,6)})
print('HOLDERS',json.dumps(rows,indent=2))
print('SUMMARY',json.dumps({'threshold':threshold,'largestAmount':rows[0]['amount'] if rows else 0,'largestMeetsBoundary':bool(rows and rows[0]['amount']>=threshold),'sumTop20':sum(r['amount'] for r in rows),'ownersMeetingBoundary':[r['owner'] for r in rows if r['amount']>=threshold]},indent=2))
