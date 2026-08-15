import BN from 'bn.js';
import {Connection,PublicKey} from '@solana/web3.js';
import {OnlinePumpAmmSdk,PUMP_AMM_SDK} from '@pump-fun/pump-swap-sdk';
const RPC='https://api.mainnet-beta.solana.com';
const PROGRAM=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const USER=new PublicKey('7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ');
const POOLS=[
 ['canonical','GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J','7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump'],
 ['index0-direct','H3yVTyEQWpGCFpR43GMCePDSXpypopTQAqGn6gRiPSjQ','DnKkDNX1ShRRDDfKj8GtzigLDJFkZ9rugYP4W3V2P3h6'],
 ['index1-direct','7oCh7mJuNFrhdfrrWHWoVZKUizDF7JuQC3tTRRpnQz9r','BxZVcxf3qPFKNaaWhzND3jLDnQ8CVB8pqjfi3Mc8MNYA'],
];
const c=new Connection(RPC,'confirmed');
function pv2(m){return PublicKey.findProgramAddressSync([Buffer.from('pool-v2'),new PublicKey(m).toBuffer()],PROGRAM)[0]}
for(const [name,pool,mint] of POOLS){const p=pv2(mint),i=await c.getAccountInfo(p,'confirmed');console.log('POOLV2',JSON.stringify({name,pool,baseMint:mint,poolV2:p.toBase58(),exists:!!i,owner:i?.owner.toBase58()??null,lamports:i?.lamports??null,dataLen:i?.data.length??null,dataHex:i?i.data.toString('hex'):null},null,2));}
const sdk=new OnlinePumpAmmSdk(c);const state=await sdk.swapSolanaState(new PublicKey(POOLS[0][1]),USER);console.log('STATE',JSON.stringify({pool:{baseMint:state.pool.baseMint.toBase58(),quoteMint:state.pool.quoteMint.toBase58(),coinCreator:state.pool.coinCreator.toBase58(),isCashbackCoin:state.pool.isCashbackCoin},poolBaseAmount:state.poolBaseAmount.toString(),poolQuoteAmount:state.poolQuoteAmount.toString(),userBaseTokenAccount:state.userBaseTokenAccount.toBase58(),userQuoteTokenAccount:state.userQuoteTokenAccount.toBase58(),userBaseExists:!!state.userBaseAccountInfo,userQuoteExists:!!state.userQuoteAccountInfo,buybackFeeRecipient:state.buybackFeeRecipient?.toBase58?.()??null},null,2));
const ixs=await PUMP_AMM_SDK.sellBaseInput(state,new BN(1_000_000),5);console.log('IX_COUNT',ixs.length);ixs.forEach((ix,n)=>console.log('IX',n,JSON.stringify({program:ix.programId.toBase58(),data:ix.data.toString('hex'),keys:ix.keys.map((k,j)=>({j,pubkey:k.pubkey.toBase58(),w:k.isWritable,s:k.isSigner}))},null,2)));
