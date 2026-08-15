#!/usr/bin/env python3
import base64,json,collections,struct
import boost_runtime_scan as core
PROGRAM=core.PROGRAM; DISC=bytes([86,255,112,14,102,53,154,250])
def main():
 url=core.choose_rpc(); rows=core.rpc_single(url,'getProgramAccounts',[PROGRAM,{'encoding':'base64','commitment':'confirmed','filters':[{'memcmp':{'offset':0,'bytes':core.b58encode(DISC)}}],'dataSlice':{'offset':0,'length':100}}]) or []
 hist=collections.Counter(); samples={}; parsed=[]
 for r in rows:
  b=base64.b64decode(r['account']['data'][0]); hist[len(b)]+=1; samples.setdefault(len(b),{'account':r['pubkey'],'dataHex':b.hex(),'lamports':r['account']['lamports']})
  x={'account':r['pubkey'],'size':len(b)}
  if len(b)>=40:x['user']=core.b58encode(b[8:40])
  if len(b)>=41:x['needsClaim']=bool(b[40])
  if len(b)>=49:x['totalUnclaimedTokens']=struct.unpack_from('<Q',b,41)[0]
  if len(b)>=57:x['totalClaimedTokens']=struct.unpack_from('<Q',b,49)[0]
  if len(b)>=65:x['currentSolVolume']=struct.unpack_from('<Q',b,57)[0]
  if len(b)>=74:x['lastUpdateTimestamp']=struct.unpack_from('<q',b,65)[0];x['hasTotalClaimedTokens']=bool(b[73])
  if len(b)>=82:x['cashbackEarned']=struct.unpack_from('<Q',b,74)[0]
  if len(b)>=90:x['totalCashbackClaimed']=struct.unpack_from('<Q',b,82)[0]
  parsed.append(x)
 print('SUMMARY',json.dumps({'count':len(rows),'sizes':dict(sorted(hist.items()))},indent=2))
 print('SAMPLES_BY_SIZE',json.dumps(samples,indent=2))
 print('TOP_VOLUME',json.dumps(sorted(parsed,key=lambda x:x.get('currentSolVolume',0),reverse=True)[:20],indent=2))
 print('TOP_CASHBACK_FIELDS',json.dumps(sorted([x for x in parsed if 'cashbackEarned' in x],key=lambda x:max(0,x.get('cashbackEarned',0)-x.get('totalCashbackClaimed',0)),reverse=True)[:20],indent=2))
if __name__=='__main__': main()
