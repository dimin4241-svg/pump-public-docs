import {PublicKey,Transaction,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,createAssociatedTokenAccountIdempotentInstruction,createSyncNativeInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';

const RPC='https://api.mainnet-beta.solana.com';
const PROGRAM=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL=new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const EVENT=new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const POOL=new PublicKey('GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J');
const BOOST_AUTH=new PublicKey('HTVZVEQMBsNanubDPTs3CxDAEGNFQHJY8c1441iy2S5r');
const ARB=new PublicKey('2jLNDZf3QVdAm7wZiR333ZUpAnNcGV7zkYVxGdXFBB3J');
const DISC=Buffer.from('8ce9215e845ac28f','hex');
const WSOL=new PublicKey('So11111111111111111111111111111111111111112');

async function rpc(method,params){for(let i=0;i<8;i++){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(r.status===429){await new Promise(x=>setTimeout(x,1000+i*1200));continue;}const j=await r.json();if(j.error)throw new Error(JSON.stringify(j.error));return j.result}throw new Error('retry exhausted')}
const pk=b=>new PublicKey(b).toBase58();
function i128(b,o){const lo=b.readBigUInt64LE(o),hi=b.readBigInt64LE(o+8);return hi*(1n<<64n)+lo}
function pool(v){const b=Buffer.from(v.data[0],'base64');return {len:b.length,creator:pk(b.subarray(11,43)),baseMint:pk(b.subarray(43,75)),quoteMint:pk(b.subarray(75,107)),poolBase:pk(b.subarray(139,171)),poolQuote:pk(b.subarray(171,203)),virtual:i128(b,245).toString()}}
function tok(v){if(!v)return {exists:false};const b=Buffer.from(v.data[0],'base64');return {exists:true,lamports:v.lamports,owner:v.owner,amount:b.length>=72?b.readBigUInt64LE(64).toString():null,tokenOwner:b.length>=64?pk(b.subarray(32,64)):null}}
function init(p,c,va,v){return new TransactionInstruction({programId:PROGRAM,data:DISC,keys:[{pubkey:POOL,isSigner:false,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},{pubkey:c,isSigner:true,isWritable:true},{pubkey:new PublicKey(p.baseMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.quoteMint),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolBase),isSigner:false,isWritable:false},{pubkey:new PublicKey(p.poolQuote),isSigner:false,isWritable:true},{pubkey:va,isSigner:false,isWritable:false},{pubkey:v,isSigner:false,isWritable:true},{pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:ASSOCIATED_TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:EVENT,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}]})}
async function sim(ixs,payer,watch){const bh=(await rpc('getLatestBlockhash',[{commitment:'processed'}])).value.blockhash;const tx=new Transaction({feePayer:payer,recentBlockhash:bh});tx.add(...ixs);const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');return (await rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'processed',accounts:{encoding:'base64',addresses:watch.map(x=>x.toBase58())}}])).value}
function sum(v){const logs=v.logs||[],t=logs.join('\n');return {err:v.err,units:v.unitsConsumed,init:logs.some(x=>x.includes('Instruction: InitBoost')),invalidAdmin:t.includes('InvalidAdmin'),anchorErrors:logs.filter(x=>x.includes('AnchorError')),logs}}
async function main(){
 const pv=(await rpc('getAccountInfo',[POOL.toBase58(),{encoding:'base64',commitment:'processed'}])).value;const p=pool(pv);console.log('CONTROL_POOL',JSON.stringify(p,null,2));if(BigInt(p.virtual)!==0n)throw new Error('control virtual nonzero');if(p.quoteMint!==WSOL.toBase58())throw new Error('quote not WSOL');
 const [va]=PublicKey.findProgramAddressSync([Buffer.from('boost_vault'),POOL.toBuffer()],PROGRAM);const vault=getAssociatedTokenAddressSync(WSOL,va,true,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID);const watch=[POOL,new PublicKey(p.poolQuote),vault];
 const bal=(await rpc('getBalance',[BOOST_AUTH.toBase58(),{commitment:'processed'}])).value;console.log('PAYER_BALANCE',bal);if(bal<20_000_000)throw new Error('known boost authority public account balance too low for simulated rent/funding');
 const emptyArb=await sim([init(p,ARB,va,vault)],BOOST_AUTH,watch);console.log('EMPTY_ARBITRARY',JSON.stringify({s:sum(emptyArb),postPool:emptyArb.accounts?.[0]?pool(emptyArb.accounts[0]):null,postVault:tok(emptyArb.accounts?.[2])},null,2));
 const emptyCreator=await sim([init(p,new PublicKey(p.creator),va,vault)],BOOST_AUTH,watch);console.log('EMPTY_POOL_CREATOR',JSON.stringify({s:sum(emptyCreator),postPool:emptyCreator.accounts?.[0]?pool(emptyCreator.accounts[0]):null,postVault:tok(emptyCreator.accounts?.[2])},null,2));
 const fund=10_000_000;
 const setup=[createAssociatedTokenAccountIdempotentInstruction(BOOST_AUTH,vault,va,WSOL,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID),SystemProgram.transfer({fromPubkey:BOOST_AUTH,toPubkey:vault,lamports:fund}),createSyncNativeInstruction(vault,TOKEN_PROGRAM_ID)];
 const fundedArb=await sim([...setup,init(p,ARB,va,vault)],BOOST_AUTH,watch);console.log('FUNDED_ARBITRARY',JSON.stringify({fund,s:sum(fundedArb),postPool:fundedArb.accounts?.[0]?pool(fundedArb.accounts[0]):null,postVault:tok(fundedArb.accounts?.[2])},null,2));
 const fundedCreator=await sim([...setup,init(p,new PublicKey(p.creator),va,vault)],BOOST_AUTH,watch);console.log('FUNDED_POOL_CREATOR',JSON.stringify({fund,s:sum(fundedCreator),postPool:fundedCreator.accounts?.[0]?pool(fundedCreator.accounts[0]):null,postVault:tok(fundedCreator.accounts?.[2])},null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
