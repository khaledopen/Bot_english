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

/**
 * Transcrit un message vocal audio (Buffer OGG Telegram) via Groq Whisper (ultra-rapide et gratuit)
 */
async function transcribeAudio(audioBuffer) {
  try {
    const file = await toFile(audioBuffer, 'voice.ogg', { type: 'audio/ogg' });
    const response = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3-turbo',
    });
    return response.text;
  } catch (error) {
    console.error('Erreur transcription Groq Whisper:', error);
    throw new Error("Impossible de transcrire le message vocal. Vérifie ta clé GROQ_API_KEY.");
  }
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
async function getTutorResponse(userId, userMessage) {
  const session = getUserSession(userId);
  const levelInstruction = LEVEL_PROMPTS[session.level] || LEVEL_PROMPTS.intermediate;

  const systemPrompt = `Tu es "Nova", un tuteur et partenaire d'apprentissage d'anglais bienveillant, chaleureux et très pédagogue sur Telegram.

Ton objectif : Aider l'utilisateur à pratiquer l'anglais quotidiennement avec confiance.

${levelInstruction}

DIRECTIVES DE MISE EN PAGE ET DE LISIBILITÉ :
⚠️ RÈGLE ABSOLUE : NE FAIS JAMAIS DE GROS BLOCS COMPACTS DE TEXTE.
Sur Telegram mobile, l'utilisateur doit pouvoir lire très facilement. Ta réponse DOIT être très aérée, découpée en plusieurs petits paragraphes courts (1 à 3 phrases maximum) séparés par un saut de ligne vide.

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

  // Ajoute le message à l'historique
  session.history.push({ role: 'user', content: userMessage });

  // On conserve les 20 derniers échanges
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...session.history
  ];

  const completion = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages,
    temperature: 0.7,
  });

  const rawReplyText = completion.choices[0].message.content;
  const replyText = formatTutorReply(rawReplyText);
  session.history.push({ role: 'assistant', content: replyText });

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
  generateSpeech
};
