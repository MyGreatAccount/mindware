import { createEmptyCard, fsrs } from './vendor/ts-fsrs.mjs';

// Parâmetros fixos deixam a reconstrução por eventos igual em todos os dispositivos.
const scheduler=fsrs({request_retention:.9,enable_fuzz:false,learning_steps:['1m','10m'],relearning_steps:['10m']});
export const ratingLabels={1:'Errei',2:'Acertei com dificuldade',3:'Acertei',4:'Acertei na hora'};
const valid=e=>e?.kind==='flashcard'&&!e.practice&&typeof e.id==='string'&&typeof e.cardId==='string'&&[1,2,3,4].includes(e.rating)&&Number.isFinite(Date.parse(e.answeredAt));
const byTime=(a,b)=>a.answeredAt.localeCompare(b.answeredAt)||a.id.localeCompare(b.id);
export function studyDay(date) {
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
export function buildSchedules(cards,events) {
  const ids=new Set(cards.map(c=>c.id));
  const states=new Map();
  const seen=new Set();
  for(const event of events.filter(e=>valid(e)&&ids.has(e.cardId)).sort(byTime)) {
    if(seen.has(event.id))continue;
    seen.add(event.id);
    const now=new Date(event.answeredAt);
    const card=states.get(event.cardId)||createEmptyCard(now);
    states.set(event.cardId,scheduler.next(card,now,event.rating).card);
  }
  return states;
}
export function previewRatings(card,now=new Date()) {
  const previews=scheduler.repeat(card||createEmptyCard(now),now);
  return Object.fromEntries([1,2,3,4].map(r=>[r,previews[r].card]));
}
export function deckStatus(cards,events,now=new Date()) {
  const states=buildSchedules(cards,events);
  const ids=new Set(cards.map(c=>c.id));
  const introduced=new Map();
  for(const event of events.filter(e=>valid(e)&&ids.has(e.cardId)).sort(byTime))if(!introduced.has(event.cardId))introduced.set(event.cardId,event.answeredAt);
  const today=studyDay(now);
  const introducedToday=[...introduced.values()].filter(date=>studyDay(new Date(date))===today).length;
  const fresh=cards.filter(c=>!states.has(c.id));
  const due=cards.filter(c=>states.has(c.id)&&states.get(c.id).due<=now).sort((a,b)=>states.get(a.id).due-states.get(b.id).due);
  const next=[...states.values()].map(c=>c.due).filter(d=>d>now).sort((a,b)=>a-b)[0]||null;
  return {states,due,fresh,newToday:Math.min(fresh.length,Math.max(0,5-introducedToday)),next};
}
export function reviewQueue(cards,events,now=new Date()) {
  const status=deckStatus(cards,events,now);
  return [...status.due,...status.fresh.slice(0,status.newToday)].slice(0,5);
}
export function intervalLabel(date,now=new Date()) {
  const minutes=Math.max(1,Math.ceil((date-now)/60000));
  if(minutes<60)return `${minutes} min`;
  if(minutes<1440)return `${Math.round(minutes/60)} h`;
  const days=Math.round(minutes/1440);
  return `${days} ${days===1?'dia':'dias'}`;
}
