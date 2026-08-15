import base64,json,struct,time,urllib.request
RPC='https://api.mainnet-beta.solana.com'
TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
MINT='7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump'
THRESHOLD=358_487_640_999_242
ALPH='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58e(b):
 n=int.from_bytes(b,'big');s=''
 while n:n,r=divmod(n,58);s=ALPH[r]+s
 z=0
 for x in b:
  if x:break
  z+=1
 return '1'*z+(s or '')
def rpc(method,params):
 body=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode()
 for a in range(12):
  try:
   req=urllib.request.Request(RPC,data=body,headers={'content-type':'application/json'})
   with urllib.request.urlopen(req,timeout=45) as r:o=json.load(r)
   if 'error' in o:raise RuntimeError(o['error'])
   return o['result']
  except Exception as e:
   print('retry',a,repr(e));time.sleep(.5+a*.3)
 raise RuntimeError('rpc exhausted')
rows=rpc('getProgramAccounts',[TOKEN,{'encoding':'base64','commitment':'processed','filters':[{'dataSize':165},{'memcmp':{'offset':0,'bytes':MINT}}],'dataSlice':{'offset':32,'length':40}}])
out=[]
for r in rows:
 d=base64.b64decode(r['account']['data'][0]);owner=b58e(d[:32]);amt=struct.unpack_from('<Q',d,32)[0]
 if amt:out.append({'tokenAccount':r['pubkey'],'owner':owner,'amount':amt,'meetsBoundary':amt>=THRESHOLD,'boundaryPct':round(100*amt/THRESHOLD,6)})
out.sort(key=lambda x:x['amount'],reverse=True)
print('TOKEN_ACCOUNTS',len(rows),'NONZERO',len(out))
print('TOP20',json.dumps(out[:20],indent=2))
print('SUMMARY',json.dumps({'threshold':THRESHOLD,'largest':out[0] if out else None,'meeting':[x for x in out if x['meetsBoundary']][:10],'sumAll':sum(x['amount'] for x in out)},indent=2))
