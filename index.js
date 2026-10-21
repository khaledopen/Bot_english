require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const {
  getUserSession,
  setUserLevel,
  resetUserHistory,
  transcribeAudio,
  getTutorResponse,
  generateSpeech
} = require('./tutor');

// Serveur HTTP léger indispensable pour Render Free Web Service
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('English Coach Telegram Bot is alive and running! 🚀\n');
}).listen(PORT, () => {
  console.log(`🌐 Serveur HTTP actif sur le port ${PORT} (compatible Render)`);
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;

if (!BOT_TOKEN) {
  console.error("❌ ERREUR : La variable TELEGRAM_BOT_TOKEN est manquante dans le fichier .env !");
  console.error("Veuillez renseigner votre token Telegram dans .env");
  process.exit(1);
}

if (!GROQ_KEY) {
  console.warn("⚠️ ATTENTION : La variable GROQ_API_KEY est manquante dans .env.");
  console.warn("Ajoute ta clé Groq gratuite (commence par gsk_...) depuis https://console.groq.com");
}

const bot = new Telegraf(BOT_TOKEN);

// Commande /start
bot.start(async (ctx) => {
  const session = getUserSession(ctx.from.id);
  const welcomeText = `🇬🇧 *Welcome to your English Coach Bot!*

Salut ${ctx.from.first_name || 'ami'} ! Je suis ton compagnon quotidien pour t'aider à progresser en anglais en toute confiance.

✨ *Ce que nous pouvons faire ensemble :*
• 💬 **Écrire en texte** : Parle-moi de ta journée, pose-moi des questions, entraîne-toi à écrire.
• 🎙️ **Envoyer des notes vocales** : Enregistre un message vocal en anglais, je t'écouterai, te corrigerai et te répondrai avec ma propre voix pour que tu améliores ton écoute et ton accent !
• 💡 **Corrections instantanées** : À chaque message, je t'explique tes erreurs avec bienveillance.

Niveau actuel : *${session.level.toUpperCase()}*

Choisis ton niveau ou commence dès maintenant en m'envoyant un message (texte ou vocal) !`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Débutant (Beginner)', 'lvl_beginner')],
    [Markup.button.callback('🟡 Intermédiaire (Intermediate)', 'lvl_intermediate')],
    [Markup.button.callback('🔴 Avancé (Advanced)', 'lvl_advanced')]
  ]);

  await ctx.replyWithMarkdown(welcomeText, keyboard);
});

// Commande /level
bot.command(['level', 'niveau'], async (ctx) => {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Débutant (Beginner)', 'lvl_beginner')],
    [Markup.button.callback('🟡 Intermédiaire (Intermediate)', 'lvl_intermediate')],
    [Markup.button.callback('🔴 Avancé (Advanced)', 'lvl_advanced')]
  ]);
  await ctx.reply('🎯 Sélectionne ton niveau actuel d\'anglais :', keyboard);
});

// Actions de changement de niveau
bot.action(/^lvl_(beginner|intermediate|advanced)$/, async (ctx) => {
  const level = ctx.match[1];
  setUserLevel(ctx.from.id, level);
  await ctx.answerCbQuery();
  
  const labels = {
    beginner: '🟢 Débutant (Beginner)',
    intermediate: '🟡 Intermédiaire (Intermediate)',
    advanced: '🔴 Avancé (Advanced)'
  };

  await ctx.editMessageText(
    `✅ Niveau configuré sur : *${labels[level]}* !\n\nEnvoie-moi un message écrit ou une note vocale pour commencer à pratiquer.`,
    { parse_mode: 'Markdown' }
  );
});

// Commande /reset
bot.command(['reset', 'clear'], async (ctx) => {
  resetUserHistory(ctx.from.id);
  await ctx.reply('🔄 Historique réinitialisé ! De quel sujet souhaites-tu parler aujourd\'hui ? (ex: hobbies, voyage, travail, films...)');
});

