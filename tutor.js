require('dotenv').config();
const Groq = require('groq-sdk');
const { toFile } = require('groq-sdk');
const googleTTS = require('google-tts-api');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Mémoire des conversations par utilisateur : userId -> { level, history }
const userSessions = new Map();

const LEVEL_PROMPTS = {
  beginner: `NIVEAU : DÉBUTANT (A1–A2). Cette personne connaît peu de mots. Elle doit TOUJOURS comprendre ce que tu écris, sinon elle se décourage.
TON ANGLAIS (partie 💬 Nova) :
- 1 ou 2 phrases très courtes (6 à 10 mots maximum chacune).
- Uniquement des mots très courants (les 1 000 mots les plus fréquents) : like, have, go, eat, work, family, today, good…
- Temps simples uniquement : présent simple, présent continu, « can », et passé simple des verbes très courants (went, had, was, did). Pas de conditionnel, pas de present perfect, pas de passif.
- Aucun idiome, aucun phrasal verb, aucune expression familière, aucune abréviation.
- Juste après ton anglais, ajoute une ligne qui commence par « 🇫🇷 » avec la traduction en français.
LA QUESTION :
- Une seule question, très simple, fermée ou à choix (« Do you like…? », « Coffee or tea? »), puis une ligne « 🇫🇷 » avec sa traduction.
- Puis une ligne « 👉 Tu peux répondre : » avec un modèle de réponse court en anglais que la personne peut recopier et adapter.
LES CORRECTIONS :
- Corrige seulement les 1 ou 2 fautes les plus importantes (celles qui gênent la compréhension). Ignore les petits détails.
- Explique en français très simple, sans jargon grammatical (pas de « auxiliaire » ni de « COD » : dis plutôt « avec I, on dit am »).
- Donne toujours la phrase corrigée complète, et encourage chaleureusement : chaque effort compte.
SI LA PERSONNE ÉCRIT EN FRANÇAIS ou dit qu'elle ne comprend pas : rassure-la, donne la phrase à dire en anglais (avec sa traduction), puis repose une question encore plus simple.`,
  intermediate: `NIVEAU : INTERMÉDIAIRE (B1–B2). Cette personne se débrouille, mais manque d'aisance et de naturel.
TON ANGLAIS (partie 💬 Nova) :
- 2 ou 3 phrases naturelles, de longueur moyenne (10 à 18 mots).
- Vocabulaire courant et varié. Tu peux utiliser une expression ou un phrasal verb fréquent, mais explique-le à la fin de la phrase entre parenthèses avec son sens en français, par exemple : (to look forward to = avoir hâte de).
- Tous les temps courants sont permis (present perfect, would, could, used to…). Évite les tournures littéraires ou rares.
- Pas de traduction complète en français.
LA QUESTION : une seule question ouverte qui pousse à répondre par des phrases complètes (« Why…? », « How was…? », « What would you do if…? »).
LES CORRECTIONS :
- Corrige toutes les vraies fautes, de façon concise.
- Signale les faux-amis et les tournures calquées sur le français, et propose la version plus naturelle (« plus naturel : … »).
- Explications courtes, en français.`,
  advanced: `NIVEAU : AVANCÉ (C1–C2). Cette personne parle bien et veut affiner son anglais.
TON ANGLAIS (partie 💬 Nova) :
- Parle comme un locuteur natif : vocabulaire riche et précis, idiomes, collocations, registres variés, humour léger quand le sujet s'y prête.
- 2 à 4 phrases ; tu peux nuancer, argumenter et relancer le débat.
- Aucune traduction en français.
LA QUESTION : une seule question ouverte et stimulante (opinion, hypothèse, nuance) qui demande une réponse développée.
LES CORRECTIONS :
- Relève aussi les erreurs fines : collocations, prépositions, registre, ordre des mots, naturel, ton.
- Propose des alternatives plus idiomatiques ou plus soutenues (« a native speaker would rather say… »).
- Si la phrase est correcte mais améliorable, propose une version plus élégante.
- Explications très brèves ; tu peux les écrire en anglais simple, avec le mot-clé en français si besoin.`,
};

