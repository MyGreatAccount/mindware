import { normalizeName, summarize, reviewQuestions, latestAnswers, shuffled, validateLibrary } from './core.mjs';
import { unseal, bytes, deriveHistoryKey, sealRecord, openRecord } from './crypto.mjs';
import { deckStatus, reviewQueue, previewRatings, intervalLabel, ratingLabels } from './srs.mjs';

const root = document.querySelector('#app');
const config = window.MARGEM_CONFIG || {};
const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { library: null, password: '', key: null, token: '', profile: null, attempts: [], pending: [], page: 'library', flash: null, bookId: '', chapterId: '', session: null, error: '', busy: false, sync: 'saved', historyLimit: 40, admin: {token:'',events:[],before:null,busy:false,error:''} };
let syncPromise;
let persistPromise = Promise.resolve();
let readerAbort;
let noticeTimer;
let deckTimer;
const pdfUrls = new Map();
const books = () => state.library?.books || [];
const allQuestions = () => books().flatMap(b => b.chapters.flatMap(ch => ch.questions.map(q => ({ ...q, bookId: b.id, chapterId: ch.id, chapterTitle: ch.title, rules: q.rules || ch.rules }))));
const questionsFor = id => allQuestions().filter(q => !id || q.bookId === id);
const allCards = () => books().flatMap(b => b.chapters.flatMap(ch => (ch.flashcards || []).map(card => ({...card,bookId:b.id,chapterTitle:ch.title,rules:card.rules||ch.rules}))));
const cardsFor = id => allCards().filter(c => !id || c.bookId === id);
const book = () => books().find(b => b.id === state.bookId);

