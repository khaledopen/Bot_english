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

/**
 * Génère la réponse du tuteur d'anglais avec Groq LLaMA 3.3 70B
 */
async function getTutorResponse(userId, userMessage) {
  const session = getUserSession(userId);
  const levelInstruction = LEVEL_PROMPTS[session.level] || LEVEL_PROMPTS.intermediate;

  const systemPrompt = `Tu es "Nova", un tuteur et partenaire d'apprentissage d'anglais bienveillant, chaleureux et très pédagogue sur Telegram.

Ton objectif : Aider l'utilisateur à pratiquer l'anglais quotidiennement avec confiance.

${levelInstruction}

RÈGLES D'OR DE RÉPONSE :
1. Si l'utilisateur fait des erreurs en anglais (grammaire, orthographe, tournures bizarres) :
   - Ajoute une section "💡 Corrections :" courte et encourageante (en français si niveau débutant/intermédiaire) en montrant la bonne formulation.
   - Si la phrase de l'utilisateur était parfaite, félicite-le brièvement !
2. Dans la section "💬 English :", réponds à ce qu'il a dit en anglais de façon naturelle, vivante et intéressante.
3. Termine TOUJOURS par une question ouverte ou une relance en anglais pour que l'utilisateur continue de converser.
4. Si l'utilisateur parle en français pour poser une question sur l'anglais, réponds à sa question puis réenchaîne en anglais.

Format de réponse attendu :
---
💡 Corrections & Conseils :
[Tes corrections bienveillantes ou félicitations]

💬 Nova :
[Ta réponse en anglais + question pour continuer]
---`;

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

  const replyText = completion.choices[0].message.content;
  session.history.push({ role: 'assistant', content: replyText });

  // Extraire la partie anglaise pour la synthèse vocale
  let spokenEnglish = replyText;
  const match = replyText.match(/💬\s*(?:Nova\s*)?:([\s\S]*)/i);
  if (match && match[1]) {
    spokenEnglish = match[1].trim();
  }

  return {
    fullText: replyText,
    spokenEnglish: spokenEnglish
  };
}

/**
 * Génère la note vocale (TTS audio MP3) 100% gratuite pour la réponse en anglais
 */
async function generateSpeech(textToSpeak) {
  try {
    const cleanText = textToSpeak
      .replace(/[*_#`\-]/g, '')
      .replace(/\n+/g, ' ')
      .trim();

    if (!cleanText) return null;

    // Découper si le texte est très long pour l'API TTS
    const shortText = cleanText.length > 200 ? cleanText.substring(0, 200) : cleanText;

    const base64Audio = await googleTTS.getAudioBase64(shortText, {
      lang: 'en',
      slow: false,
      host: 'https://translate.google.com',
      timeout: 10000,
    });

    return Buffer.from(base64Audio, 'base64');
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
