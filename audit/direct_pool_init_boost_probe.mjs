import fs from 'node:fs';
import bs58 from 'bs58';
import {PublicKey,Transaction,TransactionInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';

const RPCS=(process.env.SOLANA_RPCS||'https://api.mainnet-beta.solana.com,https://rpc.ankr.com/solana').split(',').map(x=>x.trim()).filter(Boolean);
const PROGRAM=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL=new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const EVENT_AUTH=new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const SYSTEM=new PublicKey('11111111111111111111111111111111');
const WSOL=new PublicKey('So11111111111111111111111111111111111111112');
const INIT_DISC=Buffer.from([140,233,33,94,132,90,194,143]);
const idl=JSON.parse(fs.readFileSync('idl/pump_amm.json','utf8'));
const poolDef=(idl.accounts||[]).find(x=>String(x.name).toLowerCase()==='pool');
if(!poolDef?.discriminator) throw new Error('Pool account discriminator not found in IDL');
const POOL_DISC=Buffer.from(poolDef.discriminator);

let rpcUrl=RPCS[0];
async function post(url,method,params){
  for(let attempt=0;attempt<7;attempt++){
    try{
      const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','user-agent':'pump-authorized-bounty-sim-only/1.0'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      if(r.status===429||r.status>=500){await new Promise(x=>setTimeout(x,700+attempt*900));continue;}
      const j=await r.json();
      if(j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    }catch(e){if(attempt===6)throw e;await new Promise(x=>setTimeout(x,600+attempt*700));}
  }
}
async function chooseRpc(){
  for(const u of RPCS){
    try{const v=await post(u,'getVersion',[]);rpcUrl=u;console.log('RPC_OK',u,JSON.stringify(v));return;}
    catch(e){console.log('RPC_FAIL',u,String(e));}
  }
  throw new Error('No usable Solana RPC');
}
const rpc=(m,p)=>post(rpcUrl,m,p);
const pk=b=>new PublicKey(b).toBase58();
function i128(b,o){const lo=b.readBigUInt64LE(o),hi=b.readBigInt64LE(o+8);return hi*(1n<<64n)+lo;}
function decodePoolValue(v){
  if(!v)return null;const b=Buffer.from(v.data[0],'base64');if(b.length<261)return {len:b.length,short:true};
  return {len:b.length,disc:b.subarray(0,8).toString('hex'),bump:b[8],index:b.readUInt16LE(9),creator:pk(b.subarray(11,43)),baseMint:pk(b.subarray(43,75)),quoteMint:pk(b.subarray(75,107)),lpMint:pk(b.subarray(107,139)),poolBase:pk(b.subarray(139,171)),poolQuote:pk(b.subarray(171,203)),lpSupply:b.readBigUInt64LE(203).toString(),coinCreator:pk(b.subarray(211,243)),virtualQuoteReserves:i128(b,245).toString()};
}
function decodeTokenValue(v){
  if(!v)return {exists:false,amount:'0'};const b=Buffer.from(v.data[0],'base64');
  return {exists:true,program:v.owner,lamports:v.lamports,len:b.length,mint:b.length>=72?pk(b.subarray(0,32)):null,owner:b.length>=72?pk(b.subarray(32,64)):null,amount:b.length>=72?b.readBigUInt64LE(64).toString():'0'};
}
function mintProgram(owner){if(owner===TOKEN_PROGRAM_ID.toBase58())return TOKEN_PROGRAM_ID;if(owner===TOKEN_2022_PROGRAM_ID.toBase58())return TOKEN_2022_PROGRAM_ID;throw new Error(`unsupported mint owner ${owner}`);}
async function info(k){return (await rpc('getAccountInfo',[k.toBase58(),{encoding:'base64',commitment:'confirmed'}]))?.value;}
async function multi(keys){return (await rpc('getMultipleAccounts',[keys.map(x=>x.toBase58()),{encoding:'base64',commitment:'confirmed'}]))?.value||[];}
function initIx(p,pool,creator,quoteProgram,vaultAuth,vault){return new TransactionInstruction({programId:PROGRAM,data:INIT_DISC,keys:[
 {pubkey:pool,isSigner:false,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},{pubkey:creator,isSigner:true,isWritable:true},{pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},{pubkey:vaultAuth,isSigner:false,isWritable:false},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:quoteProgram,isSigner:false,isWritable:false},{pubkey:SYSTEM,isSigner:false,isWritable:false},{pubkey:ASSOCIATED_TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:EVENT_AUTH,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}
]});}
async function simulate(ix,feePayer,watch){
 const bh=(await rpc('getLatestBlockhash',[{commitment:'processed'}])).value.blockhash;
 const tx=new Transaction({feePayer,recentBlockhash:bh});tx.add(ix);
 const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');
 return rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'processed',accounts:{encoding:'base64',addresses:watch.map(x=>x.toBase58())}}]);
}
function sumSim(r){const v=r?.value||{},logs=v.logs||[],t=logs.join('\n');return {err:v.err??null,units:v.unitsConsumed??null,init:t.includes('Instruction: InitBoost'),invalidAdmin:t.includes('InvalidAdmin'),anchorErrors:logs.filter(x=>x.includes('AnchorError')),programErrors:logs.filter(x=>x.includes('failed:')||x.includes('Error')),logs};}
async function gpaForIndex(index){
 const idx=Buffer.alloc(2);idx.writeUInt16LE(index);
 return rpc('getProgramAccounts',[PROGRAM.toBase58(),{encoding:'base64',commitment:'confirmed',filters:[{dataSize:300},{memcmp:{offset:0,bytes:bs58.encode(POOL_DISC)}},{memcmp:{offset:9,bytes:bs58.encode(idx)}}]}]);
}
async function main(){
 await chooseRpc();console.log('POOL_DISC',POOL_DISC.toString('hex'));
 let candidates=[];
 for(const index of [1,2,3,4,5,6,7,8,9,10]){
   let rows;
   try{rows=await gpaForIndex(index);}catch(e){console.log('GPA_ERROR',index,String(e));continue;}
   console.log('GPA_INDEX',index,'rows',rows?.length||0);
   for(const row of rows||[])candidates.push({pubkey:row.pubkey,value:row.account,index});
   if(candidates.length>=60)break;
 }
 console.log('TOTAL_NONCANONICAL_POOL_ROWS',candidates.length);
 let tested=0;
 for(const row of candidates.slice(0,120)){
   const poolKey=new PublicKey(row.pubkey),p=decodePoolValue(row.value);
   if(!p||p.short||p.index===0||p.quoteMint!==WSOL.toBase58()||BigInt(p.virtualQuoteReserves)!==0n)continue;
   let acs;try{acs=await multi([new PublicKey(p.poolQuote),new PublicKey(p.lpMint),new PublicKey(p.baseMint),new PublicKey(p.quoteMint)]);}catch(e){continue;}
   const poolQuote=decodeTokenValue(acs[0]),lpMintInfo=acs[1],baseMintInfo=acs[2],quoteMintInfo=acs[3];
   if(!poolQuote.exists||BigInt(poolQuote.amount)<1_000_000_000n||!lpMintInfo||!baseMintInfo||!quoteMintInfo)continue;
   let lpProgram,quoteProgram;try{lpProgram=mintProgram(lpMintInfo.owner);quoteProgram=mintProgram(quoteMintInfo.owner);}catch{continue;}
   const creator=new PublicKey(p.creator),creatorLp=getAssociatedTokenAddressSync(new PublicKey(p.lpMint),creator,true,lpProgram,ASSOCIATED_TOKEN_PROGRAM_ID);
   let creatorLpInfo;try{creatorLpInfo=await info(creatorLp);}catch{continue;}
   const creatorLpTok=decodeTokenValue(creatorLpInfo);
   const [vaultAuth]=PublicKey.findProgramAddressSync([Buffer.from('boost_vault'),poolKey.toBuffer()],PROGRAM);
   const vault=getAssociatedTokenAddressSync(new PublicKey(p.quoteMint),vaultAuth,true,quoteProgram,ASSOCIATED_TOKEN_PROGRAM_ID);
   const preVault=decodeTokenValue(await info(vault));
   const candidate={pool:poolKey.toBase58(),poolState:p,poolQuote,creatorLp:creatorLp.toBase58(),creatorLpToken:creatorLpTok,vaultAuth:vaultAuth.toBase58(),vault:vault.toBase58(),preVault};
   console.log('CANDIDATE',JSON.stringify(candidate,null,2));
   tested++;
   let r;try{r=await simulate(initIx(p,poolKey,creator,quoteProgram,vaultAuth,vault),creator,[poolKey,new PublicKey(p.poolQuote),vault]);}catch(e){console.log('SIM_RPC_ERROR',poolKey.toBase58(),String(e));continue;}
   const s=sumSim(r),post=r?.value?.accounts||[];
   const postPool=post[0]?decodePoolValue(post[0]):null,postQuote=decodeTokenValue(post[1]),postVault=decodeTokenValue(post[2]);
   const out={candidate,simulation:s,postPool,postQuote,postVault,quoteDelta:(BigInt(postQuote.amount)-BigInt(poolQuote.amount)).toString(),vaultDelta:(BigInt(postVault.amount)-BigInt(preVault.amount)).toString(),simulationOnly:true,broadcast:false};
   console.log('DIRECT_POOL_INIT_RESULT',JSON.stringify(out,null,2));
   if(s.err===null&&postPool&&BigInt(postPool.virtualQuoteReserves)!==0n){console.log('DECISIVE_DIRECT_POOL_BOOST_ACCEPTED',JSON.stringify(out,null,2));return;}
   if(tested>=12)break;
 }
 console.log('FINAL','NO_DIRECT_POOL_FULL_INIT_ACCEPTED_IN_TESTED_SET',JSON.stringify({tested,candidateRows:candidates.length}));
}
main().catch(e=>{console.error(e);process.exit(1)});
