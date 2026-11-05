export function normalizeName(value) {
  if (typeof value !== 'string') throw new Error('Digite seu nome ou apelido.');
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40 || !/^[\p{L}\p{N} ._-]+$/u.test(name)) {
    throw new Error('Use de 2 a 40 letras, números, espaços, pontos ou traços.');
  }
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}

export function latestAnswers(attempts) {
  const result = new Map();
  for (const a of attempts) {
    const old = result.get(a.questionId);
    if (!old || a.answeredAt > old.answeredAt || (a.answeredAt === old.answeredAt && a.id > old.id)) result.set(a.questionId, a);
  }
  return result;
}

export function summarize(questions, attempts) {
  const ids = new Set(questions.map(q => q.id));
  const relevant = attempts.filter(a => ids.has(a.questionId));
  const latest = [...latestAnswers(relevant).values()];
  return {
    total: questions.length,
    answered: latest.length,
    mastered: latest.filter(a => a.correct).length,
    mistakes: latest.filter(a => !a.correct).length,
    attempts: relevant.length,
    accuracy: relevant.length ? Math.round(100 * relevant.filter(a => a.correct).length / relevant.length) : 0,
  };
}

export function reviewQuestions(questions, attempts) {
  const latest = latestAnswers(attempts);
  return questions.filter(q => latest.has(q.id) && !latest.get(q.id).correct);
}

export function shuffled(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function validateLibrary(library) {
  if (library?.version !== 1 || !Array.isArray(library.books) || !library.books.length) throw new Error('Coleção inválida.');
  const ids = new Set();
  const bookIds = new Set();
  const text = v => typeof v === 'string' && v.length > 0 && v.length <= 5000;
  const id = v => typeof v === 'string' && /^[a-z0-9-]{1,80}$/.test(v);
  for (const b of library.books) {
    if (!id(b.id) || bookIds.has(b.id) || !text(b.title) || !text(b.author) || !Array.isArray(b.chapters) || !b.chapters.length) throw new Error('Livro inválido ou ID repetido.');
    bookIds.add(b.id);
    const chapterIds = new Set();
    for (const ch of b.chapters) {
      if (!id(ch.id) || chapterIds.has(ch.id) || !text(ch.title) || !Array.isArray(ch.summary) || !ch.summary.every(text) || !Array.isArray(ch.questions) || !ch.questions.length) throw new Error('Capítulo inválido ou ID repetido.');
      chapterIds.add(ch.id);
      for (const q of ch.questions) {
        if (!id(q.id) || ids.has(q.id) || !text(q.prompt) || !text(q.explanation) || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) throw new Error('Questão inválida ou ID repetido.');
        const choices = new Set(q.options.map(o => o.id));
        if (choices.size !== q.options.length || !choices.has(q.answer) || !q.options.every(o => id(o.id) && text(o.text))) throw new Error('Alternativas inválidas.');
        ids.add(q.id);
      }
      if (ch.flashcards !== undefined && !Array.isArray(ch.flashcards)) throw new Error('Cartões inválidos.');
      for (const card of ch.flashcards || []) {
        if (!id(card.id) || ids.has(card.id) || !text(card.front) || !text(card.back)) throw new Error('Cartão inválido ou ID repetido.');
        ids.add(card.id);
      }
    }
  }
  return library;
}
