# 🇬🇧 Bot Telegram - Coach & Tuteur d'Anglais Vocal et Écrit

Un bot Telegram intelligent propulsé par l'IA pour t'aider à pratiquer et parler l'anglais au quotidien, aussi bien par **messages écrits** que par **messages vocaux**.

---

## 🌟 Fonctionnalités

- 🎙️ **Pratique Orale (Vocale)** : Envoie des messages vocaux en anglais via Telegram. Le bot écoute grâce à Whisper, analyse ce que tu as dit et te répond avec une note vocale (TTS voix naturelle) pour entraîner ton oreille.
- 💡 **Corrections Bienveillantes** : À chaque interaction, le bot relève tes éventuelles fautes de grammaire, d'orthographe ou de vocabulaire en français et t'indique comment formuler tes idées comme un locuteur natif.
- 🎯 **3 Niveaux d'apprentissage** :
  - **Débutant** : Vocabulaire simple, explications douces et claires.
  - **Intermédiaire** : Conversations fluides, corrections d'idiomes et faux-amis.
  - **Avancé** : Vocabulaire riche, nuances de style et registre.
- 🔄 **Mémoire de conversation** : Le bot se souvient de vos derniers échanges pour maintenir une vraie conversation continue.

---

## 🚀 Configuration et Démarrage

### 1. Remplir le fichier `.env`

Ouvre le fichier `.env` situé dans le dossier du bot et ajoute tes deux clés :

```env
TELEGRAM_BOT_TOKEN=ton_token_fourni_par_botfather
OPENAI_API_KEY=sk-...ta_cle_api_openai...
```

> **Où trouver la clé OpenAI ?**  
> Rendez-vous sur [platform.openai.com/api-keys](https://platform.openai.com/api-keys) pour générer votre clé API.

### 2. Démarrer le bot

Dans un terminal (ou PowerShell) dans ce dossier :

```bash
npm start
```

Quand tu vois le message :
> `🚀 Le bot Telegram d'anglais est démarré avec succès !`

Le bot est en ligne et prêt à discuter !

---

## 📱 Utilisation sur Telegram

1. Ouvre la conversation avec ton bot sur Telegram et clique sur **/start**.
2. Choisis ton niveau (*Débutant*, *Intermédiaire* ou *Avancé*).
3. **Parle-lui** :
   - 🎙️ En maintenant le bouton micro de Telegram pour enregistrer une note vocale en anglais.
   - ✍️ Ou en lui écrivant directement un message texte.
4. **Commandes utiles** :
   - `/start` : Relancer le message d'accueil.
   - `/level` : Changer ton niveau d'anglais à tout moment.
   - `/reset` : Effacer la mémoire pour commencer un nouveau sujet de discussion.
   - `/help` : Afficher l'aide.


## Canal privé d’administration

1. Crée un canal **privé** nommé « EnglishMate AI Admin » dans Telegram. Ajoute le bot comme administrateur avec le droit de publier.
2. Publie un message dans le canal et copie son lien. Pour un lien du type t.me/c/1234567890/1, utilise ADMIN_CHANNEL_ID=-1001234567890. Indique ton identifiant Telegram numérique dans ADMIN_USER_ID.
3. Sur Render, configure ADMIN_USER_ID, ADMIN_CHANNEL_ID et ADMIN_DATABASE_URL. Pour ADMIN_DATABASE_URL, utilise une URL de connexion PostgreSQL avec TLS, depuis Neon Free par exemple. Le bot crée sa table au premier accès. En développement local, le registre utilise ADMIN_ACTIVITY_FILE si aucune URL PostgreSQL ne lui est fournie.
4. Envoie /admin_stats au bot en message direct depuis le compte administrateur. Le canal reçoit une notification par nouvel utilisateur suivi, avec son nom Telegram, son identifiant et le total. Les textes, vocaux et transcriptions restent en dehors du canal.

Le compteur démarre avec les interactions observées après activation. Un utilisateur existant est compté quand il interagit à nouveau.

## Espace Web EnglishMate

- Utilise Node.js 24 ou supérieur pour Argon2id.
- Sur Render, conserve ADMIN_DATABASE_URL pour Supabase ou configure WEB_DATABASE_URL pour une base Web distincte. Le bot crée les tables dans le schéma privé englishmate_web. Le rôle PostgreSQL doit pouvoir créer ce schéma et ses tables. Les projets Supabase utilisent le Session pooler et le certificat intégré au bot.
- Sur Vercel, le fichier vercel.json redirige /api/account vers Render. Les cookies de session restent sur le domaine du site. Déploie la version API et la version Vercel ensemble, car la nouvelle API remplace l’ancien parcours anonyme.
- Pour un serveur API de développement sur HTTP local, utilise WEB_LOCAL_HTTP=true et WEB_API_TARGET sur le serveur Vite. Utilise une base de développement et évite de démarrer une seconde instance avec le token de production Telegram.
