require('dotenv').config();
const crypto = require('crypto');
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const tutor = require('./tutor');
const { createAccountApi } = require('./web-account-api.cjs');
const { createAccountStore } = require('./web-account-store.cjs');
const {
  getUserSession,
  setUserLevel,
  startLevelConversation,
  restoreUserLevel,
  resetUserHistory,
  transcribeAudio,
  getTutorResponse,
  lastTutorReply,
  generateSpeech
} = tutor;

const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const GROQ_KEY = (process.env.GROQ_API_KEY || '').trim();

if (!BOT_TOKEN) {
  console.error("❌ ERREUR : La variable TELEGRAM_BOT_TOKEN est manquante !");
  console.error("Veuillez renseigner votre token Telegram.");
  process.exit(1);
}

if (!GROQ_KEY) {
  console.warn("⚠️ ATTENTION : La variable GROQ_API_KEY est manquante.");
  console.warn("Ajoute ta clé Groq gratuite (commence par gsk_...) depuis https://console.groq.com");
}

const bot = new Telegraf(BOT_TOKEN);

// Détection automatique de l'URL publique (Render fournit RENDER_EXTERNAL_URL automatiquement)
const PUBLIC_URL = (process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || '')
  .trim()
  .replace(/\/+$/, '');
const IS_WEBHOOK_MODE = /^https:\/\//i.test(PUBLIC_URL);
const WEBHOOK_PATH = `/telegraf/${bot.secretPathComponent()}`;
const WEBHOOK_SECRET = (
  process.env.WEBHOOK_SECRET ||
  crypto.createHash('sha256').update(BOT_TOKEN).digest('hex')
).trim();

// Déduplication des mises à jour Telegram (évite les doublons si Telegram réessaie pendant un réveil Render)
const MAX_PROCESSED_UPDATES = 500;
const processedUpdates = new Set();

function isDuplicateUpdate(updateId) {
  if (typeof updateId !== 'number') return false;
  if (processedUpdates.has(updateId)) return true;
  processedUpdates.add(updateId);
  if (processedUpdates.size > MAX_PROCESSED_UPDATES) {
    const oldestId = processedUpdates.values().next().value;
    processedUpdates.delete(oldestId);
  }
  return false;
}

