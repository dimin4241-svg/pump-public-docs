import {PublicKey, Transaction, TransactionInstruction} from '@solana/web3.js';

const RPC=process.env.SOLANA_RPC||'https://api.mainnet-beta.solana.com';
const PROGRAM=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const GLOBAL=new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const POOL=new PublicKey('GExgczEhUbdNr3V7txqvGrJPu6nt5mbgHXtWFnX8CXeF');
const BASE_MINT=new PublicKey('GdoKrGpaXc6jfrvf9ungdgzKyT1skAro4tk5c9oTpump');
const QUOTE_MINT=new PublicKey('So11111111111111111111111111111111111111112');
const POOL_BASE=new PublicKey('EicGBXGjABiPzHaKApYQ6RQyykW5ajNX2WY3mNfCtwKe');
const POOL_QUOTE=new PublicKey('52UD2WqtcznSoGNjKCcGxQ9KxpYbAD5HTCcr5iMJvUKh');
const BOOST_VAULT_AUTH=new PublicKey('6CjqtX3gFTYzsMBacdGmDK1tzvGmApiHasVKd6BMwsMH');
const BOOST_VAULT=new PublicKey('6Zb2NXg1vDQMDJZkQwo9uR5otMLPwC86R7DF8Yz45FiT');
const TOKEN=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM=new PublicKey('11111111111111111111111111111111');
const ATA=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const EVENT=new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const A=new PublicKey('2jLNDZf3QVdAm7wZiR333ZUpAnNcGV7zkYVxGdXFBB3J');
const B=new PublicKey('HTVZVEQMBsNanubDPTs3CxDAEGNFQHJY8c1441iy2S5r');
const DISC=Buffer.from('8ce9215e845ac28f','hex');
const WATCH=[A,B,POOL_QUOTE,BOOST_VAULT,POOL];

async function rpc(method,params){for(let i=0;i<9;i++){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(r.status===429){await new Promise(x=>setTimeout(x,1000+i*900));continue}const j=await r.json();if(j.error)throw new Error(JSON.stringify(j.error));return j.result}throw new Error('retry exhausted')}
function ix(c){return new TransactionInstruction({programId:PROGRAM,data:DISC,keys:[{pubkey:POOL,isSigner:false,isWritable:true},{pubkey:GLOBAL,isSigner:false,isWritable:false},{pubkey:c,isSigner:true,isWritable:true},{pubkey:BASE_MINT,isSigner:false,isWritable:false},{pubkey:QUOTE_MINT,isSigner:false,isWritable:false},{pubkey:POOL_BASE,isSigner:false,isWritable:false},{pubkey:POOL_QUOTE,isSigner:false,isWritable:true},{pubkey:BOOST_VAULT_AUTH,isSigner:false,isWritable:false},{pubkey:BOOST_VAULT,isSigner:false,isWritable:true},{pubkey:TOKEN,isSigner:false,isWritable:false},{pubkey:SYSTEM,isSigner:false,isWritable:false},{pubkey:ATA,isSigner:false,isWritable:false},{pubkey:EVENT,isSigner:false,isWritable:false},{pubkey:PROGRAM,isSigner:false,isWritable:false}]})}
function amount(ac){if(!ac?.data?.[0])return null;const b=Buffer.from(ac.data[0],'base64');return b.length>=72?b.readBigUInt64LE(64).toString():null}
async function before(){return (await rpc('getMultipleAccounts',[WATCH.map(x=>x.toBase58()),{encoding:'base64',commitment:'processed'}])).value}
async function sim(ixs,payer){const bh=await rpc('getLatestBlockhash',[{commitment:'processed'}]);const tx=new Transaction({feePayer:payer,recentBlockhash:bh.value.blockhash});tx.add(...ixs);const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64');return (await rpc('simulateTransaction',[raw,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'processed',accounts:{encoding:'base64',addresses:WATCH.map(x=>x.toBase58())}}])).value}
function snap(acs){const names=['A_arbitrary','B_boost_authority','pool_quote','boost_vault','pool'];const o={};for(let i=0;i<names.length;i++){o[names[i]]={exists:!!acs[i],lamports:acs[i]?.lamports??null,owner:acs[i]?.owner??null,tokenAmount:(i===2||i===3)?amount(acs[i]):null}}return o}
function deltas(pre,post){const names=['A_arbitrary','B_boost_authority','pool_quote','boost_vault','pool'];const o={};for(let i=0;i<names.length;i++){const pl=BigInt(pre[i]?.lamports??0),ql=BigInt(post[i]?.lamports??0);o[names[i]]={lamports:(ql-pl).toString()};if(i===2||i===3){const pa=BigInt(amount(pre[i])??0),qa=BigInt(amount(post[i])??0);o[names[i]].tokenAmount=(qa-pa).toString()}}return o}
async function main(){const pre=await before();console.log('BEFORE',JSON.stringify(snap(pre),null,2));const cases=[['A_once',[ix(A)],A],['A_A',[ix(A),ix(A)],A],['A_B_payerA',[ix(A),ix(B)],A],['A_B_payerB',[ix(A),ix(B)],B],['B_A_payerB',[ix(B),ix(A)],B],['B_B',[ix(B),ix(B)],B]];for(const [label,ixs,payer] of cases){let v;try{v=await sim(ixs,payer)}catch(e){console.log('CASE',label,'RPCERR',String(e));continue}const post=v.accounts||[];console.log('CASE',JSON.stringify({label,payer:payer.toBase58(),err:v.err,units:v.unitsConsumed,deltas:deltas(pre,post),post:snap(post),logs:v.logs||[]},null,2))}}
main().catch(e=>{console.error(e);process.exit(1)});