// Bloc de corrections commun : on montre OÙ est l'erreur, puis la phrase entière corrigée
const CORRECTION_BLOCK = {
  beginner: `💡 Corrections :
📍 Ta phrase : [recopie la phrase de l'utilisateur à l'identique, en entourant CHAQUE partie fautive de ⟦ ⟧]
• ⟦partie fautive⟧ → ✅ correction : explication très simple en français, en une phrase (1 ou 2 fautes maximum)
✍️ Phrase corrigée : [la phrase entière, corrigée]
(Si la phrase est correcte : « ✅ Phrase correcte : [sa phrase] » puis une courte félicitation en français.)`,
  intermediate: `💡 Corrections :
📍 Ta phrase : [recopie la phrase de l'utilisateur à l'identique, en entourant CHAQUE partie fautive de ⟦ ⟧]
• ⟦partie fautive⟧ → ✅ correction : explication courte en français (une ligne par faute ; ajoute « plus naturel : … » pour un calque du français)
✍️ Phrase corrigée : [la phrase entière, corrigée et naturelle]
(Si la phrase est correcte : « ✅ Phrase correcte : [sa phrase] » et une courte félicitation.)`,
  advanced: `💡 Corrections :
📍 Ta phrase : [recopie la phrase de l'utilisateur à l'identique, en entourant CHAQUE partie fautive ou maladroite de ⟦ ⟧]
• ⟦partie fautive⟧ → ✅ formulation plus juste ou plus idiomatique : explication très brève
✍️ Phrase corrigée : [la phrase entière, dans sa meilleure version]
(Si la phrase est impeccable : « ✅ Phrase correcte : [sa phrase] » puis, si possible, une variante plus élégante.)`,
};

const LEVEL_STRUCTURES = {
  beginner: `${CORRECTION_BLOCK.beginner}

💬 Nova :
[1 ou 2 phrases très courtes en anglais]
🇫🇷 [traduction française de ces phrases]

❓ [une seule question très simple en anglais]
🇫🇷 [traduction française de la question]
👉 Tu peux répondre : « [modèle de réponse court en anglais] »`,
  intermediate: `${CORRECTION_BLOCK.intermediate}

💬 Nova :
[Premier paragraphe court en anglais (1 à 2 phrases pour rebondir naturellement)]

[Deuxième paragraphe court en anglais pour développer (1 phrase), avec l'explication entre parenthèses d'une éventuelle expression]

❓ [Une seule question ouverte en anglais, isolée sur sa propre ligne]`,
  advanced: `${CORRECTION_BLOCK.advanced}

💬 Nova :
[Premier paragraphe en anglais naturel et riche (1 à 2 phrases)]

[Deuxième paragraphe en anglais qui nuance ou approfondit (1 à 2 phrases)]

❓ [Une seule question ouverte et stimulante en anglais, isolée sur sa propre ligne]`,
};

// Défis réguliers : traduire un mot, prononcer une phrase, comprendre une expression
const CHALLENGE_LEVELS = {
  beginner: `Choisis UN défi de niveau débutant, avec des mots très courants :
- « 🎯 Défi : Comment dit-on « [mot français simple : une pomme, la cuisine, j'ai faim…] » en anglais ? »
- ou « 🎯 Défi prononciation : Lis cette phrase à voix haute et envoie-moi un vocal 🎙️ » suivi d'une ligne « 🔊 [phrase anglaise très courte, 4 à 7 mots] »
- ou « 🎯 Défi : Que veut dire « [mot ou expression très simple : Nice to meet you, I'm starving…] » ? »
Ajoute ensuite une ligne « 💡 Indice : … » en français (première lettre, mot qui ressemble, etc.).`,
  intermediate: `Choisis UN défi de niveau intermédiaire :
- « 🎯 Défi : Comment dit-on « [expression française courante : avoir hâte, se débrouiller, ça vaut le coup…] » en anglais ? »
- ou « 🎯 Défi prononciation : Lis cette phrase à voix haute et envoie-moi un vocal 🎙️ » suivi d'une ligne « 🔊 [phrase avec des sons difficiles pour un francophone : th, h aspiré, -ed, voyelles longues/courtes] »
- ou « 🎯 Défi : Que veut dire « [phrasal verb ou expression : to run out of, it's up to you, to call it a day…] » ? »`,
  advanced: `Choisis UN défi de niveau avancé :
- « 🎯 Défi : Comment dirais-tu « [tournure française nuancée ou idiomatique : poser un lapin, avoir le cafard, c'est la goutte d'eau…] » en anglais ? »
- ou « 🎯 Défi prononciation : Lis cette phrase à voix haute et envoie-moi un vocal 🎙️ » suivi d'une ligne « 🔊 [phrase exigeante : accent tonique, mots piégeux comme thorough, comfortable, Worcestershire, rythme] »
- ou « 🎯 Défi : Que veut dire « [idiome ou expression soutenue : to beat around the bush, a blessing in disguise…] » et dans quel contexte l'utiliser ? »`,
};