function sendResponse(res, method, statusCode, contentType, body) {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  if (method === 'HEAD') {
    return res.end();
  }
  return res.end(body);
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Serveur HTTP léger : Webhook Telegram + routes /ping, /health, /status (compatible GET & HEAD)
const probeAdminDatabase = require('./admin-activity.cjs').installAdminActivity(bot);
const PORT = process.env.PORT || 3000;
const accountStore = createAccountStore((process.env.WEB_DATABASE_URL || process.env.ADMIN_DATABASE_URL || '').trim());
const accountApi = createAccountApi(accountStore, tutor, {
  secure: process.env.RENDER === 'true' || process.env.WEB_LOCAL_HTTP !== 'true',
});
const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname.startsWith('/api/account/')) {
    const url = new URL(req.url, 'http://localhost');
    return accountApi(req, res, pathname.slice('/api/account/'.length), url);
  }
  if (pathname === '/api/practice') {
    return sendResponse(res, req.method, 410, 'application/json', JSON.stringify({ error: 'Actualise la page pour accéder au nouvel espace de pratique.' }));
  }

  // Point de terminaison Webhook Telegram
  if (IS_WEBHOOK_MODE && req.method === 'POST' && pathname === WEBHOOK_PATH) {
    if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
      return sendResponse(res, req.method, 403, 'text/plain; charset=utf-8', 'Forbidden');
    }

    let update;
    try {
      update = await readJsonBody(req);
    } catch (err) {
      console.error('❌ Erreur lecture payload webhook:', err.message);
      return sendResponse(res, req.method, 400, 'text/plain; charset=utf-8', 'Invalid JSON');
    }

    // Accuser réception immédiatement pour éviter tout timeout Telegram pendant le traitement IA/audio
    sendResponse(res, req.method, 200, 'application/json', '{"ok":true}');

    if (!isDuplicateUpdate(update?.update_id)) {
      bot.handleUpdate(update).catch((err) => {
        console.error('❌ Erreur traitement update webhook:', err);
      });
    }
    return;
  }

  // Routes ultra-légères pour UptimeRobot / cron-job.org (sans appel externe Telegram)
  if (pathname === '/ping' || pathname === '/health' || pathname === '/healthz') {
    const payload = JSON.stringify({
      status: 'ok',
      mode: IS_WEBHOOK_MODE ? 'webhook' : 'polling',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }, null, 2);
    return sendResponse(res, req.method, 200, 'application/json', payload);
  }

  if (pathname === '/admin-db-health' && req.method === 'POST') {
    const supplied = Buffer.from(String(req.headers['x-admin-diagnostic'] || ''));
    const expected = crypto.createHash('sha256').update('admin-db-health:' + BOT_TOKEN).digest('hex');
    const key = Buffer.from(expected);
    if (supplied.length !== key.length || !crypto.timingSafeEqual(supplied, key)) {
      return sendResponse(res, req.method, 404, 'text/plain; charset=utf-8', 'Not found');
    }
    const result = probeAdminDatabase ? await probeAdminDatabase() : { status: 'disabled' };
    return sendResponse(res, req.method, 200, 'application/json', JSON.stringify(result));
  }

  // Route de diagnostic complet (vérifie la connexion Telegram)
  if (pathname === '/status') {
    if (req.method === 'HEAD') {
      return sendResponse(res, req.method, 200, 'application/json', '');
    }
    try {
      const me = await bot.telegram.getMe();
      const webhookInfo = IS_WEBHOOK_MODE ? await bot.telegram.getWebhookInfo() : null;
      return sendResponse(res, req.method, 200, 'application/json', JSON.stringify({
        status: 'online',
        mode: IS_WEBHOOK_MODE ? 'webhook' : 'polling',
        bot: `@${me.username}`,
        webhookActive: webhookInfo ? Boolean(webhookInfo.url) : false,
        pendingUpdateCount: webhookInfo ? webhookInfo.pending_update_count : undefined,
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
      }, null, 2));
    } catch (err) {
      return sendResponse(res, req.method, 200, 'application/json', JSON.stringify({
        status: 'error',
        mode: IS_WEBHOOK_MODE ? 'webhook' : 'polling',
        error: err.message,
        uptimeSeconds: Math.floor(process.uptime())
      }, null, 2));
    }
  }

  return sendResponse(
    res,
    req.method,
    200,
    'text/plain; charset=utf-8',
    'English Coach Telegram Bot is alive and running! 🚀\n'
  );
});

server.listen(PORT, () => {
  console.log(`🌐 Serveur HTTP actif sur le port ${PORT} (compatible Render)`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (IS_WEBHOOK_MODE) {
      console.error(`❌ Le port ${PORT} est déjà occupé (indispensable en mode webhook).`);
    } else {
      console.warn(`⚠️ Le port ${PORT} est déjà occupé, mais le bot Telegram continue en mode polling.`);
    }
  } else {
    console.error('Erreur serveur HTTP:', err);
  }
});

const FOOTER_SIGNATURE = "\n\n_byBEn10_";



const loadSavedLevel = id => probeAdminDatabase?.getLevel?.(id);
const speechOptions = level => ({ slow: level !== 'advanced', level: level || 'intermediate' });
const escapeHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Les parties fautives (⟦…⟧) apparaissent en gras souligné dans Telegram
// Bouton « Niveau » sous les messages de Nova, et choix du niveau affiché à sa place
const LEVEL_LABELS = { beginner: '🟢 Débutant (Beginner)', intermediate: '🟡 Intermédiaire (Intermediate)', advanced: '🔴 Avancé (Advanced)' };
const LEVEL_SHORT = { beginner: '🟢 Débutant', intermediate: '🟡 Intermédiaire', advanced: '🔴 Avancé' };
const levelButton = level => Markup.inlineKeyboard([[Markup.button.callback(`🎚️ Niveau : ${LEVEL_SHORT[level] || LEVEL_SHORT.intermediate} · Changer`, 'level_menu')]]);
const levelChoices = (current, prefix = 'lvl_') => Markup.inlineKeyboard([
  ...Object.keys(LEVEL_LABELS).map(level => [Markup.button.callback(`${LEVEL_LABELS[level]}${level === current ? ' ✓' : ''}`, `${prefix}${level}`)]),
  ...(prefix === 'lvlin_' ? [[Markup.button.callback('↩️ Annuler', 'level_cancel')]] : []),
]);

