#!/usr/bin/env python3
import base64,json,struct
import boost_runtime_scan as core
PROGRAM=core.PROGRAM
DISC=bytes([86,255,112,14,102,53,154,250])
def u64(b,o): return struct.unpack_from('<Q',b,o)[0]
def i64(b,o): return struct.unpack_from('<q',b,o)[0]
def dec(r):
 b=base64.b64decode(r['account']['data'][0])
 if len(b)<90 or b[:8]!=DISC:return None
 return {'account':r['pubkey'],'user':core.b58encode(b[8:40]),'needsClaim':bool(b[40]),'totalUnclaimedTokens':u64(b,41),'totalClaimedTokens':u64(b,49),'currentSolVolume':u64(b,57),'lastUpdateTimestamp':i64(b,65),'hasTotalClaimedTokens':bool(b[73]),'cashbackEarned':u64(b,74),'totalCashbackClaimed':u64(b,82),'cashbackUnclaimedArithmetic':max(0,u64(b,74)-u64(b,82)),'lamports':r['account']['lamports']}
def main():
 url=core.choose_rpc();rows=core.rpc_single(url,'getProgramAccounts',[PROGRAM,{'encoding':'base64','commitment':'confirmed','filters':[{'dataSize':90},{'memcmp':{'offset':0,'bytes':core.b58encode(DISC)}}]}]) or []
 xs=[x for x in (dec(r) for r in rows) if x]; bycash=sorted(xs,key=lambda x:x['cashbackUnclaimedArithmetic'],reverse=True); byvol=sorted(xs,key=lambda x:x['currentSolVolume'],reverse=True)
 print('SUMMARY',json.dumps({'count':len(xs),'needsClaim':sum(x['needsClaim'] for x in xs),'withCashbackEarned':sum(x['cashbackEarned']>0 for x in xs),'withArithmeticUnclaimedCashback':sum(x['cashbackUnclaimedArithmetic']>0 for x in xs),'totalArithmeticUnclaimedCashback':sum(x['cashbackUnclaimedArithmetic'] for x in xs)},indent=2))
 print('TOP_CASHBACK',json.dumps(bycash[:30],indent=2));print('TOP_VOLUME',json.dumps(byvol[:10],indent=2))
if __name__=='__main__':main()