function challengeInstructions(level, { challenge, answering, inputMode }) {
  const parts = [];
  if (answering) parts.push(`L'UTILISATEUR RÉPOND PEUT-ÊTRE À TON DERNIER DÉFI (ligne 🎯 de ta réponse précédente) :
- Si c'est le cas, ajoute AVANT « 💬 Nova » une section « 🎯 Résultat du défi : » :
  • ✅ Bravo ou ❌ Pas tout à fait, en le disant gentiment.
  • La bonne réponse, avec son explication en français : sens, quand l'utiliser, et un exemple de phrase en anglais.
  • Pour un mot ou une phrase à prononcer : une astuce de prononciation simple, écrite « à la française » (ex. : thought → « ssôt », langue entre les dents).
${inputMode === 'voice' ? '  • C\'était un vocal : compare ce que tu as reçu (transcription) à la phrase demandée ; un mot différent signale souvent un son mal prononcé, explique lequel et comment le corriger.' : '  • Si c\'était un défi de prononciation et qu\'il a répondu par écrit, encourage-le à envoyer un vocal 🎙️.'}
- S'il ignore le défi et parle d'autre chose, n'insiste pas : donne quand même la réponse en une ligne dans « 🎯 Résultat du défi ».`);
  if (challenge) parts.push(`DONNE UN NOUVEAU DÉFI DANS CETTE RÉPONSE :
- Place-le à la toute fin, À LA PLACE de la ligne ❓ (pas de question en plus : le défi est la question).
- ${CHALLENGE_LEVELS[level]}
- Le défi doit rester adapté au niveau et, si possible, lié au sujet de la conversation.`);
  else parts.push('PAS DE NOUVEAU DÉFI dans cette réponse : termine par la question ❓ habituelle.');
  return parts.join('\n\n');
}

// Message d'ouverture d'une nouvelle conversation après un changement de niveau
const LEVEL_OPENERS = {
  beginner: `🔄 Nouvelle conversation · Niveau Débutant 🟢

Je vais parler simplement : phrases courtes, mots faciles et traduction en français. Tu peux aussi m'écrire en français si tu bloques.

💬 Nova :
Hello! Let's start again. 😊
🇫🇷 Bonjour ! On recommence.

❓ What is your name?
🇫🇷 Comment tu t'appelles ?
👉 Tu peux répondre : « My name is … »`,
  intermediate: `🔄 Nouvelle conversation · Niveau Intermédiaire 🟡

Je parle plus naturellement, j'explique les expressions entre parenthèses et je corrige toutes tes fautes.

💬 Nova :
Great, let's start a fresh conversation! I'm curious to hear how your week is going.

❓ What did you do last weekend?`,
  advanced: `🔄 Nouvelle conversation · Niveau Avancé 🔴

Anglais natif, sans traduction, avec des corrections fines de style et de registre.

💬 Nova:
Brilliant, let's raise the bar a little. I'll be picky about nuance and natural phrasing from now on.

❓ If you could master any skill overnight, what would it be, and why?`,
};

const normalizeLevel = level => (LEVEL_PROMPTS[level] ? level : 'intermediate');

