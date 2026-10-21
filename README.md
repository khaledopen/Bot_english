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
