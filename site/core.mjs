
const n=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
const clamp=(value,low,high)=>Math.min(high,Math.max(low,value));
const round=(value,digits=2)=>Number(value.toFixed(digits));
const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;
const parseJSON=(value,fallback=[])=>{try{return JSON.parse(value)}catch{return fallback}};
const valuesFrom=value=>String(value).split(/[\s,]+/).map(Number).filter(Number.isFinite);
const result=(status,summary,metrics,rows,detail='')=>({status,summary,metrics,rows,detail});
const erf=x=>{const sign=x<0?-1:1,a=Math.abs(x),t=1/(1+0.3275911*a);const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-a*a);return sign*y};
const normalCdf=z=>0.5*(1+erf(z/Math.sqrt(2)));
const wilson=(successes,total)=>{if(!total)return[0,0];const z=1.96,p=successes/total,d=1+z*z/total,c=(p+z*z/(2*total))/d,h=z*Math.sqrt((p*(1-p)+z*z/(4*total))/total)/d;return[clamp(c-h,0,1),clamp(c+h,0,1)]};
const sha256=async value=>{const bytes=new TextEncoder().encode(String(value));const digest=await crypto.subtle.digest('SHA-256',bytes);return[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')};
const tag=(xml,name)=>xml.match(new RegExp('<'+name+'[^>]*>([\\s\\S]*?)<\\/'+name+'>','i'))?.[1]?.trim()??'';
const similarity=(a,b)=>{const x=String(a).toLowerCase(),y=String(b).toLowerCase();if(x===y)return 1;const A=new Set(x.split(/\W+/).filter(Boolean)),B=new Set(y.split(/\W+/).filter(Boolean));const inter=[...A].filter(v=>B.has(v)).length;return inter/Math.max(1,new Set([...A,...B]).size)};

export const meta={"slug":"pacingloop","name":"Pacing Loop","eyebrow":"Campaign controller","description":"Apply a seasonal baseline, damped correction, and spend ceiling to the next budget decision.","fields":[{"name":"targetSpend","label":"Target spend","type":"number","min":0,"max":1000000000,"step":100,"help":""},{"name":"actualSpend","label":"Actual spend","type":"number","min":0,"max":1000000000,"step":100,"help":""},{"name":"seasonalIndex","label":"Seasonal baseline index","type":"number","min":0.1,"max":3,"step":0.01,"help":""},{"name":"gain","label":"Controller gain","type":"number","min":0,"max":2,"step":0.01,"help":""},{"name":"damping","label":"Damping","type":"number","min":0,"max":1,"step":0.01,"help":""},{"name":"ceiling","label":"Maximum adjustment","type":"number","min":0,"max":1,"step":0.01,"help":""}]};
export const initialState={"targetSpend":100000,"actualSpend":78000,"seasonalIndex":0.82,"gain":0.7,"damping":0.45,"ceiling":0.25};
export const alternateState={"targetSpend":100000,"actualSpend":118000,"seasonalIndex":1.18,"gain":0.7,"damping":0.45,"ceiling":0.25};
export async function compute(i){const target=n(i.targetSpend),actual=n(i.actualSpend),season=n(i.seasonalIndex,1),expected=target*season,error=(expected-actual)/Math.max(1,expected),raw=error*n(i.gain)*(1-n(i.damping)),adj=clamp(raw,-n(i.ceiling),n(i.ceiling)),next=actual*(1+adj),normal=Math.abs(error)<.08;return result('Correction calculated',normal?'Observed spend is within the seasonal tolerance; correction remains damped.':`Controller applies a ${round(adj*100)}% bounded adjustment.`,[{label:'Seasonal target',value:`$${Math.round(expected).toLocaleString()}`},{label:'Pacing error',value:`${round(error*100)}%`},{label:'Adjustment',value:`${round(adj*100)}%`},{label:'Next budget',value:`$${Math.round(next).toLocaleString()}`}],[{step:'Raw error',value:round(error,4)},{step:'Gain response',value:round(error*n(i.gain),4)},{step:'After damping',value:round(raw,4)},{step:'After ceiling',value:round(adj,4)}], 'Seasonality is removed before the controller decides whether the campaign is genuinely off pace.')}