// Partie à lire à voix haute : uniquement l'anglais de Nova, sans traductions ni aides en français
function spokenPart(replyText = '') {
  const match = replyText.match(/💬\s*(?:Nova)?\s*[:\n\-–]?\s*([\s\S]*)/i);
  const english = match?.[1] ? match[1] : replyText;
  return english
    .split('\n')
    .filter(line => !/^\s*(?:🇫🇷|👉|🎯|💡)/u.test(line))
    .map(line => line.replace(/^\s*🔊\s*/u, ''))
    .join('\n')
    .replace(/\s*\([^()]*=[^()]*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

const WEB_GOALS = {
  speaking: "Privilégie des formulations faciles à dire et des questions pour pratiquer l’oral.",
  everyday: "Privilégie les situations et le vocabulaire de la vie quotidienne.",
  professional: "Propose des formulations adaptées au travail quand le sujet s’y prête.",
  interviews: "Aide à formuler des réponses et des exemples utiles en entretien quand le sujet s’y prête.",
  grammar: "Accorde une attention particulière à la grammaire et au vocabulaire.",
};

function getUserSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      level: 'intermediate',
      history: []
    });
  }
  return userSessions.get(userId);
}

function setUserLevel(userId, level) {
  const session = getUserSession(userId);
  session.level = normalizeLevel(level);
  session.levelChosen = true;
  return session.level;
}

// Reprend le niveau mémorisé (base de données) au premier message après un redémarrage du bot
async function restoreUserLevel(userId, loadLevel) {
  const session = getUserSession(userId);
  if (session.levelChecked || session.levelChosen || typeof loadLevel !== 'function') return session.level;
  session.levelChecked = true;
  try {
    const saved = await loadLevel(String(userId));
    if (saved && LEVEL_PROMPTS[saved]) session.level = saved;
  } catch {}
  return session.level;
}

function resetUserHistory(userId) {
  const session = getUserSession(userId);
  session.history = [];
}

// Consigne donnée à Whisper : garder les fautes de l'apprenant au lieu de les corriger.
const LEARNER_PROMPT = 'An English learner, often a French speaker, is practising spoken English with a tutor. '
  + 'Transcribe exactly what the speaker says, word for word, keeping every grammar mistake, for example: '
  + '"Yesterday I go to the cinema and I have see a very good film, it was very interesting for me." '
  + 'Do not correct, translate or summarise.';
const HALLUCINATION = /^(?:thanks? (?:you )?(?:so much )?for watching[.!]?|thank you[.!]?|subtitles? by.*|.*amara\.org.*|you[.!]?|bye[.!]?|[.\s…]+)$/i;

