import fs from 'node:fs';
import {BorshEventCoder} from '@coral-xyz/anchor';
const idl=JSON.parse(fs.readFileSync('idl/pump_amm.json','utf8'));
const coder=new BorshEventCoder(idl);
const samples=[
  // InitBoost event from successful canonical pool init at slot 439447997.
  'rnxK+QRR9hGLcoBqAAAAAF4hZ2YvvpBe0kKca5L4CM1XV7nCv//37K3qhtHBlqLvIvZdDRylMbFegRvbkCI/Nxn6k2SdWnIWjajjL/e1NMLr2JLVXTwteYsNc4UYK0/wxxiuW36mJIcELC2S+40PVRL2L0gTAAAAAAAAAAAAAAD5SRC5CgAAAA==',
  // Events from the correct-authority BoostBuyAndBurn simulation at the same state.
  'Z/RSHyz1d3eLcoBqAAAAAO7jDmK7AwAAvaNcMQAAAAAAAAAAAAAAABL2L0gTAAAAclm7gHdIAgD5SRC5CgAAAL2jXDEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC9o1wxAAAAAL2jXDEAAAAA69iS1V08LXmLDXOFGCtP8McYrlt+piSHBCwtkvuND1U/uUY6WHPYaRMyIjfwUS4n5RzHBFIrFww5DhWYujydhgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAtOxCdP2LPpt/3AOcxC4xjcHPZzw+dD3kvZc6/zVIYvQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQFIle84opRB1OiQmITpiChwbKmzCWG5hbnbodCEuG64AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASAAAAYnV5X2V4YWN0X3F1b3RlX2luAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAS9i9IEwAAAAAAAAAAAAAAAQoTHhcTiQMA',
  'P0UcFjBcwrmLcoBqAAAAAF4hZ2YvvpBe0kKca5L4CM1XV7nCv//37K3qhtHBlqLvIvZdDRylMbFegRvbkCI/Nxn6k2SdWnIWjajjL/e1NMLr2JLVXTwteYsNc4UYK0/wxxiuW36mJIcELC2S+40PVfSEYofB0vyr1vGBX2l/VABW/RZVaGEbANPK6XSCwSxlvaNcMQAAAAC9o1wxAAAAAO7jDmK7AwAAEvYvSBMAAAAAAAAAAAAAALbtbOoKAAAAhHWsHrxEAgBVUtMWEwAAAA=='
];
function clean(x){if(x===null||x===undefined)return x;if(typeof x==='bigint')return x.toString();if(Buffer.isBuffer(x)||x instanceof Uint8Array)return Buffer.from(x).toString('hex');if(Array.isArray(x))return x.map(clean);if(typeof x==='object'){if(typeof x.toBase58==='function')return x.toBase58();const o={};for(const [k,v] of Object.entries(x))o[k]=clean(v);return o;}return x;}
for(const s of samples){let e=null;try{e=coder.decode(s)}catch(err){console.log('DECODE_ERROR',err?.stack||String(err))}console.log('EVENT',JSON.stringify(clean(e),null,2));}
