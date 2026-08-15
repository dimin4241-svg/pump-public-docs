import fs from 'node:fs';
import bs58 from 'bs58';
import {PublicKey,Transaction,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';

const RPC='https://api.mainnet-beta.solana.com';
const PROGRAM=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL=new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const EVENT_AUTH=new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const WSOL=new PublicKey('So11111111111111111111111111111111111111112');
const INIT_DISC=Buffer.from([140,233,33,94,132,90,194,143]);
const idl=JSON.parse(fs.readFileSync('idl/pump_amm.json','utf8'));
const POOL_DISC=Buffer.from(idl.accounts.find(x=>String(x.name).toLowerCase()==='pool').discriminator);

async function rpc(method,params){
 for(let a=0;a<10;a++){
  const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  if(r.status===429||r.status>=500){await new Promise(x=>setTimeout(x,700+a*800));continue;}
  const j=await r.json();if(j.error)throw new Error(`${method}: ${JSON.stringify(j.error)}`);return j.result;
 }
 throw new Error(`${method}: retries exhausted`);
}
const pk=b=>new PublicKey(b).toBase58();
function i128(b,o){const lo=b.readBigUInt64LE(o),hi=b.readBigInt64LE(o+8);return hi*(1n<<64n)+lo;}
function pool(pubkey,v){const b=Buffer.from(v.data[0],'base64');return {pubkey,index:b.readUInt16LE(9),creator:pk(b.subarray(11,43)),baseMint:pk(b.subarray(43,75)),quoteMint:pk(b.subarray(75,107)),lpMint:pk(b.subarray(107,139)),poolBase:pk(b.subarray(139,171)),poolQuote:pk(b.subarray(171,203)),lpSupply:b.readBigUInt64LE(203).toString(),virtual:i128(b,245).toString()};}
function token(v){if(!v)return {exists:false,amount:'0'};const b=Buffer.from(v.data[0],'base64');return {exists:true,program:v.owner,lamports:v.lamports,mint:b.length>=72?pk(b.subarray(0,32)):null,owner:b.length>=72?pk(b.subarray(32,64)):null,amount:b.length>=72?b.readBigUInt64LE(64).toString():'0'};}
function mintProgram(owner){if(owner===TOKEN_PROGRAM_ID.toBase58())return TOKEN_PROGRAM_ID;if(owner===TOKEN_2022_PROGRAM_ID.toBase58())return TOKEN_2022_PROGRAM_ID;throw new Error('unsupported mint owner '+owner);}
async function multi(keys){const out=[];for(let i=0;i<keys.length;i+=100){const r=await rpc('getMultipleAccounts',[keys.slice(i,i+100).map(k=>k.toBase58()),{encoding:'base64',commitment:'confirmed'}]);out.push(...r.value);if(i+100<keys.length)await new Promise(x=>setTimeout(x,120));}return out;}
async function info(k){return (await rpc('getAccountInfo',[k.toBase58(),{encoding:'base64',commitment:'confirmed'}])).value;}
function initIx(p,poolKey,creator,quoteProgram,va,vault){return new TransactionInstruction({programId:PROGRAM,data:INIT_DISC,keys:[{pubkey:poolKey,isSigner:false,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},{pubkey:creator,isSigner:true,isWritable:true},{pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},{pubkey:va,isSigner:false,isWritable:false},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:quoteProgram,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:ASSOCIATED_TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:EVENT_AUTH,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}]});}
async function findSystemPayer(){
 const sigs=await rpc('getSignaturesForAddress',[PROGRAM.toBase58(),{limit:50,commitment:'confirmed'}]);
 for(const row of sigs||[]){
  if(row.err)continue;
  try{
   const tx=await rpc('getTransaction',[row.signature,{encoding:'json',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
   const p=tx?.transaction?.message?.accountKeys?.[0];if(!p)continue;
   const v=await info(new PublicKey(p));
   if(v&&v.owner===SystemProgram.programId.toBase58()&&v.lamports>50_000_000)return new PublicKey(p);
  }catch{}
 }
 throw new Error('no funded system fee payer found');
}
async function sim(p,poolKey,creator,quoteProgram,va,vault,payer,creatorInfo){
 const ixs=[];
 if(!creatorInfo||creatorInfo.owner!==SystemProgram.programId.toBase58()||creatorInfo.lamports<3_000_000){
  if(creatorInfo&&creatorInfo.owner!==SystemProgram.programId.toBase58())return {skipped:'creator_not_system_account',creatorOwner:creatorInfo.owner};
  ixs.push(SystemProgram.transfer({fromPubkey:payer,toPubkey:creator,lamports:5_000_000}));
 }
 ixs.push(initIx(p,poolKey,creator,quoteProgram,va,vault));
 const bh=(await rpc('getLatestBlockhash',[{commitment:'processed'}])).value.blockhash;
 const tx=new Transaction({feePayer:payer,recentBlockhash:bh});tx.add(...ixs);
 const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
 const r=await rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'processed',accounts:{encoding:'base64',addresses:[poolKey.toBase58(),p.poolQuote,vault.toBase58()]}}]);
 return {r,prefunded:ixs.length>1};
}
function sm(r){const v=r?.value||{},logs=v.logs||[],t=logs.join('\n');return {err:v.err??null,sawInit:t.includes('Instruction: InitBoost'),success:logs.includes(`Program ${PROGRAM.toBase58()} success`),anchor:logs.filter(x=>x.includes('AnchorError')),errors:logs.filter(x=>x.includes('failed:')||x.includes('Error')),logs};}
async function main(){
 const idx=Buffer.alloc(2);idx.writeUInt16LE(1);
 const rows=await rpc('getProgramAccounts',[PROGRAM.toBase58(),{encoding:'base64',commitment:'confirmed',filters:[{dataSize:300},{memcmp:{offset:0,bytes:bs58.encode(POOL_DISC)}},{memcmp:{offset:9,bytes:bs58.encode(idx)}},{memcmp:{offset:75,bytes:bs58.encode(WSOL.toBuffer())}}]}]);
 const ps=rows.map(x=>pool(x.pubkey,x.account)).filter(p=>BigInt(p.virtual)===0n);
 const quoteVals=await multi(ps.map(p=>new PublicKey(p.poolQuote)));
 const creators=[...new Map(ps.map(p=>[p.creator,new PublicKey(p.creator)])).values()];
 const creatorVals=await multi(creators);const creatorMap=new Map(creators.map((k,i)=>[k.toBase58(),creatorVals[i]]));
 const ranked=ps.map((p,i)=>({...p,q:token(quoteVals[i]),qAmount:BigInt(token(quoteVals[i]).amount),creatorInfo:creatorMap.get(p.creator)})).filter(x=>x.q.exists).sort((a,b)=>a.qAmount===b.qAmount?0:(a.qAmount>b.qAmount?-1:1));
 const payer=await findSystemPayer();console.log('SYSTEM_SIM_PAYER',payer.toBase58());
 let tested=0,full=0,noops=0;const results=[];
 for(const p of ranked.slice(0,80)){
  if(p.qAmount<40_000n)break;
  let mintVals;try{mintVals=await multi([new PublicKey(p.lpMint),new PublicKey(p.quoteMint)]);}catch{continue;}
  if(!mintVals[0]||!mintVals[1])continue;
  let lpProg,qProg;try{lpProg=mintProgram(mintVals[0].owner);qProg=mintProgram(mintVals[1].owner);}catch{continue;}
  const creator=new PublicKey(p.creator),poolKey=new PublicKey(p.pubkey),creatorLp=getAssociatedTokenAddressSync(new PublicKey(p.lpMint),creator,true,lpProg,ASSOCIATED_TOKEN_PROGRAM_ID);
  const lpTok=token(await info(creatorLp));
  // Prefer pools where the creator still has LP, but do not require it for protocol eligibility testing.
  const [va]=PublicKey.findProgramAddressSync([Buffer.from('boost_vault'),poolKey.toBuffer()],PROGRAM);const vault=getAssociatedTokenAddressSync(WSOL,va,true,qProg,ASSOCIATED_TOKEN_PROGRAM_ID);const preVault=token(await info(vault));
  let sr;try{sr=await sim(p,poolKey,creator,qProg,va,vault,payer,p.creatorInfo);}catch(e){console.log('SIM_ERROR',p.pubkey,String(e));continue;}
  if(sr.skipped){results.push({pool:p.pubkey,quote:p.qAmount.toString(),creatorLp:lpTok.amount,skipped:sr});continue;}
  const s=sm(sr.r),acs=sr.r?.value?.accounts||[],postPool=acs[0]?pool(p.pubkey,acs[0]):null,postQuote=token(acs[1]),postVault=token(acs[2]);
  const out={pool:p.pubkey,index:p.index,creator:p.creator,quote:p.qAmount.toString(),creatorLamports:p.creatorInfo?.lamports??null,creatorLp:lpTok.amount,prefunded:sr.prefunded,err:s.err,sawInit:s.sawInit,success:s.success,anchor:s.anchor,errors:s.errors,postVirtual:postPool?.virtual??null,postQuote:postQuote.amount,postVault:postVault.amount,quoteDelta:acs[1]?(BigInt(postQuote.amount)-p.qAmount).toString():null,vaultDelta:acs[2]?(BigInt(postVault.amount)-BigInt(preVault.amount)).toString():null};
  results.push(out);tested++;if(s.err===null&&postPool&&BigInt(postPool.virtual)!==0n){full++;console.log('FULL_DIRECT_BOOST',JSON.stringify(out,null,2));break;}if(s.err===null&&postPool&&BigInt(postPool.virtual)===0n)noops++;
  console.log('CONTROL',JSON.stringify(out,null,2));if(tested>=12)break;
 }
 console.log('SUMMARY',JSON.stringify({tested,full,noops,results:results.map(x=>({pool:x.pool,quote:x.quote,creatorLp:x.creatorLp,prefunded:x.prefunded,err:x.err,postVirtual:x.postVirtual,quoteDelta:x.quoteDelta,vaultDelta:x.vaultDelta,skipped:x.skipped}))},null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