async function sendTutorText(ctx, text, { button = true } = {}) {
  const level = getUserSession(ctx.from.id).level;
  const extra = button ? levelButton(level) : {};
  const html = escapeHtml(`${text}\n\nbyBEn10`).replace(/⟦([^⟧]+)⟧/g, '<b><u>$1</u></b>');
  try { return await ctx.reply(html, { parse_mode: 'HTML', ...extra }); }
  catch { return ctx.reply(`${text}\n\nbyBEn10`.replace(/⟦([^⟧]+)⟧/g, '« $1 »'), extra); }
}

// Note vocale de Nova, avec le bouton « Niveau » quand elle termine l'échange
async function sendNovaVoice(ctx, buffer, filename, { caption, button = false } = {}) {
  if (!buffer) return null;
  const extra = { ...(caption ? { caption } : {}), ...(button ? levelButton(getUserSession(ctx.from.id).level) : {}) };
  return ctx.replyWithVoice({ source: buffer, filename }, extra).catch(error => { console.warn('Note vocale non envoyée :', error.message); return null; });
}
const spokenOpener = text => text.split('💬').slice(1).join(' ').split('\n').filter(line => !/^\s*(?:🇫🇷|👉)/u.test(line)).join(' ').replace(/Nova\s*:|[❓]/gu, ' ').trim();

// Commande /start
bot.start(async (ctx) => {
  await restoreUserLevel(ctx.from.id, loadSavedLevel);
  console.log(`👋 [${new Date().toLocaleTimeString()}] /start reçu de ${ctx.from.first_name || 'Utilisateur'}`);
  const session = getUserSession(ctx.from.id);
  const welcomeText = `🇬🇧 *Welcome to your English Coach Bot!*

Salut ${ctx.from.first_name || 'ami'} ! Je suis ton compagnon quotidien pour t'aider à progresser en anglais en toute confiance.

✨ *Ce que nous pouvons faire ensemble :*
• 💬 **Écrire en texte** : Parle-moi de ta journée, pose-moi des questions, entraîne-toi à écrire.
• 🎙️ **Envoyer des notes vocales** : Enregistre un message vocal en anglais, je t'écouterai, te corrigerai et te répondrai avec ma propre voix pour que tu améliores ton écoute et ton accent !
• 💡 **Corrections instantanées** : À chaque message, je t'explique tes erreurs avec bienveillance.

Niveau actuel : *${session.level.toUpperCase()}*

Choisis ton niveau ou commence dès maintenant en m'envoyant un message (texte ou vocal) !${FOOTER_SIGNATURE}`;

  await ctx.replyWithMarkdown(welcomeText, levelChoices(session.level));
});

// Commande /level
bot.command(['level', 'niveau'], async (ctx) => {
  await restoreUserLevel(ctx.from.id, loadSavedLevel);
  await ctx.reply('🎯 Sélectionne ton niveau actuel d\'anglais :', levelChoices(getUserSession(ctx.from.id).level));
});

// Bouton « Niveau » d'un message de Nova : les trois niveaux s'affichent sous ce message
bot.action('level_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await restoreUserLevel(ctx.from.id, loadSavedLevel);
  await ctx.editMessageReplyMarkup(levelChoices(getUserSession(ctx.from.id).level, 'lvlin_').reply_markup).catch(() => {});
});
bot.action('level_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(levelButton(getUserSession(ctx.from.id).level).reply_markup).catch(() => {});
});

