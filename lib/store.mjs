import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const dataPath = path.join(ROOT, 'data');
let prisma = null;

async function getPrisma(){
  if(!process.env.DATABASE_URL) return null;
  if(!prisma){ const mod = await import('@prisma/client'); prisma = new mod.PrismaClient(); }
  return prisma;
}

async function readJson(name){ return JSON.parse(await fs.readFile(path.join(dataPath,name),'utf8')); }
async function writeJson(name,data){ await fs.writeFile(path.join(dataPath,name), JSON.stringify(data,null,2)); }

export async function seed(){
  const p = await getPrisma();
  const events = await readJson('events.json');
  const developing = await readJson('developing.json');
  if(!p) return {events:events.length, developing:developing.length, mode:'file'};
  for(const e of events){ await p.event.upsert({where:{id:e.id},update:{...e,date:new Date(e.date),start:e.start?new Date(e.start):null},create:{...e,date:new Date(e.date),start:e.start?new Date(e.start):null}}); }
  for(const d of developing){ await p.developingMatchup.upsert({where:{id:d.id},update:d,create:d}); }
  return {events:events.length, developing:developing.length, mode:'postgres'};
}

export async function listEvents(){
  const p=await getPrisma(); if(p){ return (await p.event.findMany({orderBy:[{date:'asc'},{headline:'asc'}]})).map(e=>({...e,date:e.date.toISOString().slice(0,10),start:e.start?.toISOString()??null})); }
  return readJson('events.json');
}
export async function getEvent(id){ return (await listEvents()).find(e=>e.id===id)??null; }
export async function listDeveloping(){ const p=await getPrisma(); return p? p.developingMatchup.findMany({orderBy:{confidence:'desc'}}):readJson('developing.json'); }

const subFile='subscribers.json', deliveryFile='deliveries.json';
async function fileList(name){ try{return await readJson(name)}catch{return []} }
export async function upsertSubscriber(input){
  const p=await getPrisma();
  if(p) return p.subscriber.upsert({where:{email:input.email},update:input,create:input});
  const rows=await fileList(subFile); let row=rows.find(x=>x.email===input.email);
  if(row) Object.assign(row,input,{updatedAt:new Date().toISOString()}); else {row={id:crypto.randomUUID(),status:'PENDING',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),...input};rows.push(row)}
  await writeJson(subFile,rows); return row;
}
export async function findSubscriberByEmail(email){ const p=await getPrisma(); if(p)return p.subscriber.findUnique({where:{email}}); return (await fileList(subFile)).find(x=>x.email===email)??null; }
export async function findSubscriberByHash(field,hash){ const p=await getPrisma(); if(p)return p.subscriber.findFirst({where:{[field]:hash}}); return (await fileList(subFile)).find(x=>x[field]===hash)??null; }
export async function updateSubscriber(id,data){ const p=await getPrisma(); if(p)return p.subscriber.update({where:{id},data}); const rows=await fileList(subFile); const row=rows.find(x=>x.id===id); if(!row)return null; Object.assign(row,data,{updatedAt:new Date().toISOString()}); await writeJson(subFile,rows); return row; }
export async function activeSubscribers(){ const p=await getPrisma(); if(p)return p.subscriber.findMany({where:{status:'ACTIVE'}}); return (await fileList(subFile)).filter(x=>x.status==='ACTIVE'); }
export async function deliveryExists(key){ const p=await getPrisma(); if(p)return !!(await p.delivery.findUnique({where:{dedupeKey:key}})); return (await fileList(deliveryFile)).some(x=>x.dedupeKey===key); }
export async function logDelivery(data){ const p=await getPrisma(); if(p)return p.delivery.create({data}); const rows=await fileList(deliveryFile); const row={id:crypto.randomUUID(),createdAt:new Date().toISOString(),...data}; rows.push(row); await writeJson(deliveryFile,rows); return row; }
export async function stats(){ const p=await getPrisma(); if(p){ const [events,subs,deliveries]=await Promise.all([p.event.count(),p.subscriber.count({where:{status:'ACTIVE'}}),p.delivery.count({where:{status:'SENT'}})]); return {events,subscribers:subs,deliveries,mode:'postgres'}; } return {events:(await listEvents()).length,subscribers:(await activeSubscribers()).length,deliveries:(await fileList(deliveryFile)).filter(x=>x.status==='SENT').length,mode:'file'}; }
