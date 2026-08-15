import {
  PublicKey, Transaction, TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';

const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const EVENT_AUTH = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const SYSTEM = new PublicKey('11111111111111111111111111111111');
const POOL = new PublicKey('GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J');
const FEE_PAYER = new PublicKey('HTVZVEQMBsNanubDPTs3CxDAEGNFQHJY8c1441iy2S5r');
const WITHDRAW_DISC = Buffer.from([183,18,70,156,148,109,161,34]);
const DEPOSIT_DISC = Buffer.from([242,35,198,137,82,225,242,182]);
const INIT_BOOST_DISC = Buffer.from([140,233,33,94,132,90,194,143]);

async function rpc(method, params) {
  for (let attempt=0; attempt<10; attempt++) {
    const r = await fetch(RPC, {
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
    });
    if (r.status === 429) {
      await new Promise(x=>setTimeout(x,900+attempt*900));
      continue;
    }
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }
  throw new Error(`${method}: retries exhausted`);
}
function pk(buf){ return new PublicKey(buf).toBase58(); }
function i128le(b,o){
  const lo=b.readBigUInt64LE(o), hi=b.readBigInt64LE(o+8);
  return hi*(1n<<64n)+lo;
}
function decodePoolValue(v) {
  if (!v) return null;
  const b=Buffer.from(v.data[0],'base64');
  return {
    len:b.length,
    creator:pk(b.subarray(11,43)),
    baseMint:pk(b.subarray(43,75)), quoteMint:pk(b.subarray(75,107)),
    lpMint:pk(b.subarray(107,139)),
    poolBase:pk(b.subarray(139,171)), poolQuote:pk(b.subarray(171,203)),
    lpSupply:b.readBigUInt64LE(203).toString(),
    virtualQuoteReserves:i128le(b,245).toString(),
  };
}
function decodeTokenValue(v) {
  if (!v) return {exists:false,amount:'0'};
  const b=Buffer.from(v.data[0],'base64');
  return {
    exists:true, ownerProgram:v.owner, lamports:v.lamports, len:b.length,
    mint:b.length>=72?pk(b.subarray(0,32)):null,
    owner:b.length>=72?pk(b.subarray(32,64)):null,
    amount:b.length>=72?b.readBigUInt64LE(64).toString():'0',
  };
}
function u64(v){ const b=Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }
function mintProgram(owner){
  if (owner===TOKEN_PROGRAM_ID.toBase58()) return TOKEN_PROGRAM_ID;
  if (owner===TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  throw new Error(`Unsupported mint owner ${owner}`);
}
function withdrawIx({p,user,userBase,userQuote,userLp,baseProgram,quoteProgram,lpAmount}) {
  return new TransactionInstruction({
    programId:PROGRAM,
    data:Buffer.concat([WITHDRAW_DISC,u64(lpAmount),u64(0),u64(0)]),
    keys:[
      {pubkey:POOL,isSigner:false,isWritable:true},
      {pubkey:GLOBAL,isSigner:false,isWritable:false},
      {pubkey:user,isSigner:true,isWritable:false},
      {pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:false},
      {pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},
      {pubkey:new PublicKey(p.lpMint),isSigner:false,isWritable:true},
      {pubkey:userBase,isSigner:false,isWritable:true},
      {pubkey:userQuote,isSigner:false,isWritable:true},
      {pubkey:userLp,isSigner:false,isWritable:true},
      {pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:true},
      {pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},
      {pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},
      {pubkey:TOKEN_2022_PROGRAM_ID,isSigner:false,isWritable:false},
      {pubkey:EVENT_AUTH,isSigner:false,isWritable:false},
      {pubkey:PROGRAM,isSigner:false,isWritable:false},
    ],
  });
}
function initBoostIx({p,creator,quoteProgram,vaultAuth,vault}) {
  return new TransactionInstruction({
    programId:PROGRAM, data:INIT_BOOST_DISC,
    keys:[
      {pubkey:POOL,isSigner:false,isWritable:true},
      {pubkey:GLOBAL,isSigner:false,isWritable:false},
      {pubkey:creator,isSigner:true,isWritable:true},
      {pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:false},
      {pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},
      {pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:false},
      {pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},
      {pubkey:vaultAuth,isSigner:false,isWritable:false},
      {pubkey:vault,isSigner:false,isWritable:true},
      {pubkey:quoteProgram,isSigner:false,isWritable:false},
      {pubkey:SYSTEM,isSigner:false,isWritable:false},
      {pubkey:ASSOCIATED_TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},
      {pubkey:EVENT_AUTH,isSigner:false,isWritable:false},
      {pubkey:PROGRAM,isSigner:false,isWritable:false},
    ],
  });
}
async function accountInfo(key, commitment='processed') {
  return (await rpc('getAccountInfo',[key.toBase58(),{encoding:'base64',commitment}])).value;
}
async function multiple(keys) {
  return (await rpc('getMultipleAccounts',[keys.map(k=>k.toBase58()),{encoding:'base64',commitment:'processed'}])).value;
}
function allTxKeys(tx) {
  const staticKeys=tx?.transaction?.message?.accountKeys||[];
  const loaded=tx?.meta?.loadedAddresses||{};
  return [...staticKeys,...(loaded.writable||[]),...(loaded.readonly||[])];
}
function instructionStream(tx) {
  const out=[];
  for(const [position,ix] of (tx?.transaction?.message?.instructions||[]).entries()) out.push({layer:'top',position,ix});
  for(const group of (tx?.meta?.innerInstructions||[])) {
    for(const [position,ix] of (group.instructions||[]).entries()) out.push({layer:`inner@${group.index}`,position,ix});
  }
  return out;
}
function discriminator(ix) {
  try { return Buffer.from(bs58.decode(ix.data||'')).subarray(0,8); }
  catch { return Buffer.alloc(0); }
}
async function findLpHolder(p, lpProgram) {
  const lpMint=new PublicKey(p.lpMint);
  const creator=new PublicKey(p.creator);
  const creatorAta=getAssociatedTokenAddressSync(lpMint,creator,true,lpProgram,ASSOCIATED_TOKEN_PROGRAM_ID);
  const creatorInfo=await accountInfo(creatorAta);
  if(creatorInfo) {
    const t=decodeTokenValue(creatorInfo);
    console.log('CREATOR_LP_ATA',JSON.stringify({address:creatorAta.toBase58(),token:t},null,2));
    if(t.mint===p.lpMint && t.owner===p.creator && BigInt(t.amount)>0n) {
      return {key:creatorAta,info:creatorInfo,token:t,source:'creator_canonical_ata'};
    }
  } else {
    console.log('CREATOR_LP_ATA',JSON.stringify({address:creatorAta.toBase58(),exists:false},null,2));
  }

  // Swaps do not touch the LP mint, so LP-mint history is a low-noise way to find a live liquidity position.
  const sigRows=await rpc('getSignaturesForAddress',[p.lpMint,{limit:100,commitment:'confirmed'}])||[];
  console.log('LP_MINT_HISTORY',JSON.stringify({rows:sigRows.length},null,2));
  for(const row of sigRows) {
    if(row.err) continue;
    let tx;
    try {
      tx=await rpc('getTransaction',[row.signature,{encoding:'json',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
    } catch(e) {
      console.log('LP_HISTORY_TX_ERROR',row.signature,String(e));
      continue;
    }
    if(!tx) continue;
    const keys=allTxKeys(tx);
    for(const {layer,position,ix} of instructionStream(tx)) {
      const pi=ix.programIdIndex;
      if(pi===undefined || pi>=keys.length || keys[pi]!==PROGRAM.toBase58()) continue;
      const d=discriminator(ix);
      if(!d.equals(WITHDRAW_DISC) && !d.equals(DEPOSIT_DISC)) continue;
      const ai=ix.accounts||[];
      if(ai.length<9 || ai[2]>=keys.length || ai[8]>=keys.length) continue;
      const userKey=new PublicKey(keys[ai[2]]);
      const lpKey=new PublicKey(keys[ai[8]]);
      const info=await accountInfo(lpKey);
      if(!info) continue;
      const t=decodeTokenValue(info);
      const candidate={signature:row.signature,layer,position,kind:d.equals(WITHDRAW_DISC)?'withdraw':'deposit',user:userKey.toBase58(),userLp:lpKey.toBase58(),currentToken:t};
      console.log('LP_HISTORY_CANDIDATE',JSON.stringify(candidate,null,2));
      if(t.mint===p.lpMint && t.owner===userKey.toBase58() && BigInt(t.amount)>0n) {
        return {key:lpKey,info,token:t,source:'live_account_from_lp_mint_history',sourceTx:row.signature};
      }
    }
    await new Promise(x=>setTimeout(x,120));
  }
  throw new Error('No live LP token holder found via creator ATA or LP-mint history');
}
async function makeTx(ixs, blockhash) {
  const tx=new Transaction({feePayer:FEE_PAYER,recentBlockhash:blockhash});
  tx.add(...ixs);
  // Signer bits come from instruction metas. sigVerify=false means no private keys are needed.
  return tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
}
async function simulateRaw(raw, watch) {
  return rpc('simulateTransaction',[raw,{
    encoding:'base64',sigVerify:false,replaceRecentBlockhash:false,commitment:'processed',
    accounts:{encoding:'base64',addresses:watch.map(k=>k.toBase58())},
  }]);
}
function amount(v){ return BigInt(decodeTokenValue(v).amount); }
function summarizeSim(result, pre, names) {
  const v=result?.value||{}; const logs=v.logs||[]; const post=v.accounts||[];
  const deltas={};
  for(let i=0;i<names.length;i++) {
    if(names[i]==='pool') continue;
    deltas[names[i]]=(amount(post[i])-amount(pre[i])).toString();
  }
  return {
    contextSlot:result?.context?.slot??null, err:v.err??null, units:v.unitsConsumed??null,
    deltas,
    postPool:post[0]?decodePoolValue(post[0]):null,
    post:Object.fromEntries(names.slice(1).map((n,i)=>[n,decodeTokenValue(post[i+1])])),
    anchorErrors:logs.filter(x=>x.includes('AnchorError')),
    instructionLogs:logs.filter(x=>x.includes('Instruction:')||x.includes('Program log: Error')||x.includes('Program failed')),
    logs,
  };
}
async function main() {
  const poolInfo=await accountInfo(POOL);
  const p=decodePoolValue(poolInfo);
  console.log('POOL',JSON.stringify(p,null,2));
  if(BigInt(p.virtualQuoteReserves)!==0n) throw new Error(`control pool already boosted: ${p.virtualQuoteReserves}`);

  const baseMintInfo=await accountInfo(new PublicKey(p.baseMint));
  const quoteMintInfo=await accountInfo(new PublicKey(p.quoteMint));
  const lpMintInfo=await accountInfo(new PublicKey(p.lpMint));
  const baseProgram=mintProgram(baseMintInfo.owner);
  const quoteProgram=mintProgram(quoteMintInfo.owner);
  const lpProgram=mintProgram(lpMintInfo.owner);
  console.log('MINT_PROGRAMS',JSON.stringify({base:baseProgram.toBase58(),quote:quoteProgram.toBase58(),lp:lpProgram.toBase58()},null,2));

  const chosen=await findLpHolder(p,lpProgram);
  const user=new PublicKey(chosen.token.owner);
  const userLp=chosen.key;
  const lpBalance=BigInt(chosen.token.amount);
  console.log('LP_HOLDER',JSON.stringify({user:user.toBase58(),userLp:userLp.toBase58(),lpBalance:lpBalance.toString(),source:chosen.source,sourceTx:chosen.sourceTx||null},null,2));

  const userBase=getAssociatedTokenAddressSync(new PublicKey(p.baseMint),user,true,baseProgram,ASSOCIATED_TOKEN_PROGRAM_ID);
  const userQuote=getAssociatedTokenAddressSync(new PublicKey(p.quoteMint),user,true,quoteProgram,ASSOCIATED_TOKEN_PROGRAM_ID);
  const [vaultAuth]=PublicKey.findProgramAddressSync([Buffer.from('boost_vault'),POOL.toBuffer()],PROGRAM);
  const vault=getAssociatedTokenAddressSync(new PublicKey(p.quoteMint),vaultAuth,true,quoteProgram,ASSOCIATED_TOKEN_PROGRAM_ID);
  const creator=new PublicKey(p.creator);

  const preBase=await accountInfo(userBase), preQuote=await accountInfo(userQuote);
  const setup=[];
  if(!preBase) setup.push(createAssociatedTokenAccountIdempotentInstruction(FEE_PAYER,userBase,user,new PublicKey(p.baseMint),baseProgram,ASSOCIATED_TOKEN_PROGRAM_ID));
  if(!preQuote) setup.push(createAssociatedTokenAccountIdempotentInstruction(FEE_PAYER,userQuote,user,new PublicKey(p.quoteMint),quoteProgram,ASSOCIATED_TOKEN_PROGRAM_ID));

  const watch=[POOL,userBase,userQuote,userLp,new PublicKey(p.poolBase),new PublicKey(p.poolQuote),vault];
  const names=['pool','userBase','userQuote','userLp','poolBase','poolQuote','boostVault'];
  const pre=await multiple(watch);
  console.log('PRE',JSON.stringify({
    pool:decodePoolValue(pre[0]),userBase:decodeTokenValue(pre[1]),userQuote:decodeTokenValue(pre[2]),
    userLp:decodeTokenValue(pre[3]),poolBase:decodeTokenValue(pre[4]),poolQuote:decodeTokenValue(pre[5]),boostVault:decodeTokenValue(pre[6]),
    creator:creator.toBase58(),vaultAuth:vaultAuth.toBase58(),vault:vault.toBase58(),setupInstructionCount:setup.length,
  },null,2));

  const fractions=[10000n,100000n,1000000n]; // 1%, 10%, 100% of this holder, denominator 1e6
  const results=[];
  for(const f of fractions) {
    let lpAmount=(lpBalance*f)/1000000n;
    if(lpAmount===0n) lpAmount=1n;
    if(lpAmount>lpBalance) lpAmount=lpBalance;
    const wd=withdrawIx({p,user,userBase,userQuote,userLp,baseProgram,quoteProgram,lpAmount});
    const init=initBoostIx({p,creator,quoteProgram,vaultAuth,vault});
    const bh=(await rpc('getLatestBlockhash',[{commitment:'processed'}])).value.blockhash;
    const rawA=await makeTx([...setup,wd],bh);
    const rawB=await makeTx([...setup,init,wd],bh);
    // Fire both simulations concurrently so both branches are evaluated against the same RPC bank whenever possible.
    const [a,b]=await Promise.all([simulateRaw(rawA,watch),simulateRaw(rawB,watch)]);
    const sa=summarizeSim(a,pre,names), sb=summarizeSim(b,pre,names);
    const row={fractionPpm:f.toString(),lpAmount:lpAmount.toString(),baseline:sa,afterInitBoost:sb};
    if(sa.err===null && sb.err===null) {
      const aq=BigInt(sa.deltas.userQuote), bq=BigInt(sb.deltas.userQuote);
      const ab=BigInt(sa.deltas.userBase), bb=BigInt(sb.deltas.userBase);
      row.comparison={
        sameContextSlot:sa.contextSlot===sb.contextSlot,
        quoteOutBaseline:aq.toString(),quoteOutAfterInit:bq.toString(),quoteDifference:(bq-aq).toString(),
        baseOutBaseline:ab.toString(),baseOutAfterInit:bb.toString(),baseDifference:(bb-ab).toString(),
        quoteRetentionBps:aq>0n?((bq*10000n)/aq).toString():null,
        baseRetentionBps:ab>0n?((bb*10000n)/ab).toString():null,
      };
    }
    results.push(row);
    console.log('PAIR',JSON.stringify(row,null,2));
    await new Promise(x=>setTimeout(x,250));
  }
  const decisive=results.map(r=>({
    fractionPpm:r.fractionPpm,lpAmount:r.lpAmount,
    baselineErr:r.baseline.err,afterInitErr:r.afterInitBoost.err,
    baselineSlot:r.baseline.contextSlot,afterInitSlot:r.afterInitBoost.contextSlot,
    comparison:r.comparison??null,
    afterInitVirtual:r.afterInitBoost.postPool?.virtualQuoteReserves??null,
    afterInitBoostVault:r.afterInitBoost.post?.boostVault?.amount??null,
  }));
  console.log('DECISIVE_SUMMARY',JSON.stringify(decisive,null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