// Actions de changement de niveau (lvl_ : menu /start ou /level ; lvlin_ : sous un message de Nova)
bot.action(/^(lvl|lvlin)_(beginner|intermediate|advanced)$/, async (ctx) => {
  const inPlace = ctx.match[1] === 'lvlin';
  const level = ctx.match[2];
  await restoreUserLevel(ctx.from.id, loadSavedLevel);
  const session = getUserSession(ctx.from.id);
  // Même niveau en pleine conversation : on garde la conversation en cours
  if (level === session.level && session.history.length > 1) {
    await ctx.answerCbQuery(`Tu es déjà en ${LEVEL_SHORT[level]}.`);
    if (inPlace) await ctx.editMessageReplyMarkup(levelButton(level).reply_markup).catch(() => {});
    else await ctx.editMessageText(`✅ Niveau conservé : ${LEVEL_LABELS[level]}`).catch(() => {});
    return;
  }
  await ctx.answerCbQuery(`Niveau : ${LEVEL_SHORT[level]}`);
  // Changer de niveau ouvre une nouvelle conversation, annoncée par Nova dans le nouveau niveau
  const opener = startLevelConversation(ctx.from.id, level);
  if (inPlace) await ctx.editMessageReplyMarkup(undefined).catch(() => {}); // le message de Nova reste intact
  else await ctx.editMessageText(`✅ Niveau changé : ${LEVEL_LABELS[level]}`).catch(() => {});
  await sendTutorText(ctx, opener, { button: false });
  const voiceBuffer = await generateSpeech(spokenOpener(opener), speechOptions(level));
  if (!await sendNovaVoice(ctx, voiceBuffer, 'nova.mp3', { button: true })) await ctx.reply('🎚️ Tu peux changer de niveau à tout moment :', levelButton(level));
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

  await ctx.replyWithMarkdown(helpText + FOOTER_SIGNATURE);
});

// Gestion des messages vocaux (Voice notes)
bot.on(['voice', 'audio'], async (ctx) => {
  const senderName = ctx.from.first_name || 'Utilisateur';
  console.log(`🎙️ [${new Date().toLocaleTimeString()}] Note vocale reçue de ${senderName}`);

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
    await restoreUserLevel(ctx.from.id, loadSavedLevel);
    const userTranscript = await transcribeAudio(audioBuffer, 'ogg', 'audio/ogg', lastTutorReply(ctx.from.id));

    if (!userTranscript || !userTranscript.trim()) {
      await ctx.reply("🤔 Je n'ai pas bien entendu ton enregistrement. Peux-tu réessayer en parlant plus près du micro ?" + FOOTER_SIGNATURE, { parse_mode: 'Markdown' });
      return;
    }

    // Informer l'utilisateur de ce qui a été compris
    await ctx.reply(`🎙️ *Tu as dit :*\n_« ${userTranscript.trim()} »_`, { parse_mode: 'Markdown' });

    // 2. Générer la réponse pédagogique (Groq LLaMA 3.3 70B)
    await ctx.sendChatAction('typing');
    const tutorResponse = await getTutorResponse(ctx.from.id, userTranscript, { inputMode: 'voice' });

    // 3. Synthèse vocale de la réponse anglaise
    await ctx.sendChatAction('record_voice');
    const voiceBuffer = await generateSpeech(tutorResponse.spokenEnglish, speechOptions(tutorResponse.level));

    await sendNovaVoice(ctx, voiceBuffer, 'response.mp3');

    // 4. Envoyer les corrections et la réponse textuelle signée, avec le bouton « Niveau »
    await sendTutorText(ctx, tutorResponse.fullText);

  } catch (error) {
    console.error('Erreur traitement vocal:', error);
    await ctx.reply(`⚠️ Oups, une erreur est survenue lors de l'analyse vocale : ${error.message}\n\nbyBEn10`);
  }
});