function notice(message) {
  const el = document.querySelector('#notice');
  el.textContent = message; el.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { el.hidden = true; }, 6000);
}
function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function cacheKey() { return 'margem:encrypted-profile:' + state.profile.id; }
function persist() {
  const storageKey = cacheKey(); const key = state.key; const context = 'cache:' + state.profile.id;
  const snapshot = structuredClone({ attempts: state.attempts, pending: state.pending });
  persistPromise = persistPromise.then(async () => {
    try { localStorage.setItem(storageKey, JSON.stringify(await sealRecord(snapshot,key,context))); }
    catch { notice('Não foi possível guardar a cópia criptografada neste navegador. Mantenha a aba aberta até sincronizar.'); }
  });
  return persistPromise;
}
function syncLabel() {
  if (config.preview) return 'Demonstração local';
  return state.sync === 'syncing' ? 'Sincronizando…' : state.pending.length ? `${state.pending.length} resposta${state.pending.length === 1 ? '' : 's'} pendente${state.pending.length === 1 ? '' : 's'}` : 'Progresso sincronizado';
}
function updateSync() {
  const el = document.querySelector('[data-sync]');
  if (el) { el.classList.toggle('pending', !!state.pending.length); el.querySelector('span:last-of-type').textContent = syncLabel(); }
}
async function api(path, method = 'GET', data, token = state.token) {
  const response = await fetch((config.apiBase || '') + '/api' + path, {
    method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: data ? JSON.stringify(data) : undefined, cache: 'no-store', credentials: 'omit',
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || 'Não foi possível acessar a sincronização.');
    error.status = response.status; throw error;
  }
  return result;
}
async function sync() {
  if (!state.token || !state.profile) return;
  if (syncPromise) return syncPromise;
  const profile = state.profile.id;
  state.sync = 'syncing'; updateSync();
  syncPromise = (async () => {
    try {
      while (state.pending.length && state.profile?.id === profile) {
        const chunk = state.pending.slice(0, 50);
        const envelopes = await Promise.all(chunk.map(async a => ({id:a.id,box:await sealRecord(a,state.key,profile+':'+a.id),activity:a.kind==='flashcard'?{action:'card_reviewed',bookId:a.bookId,cardId:a.cardId,rating:a.rating,practice:a.practice}:{action:'question_answered',bookId:a.bookId,questionId:a.questionId,correct:a.correct}})));
        const { saved } = await api('/attempts', 'POST', { attempts: envelopes });
        if (state.profile?.id !== profile) return;
        const ids = new Set(saved);
        state.pending = state.pending.filter(a => !ids.has(a.id)); persist();
      }
      const remote = []; let before = null;
      do {
        const result = await api('/attempts' + (before ? '?before=' + before : ''));
        if (state.profile?.id !== profile) return;
        for (const entry of result.attempts) {
          const answer = await openRecord(entry.box,state.key,profile+':'+entry.id);
          if (answer.id !== entry.id) throw new Error('Registro inválido.');
          remote.push(answer);
        }
        before = result.before;
      } while (before);
      const map = new Map([...remote, ...state.pending].map(a => [a.id, a]));
      state.attempts = [...map.values()]; persist();
      state.sync = 'saved';
    } catch (error) {
      state.sync = 'pending';
      if (error.status === 401) notice('Sua sessão expirou. Saia e entre novamente; as respostas pendentes serão reenviadas.');
    } finally {
      syncPromise = null; updateSync();
      if (state.token && state.profile && (state.profile.id !== profile || (state.sync === 'saved' && state.pending.length))) queueMicrotask(() => sync());
    }
  })();
  return syncPromise;
}
function track(action,details={}) { if(state.token)api('/activity','POST',{action,...details}).catch(()=>{}); }
function pdfUrl(b) {
  if (!b.pdf?.data) return null;
  if (!pdfUrls.has(b.id)) pdfUrls.set(b.id, URL.createObjectURL(new Blob([bytes(b.pdf.data)], { type: 'application/pdf' })));
  return pdfUrls.get(b.id);
}
const cover = b => `<div class="book-cover" aria-hidden="true"><span class="cover-small">${e(b.author)}</span><span class="cover-line">${e(b.coverTitle || b.title)}</span><span class="cover-mark">${e((b.coverTitle || b.title).charAt(0).toLowerCase())}.</span><span class="cover-small">Resumo & prática</span></div>`;
function auth() {
  const choosingName = !!state.library;
  const lastName = '';
  return `<div class="auth"><section class="auth-story" aria-label="mindware"><a class="wordmark" href="./">mindware<span>↗</span></a><div><p class="eyebrow">Um espaço para voltar às ideias</p><h1>Leia.<br>Pratique.<br><em>Faça ficar.</em></h1><p>Seus livros, pequenas revisões e tempo para entender. Sem pressa de terminar.</p><div class="auth-art" aria-hidden="true"><i></i><i>a.</i><i></i></div></div><p class="auth-bottom">Biblioteca compartilhada · estudo no seu ritmo</p></section><main id="main" class="auth-form"><div><span class="tag">${choosingName ? '02 / Seu perfil' : '01 / Nosso espaço'}</span><h1>${choosingName ? 'Como podemos te chamar?' : 'Bom ter você por aqui.'}</h1><p class="muted">${choosingName ? 'Use o mesmo nome em qualquer dispositivo para retomar seu progresso.' : 'Entre com a senha compartilhada para abrir a biblioteca.'}</p><form id="login-form"><label for="login-input">${choosingName ? 'Seu nome ou apelido' : 'Senha do site'}</label><input id="login-input" class="input" name="entry" ${choosingName ? 'type="text" autocomplete="nickname" minlength="2" maxlength="40"' : 'type="password" autocomplete="current-password" maxlength="1024"'} value="${choosingName ? e(lastName) : ''}" required aria-describedby="login-hint login-error" ${state.busy ? 'disabled' : ''}><p class="hint" id="login-hint">${choosingName ? 'Escolha um nome que seus colegas não usem. Aqui são perfis simples, sem senha individual.' : 'O conteúdo só é desbloqueado depois da senha.'}</p><p id="login-error" class="error" role="alert">${e(state.error)}</p><button class="btn primary" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Preparando…' : choosingName ? 'Entrar no meu espaço →' : 'Abrir a biblioteca →'}</button>${choosingName ? '<button class="quiet" type="button" data-action="lock">← Voltar à senha</button>' : ''}</form><p class="footnote">O administrador registra nome, IP e atividade neste espaço.</p>${config.preview ? '<div class="preview-note"><b>Prévia para testar</b><br>Senha: <strong>estudar-juntos-2026</strong><br>O banco desta demonstração é local. A publicação usará sua senha e o banco na nuvem.</div>' : ''}</div></main></div>`;
}
function shell(content) {
  const nav = [['library', '▤', 'Biblioteca'], ['decks', '↺', 'Cartões'], ['progress', '◷', 'Meu progresso'], ['settings', '⚙', 'Meu espaço']];
  return `<div class="shell ${['quiz','reader','flash','flash-result'].includes(state.page) ? 'focus-mode' : ''}"><aside class="sidebar"><a href="#" data-action="nav" data-page="library" class="wordmark">mindware<span>↗</span></a><nav class="nav" aria-label="Principal">${nav.map(([page, icon, label]) => `<button data-action="nav" data-page="${page}" class="${(state.page === page || (page === 'decks' && ['flash','flash-result'].includes(state.page)) || (page === 'library' && ['book','quiz','result'].includes(state.page))) ? 'active' : ''}" ${(state.page === page || (page === 'decks' && ['flash','flash-result'].includes(state.page))) ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="profile"><span class="avatar">${e(state.profile.name.slice(0,2).toUpperCase())}</span><div><div class="profile-name">${e(state.profile.name)}</div><div class="profile-label">Seu espaço de estudo</div></div><button class="quiet" data-action="logout" aria-label="Sair do perfil">↗</button></div></div></aside><div class="content"><header class="topbar"><span class="topbar-label">mindware · treino de racionalidade</span><span class="mobile-brand">mindware ↗</span>${adminOwner()?'<button class="quiet admin-top" data-action="admin">ADM</button>':''}<div class="sync ${state.pending.length ? 'pending' : ''}" data-sync><span class="sync-dot" aria-hidden="true"></span><span>${syncLabel()}</span><button data-action="sync" aria-label="Sincronizar agora">↻</button></div></header><main id="main">${content}</main></div></div>`;
}
function stats(s) {
  return `<div class="stats"><div class="stat"><strong>${s.answered}<small class="muted" style="font:inherit;font-size:.45em"> / ${s.total}</small></strong><span>questões exploradas</span></div><div class="stat"><strong>${s.accuracy}%</strong><span>acertos nas tentativas</span></div><div class="stat"><strong>${s.mistakes}</strong><span>questões para revisar</span></div></div>`;
}
function library() {
  const s = summarize(allQuestions(), state.attempts);
  return `<div class="page-intro"><div><p class="eyebrow">Sua biblioteca de ideias</p><h1>Olá, ${e(state.profile.name.split(' ')[0])}.</h1><p>Escolha um livro para ler ou revisar.</p></div><span class="tag">${books().length} livro${books().length === 1 ? '' : 's'} na estante</span></div><div class="section-label"><h2>Na sua estante</h2><span>Leitura e prática no mesmo lugar</span></div><div class="library-layout"><div class="stack">${books().map(b => {
    const bs = summarize(questionsFor(b.id), state.attempts); const pct = Math.round(100 * bs.mastered / bs.total);
    return `<article class="book-card"><div class="book-top">${cover(b)}<div class="book-info"><span class="tag">${e(b.topic || "Leitura & prática")}</span><h2>${e(b.title)}</h2><p>${e(b.author)}</p><p>${e(b.subtitle)}</p><div class="meta">${b.chapters.length} etapas · ${bs.total} questões · ${b.pdf?.pages ? e(b.pdf.pages) + " páginas de resumo" : "Resumo em PDF"}</div></div></div><div class="book-bottom"><div class="progress-info"><span>${bs.mastered ? `${bs.mastered} questões com último resultado correto` : 'Seu próximo começo está aqui'}</span><span>${pct}%</span></div><div class="track" role="progressbar" aria-label="Questões com último resultado correto" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:${pct}%"></div></div><div class="actions"><button class="btn primary" data-action="book" data-book="${e(b.id)}">${bs.answered ? 'Continuar estudando' : 'Explorar o livro'} <span aria-hidden="true">→</span></button>${pdfUrl(b) ? `<button class="btn secondary" data-action="reader" data-book="${e(b.id)}">Ler o resumo</button>` : ''}</div></div></article>`;
  }).join('')}</div></div><p class="footnote">Cada tentativa fica no seu histórico. Você pode refazer qualquer etapa, quantas vezes quiser.</p>`;
}
function bookView() {
  const b = book(); if (!b) return library();
  const s = summarize(questionsFor(b.id), state.attempts);
  const ch = b.chapters.find(c => c.id === state.chapterId);
  return `<button class="quiet back" data-action="nav" data-page="library">← Sua biblioteca</button><div class="book-heading">${cover(b)}<div><p class="eyebrow">${e(b.author)}</p><h1>${e(b.title)}</h1><p class="muted">${e(b.subtitle)}</p></div></div><div class="book-tools"><button class="btn secondary" data-action="nav" data-page="decks">Cartões de revisão</button>${pdfUrl(b) ? `<button class="btn secondary" data-action="reader" data-book="${e(b.id)}">Ler resumo</button><a class="btn secondary" href="${pdfUrl(b)}" download="${e(b.pdf.filename)}">Baixar PDF ↓</a>` : ''}<button class="btn primary" data-action="practice" data-mode="mixed" data-book="${e(b.id)}">Recapitulação rápida →</button><button class="btn secondary" data-action="practice" data-mode="mistakes" data-book="${e(b.id)}">Revisar erros (${s.mistakes})</button></div>${ch ? `<section class="reading"><p class="eyebrow">Antes da prática · ${e(ch.rules)}</p><h2>${e(ch.title)}</h2>${ch.summary.map(p => `<p>${e(p)}</p>`).join('')}<div class="actions"><button class="btn primary" data-action="practice" data-book="${e(b.id)}" data-chapter="${e(ch.id)}" data-mode="chapter">Praticar esta ideia →</button><button class="quiet" data-action="close-reading">Fechar leitura</button></div></section>` : ''}<div class="section-label"><h2>Seu caminho pelo livro</h2><span>Todas as etapas estão disponíveis</span></div><div class="chapters">${b.chapters.map((ch,i) => {
    const qs = questionsFor(b.id).filter(q => q.chapterId === ch.id); const cs = summarize(qs, state.attempts);
    return `<article class="chapter"><span class="chapter-number ${cs.mastered === qs.length ? 'done' : ''}">${cs.mastered === qs.length ? '✓' : String(i+1).padStart(2,'0')}</span><div><h2>${e(ch.title)}</h2><p>${e(ch.rules)} · ${qs.length} perguntas · ${cs.answered ? `${cs.mastered}/${qs.length} corretas na última tentativa` : 'Ainda não explorado'}</p></div><div class="actions"><button class="quiet" data-action="read" data-chapter="${e(ch.id)}">Ideia-chave</button><button class="btn secondary" data-action="practice" data-mode="chapter" data-book="${e(b.id)}" data-chapter="${e(ch.id)}">${cs.answered ? 'Refazer' : 'Praticar'} →</button></div></article>`;
  }).join('')}</div><p class="footnote">O percentual indica questões com último resultado correto; não é uma medida de domínio definitivo.</p>`;
}
function quiz() {
  const session = state.session; const item = session.questions[session.index];
  const pct = Math.round(100 * session.index / session.questions.length);
  return `<div class="question-wrap"><div class="question-top"><button class="quiet" data-action="leave-quiz">← Encerrar rodada</button><span>${session.index+1} de ${session.questions.length}</span></div><div class="track" role="progressbar" aria-label="Andamento da rodada" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:${pct}%"></div></div><p class="question-meta">${e(item.chapterTitle)} · ${e(item.rules)}</p><h1 tabindex="-1">${e(item.prompt)}</h1><div class="options" role="group" aria-label="Escolha sua resposta">${session.options.map((o,i) => `<button class="option ${session.selected === o.id ? 'selected' : ''} ${session.checked && o.id === item.answer ? 'right' : ''} ${session.checked && session.selected === o.id && o.id !== item.answer ? 'wrong' : ''}" data-action="choose" data-choice="${e(o.id)}" aria-pressed="${session.selected === o.id}" ${session.checked ? 'disabled' : ''}><span class="letter" aria-hidden="true">${String.fromCharCode(65+i)}</span><span>${e(o.text)}</span></button>`).join('')}</div>${session.checked ? `<section class="feedback ${session.selected === item.answer ? '' : 'miss'}" tabindex="-1" aria-label="Explicação da resposta"><h2>${session.selected === item.answer ? '✓ Isso. Vamos entender o porquê.' : '↺ Essa pede uma segunda olhada.'}</h2>${session.selected !== item.answer ? `<p><b>Resposta:</b> ${e(item.options.find(o => o.id === item.answer).text)}</p>` : ''}<p>${e(item.explanation)}</p><small>${e(item.rules)} · ${e(books().find(b => b.id === item.bookId)?.author)}</small></section>` : ''}<div class="exercise-footer"><p>${session.checked ? 'Sua tentativa já está no histórico.' : 'Pense no raciocínio. Não precisa correr.'}</p><button class="btn primary" data-action="${session.checked ? 'next' : 'check'}" ${!session.selected ? 'disabled' : ''}>${session.checked ? session.index+1 === session.questions.length ? 'Concluir rodada →' : 'Próxima pergunta →' : 'Conferir resposta'}</button></div></div>`;
}
function result() {
  const s = state.session; const right = s.results.filter(a => a.correct).length;
  return `<div class="result"><div class="result-symbol" aria-hidden="true">${right === s.results.length ? '✓' : '↗'}</div><p class="eyebrow">Mais uma volta nas ideias</p><h1>${right === s.results.length ? 'Uma boa rodada.' : 'Você avançou.'}</h1><p class="muted">${right} de ${s.results.length} respostas corretas. ${right < s.results.length ? 'As questões que faltaram ficam na sua revisão.' : 'Voltar a essas ideias depois ajuda a mantê-las por perto.'}</p><div class="actions"><button class="btn primary" data-action="again">Refazer a rodada ↺</button><button class="btn secondary" data-action="back-book">Voltar ao livro →</button></div><p class="footnote">${state.pending.length ? 'Há respostas aguardando sincronização. Elas permanecem guardadas neste navegador.' : 'Seu histórico foi atualizado. Refazer não apaga tentativas anteriores.'}</p></div>`;
}
function reader() {
  const b = book();
  return `<section class="pdf-reader"><header class="reader-header"><button class="quiet" data-action="back-book" aria-label="Voltar ao livro">← Voltar</button><h1>${e(b.title)}</h1><a class="quiet" href="${pdfUrl(b)}" download="${e(b.pdf.filename)}">Baixar PDF ↓</a></header><div id="pdf-host" aria-label="Leitor do resumo de ${e(b.author)}"><p class="hint" role="status">Abrindo o PDF…</p></div></section>`;
}
function decks() {
  return `<div class="page-intro"><div><p class="eyebrow">Revisão espaçada</p><h1>Uma ideia por vez.</h1><p>Tente lembrar, revele a resposta e avalie sua lembrança.</p></div></div><div class="deck-list">${books().map(b=>{
    const cards=cardsFor(b.id); if(!cards.length)return '';
    const status=deckStatus(cards,state.attempts); const queue=reviewQueue(cards,state.attempts);
    return `<article class="deck-row"><div><h2>${e(b.title)}</h2><p class="muted">${cards.length} cartões · ${status.due.length} para revisar agora · ${status.newToday} novos para hoje</p>${!queue.length&&status.next?`<p class="hint">Próxima revisão: ${e(status.next.toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}))} (em ${intervalLabel(status.next)}).</p>`:''}</div><div class="actions"><button class="btn primary" data-action="start-cards" data-book="${e(b.id)}" ${!queue.length?'disabled':''}>${queue.length?`Revisar ${queue.length} cartões →`:'Tudo em dia'}</button><button class="quiet" data-action="free-cards" data-book="${e(b.id)}">Treino livre</button></div></article>`;
  }).join('')}</div><p class="footnote">Até 5 cartões novos por livro a cada dia. Revisões vencidas vêm primeiro. O treino livre não muda a agenda.</p>`;
}
function flashcard() {
  const session=state.flash; const card=session.cards[session.index];
  return `<div class="question-wrap flash-wrap"><div class="question-top"><button class="quiet" data-action="end-cards">← Encerrar revisão</button><span>${session.index+1} de ${session.cards.length}</span></div><p class="question-meta">${session.practice?'Treino livre':'Revisão espaçada'} · ${e(card.chapterTitle)}</p><section class="flash-face"><h1 tabindex="-1">${e(card.front)}</h1>${session.revealed?`<div class="flash-answer" tabindex="-1"><p>${e(card.back)}</p><small>${e(card.rules)}</small></div>`:'<p class="hint">Responda mentalmente antes de revelar.</p>'}</section>${session.revealed?`<p class="rating-prompt">Como foi lembrar?</p><div class="rating-actions">${[1,2,3,4].map(r=>`<button class="btn secondary rating-${r}" data-action="rate-card" data-rating="${r}" ${session.saving?'disabled':''}><span>${ratingLabels[r]}</span><small>${session.practice?'Sem mudar a agenda':'Volta em '+intervalLabel(session.previews[r].due,session.previewTime)}</small></button>`).join('')}</div><p class="hint rating-hint">${session.practice?'Este treino não muda a data das próximas revisões.':'Avalie o que lembrou antes de ver a resposta. Quanto mais fácil lembrar, mais tarde o cartão volta.'}</p>`:'<button class="btn primary reveal" data-action="reveal-card">Mostrar resposta</button>'}<p class="footnote keyboard-hint">Espaço revela a resposta · teclas 1–4 avaliam</p></div>`;
}
function flashResult() {
  const session=state.flash;
  return `<div class="result"><div class="result-symbol" aria-hidden="true">✓</div><h1>Rodada concluída.</h1><p class="muted">${session.cards.length} cartões revisados. ${session.practice?'A agenda continua igual.':'As próximas revisões foram programadas.'}</p><div class="actions"><button class="btn primary" data-action="nav" data-page="decks">Voltar aos cartões →</button><button class="btn secondary" data-action="free-cards" data-book="${e(session.bookId)}">Treinar livremente</button></div></div>`;
}
function startCards(bookId,practice=false) {
  const available=cardsFor(bookId);
  const cards=practice?shuffled(available).slice(0,5):reviewQueue(available,state.attempts);
  if(!cards.length){notice('Nenhum cartão para revisar agora. Você pode usar o treino livre.');return;}
  state.flash={id:crypto.randomUUID(),bookId,cards,index:0,practice,revealed:false,saving:false};
  state.page='flash';window.scrollTo(0,0);render();
}
async function rateCard(rating) {
  const session=state.flash;
  if(!session?.revealed||session.saving||![1,2,3,4].includes(rating))return;
  session.saving=true;
  const card=session.cards[session.index];
  const event={id:crypto.randomUUID(),sessionId:session.id,kind:'flashcard',bookId:card.bookId,cardId:card.id,rating,practice:session.practice,answeredAt:new Date().toISOString()};
  state.attempts.push(event);state.pending.push(event);await persist();sync();
  if(++session.index===session.cards.length)state.page='flash-result';
  else{session.revealed=false;session.saving=false;session.previews=null;}
  window.scrollTo(0,0);render();
}
function progress() {
  const qs = allQuestions(); const s = summarize(qs, state.attempts); const map = new Map(qs.map(q => [q.id,q]));
  const history = [...state.attempts].sort((a,b) => b.answeredAt.localeCompare(a.answeredAt));
  const cardMap = new Map(allCards().map(c=>[c.id,c]));
  return `<div class="page-intro"><div><p class="eyebrow">Seu caminho até aqui</p><h1>O que está ficando.</h1><p>Veja suas tentativas e volte às ideias que ainda pedem atenção.</p></div><button class="btn secondary" data-action="practice" data-mode="mistakes">Revisar erros (${s.mistakes}) →</button></div>${stats(s)}<div class="section-label"><h2>Histórico de respostas</h2><span>${history.length} tentativa${history.length === 1 ? '' : 's'}</span></div>${history.length ? `<div class="history">${history.slice(0,state.historyLimit).map(a => {
    const q = map.get(a.questionId);
    if (a.kind === 'flashcard') { const card=cardMap.get(a.cardId); return `<div class="history-row"><span class="muted" aria-hidden="true">↺</span><div><p>${e(card?.front || a.cardId)}</p><small>Cartão · ${e(ratingLabels[a.rating] || 'Revisão')} · ${a.practice ? 'treino livre' : 'revisão agendada'}</small></div><small>${e(new Date(a.answeredAt).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}))}</small></div>`; }
    return `<div class="history-row"><span class="${a.correct ? 'result-correct' : 'result-wrong'}" aria-label="${a.correct ? 'Correta' : 'Incorreta'}">${a.correct ? '✓' : '↺'}</span><div><p>${e(q?.prompt || a.questionId)}</p><small>${e(q?.chapterTitle || a.bookId)} · Sua resposta: ${e(q?.options.find(o => o.id === a.choiceId)?.text || a.choiceId)}</small>${q ? `<details><summary>Rever a explicação</summary><p>${e(q.explanation)}</p></details>` : ''}</div><small>${e(new Date(a.answeredAt).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}))}</small></div>`;
  }).join('')}</div>${history.length > state.historyLimit ? '<button class="btn secondary" style="margin-top:20px" data-action="more-history">Mostrar mais tentativas</button>' : ''}` : '<div class="empty"><h2>A primeira tentativa abre o caminho.</h2><p>Escolha um livro na biblioteca e faça uma rodada curta.</p><button class="btn primary" data-action="nav" data-page="library">Ir à biblioteca →</button></div>'}`;
}
function settings() {
  return `<div class="settings"><p class="eyebrow">Seu espaço</p><h1>Simples, do seu jeito.</h1><section><h2>Você está usando o perfil ${e(state.profile.name)}</h2><p>Entre com o mesmo nome em outro dispositivo para continuar. Maiúsculas, acentos e espaços extras não criam outro perfil. A senha do site é compartilhada; quem a conhece pode entrar usando qualquer nome.</p><button class="btn secondary" data-action="logout">Sair / trocar de perfil →</button></section><section><h2>Seu progresso, guardado</h2><p>As respostas são sincronizadas automaticamente. Se a conexão cair, novas tentativas aguardam neste navegador até você se conectar de novo. Não limpe os dados do navegador enquanto houver respostas pendentes.</p><div class="actions"><button class="btn secondary" data-action="sync">Sincronizar agora ↻</button><button class="quiet" data-action="export">Baixar meu histórico ↓</button></div></section><section><h2>Recomeçar sem perder o caminho</h2><p>Você pode refazer qualquer etapa. Todas as tentativas ficam no histórico; a revisão de erros considera a resposta mais recente de cada questão.</p></section>${adminOwner()?'<section><h2>Administração</h2><button class="quiet" data-action="admin">Abrir painel do administrador →</button></section>':''}<section><h2>Apagar este perfil</h2><p>Remove as respostas deste nome no banco. Os registros de acesso e atividade do administrador permanecem guardados.</p><button class="quiet danger" data-action="delete-profile">Apagar perfil e histórico</button></section></div>`;
}
function activityDescription(item) {
  const d=item.details||{};
  const b=books().find(b=>b.id===d.bookId);
  if(item.action==='card_reviewed')return `${ratingLabels[d.rating]||'Revisou cartão'}${d.practice?' (treino livre)':''} · ${allCards().find(c=>c.id===d.cardId)?.front||d.cardId}`;
  if(item.action==='question_answered')return `${d.correct?'Acertou':'Errou'} · ${allQuestions().find(q=>q.id===d.questionId)?.prompt||d.questionId}`;
  if(item.action==='pdf_page')return `Leu página ${d.page} · ${b?.title||d.bookId}`;
  return ({login:'Entrou no site',logout:'Saiu do perfil',book_open:'Abriu livro',cards_open:'Abriu cartões',backup_export:'Exportou histórico',profile_deleted:'Excluiu o perfil',answer_saved:'Salvou uma resposta'}[item.action]||item.action)+(b?' · '+b.title:'');
}
const adminOwner = () => state.profile && normalizeName(state.profile.name)==='joao';
function adminView() {
  const a=state.admin;
  if(!a.token)return `<div class="admin-login"><p class="eyebrow">Acesso restrito</p><h1>Administração</h1><p class="muted">Perfil joao · use sua senha de administrador.</p><form id="admin-login"><label for="admin-password">Senha de administrador</label><input class="input" id="admin-password" name="password" type="password" autocomplete="current-password" required maxlength="1024" ${a.busy?'disabled':''}><p class="error" role="alert">${e(a.error)}</p><button class="btn primary" ${a.busy?'disabled':''}>${a.busy?'Entrando…':'Abrir painel'}</button></form></div>`;
  return `<div class="page-intro"><div><p class="eyebrow">Acesso restrito</p><h1>Atividade do espaço</h1><p>Nome usado, IP e ações registradas. Sem exclusão automática.</p></div><div class="actions"><button class="btn secondary" data-action="admin-refresh" ${a.busy?'disabled':''}>Atualizar</button><button class="quiet" data-action="admin-exit">Fechar administração</button></div></div><p class="error" role="alert">${e(a.error)}</p><div class="audit-list">${a.events.length?a.events.map(item=>`<article class="audit-row"><div><strong>${e(item.name)}</strong><small>${e(new Date(item.at*1000).toLocaleString('pt-BR'))} · IP ${e(item.ip)}</small></div><p>${e(activityDescription(item))}</p></article>`).join(''):'<p class="muted">Nenhuma atividade registrada ainda.</p>'}</div>${a.before?'<button class="btn secondary" data-action="admin-more">Carregar mais</button>':''}<p class="footnote">Nomes são declarados por quem entra. IPs podem mudar ou ser compartilhados. A navegação é informada pelo navegador; respostas pendentes são registradas quando sincronizam.</p>`;
}
async function loadActivity(append=false) {
  const a=state.admin;if(a.busy)return;
  a.busy=true;a.error='';render(false);
  try {
    const result=await api('/admin/activity'+(append&&a.before?'?before='+a.before:''),'GET',undefined,a.token);
    a.events=append?[...a.events,...result.events]:result.events;a.before=result.before;
  } catch(error) {a.error=error.message;if(error.status===401)a.token='';}
  finally {a.busy=false;render(false);}
}
async function adminLogin(event) {
  event.preventDefault();const a=state.admin;if(a.busy)return;
  let password=new FormData(event.target).get('password');a.busy=true;a.error='';render(false);
  try {const result=await api('/admin/login','POST',{password},state.token);a.token=result.token;}
  catch(error){a.error=error.message;}
  finally{password='';a.busy=false;}
  if(a.token)await loadActivity();else render();
}
function refreshDeckWhenDue() {
  clearTimeout(deckTimer);
  if (!state.profile || state.page !== 'decks') return;
  const snapshot = () => JSON.stringify(books().map(b => {
    const s = deckStatus(cardsFor(b.id),state.attempts);
    return [b.id,s.due.map(c=>c.id),s.newToday];
  }));
  const previous = snapshot();
  const next = books().map(b=>deckStatus(cardsFor(b.id),state.attempts).next).filter(Boolean);
  const delay = Math.max(250,Math.min(60000,...next.map(date=>date-Date.now()+100)));
  deckTimer = setTimeout(() => {
    if (!state.profile || state.page !== 'decks') return;
    if (snapshot() !== previous) render(false);
    else refreshDeckWhenDue();
  },delay);
}
function render(focus = true) {
  readerAbort?.abort(); readerAbort = null;
  const pages = { library, book: bookView, quiz, result, progress, settings, reader, decks, flash:flashcard, 'flash-result':flashResult, admin:adminView };
  root.innerHTML = state.profile ? shell((pages[state.page] || library)()) : auth();
  refreshDeckWhenDue();
  if (state.profile && state.page === 'reader') {
    readerAbort = new AbortController();
    const signal = readerAbort.signal;
    const data = bytes(book().pdf.data);
    const host = document.querySelector('#pdf-host');
    import('./reader.mjs').then(module => { if (!signal.aborted) return module.mountReader(data,host,signal,page=>track('pdf_page',{bookId:state.bookId,page})); }).catch(() => { if (!signal.aborted) host.textContent = 'Não foi possível abrir o leitor. Você pode baixar o PDF.'; });
  }
  if (focus) requestAnimationFrame(() => {
    const target = state.page === 'flash' && state.profile ? document.querySelector(state.flash.revealed?'.flash-answer':'#main h1') : state.page === 'quiz' && state.profile ? document.querySelector(state.session.checked ? '.feedback' : 'h1') : state.profile ? document.querySelector('#main h1') : document.querySelector('#login-input');
    if (target) { if (!target.matches('input')) target.setAttribute('tabindex','-1'); target.focus({preventScroll:true}); }
  });
}
async function login(event) {
  event.preventDefault(); if (state.busy) return;
  const value = new FormData(event.target).get('entry');
  state.error = ''; state.busy = true; render(false);
  try {
    if (!state.library) {
      const response = await fetch('./library.enc.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('A biblioteca ainda não foi preparada para publicação.');
      try { const unlocked = validateLibrary(await unseal(await response.json(), value)); if (typeof unlocked.historySecret !== 'string' || unlocked.historySecret.length < 32) throw new Error('Chave de histórico ausente.'); state.library = unlocked; }
      catch { throw new Error('Senha incorreta ou biblioteca desatualizada. Confira a senha e tente novamente.'); }
      state.password = value;
    } else {
      normalizeName(value);
      const logged = await api('/login', 'POST', { name: value, password: state.password });
      state.profile = logged.profile; state.token = logged.token;
      state.key = await deriveHistoryKey(state.library.historySecret,normalizeName(value));
      state.password = '';
      const encrypted = stored(cacheKey(),null);
      let cached = {attempts:[],pending:[]};
      if (encrypted) {
        try { cached = await openRecord(encrypted,state.key,'cache:'+state.profile.id); }
        catch { notice('A cópia local não pôde ser aberta. Vamos recuperar o histórico da nuvem.'); }
      }
      state.attempts = Array.isArray(cached.attempts) ? cached.attempts : [];
      state.pending = Array.isArray(cached.pending) ? cached.pending : [];
      await sync(); state.page = 'library';
    }
  } catch (error) { state.error = error.message; }
  finally { state.busy = false; render(); }
}
function start(mode, bookId, chapterId) {
  let questions = questionsFor(bookId);
  if (mode === 'chapter') questions = questions.filter(q => q.chapterId === chapterId);
  if (mode === 'mistakes') questions = reviewQuestions(questions, state.attempts);
  if (!questions.length) { notice(mode === 'mistakes' ? 'Nenhum erro pendente por aqui. Você pode fazer uma recapitulação rápida.' : 'Esta etapa ainda não tem questões.'); return; }
  if (mode !== 'chapter') {
    const latest = latestAnswers(state.attempts);
    questions = shuffled(questions).sort((a,b) => (latest.get(a.id)?.correct ? 1 : 0) - (latest.get(b.id)?.correct ? 1 : 0)).slice(0,5);
  }
  beginSession(questions, mode, bookId);
}
function beginSession(questions, mode, bookId) {
  state.bookId = bookId || questions[0].bookId;
  state.session = { id: crypto.randomUUID(), mode, questions: shuffled(questions), index: 0, results: [], selected: null, checked: false };
  state.session.options = shuffled(state.session.questions[0].options);
  state.page = 'quiz'; window.scrollTo(0,0); render();
}
function downloadFile(data, filename, type) {
  const url = URL.createObjectURL(new Blob([data], {type}));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function logout() {
  if (state.pending.length && !confirm('Há respostas pendentes neste navegador. Elas serão reenviadas quando você entrar neste mesmo perfil aqui. Sair agora?')) return;
  await persistPromise;
  track('logout');
  state.admin={token:'',events:[],before:null,busy:false,error:''};
  state.profile = null; state.token = ''; state.password = ''; state.key = null; state.library = null; state.attempts = []; state.pending = []; state.session = null; state.flash = null; state.error = ''; state.page = 'library';
  for (const url of pdfUrls.values()) URL.revokeObjectURL(url); pdfUrls.clear(); render();
}
root.addEventListener('submit', event => { if (event.target.id === 'login-form') login(event); else if(event.target.id==='admin-login')adminLogin(event); });
root.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]'); if (!target) return; event.preventDefault();
  const { action, page, book: bid, chapter, mode, choice } = target.dataset;
  if(action==='admin'){if(!adminOwner())return;state.page='admin';render();if(state.admin.token)await loadActivity();return;}
  if(action==='admin-refresh'||action==='admin-more')return loadActivity(action==='admin-more');
  if(action==='admin-exit'){state.admin={token:'',events:[],before:null,busy:false,error:''};state.page='settings';render();return;}
  if(action==='start-cards'||action==='free-cards')return startCards(bid,action==='free-cards');
  if(action==='end-cards'){state.page='decks';render();return;}
  if(action==='reveal-card'){
    state.flash.previewTime=new Date();
    state.flash.previews=previewRatings(deckStatus(cardsFor(state.flash.bookId),state.attempts).states.get(state.flash.cards[state.flash.index].id),state.flash.previewTime);
    state.flash.revealed=true;render();return;
  }
  if(action==='rate-card')return rateCard(Number(target.dataset.rating));
  if (action === 'lock' || action === 'logout') return logout();
  if (action === 'sync') { await sync(); notice(state.pending.length || state.sync === 'pending' ? 'Ainda sem conexão com o banco. Vamos tentar novamente depois.' : 'Tudo sincronizado.'); if (state.page === 'progress') render(); return; }
  if (action === 'choose') { if (state.session.checked) return; state.session.selected = choice; render(false); document.querySelector(`[data-choice="${CSS.escape(choice)}"]`)?.focus(); return; }
  if (action === 'check') {
    const s = state.session; if (!s.selected || s.checked) return;
    const q = s.questions[s.index]; s.checked = true;
    const attempt = { id: crypto.randomUUID(), sessionId: s.id, bookId: q.bookId, questionId: q.id, choiceId: s.selected, correct: s.selected === q.answer, mode: s.mode, answeredAt: new Date().toISOString() };
    state.attempts.push(attempt); state.pending.push(attempt); s.results.push(attempt); await persist(); sync(); render(); return;
  }
  if (action === 'next') {
    const s = state.session; if (!s.checked) return;
    if (++s.index === s.questions.length) state.page = 'result';
    else { s.selected = null; s.checked = false; s.options = shuffled(s.questions[s.index].options); }
    window.scrollTo(0,0); render(); return;
  }
  if (action === 'leave-quiz') { if (!confirm('Encerrar esta rodada? As respostas já conferidas continuam salvas.')) return; state.page = 'book'; }
  if (action === 'nav') {
    if (state.page === 'quiz' && !confirm('Sair da rodada? As respostas já conferidas continuam salvas.')) return;
    state.page = page; state.chapterId = ''; if(page==='decks')track('cards_open');
  }
  if (action === 'reader') { state.bookId = bid; state.page = 'reader'; }
  if (action === 'book') { state.bookId = bid; state.page = 'book'; state.chapterId = ''; track('book_open',{bookId:bid}); }
  if (action === 'back-book') { state.page = 'book'; state.chapterId = ''; }
  if (action === 'read') { state.chapterId = chapter; window.scrollTo(0,0); }
  if (action === 'close-reading') state.chapterId = '';
  if (action === 'practice') return start(mode, bid, chapter);
  if (action === 'again') return beginSession(state.session.questions, state.session.mode, state.bookId);
  if (action === 'more-history') state.historyLimit += 40;
  if (action === 'export') { track('backup_export'); const box = await sealRecord({attempts:state.attempts},state.key,'export:'+state.profile.id); downloadFile(JSON.stringify({profileId:state.profile.id,box},null,2), 'mindware-historico-criptografado.json', 'application/json'); return; }
  if (action === 'delete-profile') {
    if (!confirm(`Apagar todas as respostas de ${state.profile.name}? Esta ação não pode ser desfeita pelo site.`)) return;
    try { await persistPromise; await sync(); if (state.sync === 'pending') throw new Error('Conecte-se para apagar seu perfil com segurança.'); await persistPromise; await api('/profile', 'DELETE'); localStorage.removeItem(cacheKey()); state.pending = []; await logout(); }
    catch (error) { notice(error.message); } return;
  }
  render();
});
window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
render();
document.addEventListener('keydown',event=>{
  if(!state.profile||state.page!=='flash'||event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.target.matches('input,textarea,select'))return;
  if(event.code==='Space'&&!state.flash.revealed){event.preventDefault();document.querySelector('[data-action="reveal-card"]')?.click();}
  else if(state.flash.revealed&&['1','2','3','4'].includes(event.key)){event.preventDefault();rateCard(Number(event.key));}
});