function englishPart(reply = '') {
  const match = reply.match(/💬\s*(?:Nova)?\s*[:\n\-–]?\s*([\s\S]*)/i);
  return (match?.[1] || reply).replace(/[❓💡❌✅💬•*_]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Transcrit un vocal avec Groq Whisper Large v3 (le plus précis), en anglais, sans corriger l'apprenant.
 * `context` : dernière réponse du tuteur, pour aider à reconnaître les mots du sujet en cours.
 */
async function transcribeAudio(audioBuffer, extension = 'ogg', type = 'audio/ogg', context = '') {
  const tutorLine = englishPart(context).slice(-280);
  const prompt = tutorLine ? `${LEARNER_PROMPT} The tutor just said: "${tutorLine}"` : LEARNER_PROMPT;
  let response;
  let lastError;
  for (const model of ['whisper-large-v3', 'whisper-large-v3-turbo']) {
    try {
      const file = await toFile(audioBuffer, `voice.${extension}`, { type });
      response = await groq.audio.transcriptions.create({
        file, model, language: 'en', temperature: 0, prompt, response_format: 'verbose_json',
      });
      break;
    } catch (error) {
      lastError = error;
      console.warn(`Transcription ${model} indisponible :`, error?.message || error);
    }
  }
  if (!response) {
    console.error('Erreur transcription Groq Whisper:', lastError);
    throw new Error("Impossible de transcrire le message vocal. Vérifie ta clé GROQ_API_KEY.");
  }
  const segments = Array.isArray(response.segments) ? response.segments : [];
  // Écarte les passages où Whisper « invente » du texte sur du silence ou du bruit.
  const spoken = segments.length
    ? segments.filter(part => !(part.no_speech_prob > 0.6 && part.avg_logprob < -0.8)).map(part => part.text).join(' ')
    : response.text || '';
  const text = spoken.replace(/\s+/g, ' ').trim();
  if (!text || HALLUCINATION.test(text) || (text.length > 20 && prompt.includes(text))) return '';
  return text;
}

function formatTutorReply(rawText) {
  if (!rawText) return '';
  return rawText
    // Supprimer les délimiteurs markdown bruts type --- ou ===
    .replace(/^---+$/gm, '')
    .replace(/^===+$/gm, '')
    // Assurer un saut de ligne propre avant les sections principales
    .replace(/([^\n])\n(💡\s*Corrections)/gi, '$1\n\n$2')
    .replace(/([^\n])\n(💬\s*Nova)/gi, '$1\n\n$2')
    .replace(/([^\n])\n(❓)/gi, '$1\n\n$2')
    // Éviter plus de 2 sauts de ligne successifs
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Génère la réponse du tuteur d'anglais avec Groq
 */
async function getTutorResponse(userId, userMessage, options = {}) {
  const session = getUserSession(userId);
  return replyToSession({ ...session, ...challengeState(session.history), ...options, history: session.history }, userMessage, 'telegram', session);
}

// Un défi toutes les trois réponses ; on signale aussi quand l'utilisateur répond au défi précédent
function challengeState(history = []) {
  const replies = history.filter(turn => turn.role === 'assistant')
  const answers = replies.filter(turn => !turn.opener).length
  return { challenge: answers % 3 === 2, answeringChallenge: /🎯\s*Défi/u.test(replies.at(-1)?.content || '') }
}

// Nouvelle conversation après un changement de niveau (Telegram)
function startLevelConversation(userId, level) {
  const session = getUserSession(userId);
  session.level = normalizeLevel(level);
  session.levelChosen = true;
  session.history = [{ role: 'assistant', content: LEVEL_OPENERS[session.level], opener: true }];
  return LEVEL_OPENERS[session.level];
}

function lastTutorReply(userId) {
  return getUserSession(userId).history.filter(turn => turn.role === 'assistant').at(-1)?.content || '';
}

async function replyToSession(session, userMessage, platform = 'telegram', memory = session) {
  const level = normalizeLevel(session.level);
  const levelInstruction = LEVEL_PROMPTS[level];

  const systemPrompt = `Tu es "Nova", un tuteur et partenaire d'apprentissage d'anglais bienveillant, chaleureux et très pédagogue ${platform === 'web' ? 'sur le Web' : 'sur Telegram'}.

Ton objectif : Aider l'utilisateur à pratiquer l'anglais quotidiennement avec confiance.

${levelInstruction}
${platform === 'web' ? WEB_GOALS[session.goal] || '' : ''}

RESPECT DU NIVEAU (PRIORITAIRE) :
- Adapte TOUTE ta réponse (vocabulaire, longueur, corrections, question) au niveau ci-dessus, à chaque message.
- Applique ce niveau même si l'historique contient des réponses d'un autre niveau : l'utilisateur a pu changer de niveau.
- Si l'utilisateur semble perdu, simplifie encore ; s'il est très à l'aise, reste malgré tout dans le cadre de son niveau.

PRÉCISION DES CORRECTIONS (TRÈS IMPORTANT) :
- Relis la phrase de l'utilisateur mot par mot avant de répondre.
- Corrige TOUTES les vraies erreurs : conjugaison et temps, accords, articles, prépositions, ordre des mots, vocabulaire, faux-amis, tournures calquées sur le français.
- N'invente JAMAIS d'erreur et ne « corrige » pas une phrase déjà correcte : dans ce cas, dis-le clairement.
- Distingue une vraie faute d'une formulation simplement moins naturelle (« plus naturel : … »).
- Montre TOUJOURS où est l'erreur : recopie la phrase de l'utilisateur dans « 📍 Ta phrase : » en entourant chaque partie fautive de ⟦ ⟧ (exemple : « Yesterday I ⟦go⟧ to the market »), puis explique chaque faute, puis donne la phrase entière corrigée dans « ✍️ Phrase corrigée : ».
- Les marques ⟦ ⟧ ne servent QUE dans la ligne 📍 et les puces d'erreur ; n'en mets jamais ailleurs.
- S'il a écrit plusieurs phrases, ne recopie dans 📍 que celles qui contiennent une faute.
- Garde le sens exact de ce que l'utilisateur voulait dire ; ne change pas son idée.
${session.inputMode === 'voice' ? `
CE MESSAGE VIENT D'UN VOCAL TRANSCRIT AUTOMATIQUEMENT :
- Ignore la ponctuation, les majuscules et les hésitations (euh, hum) : ce ne sont pas des fautes.
- Ne corrige pas l'orthographe, seulement ce qui s'entend : grammaire, vocabulaire, structure.
- Si un mot semble mal reconnu à cause de la prononciation (mot absurde dans le contexte), propose gentiment le mot probable et une astuce de prononciation simple.
- Ajoute un court conseil d'oral (prononciation, rythme ou intonation) quand c'est utile.` : ''}

DÉFIS :
${challengeInstructions(level, { challenge: !!session.challenge, answering: !!session.answeringChallenge, inputMode: session.inputMode })}

DIRECTIVES DE MISE EN PAGE ET DE LISIBILITÉ :
⚠️ RÈGLE ABSOLUE : NE FAIS JAMAIS DE GROS BLOCS COMPACTS DE TEXTE.
Sur mobile, l'utilisateur doit pouvoir lire très facilement. Ta réponse DOIT être très aérée, découpée en plusieurs petits paragraphes courts (1 à 3 phrases maximum) séparés par un saut de ligne vide.

STRUCTURE EXACTE À RESPECTER :

${LEVEL_STRUCTURES[level]}`;

  const userTurn = { role: 'user', content: userMessage };
  const messages = [
    { role: 'system', content: systemPrompt },
    ...session.history.slice(-18).map(({ role, content }) => ({ role, content })),
    userTurn,
  ];

  const completion = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages,
    temperature: 0.5,
  });

  const rawReplyText = completion.choices[0].message.content;
  const replyText = formatTutorReply(rawReplyText);
  if (!replyText) throw new Error('Empty tutor response');
  memory.history.splice(0, Math.max(0, memory.history.length - 18));
  memory.history.push(userTurn);
  memory.history.push({ role: 'assistant', content: replyText });

  return {
    fullText: replyText,
    spokenEnglish: spokenPart(replyText) || replyText,
    level,
  };
}

/**
 * Génère la note vocale (TTS audio MP3) 100% gratuite pour la réponse en anglais.
 * Parle plus posément et lentement (slow: true) pour que l'utilisateur comprenne distinctement chaque mot.
 */
async function generateSpeech(textToSpeak, { slow = true } = {}) {
  try {
    const cleanText = String(textToSpeak || '')
      .split('\n').filter(line => !/^\s*(?:🇫🇷|👉|🎯|💡)/u.test(line)).join('\n')
      .replace(/\s*\([^()]*=[^()]*\)/g, '')
      .replace(/[*_#`~>]/g, '')
      .replace(/[❓💡❌✅💬•🔊⟦⟧]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanText) return null;

    // Découper proprement jusqu'à 350 caractères pour une note vocale claire, concise et pédagogique
    const maxChars = 350;
    let targetText = cleanText;
    if (targetText.length > maxChars) {
      const lastSentenceIndex = targetText.lastIndexOf('.', maxChars);
      if (lastSentenceIndex > 100) {
        targetText = targetText.substring(0, lastSentenceIndex + 1);
      } else {
        targetText = targetText.substring(0, maxChars);
      }
    }

    const audioList = await googleTTS.getAllAudioBase64(targetText, {
      lang: 'en',
      slow, // plus lent pour débutants et intermédiaires, vitesse naturelle pour le niveau avancé
      host: 'https://translate.google.com',
      timeout: 10000,
    });

    const audioBuffers = audioList.map(item => Buffer.from(item.base64, 'base64'));
    return Buffer.concat(audioBuffers);
  } catch (error) {
    console.error('Erreur génération TTS:', error);
    return null;
  }
}

module.exports = {
  LEVEL_OPENERS,
  challengeState,
  startLevelConversation,
  normalizeLevel,
  getUserSession,
  setUserLevel,
  restoreUserLevel,
  resetUserHistory,
  transcribeAudio,
  getTutorResponse,
  lastTutorReply,
  replyToSession,
  generateSpeech
};
