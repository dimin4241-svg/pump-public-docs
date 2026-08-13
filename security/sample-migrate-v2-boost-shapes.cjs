const { Connection, PublicKey } = require('@solana/web3.js');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const WITHDRAW = new PublicKey(process.env.WITHDRAW_AUTHORITY || '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const MIGRATE_V2 = Buffer.from([187,203,18,31,206,237,254,41]);
const INIT_BOOST = Buffer.from([140,233,33,94,132,90,194,143]);
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s){let a=[0];for(const c of s){let v=ALPHABET.indexOf(c);if(v<0)throw 0;let carry=v;for(let j=0;j<a.length;j++){carry+=a[j]*58;a[j]=carry&255;carry>>=8}while(carry){a.push(carry&255);carry>>=8}}for(let k=0;k<s.length&&s[k]==='1';k++)a.push(0);return Buffer.from(a.reverse())}
function match(data,disc){try{const b=b58decode(data);return b.length>=8&&b.subarray(0,8).equals(disc)}catch{return false}}
async function txRetry(c,sig){for(let i=0;i<8;i++){try{return await c.getParsedTransaction(sig,{commitment:'confirmed',maxSupportedTransactionVersion:0})}catch(e){if(i===7)throw e;await new Promise(r=>setTimeout(r,700*(i+1)))}}}
function hasInit(tx,outerIndex){const group=(tx.meta?.innerInstructions||[]).find(x=>x.index===outerIndex);return (group?.instructions||[]).some(ix=>'data'in ix&&ix.programId.equals(AMM)&&match(ix.data,INIT_BOOST)) || (tx.meta?.logMessages||[]).some(x=>x.includes('Instruction: InitBoost'))}
async function main(){
 if(!RPC.includes('mainnet')&&process.env.ALLOW_CUSTOM_RPC!=='1')throw new Error('read-only mainnet expected');
 const c=new Connection(RPC,'confirmed');
 const sigs=await c.getSignaturesForAddress(WITHDRAW,{limit:Number(process.env.SIG_LIMIT||100)},'confirmed');
 console.log(`withdraw_signatures=${sigs.length}`);
 const rows=[];
 for(const s of sigs){
   const tx=await txRetry(c,s.signature); if(!tx)continue;
   const outer=tx.transaction.message.instructions;
   for(let i=0;i<outer.length;i++){
     const ix=outer[i];
     if(!('data'in ix)||!ix.programId.equals(PUMP)||!match(ix.data,MIGRATE_V2))continue;
     rows.push({
       signature:s.signature,slot:s.slot,blockTime:s.blockTime,err:tx.meta?.err||null,
       accountCount:ix.accounts.length,remainingCount:Math.max(0,ix.accounts.length-27),
       baseMint:ix.accounts[2]?.toBase58?.()||null,pool:ix.accounts[10]?.toBase58?.()||null,
       remaining:(ix.accounts.slice(27)||[]).map(x=>x.toBase58()),
       initBoostCpi:hasInit(tx,i),
       logs:(tx.meta?.logMessages||[]).filter(x=>/MigrateV2|InitBoost|NotEnoughRemaining|BOOST|boost/i.test(x)),
     });
   }
   if(rows.length>=Number(process.env.MIGRATE_LIMIT||30))break;
   await new Promise(r=>setTimeout(r,180));
 }
 console.log('MIGRATE_V2_SAMPLE_START');
 console.log(JSON.stringify(rows,null,2));
 console.log('MIGRATE_V2_SAMPLE_END');
 const summary={};
 for(const r of rows){const k=`${r.err?'failed':'success'}_${r.accountCount}acct_${r.initBoostCpi?'init':'noinit'}`;summary[k]=(summary[k]||0)+1}
 console.log('SUMMARY='+JSON.stringify(summary));
 const successBare=rows.filter(r=>!r.err&&r.accountCount===27&&!r.initBoostCpi);
 const failedBare=rows.filter(r=>r.err&&r.accountCount===27);
 console.log(`successful_27_without_init=${successBare.length}`);
 console.log(`failed_27=${failedBare.length}`);
 if(successBare.length) console.log('VERDICT: SUCCESSFUL_BARE_MIGRATE_V2_OBSERVED_WITHOUT_INIT_BOOST');
 else if(failedBare.length) console.log('VERDICT: BARE_27_ACCOUNT_MIGRATIONS_EXIST_BUT_FAIL_IN_SAMPLE');
 else console.log('VERDICT: ALL_SAMPLED_MIGRATIONS_USE_BOOST_REMAINING_ACCOUNTS_OR_SAMPLE_EMPTY');
}
main().catch(e=>{console.error(e.stack||String(e));process.exitCode=1});
