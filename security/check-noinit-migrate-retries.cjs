const {Connection,PublicKey}=require('@solana/web3.js');
const RPC=process.env.SOLANA_RPC_URL||'https://api.mainnet-beta.solana.com';
const AMM=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const INIT=Buffer.from([140,233,33,94,132,90,194,143]);
const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function dec(s){let a=[0];for(const c of s){let v=A.indexOf(c),q=v;for(let j=0;j<a.length;j++){q+=a[j]*58;a[j]=q&255;q>>=8}while(q){a.push(q&255);q>>=8}}for(let k=0;k<s.length&&s[k]=='1';k++)a.push(0);return Buffer.from(a.reverse())}
function isInit(ix){try{return 'data'in ix&&ix.programId.equals(AMM)&&dec(ix.data).subarray(0,8).equals(INIT)}catch{return false}}
async function tx(c,s){for(let i=0;i<7;i++){try{return await c.getParsedTransaction(s,{commitment:'confirmed',maxSupportedTransactionVersion:0})}catch(e){if(i===6)throw e;await new Promise(r=>setTimeout(r,600*(i+1)))}}}
const cases=[
 {migrateSig:'dxonnk92tqfJkVsA1CKqkR3Z6YNgVoFwFFxSogUiCQZSo3aRLAQGy4VzfKHH4vT6CeMJWaUkHCJFRdtMj9VJPqb',migrateSlot:439027198,pool:'CULKhDwgGe9T7WS2RHavnjF5wx52m5JzCzMnrLjjQRM2',vault:'mAScDwAuD2L392Bh1azNeUa5XAoj3mKpCa8LMQBjtyA'},
 {migrateSig:'gUuigRuMWJg5riUtnTN3sFJ92aN7wvD2N9XBRbLNypxzxqTFTtHQq2cZ3FmLvdpAGdaTJ38QknqyHy4uhj26BGY',migrateSlot:439026070,pool:'8hYdusjywTPVuUnvUgVXArBGiQip5DcAjbnCbdxga1uq',vault:'oRMpv56EirEfbyLVeY2Psehc1G85LcMDEz1wnUfj2YH'},
 {migrateSig:'3aqYSVqWfZM1nztAazfvN1JVt86so4vyLXHRX55Fkp6GwcB3tk8NSDgnVZr4rm1Gf4TPqsE4zF43fKPkvfR1ugiU',migrateSlot:439025771,pool:'DtvCbPv6phTQx3ATfokKeYB8q37rmEyrtmMrD5nfRBSA',vault:'E5qYXci5kQZXsqFkCqrTx7UxQSNLT3J9J1MizneJUJKT'},
 {migrateSig:'Y5sCvsQ9wEqHT8iTQkzgAuFF72vejqFnUCWofrskqNw7VXgrcPe5ds6Y95kcLQxRrzPP5ExTaJcALe3G7Sp83zg',migrateSlot:439025455,pool:'HuP7zfJYS79UtuHvUhfVPzS4nm6jcA8A5wBUfcD16x76',vault:'AQbjz2Db8VzKkn4Laad437LqhB57izvs1J652Tg9YRaL'}
];
async function main(){const c=new Connection(RPC,'confirmed');const out=[];for(const x of cases){const sigs=await c.getSignaturesForAddress(new PublicKey(x.vault),{limit:100},'confirmed');let init=null;for(const s of sigs){const t=await tx(c,s.signature);if(!t)continue;let found=false;for(const ix of t.transaction.message.instructions)if(isInit(ix))found=true;for(const g of t.meta?.innerInstructions||[])for(const ix of g.instructions)if(isInit(ix))found=true;if(found){init={signature:s.signature,slot:s.slot,blockTime:s.blockTime,err:t.meta?.err||null};break}await new Promise(r=>setTimeout(r,150))}out.push({...x,vaultSignatureCount:sigs.length,init,relative:init?(init.slot<x.migrateSlot?'init_before_noinit_retry':init.slot===x.migrateSlot?'same_slot':'init_after_noinit'):null})}console.log('NOINIT_RETRY_CLASSIFICATION_START');console.log(JSON.stringify(out,null,2));console.log('NOINIT_RETRY_CLASSIFICATION_END');const bad=out.filter(x=>!x.init||x.init.slot>x.migrateSlot);if(bad.length)console.log('VERDICT: AT_LEAST_ONE_SUCCESS_NO_INIT_NOT_EXPLAINED_AS_POST_INIT_RETRY');else console.log('VERDICT: ALL_SAMPLED_SUCCESS_NO_INIT_CALLS_ARE_AT_OR_AFTER_AN_INIT_BOOST_HISTORY');}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