// Gestion des messages texte
bot.on('text', async (ctx) => {
  const userText = ctx.message.text.trim();
  if (userText.startsWith('/')) return; // Ignore les commandes non traitées

  const senderName = ctx.from.first_name || 'Utilisateur';
  console.log(`📩 [${new Date().toLocaleTimeString()}] Message reçu de ${senderName} : "${userText}"`);

  try {
    await ctx.sendChatAction('typing');
    await restoreUserLevel(ctx.from.id, loadSavedLevel);
    const tutorResponse = await getTutorResponse(ctx.from.id, userText);

    // Envoyer d'abord la réponse texte signée
    const textMessage = await sendTutorText(ctx, tutorResponse.fullText, { button: false });
    console.log(`💬 Réponse texte envoyée à ${senderName}`);

    // Générer également le message vocal pour l'écoute ; le bouton « Niveau » se place en bas de l'échange
    await ctx.sendChatAction('record_voice');
    const voiceBuffer = await generateSpeech(tutorResponse.spokenEnglish, speechOptions(tutorResponse.level));
    if (await sendNovaVoice(ctx, voiceBuffer, 'english.mp3', { caption: '🎧 Écoute la prononciation anglaise :', button: true })) {
      console.log(`🎙️ Note vocale envoyée à ${senderName}`);
    } else if (textMessage) {
      await ctx.telegram.editMessageReplyMarkup(ctx.chat.id, textMessage.message_id, undefined, levelButton(tutorResponse.level).reply_markup).catch(() => {});
    }

  } catch (error) {
    console.error('Erreur traitement texte:', error);
    await ctx.reply(`⚠️ Oups, une erreur est survenue : ${error.message}\n\nbyBEn10`);
  }
});

// Gestion globale des erreurs Telegraf pour éviter un arrêt silencieux du processus
bot.catch((err, ctx) => {
  console.error(`❌ Erreur Telegraf (${ctx?.updateType || 'unknown'}):`, err);
});

let keepAliveTimer = null;

function startSelfKeepAlive() {
  if (!IS_WEBHOOK_MODE || process.env.DISABLE_SELF_PING === 'true') return;
  const intervalMs = 10 * 60 * 1000; // 10 minutes (< seuil 15 min de Render)
  keepAliveTimer = setInterval(async () => {
    try {
      const res = await fetch(`${PUBLIC_URL}/ping`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        console.warn(`⚠️ Keep-alive /ping a répondu HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn('⚠️ Échec keep-alive /ping:', err.message);
    }
  }, intervalMs);
  keepAliveTimer.unref();
  console.log('💓 Auto-ping keep-alive activé toutes les 10 minutes sur /ping');
}

let isShuttingDown = false;

async function startBot() {
  if (IS_WEBHOOK_MODE) {
    const webhookUrl = `${PUBLIC_URL}${WEBHOOK_PATH}`;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        bot.botInfo = await bot.telegram.getMe();
        await bot.telegram.setWebhook(webhookUrl, {
          secret_token: WEBHOOK_SECRET,
          drop_pending_updates: false
        });
        console.log('🚀 Le bot Telegram d\'anglais (Groq) est démarré en mode WEBHOOK !');
        console.log(`🤖 Connecté en tant que @${bot.botInfo.username}`);
        console.log(`🔗 Webhook configuré sur ${PUBLIC_URL}/telegraf/***`);
        startSelfKeepAlive();
        return;
      } catch (err) {
        if (attempt === maxAttempts || isShuttingDown) {
          throw err;
        }
        console.warn(`⚠️ Tentative ${attempt}/${maxAttempts} setWebhook échouée (${err.message}), nouvelle tentative dans 5s...`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    return;
  }

  await bot.launch(() => {
    console.log('🚀 Le bot Telegram d\'anglais (Groq) est démarré en mode POLLING (local) !');
    console.log(`🤖 Connecté en tant que @${bot.botInfo?.username || 'EnglishMate_KB_bot'}`);
    console.log('👉 Tu peux lui envoyer un message sur Telegram dès maintenant.');
  });
}

startBot().catch((err) => {
  console.error('❌ Erreur au lancement du bot:', err);
});

// Arrêt propre en cas de signal système
function shutdown(signal) {
  isShuttingDown = true;
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  server.close();
  if (!IS_WEBHOOK_MODE) {
    try {
      bot.stop(signal);
    } catch {
      // Ignore si le polling n'était pas démarré
    }
  }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
