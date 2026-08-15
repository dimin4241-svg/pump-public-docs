import {PublicKey,Transaction,TransactionInstruction,ComputeBudgetProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,createAssociatedTokenAccountIdempotentInstruction,createBurnInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';

const RPC='https://api.mainnet-beta.solana.com';
const PROGRAM=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL=new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const EVENT=new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const POOL=new PublicKey('H3yVTyEQWpGCFpR43GMCePDSXpypopTQAqGn6gRiPSjQ');
const PAYER=new PublicKey('7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ');
const INIT=Buffer.from('8ce9215e845ac28f','hex');

async function rpc(method,params){for(let a=0;a<10;a++){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(r.status===429||r.status>=500){await new Promise(x=>setTimeout(x,600+a*750));continue;}const j=await r.json();if(j.error)throw new Error(`${method}: ${JSON.stringify(j.error)}`);return j.result;}throw new Error(`${method}: retries exhausted`);}
const pk=b=>new PublicKey(b).toBase58();
function i128(b,o){const lo=b.readBigUInt64LE(o),hi=b.readBigInt64LE(o+8);return hi*(1n<<64n)+lo;}
function decodePool(v){const b=Buffer.from(v.data[0],'base64');return {index:b.readUInt16LE(9),creator:pk(b.subarray(11,43)),baseMint:pk(b.subarray(43,75)),quoteMint:pk(b.subarray(75,107)),lpMint:pk(b.subarray(107,139)),poolBase:pk(b.subarray(139,171)),poolQuote:pk(b.subarray(171,203)),lpSupply:b.readBigUInt64LE(203).toString(),virtual:i128(b,245).toString()};}
function decodeToken(v){if(!v)return {exists:false,amount:'0'};const b=Buffer.from(v.data[0],'base64');return {exists:true,program:v.owner,lamports:v.lamports,mint:b.length>=32?pk(b.subarray(0,32)):null,owner:b.length>=64?pk(b.subarray(32,64)):null,amount:b.length>=72?b.readBigUInt64LE(64).toString():'0'};}
function decodeMint(v){const b=Buffer.from(v.data[0],'base64');return {program:v.owner,supply:b.readBigUInt64LE(36).toString(),decimals:b[44]};}
function tokenProgram(owner){if(owner===TOKEN_PROGRAM_ID.toBase58())return TOKEN_PROGRAM_ID;if(owner===TOKEN_2022_PROGRAM_ID.toBase58())return TOKEN_2022_PROGRAM_ID;throw new Error(`unsupported token program ${owner}`);}
async function info(k){return (await rpc('getAccountInfo',[k.toBase58(),{encoding:'base64',commitment:'confirmed'}])).value;}
function initIx(p,creator,quoteProgram,vaultAuth,vault){return new TransactionInstruction({programId:PROGRAM,data:INIT,keys:[
 {pubkey:POOL,isSigner:false,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},{pubkey:creator,isSigner:true,isWritable:true},
 {pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},
 {pubkey:vaultAuth,isSigner:false,isWritable:false},{pubkey:vault,isSigner:false,isWritable:true},{pubkey:quoteProgram,isSigner:false,isWritable:false},
 {pubkey:new PublicKey('11111111111111111111111111111111'),isSigner:false,isWritable:false},{pubkey:ASSOCIATED_TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:EVENT,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}
]});}
async function simulate(ixs,watch){const bh=(await rpc('getLatestBlockhash',[{commitment:'processed'}])).value.blockhash;const tx=new Transaction({feePayer:PAYER,recentBlockhash:bh});tx.add(ComputeBudgetProgram.setComputeUnitLimit({units:500000}),...ixs);const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');return rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'processed',accounts:{encoding:'base64',addresses:watch.map(x=>x.toBase58())}}]);}
function summarize(r,names){const v=r?.value||{},a=v.accounts||[],logs=v.logs||[];return {slot:r?.context?.slot??null,err:v.err??null,accounts:Object.fromEntries(names.map((n,i)=>[n,n==='pool'?decodePool(a[i]):n==='lpMint'?decodeMint(a[i]):decodeToken(a[i])])),anchor:logs.filter(x=>x.includes('AnchorError')),instructions:logs.filter(x=>x.includes('Instruction:')),errors:logs.filter(x=>x.includes('failed:')||x.includes('Error')),logs};}
async function main(){
 const p=decodePool(await info(POOL));if(p.index!==0||BigInt(p.virtual)!==0n)throw new Error(`unexpected target state ${JSON.stringify(p)}`);
 const creator=new PublicKey(p.creator),lpMint=new PublicKey(p.lpMint),quoteMint=new PublicKey(p.quoteMint),lpMintV=await info(lpMint),quoteMintV=await info(quoteMint),lpProg=tokenProgram(lpMintV.owner),qProg=tokenProgram(quoteMintV.owner),lpState=decodeMint(lpMintV);
 const creatorLp=getAssociatedTokenAddressSync(lpMint,creator,true,lpProg,ASSOCIATED_TOKEN_PROGRAM_ID),creatorLpState=decodeToken(await info(creatorLp));
 const [vaultAuth]=PublicKey.findProgramAddressSync([Buffer.from('boost_vault'),POOL.toBuffer()],PROGRAM),vault=getAssociatedTokenAddressSync(quoteMint,vaultAuth,true,qProg,ASSOCIATED_TOKEN_PROGRAM_ID),preVault=decodeToken(await info(vault)),preQuote=decodeToken(await info(new PublicKey(p.poolQuote)));
 const locked=BigInt(p.lpSupply)-BigInt(lpState.supply);
 console.log('PRE',JSON.stringify({pool:p,lpMint:lpState,lockedLp:locked.toString(),creatorLp:creatorLp.toBase58(),creatorLpState,poolQuote:preQuote,vault:preVault,vaultAuth:vaultAuth.toBase58()},null,2));
 const precreate=createAssociatedTokenAccountIdempotentInstruction(PAYER,vault,vaultAuth,quoteMint,qProg,ASSOCIATED_TOKEN_PROGRAM_ID),init=initIx(p,creator,qProg,vaultAuth,vault),watch=[POOL,lpMint,creatorLp,new PublicKey(p.poolQuote),vault];
 const control=summarize(await simulate([precreate,init],watch),['pool','lpMint','creatorLp','poolQuote','vault']);
 console.log('CONTROL_INIT',JSON.stringify(control,null,2));
 const result={control:{err:control.err,postVirtual:control.accounts.pool.virtual,postQuote:control.accounts.poolQuote.amount,postVault:control.accounts.vault.amount},burnTest:null};
 if(creatorLpState.exists&&creatorLpState.owner===creator.toBase58()&&BigInt(creatorLpState.amount)>10000n){
   const burn=BigInt(creatorLpState.amount)/10n;
   const burnIx=createBurnInstruction(creatorLp,lpMint,creator,burn,[],lpProg);
   const test=summarize(await simulate([precreate,burnIx,init],watch),['pool','lpMint','creatorLp','poolQuote','vault']);
   const movedToVault=BigInt(test.accounts.vault.amount)-BigInt(control.accounts.vault.amount);
   const quoteDifference=BigInt(test.accounts.poolQuote.amount)-BigInt(control.accounts.poolQuote.amount);
   const expectedBurnedClaim=(BigInt(preQuote.amount)*burn)/BigInt(p.lpSupply);
   result.burnTest={burn:burn.toString(),err:test.err,postVirtual:test.accounts.pool.virtual,postQuote:test.accounts.poolQuote.amount,postVault:test.accounts.vault.amount,movedToVault:movedToVault.toString(),quoteDifference:quoteDifference.toString(),expectedBurnedQuoteClaimFloor:expectedBurnedClaim.toString(),movedVsBurnClaimBps:expectedBurnedClaim>0n?((movedToVault*10000n)/expectedBurnedClaim).toString():null};
   console.log('BURN_THEN_INIT',JSON.stringify(test,null,2));
 }
 console.log('DECISIVE',JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
