import {
  PublicKey,Transaction,TransactionInstruction,SystemProgram,ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,createSyncNativeInstruction,getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const RPC='https://api.mainnet-beta.solana.com';
const PROGRAM=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL=new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const EVENT=new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const BOOST_AUTH=new PublicKey('HTVZVEQMBsNanubDPTs3CxDAEGNFQHJY8c1441iy2S5r');
const POOL=new PublicKey('GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J');
const WSOL=new PublicKey('So11111111111111111111111111111111111111112');
const INIT=Buffer.from('8ce9215e845ac28f','hex');
const DEPOSIT=Buffer.from([242,35,198,137,82,225,242,182]);
const WITHDRAW=Buffer.from([183,18,70,156,148,109,161,34]);
const BOOST=Buffer.from('694406af000723a2','hex');

async function rpc(method,params){for(let a=0;a<10;a++){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(r.status===429||r.status>=500){await new Promise(x=>setTimeout(x,750+a*850));continue;}const j=await r.json();if(j.error)throw new Error(`${method}: ${JSON.stringify(j.error)}`);return j.result;}throw new Error(`${method}: retries exhausted`);}
const pk=b=>new PublicKey(b).toBase58();
function i128(b,o){const lo=b.readBigUInt64LE(o),hi=b.readBigInt64LE(o+8);return hi*(1n<<64n)+lo;}
function pool(v){if(!v)return null;const b=Buffer.from(v.data[0],'base64');return {creator:pk(b.subarray(11,43)),baseMint:pk(b.subarray(43,75)),quoteMint:pk(b.subarray(75,107)),lpMint:pk(b.subarray(107,139)),poolBase:pk(b.subarray(139,171)),poolQuote:pk(b.subarray(171,203)),lpSupply:b.readBigUInt64LE(203).toString(),virtual:i128(b,245).toString()};}
function tok(v){if(!v)return {exists:false,amount:'0'};const b=Buffer.from(v.data[0],'base64');return {exists:true,ownerProgram:v.owner,lamports:v.lamports,mint:b.length>=72?pk(b.subarray(0,32)):null,owner:b.length>=72?pk(b.subarray(32,64)):null,amount:b.length>=72?b.readBigUInt64LE(64).toString():'0'};}
function mintProgram(owner){if(owner===TOKEN_PROGRAM_ID.toBase58())return TOKEN_PROGRAM_ID;if(owner===TOKEN_2022_PROGRAM_ID.toBase58())return TOKEN_2022_PROGRAM_ID;throw new Error('unsupported token program '+owner);}
async function info(k){return (await rpc('getAccountInfo',[k.toBase58(),{encoding:'base64',commitment:'confirmed'}])).value;}
async function multi(keys){return (await rpc('getMultipleAccounts',[keys.map(k=>k.toBase58()),{encoding:'base64',commitment:'confirmed'}])).value;}
function u64(x){const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(x));return b;}
function ceilDiv(a,b){return (a+b-1n)/b;}
function liquidityKeys(p,user,userBase,userQuote,userLp){return [
 {pubkey:POOL,isSigner:false,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},{pubkey:user,isSigner:true,isWritable:false},
 {pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.lpMint),isSigner:false,isWritable:true},
 {pubkey:userBase,isSigner:false,isWritable:true},{pubkey:userQuote,isSigner:false,isWritable:true},{pubkey:userLp,isSigner:false,isWritable:true},
 {pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:true},{pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},
 {pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:TOKEN_2022_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:EVENT,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}
];}
function depositIx(p,user,userBase,userQuote,userLp,lp,maxBase,maxQuote){return new TransactionInstruction({programId:PROGRAM,data:Buffer.concat([DEPOSIT,u64(lp),u64(maxBase),u64(maxQuote)]),keys:liquidityKeys(p,user,userBase,userQuote,userLp)});}
function withdrawIx(p,user,userBase,userQuote,userLp,lp){return new TransactionInstruction({programId:PROGRAM,data:Buffer.concat([WITHDRAW,u64(lp),u64(0),u64(0)]),keys:liquidityKeys(p,user,userBase,userQuote,userLp)});}
function initIx(p,creator,qProg,va,vault){return new TransactionInstruction({programId:PROGRAM,data:INIT,keys:[{pubkey:POOL,isSigner:false,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},{pubkey:creator,isSigner:true,isWritable:true},{pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},{pubkey:va,isSigner:false,isWritable:false},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:qProg,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:ASSOCIATED_TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:EVENT,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}]});}
function boostIx(p,bProg,qProg,va,vault,quoteIn){return new TransactionInstruction({programId:PROGRAM,data:Buffer.concat([BOOST,u64(quoteIn),u64(0)]),keys:[{pubkey:POOL,isSigner:false,isWritable:false},{pubkey:BOOST_AUTH,isSigner:true,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},{pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:true},{pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:true},{pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},{pubkey:va,isSigner:false,isWritable:false},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:bProg,isSigner:false,isWritable:false},{pubkey:qProg,isSigner:false,isWritable:false},{pubkey:EVENT,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}]});}
async function findFundedBaseHolder(p,bProg){
 const candidates=new Set([p.creator]);
 const sigs=await rpc('getSignaturesForAddress',[POOL.toBase58(),{limit:80,commitment:'confirmed'}]);
 for(const row of sigs||[]){
  if(row.err)continue;let tx;try{tx=await rpc('getTransaction',[row.signature,{encoding:'json',commitment:'confirmed',maxSupportedTransactionVersion:0}]);}catch{continue;}if(!tx)continue;
  for(const x of [...(tx.meta?.preTokenBalances||[]),...(tx.meta?.postTokenBalances||[])])if(x.mint===p.baseMint&&x.owner)candidates.add(x.owner);
  if(candidates.size>=20)break;
 }
 for(const s of candidates){
  let user;try{user=new PublicKey(s);}catch{continue;}
  const av=await info(user);if(!av||av.owner!==SystemProgram.programId.toBase58()||av.lamports<30_000_000)continue;
  const ata=getAssociatedTokenAddressSync(new PublicKey(p.baseMint),user,true,bProg,ASSOCIATED_TOKEN_PROGRAM_ID);const tv=tok(await info(ata));
  if(tv.exists&&tv.mint===p.baseMint&&BigInt(tv.amount)>1000n)return {user,system:av,baseAta:ata,base:tv};
 }
 throw new Error('no recent system wallet with base tokens and enough SOL');
}
async function simulate(ixs,feePayer,watch,bh){const tx=new Transaction({feePayer,recentBlockhash:bh});tx.add(ComputeBudgetProgram.setComputeUnitLimit({units:1_000_000}),...ixs);const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');return rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:false,commitment:'processed',accounts:{encoding:'base64',addresses:watch.map(k=>k.toBase58())}}]);}
function summary(r,names){const v=r?.value||{},logs=v.logs||[],acs=v.accounts||[];return {slot:r?.context?.slot??null,err:v.err??null,units:v.unitsConsumed??null,accounts:Object.fromEntries(names.map((n,i)=>[n,n==='pool'?pool(acs[i]):tok(acs[i])])),anchor:logs.filter(x=>x.includes('AnchorError')),instructions:logs.filter(x=>x.includes('Instruction:')),errors:logs.filter(x=>x.includes('failed:')||x.includes('Error')),logs};}
async function main(){
 const pv=await info(POOL),p=pool(pv);console.log('POOL_PRE',JSON.stringify(p,null,2));if(BigInt(p.virtual)!==0n)throw new Error('control pool no longer virtual=0');if(p.quoteMint!==WSOL.toBase58())throw new Error('quote is not WSOL');
 const [baseMintV,quoteMintV,lpMintV]=await multi([new PublicKey(p.baseMint),new PublicKey(p.quoteMint),new PublicKey(p.lpMint)]);const bProg=mintProgram(baseMintV.owner),qProg=mintProgram(quoteMintV.owner),lpProg=mintProgram(lpMintV.owner);
 const holder=await findFundedBaseHolder(p,bProg),user=holder.user;console.log('USER',JSON.stringify({user:user.toBase58(),solLamports:holder.system.lamports,baseAta:holder.baseAta.toBase58(),baseAmount:holder.base.amount},null,2));
 const creator=new PublicKey(p.creator);const creatorV=await info(creator);const [va]=PublicKey.findProgramAddressSync([Buffer.from('boost_vault'),POOL.toBuffer()],PROGRAM);const vault=getAssociatedTokenAddressSync(WSOL,va,true,qProg,ASSOCIATED_TOKEN_PROGRAM_ID);
 const userQuote=getAssociatedTokenAddressSync(WSOL,user,true,qProg,ASSOCIATED_TOKEN_PROGRAM_ID),userLp=getAssociatedTokenAddressSync(new PublicKey(p.lpMint),user,true,lpProg,ASSOCIATED_TOKEN_PROGRAM_ID);
 const initSetup=[];if(!creatorV||creatorV.owner!==SystemProgram.programId.toBase58())throw new Error('canonical pool creator not a system account in this control');if(creatorV.lamports<3_000_000)initSetup.push(SystemProgram.transfer({fromPubkey:user,toPubkey:creator,lamports:5_000_000}));initSetup.push(initIx(p,creator,qProg,va,vault));
 const watchInit=[POOL,new PublicKey(p.poolBase),new PublicKey(p.poolQuote),vault];const bh0=(await rpc('getLatestBlockhash',[{commitment:'processed'}])).value.blockhash;const initR=await simulate(initSetup,user,watchInit,bh0);const initS=summary(initR,['pool','poolBase','poolQuote','vault']);console.log('INIT_ONLY',JSON.stringify(initS,null,2));if(initS.err!==null)throw new Error('init baseline failed');
 const postP=initS.accounts.pool,postBase=BigInt(initS.accounts.poolBase.amount),postQuote=BigInt(initS.accounts.poolQuote.amount),postVault=BigInt(initS.accounts.vault.amount),S=BigInt(postP.lpSupply);if(postVault<=0n||BigInt(postP.virtual)<=0n)throw new Error('init did not establish BOOST state');
 const userBase=BigInt(holder.base.amount),userSol=BigInt(holder.system.lamports);const maxQuoteBudget=[20_000_000n,userSol/5n].reduce((a,b)=>a<b?a:b);let byBase=(userBase*S)/(postBase*20n);let byQuote=(maxQuoteBudget*S)/(postQuote*2n);let lpOut=byBase<byQuote?byBase:byQuote;if(lpOut<1000n)lpOut=1000n;
 let baseIn=ceilDiv(postBase*lpOut,S),quoteIn=ceilDiv(postQuote*lpOut,S);if(baseIn>userBase/4n)throw new Error(`selected user base too small: need ${baseIn} have ${userBase}`);if(quoteIn>userSol/4n)throw new Error(`selected user SOL too small: need ${quoteIn} have ${userSol}`);
 const maxBase=baseIn+ceilDiv(baseIn,100n)+10n,maxQuote=quoteIn+ceilDiv(quoteIn,100n)+10n;const wrapAmount=maxQuote+2_000_000n;
 let boostQuote=postVault/20n;if(boostQuote>1_000_000_000n)boostQuote=1_000_000_000n;if(boostQuote<1_000_000n)boostQuote=postVault/2n;
 console.log('PLAN',JSON.stringify({lpOut:lpOut.toString(),baseIn:baseIn.toString(),quoteIn:quoteIn.toString(),maxBase:maxBase.toString(),maxQuote:maxQuote.toString(),wrapAmount:wrapAmount.toString(),boostQuote:boostQuote.toString(),postBase:postBase.toString(),postQuote:postQuote.toString(),postVault:postVault.toString(),lpSupply:S.toString()},null,2));
 const common=[...initSetup,createAssociatedTokenAccountIdempotentInstruction(user,userQuote,user,WSOL,qProg,ASSOCIATED_TOKEN_PROGRAM_ID),createAssociatedTokenAccountIdempotentInstruction(user,userLp,user,new PublicKey(p.lpMint),lpProg,ASSOCIATED_TOKEN_PROGRAM_ID),SystemProgram.transfer({fromPubkey:user,toPubkey:userQuote,lamports:Number(wrapAmount)}),createSyncNativeInstruction(userQuote,qProg),depositIx(p,user,holder.baseAta,userQuote,userLp,lpOut,maxBase,maxQuote)];
 const wd=withdrawIx(p,user,holder.baseAta,userQuote,userLp,lpOut),boost=boostIx(p,bProg,qProg,va,vault,boostQuote);
 const watch=[POOL,holder.baseAta,userQuote,userLp,new PublicKey(p.poolBase),new PublicKey(p.poolQuote),vault];const names=['pool','userBase','userQuote','userLp','poolBase','poolQuote','vault'];const bh=(await rpc('getLatestBlockhash',[{commitment:'processed'}])).value.blockhash;
 const [controlR,testR]=await Promise.all([simulate([...common,wd],user,watch,bh),simulate([...common,boost,wd],user,watch,bh)]);const c=summary(controlR,names),t=summary(testR,names);console.log('CONTROL_NO_BOOST_BURN',JSON.stringify(c,null,2));console.log('TEST_WITH_BOOST_BURN',JSON.stringify(t,null,2));
 const result={controlErr:c.err,testErr:t.err,controlSlot:c.slot,testSlot:t.slot,lpOut:lpOut.toString(),boostQuote:boostQuote.toString()};if(c.err===null&&t.err===null){const cb=BigInt(c.accounts.userBase.amount),tb=BigInt(t.accounts.userBase.amount),cq=BigInt(c.accounts.userQuote.amount),tq=BigInt(t.accounts.userQuote.amount);result.userBaseDifference=(tb-cb).toString();result.userQuoteDifference=(tq-cq).toString();result.poolQuoteDifference=(BigInt(t.accounts.poolQuote.amount)-BigInt(c.accounts.poolQuote.amount)).toString();result.vaultDifference=(BigInt(t.accounts.vault.amount)-BigInt(c.accounts.vault.amount)).toString();result.controlLp=c.accounts.userLp.amount;result.testLp=t.accounts.userLp.amount;}
 console.log('DECISIVE',JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