// Commande /help
bot.help(async (ctx) => {
  const helpText = `📖 *Guide d'utilisation de ton tuteur d'anglais :*

1. 🎙️ **Pratique de l'oral (Vocal)** :
   Maintiens le micro de Telegram et parle en anglais pendant quelques secondes. Le bot comprendra ta voix, te répondra avec une note vocale et t'affichera la correction écrite.

2. ✍️ **Pratique de l'écrit (Texte)** :
   Envoie un message en anglais ou pose une question sur une règle de grammaire.

3. ⚙️ **Commandes disponibles :**
   • /start : Relancer l'accueil
   • /level : Changer de niveau (Débutant, Intermédiaire, Avancé)
   • /reset : Démarrer une nouvelle conversation à zéro
   • /help : Afficher ce guide

💡 *Astuce* : Pas besoin d'être parfait ! L'important est de pratiquer un peu chaque jour.`;

  await ctx.replyWithMarkdown(helpText);
});

// Gestion des messages vocaux (Voice notes)
bot.on(['voice', 'audio'], async (ctx) => {
  try {
    await ctx.sendChatAction('record_voice');

    const voice = ctx.message.voice || ctx.message.audio;
    if (!voice) return;

    // Récupérer le lien de téléchargement Telegram
    const fileLink = await ctx.telegram.getFileLink(voice.file_id);

    // Télécharger le fichier audio en Buffer
    const response = await fetch(fileLink.href);
    if (!response.ok) {
      throw new Error(`Échec du téléchargement audio Telegram (${response.statusText})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    // 1. Transcription avec Groq Whisper (gratuit & ultra rapide)
    await ctx.sendChatAction('typing');
    const userTranscript = await transcribeAudio(audioBuffer);

    if (!userTranscript || !userTranscript.trim()) {
      await ctx.reply("🤔 Je n'ai pas bien entendu ton enregistrement. Peux-tu réessayer en parlant plus près du micro ?");
      return;
    }

    // Informer l'utilisateur de ce qui a été compris
    await ctx.reply(`🎙️ *Tu as dit :*\n_« ${userTranscript.trim()} »_`, { parse_mode: 'Markdown' });

    // 2. Générer la réponse pédagogique (Groq LLaMA 3.3 70B)
    await ctx.sendChatAction('typing');
    const tutorResponse = await getTutorResponse(ctx.from.id, userTranscript);

    // 3. Synthèse vocale de la réponse anglaise
    await ctx.sendChatAction('record_voice');
    const voiceBuffer = await generateSpeech(tutorResponse.spokenEnglish);

    if (voiceBuffer) {
      // Envoyer la note vocale Telegram
      await ctx.replyWithVoice({ source: voiceBuffer, filename: 'response.mp3' });
    }

    // 4. Envoyer les corrections et la réponse textuelle
    await ctx.reply(tutorResponse.fullText);

  } catch (error) {
    console.error('Erreur traitement vocal:', error);
    await ctx.reply(`⚠️ Oups, une erreur est survenue lors de l'analyse vocale : ${error.message}`);
  }
});

// Gestion des messages texte
bot.on('text', async (ctx) => {
  const userText = ctx.message.text.trim();
  if (userText.startsWith('/')) return; // Ignore les commandes non traitées

  try {
    await ctx.sendChatAction('typing');
    const tutorResponse = await getTutorResponse(ctx.from.id, userText);

    // Envoyer d'abord la réponse texte
    await ctx.reply(tutorResponse.fullText);

    // Générer également le message vocal pour l'écoute
    await ctx.sendChatAction('record_voice');
    const voiceBuffer = await generateSpeech(tutorResponse.spokenEnglish);
    if (voiceBuffer) {
      await ctx.replyWithVoice({ source: voiceBuffer, filename: 'english.mp3' }, { caption: '🎧 Écoute la prononciation anglaise :' });
    }

  } catch (error) {
    console.error('Erreur traitement texte:', error);
    await ctx.reply(`⚠️ Oups, une erreur est survenue : ${error.message}`);
  }
});

// Lancement du bot
bot.launch()
  .then(() => {
    console.log('🚀 Le bot Telegram d\'anglais (Groq) est démarré avec succès !');
    console.log('Tu peux maintenant lui parler sur Telegram.');
  })
  .catch((err) => {
    console.error('Erreur au lancement du bot:', err);
  });

// Arrêt propre en cas de signal système
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
