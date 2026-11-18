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
  beginner: `L'utilisateur est DÉBUTANT en anglais. 
- Utilise un vocabulaire simple et des phrases courtes en anglais.
- Fais des corrections simples, bienveillantes et faciles à comprendre en français.
- Propose du vocabulaire utile après chaque échange.`,
  intermediate: `L'utilisateur est de niveau INTERMÉDIAIRE en anglais.
- Engage une conversation naturelle et dynamique.
- Corrige les subtilités, faux-amis et erreurs de grammaire en français avec concision.
- Encourage l'usage d'idiomes et de tournures naturelles anglaises.`,
  advanced: `L'utilisateur est AVANCÉ en anglais.
- Parle comme un locuteur natif avec un vocabulaire riche et varié.
- Relève les erreurs minimes de style ou de registre.
- Explications concises, majoritairement en anglais si pertinent.`
};

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
  session.level = level;
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
  return replyToSession({ ...getUserSession(userId), ...options, history: getUserSession(userId).history }, userMessage, 'telegram', getUserSession(userId));
}

function lastTutorReply(userId) {
  return getUserSession(userId).history.filter(turn => turn.role === 'assistant').at(-1)?.content || '';
}

async function replyToSession(session, userMessage, platform = 'telegram', memory = session) {
  const levelInstruction = LEVEL_PROMPTS[session.level] || LEVEL_PROMPTS.intermediate;

  const systemPrompt = `Tu es "Nova", un tuteur et partenaire d'apprentissage d'anglais bienveillant, chaleureux et très pédagogue ${platform === 'web' ? 'sur le Web' : 'sur Telegram'}.

Ton objectif : Aider l'utilisateur à pratiquer l'anglais quotidiennement avec confiance.

${levelInstruction}
${platform === 'web' ? WEB_GOALS[session.goal] || '' : ''}

PRÉCISION DES CORRECTIONS (TRÈS IMPORTANT) :
- Relis la phrase de l'utilisateur mot par mot avant de répondre.
- Corrige TOUTES les vraies erreurs : conjugaison et temps, accords, articles, prépositions, ordre des mots, vocabulaire, faux-amis, tournures calquées sur le français.
- N'invente JAMAIS d'erreur et ne « corrige » pas une phrase déjà correcte : dans ce cas, dis-le clairement.
- Distingue une vraie faute d'une formulation simplement moins naturelle (« plus naturel : … »).
- Quand il y a des fautes, donne aussi la phrase complète corrigée.
- Garde le sens exact de ce que l'utilisateur voulait dire ; ne change pas son idée.
${session.inputMode === 'voice' ? `
CE MESSAGE VIENT D'UN VOCAL TRANSCRIT AUTOMATIQUEMENT :
- Ignore la ponctuation, les majuscules et les hésitations (euh, hum) : ce ne sont pas des fautes.
- Ne corrige pas l'orthographe, seulement ce qui s'entend : grammaire, vocabulaire, structure.
- Si un mot semble mal reconnu à cause de la prononciation (mot absurde dans le contexte), propose gentiment le mot probable et une astuce de prononciation simple.
- Ajoute un court conseil d'oral (prononciation, rythme ou intonation) quand c'est utile.` : ''}

DIRECTIVES DE MISE EN PAGE ET DE LISIBILITÉ :
⚠️ RÈGLE ABSOLUE : NE FAIS JAMAIS DE GROS BLOCS COMPACTS DE TEXTE.
Sur mobile, l'utilisateur doit pouvoir lire très facilement. ${platform === 'web' ? 'Explique les corrections en français à chaque niveau et réponds en anglais.' : ''} Ta réponse DOIT être très aérée, découpée en plusieurs petits paragraphes courts (1 à 3 phrases maximum) séparés par un saut de ligne vide.

STRUCTURE EXACTE À RESPECTER :

💡 Corrections & Conseils :
• Si l'utilisateur a fait des fautes :
  - ❌ "erreur" → ✅ "correction"
  - Explication courte et claire en français avec des puces et des sauts de ligne.
• Si la phrase de l'utilisateur est parfaite : félicite-le chaleureusement en 1 courte phrase.

💬 Nova :
[Premier paragraphe court en anglais (1 à 2 phrases pour rebondir naturellement)]

[Deuxième paragraphe court en anglais pour développer ou donner un détail intéressant (1 à 2 phrases)]

❓ [Question finale de relance en anglais, isolée sur sa propre ligne pour continuer la discussion]`;

  const userTurn = { role: 'user', content: userMessage };
  const messages = [
    { role: 'system', content: systemPrompt },
    ...session.history.slice(-18),
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

  // Extraire la partie anglaise pour la synthèse vocale
  let spokenEnglish = replyText;
  const match = replyText.match(/💬\s*(?:Nova)?\s*[:\n\-–]?\s*([\s\S]*)/i);
  if (match && match[1]) {
    spokenEnglish = match[1].trim();
  }

  return {
    fullText: replyText,
    spokenEnglish: spokenEnglish
  };
}

/**
 * Génère la note vocale (TTS audio MP3) 100% gratuite pour la réponse en anglais.
 * Parle plus posément et lentement (slow: true) pour que l'utilisateur comprenne distinctement chaque mot.
 */
async function generateSpeech(textToSpeak) {
  try {
    const cleanText = textToSpeak
      .replace(/[*_#`~>]/g, '')
      .replace(/[❓💡❌✅💬•]/gu, '')
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
      slow: true, // Parle plus lentement pour une écoute et prononciation optimales
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
  getUserSession,
  setUserLevel,
  resetUserHistory,
  transcribeAudio,
  getTutorResponse,
  lastTutorReply,
  replyToSession,
  generateSpeech
};
