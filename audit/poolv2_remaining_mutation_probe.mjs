import BN from 'bn.js';
import {Connection,PublicKey,Transaction,TransactionInstruction,ComputeBudgetProgram,SystemProgram} from '@solana/web3.js';
import {OnlinePumpAmmSdk,PUMP_AMM_SDK} from '@pump-fun/pump-swap-sdk';
const RPC='https://api.mainnet-beta.solana.com';
const PROGRAM=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const USER=new PublicKey('7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ');
const POOL=new PublicKey('GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J');
const FOREIGN_BASE=new PublicKey('DnKkDNX1ShRRDDfKj8GtzigLDJFkZ9rugYP4W3V2P3h6');
const pv2=m=>PublicKey.findProgramAddressSync([Buffer.from('pool-v2'),m.toBuffer()],PROGRAM)[0];
const c=new Connection(RPC,'confirmed');
async function rpc(method,params){for(let a=0;a<14;a++){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(r.status===429||r.status>=500){await new Promise(x=>setTimeout(x,300+a*250));continue}const j=await r.json();if(j.error)throw Error(JSON.stringify(j.error));return j.result}throw Error('rpc retries')}
function clone(ix,keys=ix.keys){return new TransactionInstruction({programId:ix.programId,data:Buffer.from(ix.data),keys:keys.map(k=>({...k}))})}
function raw(ix,bh){const t=new Transaction({feePayer:USER,recentBlockhash:bh});t.add(ComputeBudgetProgram.setComputeUnitLimit({units:500000}),ix);return t.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64')}
function tokenAmount(a){if(!a)return null;const b=Buffer.from(a.data[0],'base64');return b.length>=72?b.readBigUInt64LE(64).toString():null}
function summarize(x,watchNames){const v=x?.result?.value||x?.value||{},logs=v.logs||[],acs=v.accounts||[];return {slot:(x?.result?.context?.slot??x?.context?.slot??null),err:v.err??null,units:v.unitsConsumed??null,accounts:Object.fromEntries(watchNames.map((n,i)=>[n,tokenAmount(acs[i])])),anchor:logs.filter(l=>l.includes('AnchorError')||l.includes('Error Code:')),failed:logs.filter(l=>l.includes('failed:')),instructions:logs.filter(l=>l.includes('Instruction:')),logs}}
async function main(){const sdk=new OnlinePumpAmmSdk(c),state=await sdk.swapSolanaState(POOL,USER);console.log('CONFIG',JSON.stringify({coinCreator:state.pool.coinCreator.toBase58(),isCashbackCoin:state.pool.isCashbackCoin,buybackBasisPoints:state.globalConfig?.buybackBasisPoints?.toString?.()??null,buybackFeeRecipients:(state.globalConfig?.buybackFeeRecipients??[]).map(x=>x.toBase58()),lpFeeBasisPoints:state.globalConfig?.lpFeeBasisPoints?.toString?.()??null,protocolFeeBasisPoints:state.globalConfig?.protocolFeeBasisPoints?.toString?.()??null,coinCreatorFeeBasisPoints:state.globalConfig?.coinCreatorFeeBasisPoints?.toString?.()??null},null,2));
 const ixs=await PUMP_AMM_SDK.sellBaseInput(state,new BN(1_000_000),5);const sell=ixs.find(ix=>ix.programId.equals(PROGRAM));if(!sell)throw Error('sell ix missing');console.log('SELL_META',JSON.stringify({keyCount:sell.keys.length,data:sell.data.toString('hex'),keys:sell.keys.map((k,i)=>({i,p:k.pubkey.toBase58(),w:k.isWritable,s:k.isSigner}))},null,2));if(sell.keys.length<24)throw Error('unexpected sell layout');
 const K=sell.keys;const correctPv2=K[21].pubkey, buybackRecip=K[22].pubkey,buybackAta=K[23].pubkey, foreignPv2=pv2(FOREIGN_BASE);
 const cases={
  control:clone(sell),
  foreign_poolv2:clone(sell,K.map((k,i)=>i===21?{...k,pubkey:foreignPv2}:k)),
  system_as_poolv2:clone(sell,K.map((k,i)=>i===21?{...k,pubkey:SystemProgram.programId}:k)),
  omit_poolv2:clone(sell,K.filter((_,i)=>i!==21)),
  swap_poolv2_buyback_recipient:clone(sell,K.map((k,i)=>i===21?{...K[22],isWritable:false,isSigner:false}:i===22?{...K[21],isWritable:false,isSigner:false}:k)),
  omit_buyback_pair:clone(sell,K.slice(0,22)),
  omit_buyback_ata_only:clone(sell,K.slice(0,23)),
  foreign_buyback_recipient:clone(sell,K.map((k,i)=>i===22?{...k,pubkey:USER}:k)),
  foreign_buyback_ata:clone(sell,K.map((k,i)=>i===23?{...k,pubkey:state.userQuoteTokenAccount}:k)),
 };
 const watch=[state.userBaseTokenAccount,state.userQuoteTokenAccount,state.pool.poolBaseTokenAccount,state.pool.poolQuoteTokenAccount,K[17].pubkey,K[10].pubkey,buybackAta];const names=['userBase','userQuote','poolBase','poolQuote','coinCreatorFeeAta','protocolFeeAta','buybackAta'];const bh=(await rpc('getLatestBlockhash',[{commitment:'processed'}])).value.blockhash;const cfg={encoding:'base64',sigVerify:false,replaceRecentBlockhash:false,commitment:'processed',accounts:{encoding:'base64',addresses:watch.map(x=>x.toBase58())}};
 const entries=Object.entries(cases);const payload=entries.map(([name,ix],i)=>({jsonrpc:'2.0',id:i+1,method:'simulateTransaction',params:[raw(ix,bh),cfg]}));let arr;for(let a=0;a<10;a++){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});if(r.status===429||r.status>=500){await new Promise(x=>setTimeout(x,400+a*300));continue}arr=await r.json();break}if(!Array.isArray(arr))throw Error('no batch '+JSON.stringify(arr));const by=new Map(arr.map(x=>[x.id,x]));const out={};for(let i=0;i<entries.length;i++){const [name]=entries[i],res=by.get(i+1);out[name]=res?.error?{rpcError:res.error}:summarize(res,names);console.log('CASE',name,JSON.stringify(out[name],null,2))}
 const ctl=out.control;function delta(c,n){if(!c?.accounts||!ctl?.accounts)return null;const a=ctl.accounts[n],b=c.accounts[n];return a==null||b==null?null:(BigInt(b)-BigInt(a)).toString()}
 console.log('DECISIVE',JSON.stringify({correctPv2:correctPv2.toBase58(),foreignPv2:foreignPv2.toBase58(),buybackRecip:buybackRecip.toBase58(),buybackAta:buybackAta.toBase58(),controlErr:ctl?.err??null,cases:Object.fromEntries(Object.entries(out).map(([n,x])=>[n,{err:x.err??x.rpcError??null,slot:x.slot??null,dUserQuote:delta(x,'userQuote'),dPoolQuote:delta(x,'poolQuote'),dCoinCreatorFee:delta(x,'coinCreatorFeeAta'),dProtocolFee:delta(x,'protocolFeeAta'),dBuybackFee:delta(x,'buybackAta'),anchor:x.anchor??[],failed:x.failed??[]}]))},null,2));}
main().catch(e=>{console.error(e);process.exit(1)});
