import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  generateForwardMessageContent,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  generateWAMessage,
  proto
} from '@whiskeysockets/baileys';

import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import axios from 'axios'; 
import archiver from 'archiver';
import { loadSettings, saveSettings, updateSetting, getCurrentSettings } from './lib/persistentData.js';
import { handleLinkDetection } from './eclipse-plug/antilink.js';
import isAdmin from './lib/isAdmin.js';
import { buttonResponses } from './lib/menuButtons.js';
import { storeMessage, handleMessageRevocation } from './eclipse-plug/self/antidelete.js';
import { readState as readAnticallState } from './eclipse-plug/self/anticall.js';
import { checkAutoGreetings } from './eclipse-plug/self/autogreet.js';
import antitag from './eclipse-plug/antitag.js';
import './lib/preview.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_MODE = process.env.TEST_MODE_ONLY === 'true';

import config from './config.js';
const COMMAND_PREFIX = process.env.BOT_PREFIX || config.prefix;

global.config = {
  botName: config.botName,
  prefix: COMMAND_PREFIX,
  ownerNumber: config.ownerNumber,
  ownerName: config.ownerName
};
global.COMMAND_PREFIX = COMMAND_PREFIX;
global.prepareWAMessageMedia = prepareWAMessageMedia;

const MODS_FILE = path.join(__dirname, 'data', 'moderators.json');
const BANNED_FILE = path.join(__dirname, 'data', 'banned.json');
const WELCOME_CONFIG_FILE = path.join(__dirname, 'data', 'welcomeConfig.json');
const SESSION_ID_FILE = path.join(__dirname, 'SESSION-ID');
const ANTIDELETE_MESSAGES_FILE = path.join(__dirname, 'data', 'antidelete_messages.json');

// CLEAR TMP/TEMP ON STARTUP
function clearTempDirs() {
    const dirs = [path.join(__dirname, 'temp'), path.join(__dirname, 'tmp')];
    dirs.forEach(dir => {
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                const curPath = path.join(dir, file);
                try {
                    if (fs.lstatSync(curPath).isDirectory()) {
                        // skip subdirs for safety or handle recursively
                    } else {
                        fs.unlinkSync(curPath);
                    }
                } catch (e) {}
            });
            console.log(`[STARTUP] Cleared ${path.basename(dir)} directory`);
        } else {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}
clearTempDirs();

function clearAntideleteMessages() {
  try {
    if (fs.existsSync(ANTIDELETE_MESSAGES_FILE)) {
      fs.writeFileSync(ANTIDELETE_MESSAGES_FILE, JSON.stringify({}, null, 2));
    }
  } catch (err) {}
}
clearAntideleteMessages();

let botActive = true;

const persistentSettings = loadSettings();
let botMode = persistentSettings.botMode || 'public'; 
global.botMode = botMode; 

// Command cooldown system
const cooldowns = new Map();
const COOLDOWN_TIME = 5 * 1000; // 5 seconds

const parseBoolEnv = (key, defaultValue) => {
  const value = process.env[key];
  if (value === 'true') return true;
  if (value === 'false') return false;
  return defaultValue;
};

global.autoViewMessage = parseBoolEnv('AUTO_VIEW_MESSAGE', persistentSettings.autoViewMessage || false);
global.autoViewStatus = parseBoolEnv('AUTO_VIEW_STATUS', persistentSettings.autoViewStatus || false);
global.autoReactStatus = parseBoolEnv('AUTO_REACT_STATUS', persistentSettings.autoReactStatus || false);
global.autoReact = parseBoolEnv('AUTO_REACT', persistentSettings.autoReact || false);
global.autoStatusEmoji = process.env.AUTO_STATUS_EMOJI || persistentSettings.autoStatusEmoji || '❤️';
global.autoTyping = parseBoolEnv('AUTO_TYPING', persistentSettings.autoTyping || false);
global.autoRecording = parseBoolEnv('AUTO_RECORDING', persistentSettings.autoRecording || false);

global.antiLinkWarn = persistentSettings.antiLinkWarn || {};
global.antiLinkKick = persistentSettings.antiLinkKick || {};
global.antiBadWord = persistentSettings.antiBadWord || {};

let processedMessages = new Set();
const messageCount = {};
const TIME_LIMIT = 1 * 1000; 
const MESSAGE_LIMIT = 2;

// Memory optimization: Clear old data periodically
setInterval(() => {
  const now = Date.now();
  
  // Clear old message counts (older than 10 minutes)
  for (const [key, times] of Object.entries(messageCount)) {
    messageCount[key] = times.filter(t => now - t < 600000);
    if (messageCount[key].length === 0) delete messageCount[key];
  }
  
  // Clear old warnings from antilink (older than 30 minutes)
  if (global.antilinkWarnings) {
    for (const [chatId, warnings] of Object.entries(global.antilinkWarnings)) {
      for (const [userId, count] of Object.entries(warnings)) {
        if (!count) delete warnings[userId];
      }
      if (Object.keys(warnings).length === 0) delete global.antilinkWarnings[chatId];
    }
  }

  // Aggressive memory cleanup
  if (processedMessages.size > 1000) processedMessages.clear();
  
  // Force Garbage Collection if available
  if (global.gc) {
    global.gc();
  }
}, 180000); // Run every 3 minutes (very aggressive for Heroku) 

function loadAntibugSettings() {
  const ANTIBUG_FILE = path.join(__dirname, 'data', 'antibug_settings.json');
  if (!fs.existsSync(ANTIBUG_FILE)) {
    return { enabled: false };
  }
  try {
    return JSON.parse(fs.readFileSync(ANTIBUG_FILE, 'utf-8'));
  } catch {
    return { enabled: false };
  }
}

let moderators = fs.existsSync(MODS_FILE)
  ? JSON.parse(fs.readFileSync(MODS_FILE))
  : [];

function saveModerators() {
  fs.writeFileSync(MODS_FILE, JSON.stringify(moderators, null, 2));
}

function loadBanned() {
  return fs.existsSync(BANNED_FILE)
    ? JSON.parse(fs.readFileSync(BANNED_FILE))
    : {};
}

let welcomeConfig = fs.existsSync(WELCOME_CONFIG_FILE)
  ? JSON.parse(fs.readFileSync(WELCOME_CONFIG_FILE))
  : {};

function saveWelcomeConfig() {
  fs.writeFileSync(WELCOME_CONFIG_FILE, JSON.stringify(welcomeConfig, null, 2));
}

async function setupAuthState() {
  const authDir = './auth_info';
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
  const configModule = await import('./config.js');
  let sessionData = process.env.DYNAMIC_SESSION || process.env.BOT_SESSION_DATA || configModule.default.sessionData;

  const detectAndNormalizeSession = (data) => {
    if (!data) return null;
    try {
      const decoded = Buffer.from(data, 'base64').toString('utf-8');
      JSON.parse(decoded);
      return data;
    } catch (e) {
      try {
        JSON.parse(data);
        return Buffer.from(data, 'utf-8').toString('base64');
      } catch (e2) {
        return null;
      }
    }
  };

  if (!sessionData) {
    const instanceSessionFile = process.env.BOT_SESSION_FILE || SESSION_ID_FILE;
    if (fs.existsSync(instanceSessionFile)) {
      sessionData = fs.readFileSync(instanceSessionFile, 'utf8').trim();
      sessionData = detectAndNormalizeSession(sessionData);
    }
  } else {
    sessionData = detectAndNormalizeSession(sessionData);
  }

  const credsPath = path.join(authDir, 'creds.json');
  if (!fs.existsSync(credsPath) && sessionData) {
    try {
      const decoded = Buffer.from(sessionData, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      fs.writeFileSync(credsPath, JSON.stringify(parsed, null, 2));
    } catch (err) {}
  }
  
  if (!fs.existsSync(credsPath) && !sessionData) {
     console.log(color('\n╔══════════════════════════════════════════════╗', 'yellow'));
     console.log(color('║          ⚠️  SESSION DATA MISSING            ║', 'yellow'));
     console.log(color('╠══════════════════════════════════════════════╣', 'yellow'));
     console.log(color('║  Please PASTE your Session ID below and      ║', 'yellow'));
     console.log(color('║  press ENTER to connect:                     ║', 'yellow'));
     console.log(color('║                                              ║', 'yellow'));
     console.log(color('║  * It will be saved to SESSION-ID file *     ║', 'yellow'));
     console.log(color('╚══════════════════════════════════════════════╝\n', 'yellow'));

     const readline = await import('readline');
     const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
     
     const input = await new Promise((resolve) => rl.question('Paste Session ID: ', resolve));
     rl.close();
     
     if (input && input.trim()) {
         sessionData = input.trim();
         fs.writeFileSync(SESSION_ID_FILE, sessionData);
         console.log(color('[SUCCESS] Session ID saved to SESSION-ID file.', 'green'));
         
         // Try to parse and save to creds.json immediately
         try {
             const normalized = detectAndNormalizeSession(sessionData);
             if (normalized) {
                 const decoded = Buffer.from(normalized, 'base64').toString('utf-8');
                 const parsed = JSON.parse(decoded);
                 fs.writeFileSync(credsPath, JSON.stringify(parsed, null, 2));
             }
         } catch (e) {}
     } else {
         console.log(color('[ERROR] No Session ID provided. Exiting...', 'red'));
         process.exit(1);
     }
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  
  if (!state || !state.creds) {
     throw new Error('AuthState state or creds is null/undefined');
  }

  return { state, saveCreds };
}

async function normalizeJid(sock, jid, groupId) {
  if (!jid || !jid.includes('@lid')) return jid?.split('@')[0] || '';
  try {
    const groupMetadata = groupId ? await sock.groupMetadata(groupId) : null;
    const participant = groupMetadata?.participants.find(p => p.id === jid);
    return participant?.id.split('@')[0] || jid.split('@')[0];
  } catch {
    return jid.split('@')[0];
  }
}

const color = (text, colorCode) => {
  const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
    reset: '\x1b[0m'
  };
  return colors[colorCode] ? colors[colorCode] + text + colors.reset : text;
};

global.commands = new Map();
global.selfCommands = new Map();
global.sessions = new Map();
const commands = global.commands;
const selfCommands = global.selfCommands;
const sessions = global.sessions;

let chatbotHandler = null;
try {
  const chatbotModule = await import('./eclipse-plug/chatbot.js');
  chatbotHandler = chatbotModule.handleChatbotResponse;
} catch (err) {}

const commandsDir = path.join(__dirname, 'eclipse-plug');
const commandFiles = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js') || f.endsWith('.cjs'));

for (const file of commandFiles) {
  try {
    const filePath = path.join(commandsDir, file);
    const imported = await import(`file://${filePath}`);
    const exportedCommands = imported.default;

    const loadSingleCommand = (command) => {
      let commandName, commandObj;
      if (command.name && typeof command.execute === 'function') {
        commandName = command.name;
        commandObj = command;
      } else if (command.nomCom && typeof command.execute === 'function') {
        commandName = command.nomCom;
        commandObj = {
          name: command.nomCom,
          description: command.description || `${command.nomCom} command`,
          category: command.categorie || 'Other',
          aliases: command.aliases || [],
          execute: async (msg, options) => {
            const { sock, args } = options;
            const dest = msg.key.remoteJid;
            const commandeOptions = { arg: args, ms: msg, msgReponse: msg };
            return await command.execute(dest, sock, commandeOptions);
          }
        };
      } else return false;
      commands.set(commandName, commandObj);
      if (commandObj.aliases) commandObj.aliases.forEach(a => commands.set(a, commandObj));
      return true;
    };

    if (exportedCommands && (exportedCommands.name || exportedCommands.nomCom) && typeof exportedCommands.execute === 'function') loadSingleCommand(exportedCommands);
    else if (Array.isArray(exportedCommands)) exportedCommands.forEach(c => loadSingleCommand(c));
    for (const [key, value] of Object.entries(imported)) {
      if (key !== 'default' && value) {
        if ((value.name || value.nomCom) && typeof value.execute === 'function') loadSingleCommand(value);
        else if (Array.isArray(value)) value.forEach(c => loadSingleCommand(c));
      }
    }
  } catch (err) {}
}

const selfCommandsDir = path.join(__dirname, 'eclipse-plug', 'self');
if (fs.existsSync(selfCommandsDir)) {
  const selfCommandFiles = fs.readdirSync(selfCommandsDir).filter((f) => f.endsWith('.js') || f.endsWith('.cjs'));
  for (const file of selfCommandFiles) {
    try {
      const filePath = path.join(selfCommandsDir, file);
      const imported = await import(`file://${filePath}`);
      const loadSelfCommand = (command) => {
        let commandName, commandObj;
        if (command.name && typeof command.execute === 'function') {
          commandName = command.name;
          commandObj = command;
        } else if (command.nomCom && typeof command.execute === 'function') {
          commandName = command.nomCom;
          commandObj = {
            name: command.nomCom,
            description: command.description || `${command.nomCom} command`,
            category: command.categorie || 'Self',
            aliases: command.aliases || [],
            execute: async (msg, options) => {
              const { sock, args } = options;
              const dest = msg.key.remoteJid;
              const commandeOptions = { arg: args, ms: msg, msgReponse: msg };
              return await command.execute(dest, sock, commandeOptions);
            }
          };
        } else return false;
        selfCommands.set(commandName, commandObj);
        if (commandObj.aliases) commandObj.aliases.forEach(a => selfCommands.set(a, commandObj));
        return true;
      };
      if (imported.default && (imported.default.name || imported.default.nomCom)) loadSelfCommand(imported.default);
      else if (Array.isArray(imported.default)) imported.default.forEach(c => loadSelfCommand(c));
      for (const [key, value] of Object.entries(imported)) {
        if (key !== 'default' && value && (value.name || value.nomCom)) loadSelfCommand(value);
      }
    } catch (err) {}
  }
}

async function startBot() {
  try {
    const { state, saveCreds } = await setupAuthState();
    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Eclipse MD', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    const connectionTimeout = setTimeout(() => {
        if (sock.user) return;
        console.log(color('\n[TIMEOUT] Connection taking too long. Check your session ID.', 'red'));
    }, 60000);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (connection === 'close') {
        clearTimeout(connectionTimeout);
        const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut && 
                               lastDisconnect.error?.output?.statusCode !== 401;
        console.log(color(`[INFO] Connection closed: ${lastDisconnect.error?.message || 'Unknown reason'} (Status: ${lastDisconnect.error?.output?.statusCode}). Reconnecting: ${shouldReconnect}`, 'yellow'));
        if (shouldReconnect) startBot();
        else {
            console.log(color('[ERROR] Logged out or session invalid. Please provide a new Session ID.', 'red'));
            if (fs.existsSync(SESSION_ID_FILE)) fs.unlinkSync(SESSION_ID_FILE);
            if (fs.existsSync(path.join(__dirname, 'auth_info', 'creds.json'))) fs.unlinkSync(path.join(__dirname, 'auth_info', 'creds.json'));
            process.exit(1);
        }
      } else if (connection === 'open') {
          clearTimeout(connectionTimeout);
          const ascii = `
  ══════════════════════════════════════════════════════
    ╔═╗╔═╗╦  ╦╔═╗╔═╗╔═╗   ╔╦╗╔╦╗
    ║╣ ║  ║  ║╠═╝╚═╗║╣ ───║║║║║║
    ╚═╝╚═╝╩═╝╩╩  ╚═╝╚═╝   ╩ ╩╩ ╩
  ══════════════════════════════════════════════════════
        `;
        console.log(color(ascii, 'cyan'));
        
        const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        const accountName = sock.user.name || config.ownerName;
        const connectedNumber = sock.user.id.split(':')[0];

        console.log(color(`[SUCCESS] Connected to WhatsApp`, 'green'));
        console.log(color(`[ACCOUNT] Name: ${accountName}`, 'cyan'));
        console.log(color(`[ACCOUNT] Number: ${connectedNumber}`, 'cyan'));
        console.log(color(`[CONFIG] Prefix: ${COMMAND_PREFIX}`, 'cyan'));

        // Update config and persistent settings with the connected number
        if (config.ownerNumber !== connectedNumber) {
            console.log(color(`[INFO] Updating owner number to: ${connectedNumber}`, 'yellow'));
            config.ownerNumber = connectedNumber;
            updateSetting('ownerNumber', connectedNumber);
        }
        
        const welcomeImage = "https://files.catbox.moe/vsxdpj.jpg";
        
        await sock.sendMessage(myJid, { 
            image: { url: welcomeImage },
            caption: `✅ *Eclipse MD Connected!*\n\n🤖 *Account:* ${accountName}\n🔢 *Number:* ${connectedNumber}\n⚡ *Prefix:* ${COMMAND_PREFIX}\n🌐 *Mode:* ${global.botMode}\n\nUse ${COMMAND_PREFIX}menu to start.`
        });
      }
    });

    sock.ev.on('group-participants.update', async (update) => {
      const { id, participants, action } = update;
      try {
          const welcomePath = path.join(__dirname, 'data', 'welcomeConfig.json');
          if (!fs.existsSync(welcomePath)) fs.writeFileSync(welcomePath, '{}');
          const welcomeConfig = JSON.parse(fs.readFileSync(welcomePath, 'utf-8'));
          const groupSettings = welcomeConfig[id] || { welcome: 'off', goodbye: 'off' };

          for (const jid of participants) {
            if (action === 'add' && groupSettings.welcome === 'on') {
              const metadata = await sock.groupMetadata(id);
              const text = groupSettings.welcomeMsg || `Welcome @user to ${metadata.subject}!`;
              await sock.sendMessage(id, { 
                text: text.replace('@user', `@${jid.split('@')[0]}`),
                mentions: [jid]
              });
            } else if (action === 'remove' && groupSettings.goodbye === 'on') {
              const text = groupSettings.goodbyeMsg || `Goodbye @user from the group.`;
              await sock.sendMessage(id, { 
                text: text.replace('@user', `@${jid.split('@')[0]}`),
                mentions: [jid]
              });
            }
          }
      } catch (e) {}
    });

    sock.ev.on('call', async (calls) => {
      const call = calls[0];
      if (call.status === 'offer') {
        const { voice, video, mode } = readAnticallState();
        const isVideo = call.isVideo;
        const shouldReject = (isVideo && video === 'on') || (!isVideo && voice === 'on');
        
        if (shouldReject) {
          await sock.rejectCall(call.id, call.from);
          if (mode === 'block') {
            await sock.sendMessage(call.from, { text: '⚠️ You have been blocked for calling the bot.' });
            await sock.updateBlockStatus(call.from, 'block');
          } else {
            await sock.sendMessage(call.from, { text: '📵 I am busy right now.' });
          }
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      if (!msg.message || !botActive) return;

      try {
        let remoteJid = msg.key.remoteJid;
        if (remoteJid.endsWith('@lid')) {
          remoteJid = remoteJid.split('@')[0] + '@s.whatsapp.net';
        }
        const isGroup = remoteJid.endsWith('@g.us');
        const isFromMe = msg.key.fromMe;
        const senderJid = isGroup ? msg.key.participant : remoteJid;
        const senderNumber = await normalizeJid(sock, senderJid, isGroup ? remoteJid : null);
        const isOwner = isFromMe || senderNumber === config.ownerNumber.replace(/[^\d]/g, '');

        if (!isOwner && body.startsWith(COMMAND_PREFIX)) {
             const args = body.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
             const cmdName = args.shift().toLowerCase();
             const restrictedCmds = ['restart', 'shutdown', 'stop', 'logout'];
             if (restrictedCmds.includes(cmdName)) {
                 return await sock.sendMessage(remoteJid, { text: '❌ This command is restricted to the bot owner.' }, { quoted: msg });
             }
        }

        if (isGroup && !isFromMe && antitag?.onMessage) {
          await antitag.onMessage(msg, { sock });
        }

        // Antilink monitor (Groups only, not from bot)
        if (isGroup && !isFromMe) {
          const userMessage = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';

          // Anti WhatsApp Channel Link
          if (global.antiChannelLink?.[remoteJid] && (userMessage.includes('whatsapp.com/channel/'))) {
              await sock.sendMessage(remoteJid, { delete: msg.key });
              return;
          }

          // Anti Telegram Link
          if (global.antiTelegramLink?.[remoteJid]) {
            const telegramPattern = /(t\.me\/|telegram\.me\/)/i;
            if (telegramPattern.test(userMessage)) {
              await sock.sendMessage(remoteJid, { delete: msg.key });
              
              if (global.antiTelegramKick?.[remoteJid]) {
                await sock.groupParticipantsUpdate(remoteJid, [senderJid], 'remove');
              } else if (global.antiTelegramWarn?.[remoteJid]) {
                if (!global.antilinkWarnings) global.antilinkWarnings = {};
                if (!global.antilinkWarnings[remoteJid]) global.antilinkWarnings[remoteJid] = {};
                global.antilinkWarnings[remoteJid][senderJid] = (global.antilinkWarnings[remoteJid][senderJid] || 0) + 1;
                
                if (global.antilinkWarnings[remoteJid][senderJid] >= 3) {
                  await sock.sendMessage(remoteJid, { text: `⚠️ @${senderNumber} has been kicked for repeated telegram link sharing.`, mentions: [senderJid] });
                  await sock.groupParticipantsUpdate(remoteJid, [senderJid], 'remove');
                  delete global.antilinkWarnings[remoteJid][senderJid];
                } else {
                  await sock.sendMessage(remoteJid, { text: `⚠️ @${senderNumber}, telegram links are not allowed! Warning: ${global.antilinkWarnings[remoteJid][senderJid]}/3`, mentions: [senderJid] });
                }
              }
              return;
            }
          }

          await handleLinkDetection(sock, remoteJid, msg, userMessage, senderJid);
        }

        await storeMessage(sock, msg);

        if (msg.message?.protocolMessage?.type === 0 || msg.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE) {
            await handleMessageRevocation(sock, msg);
        }

        let body = '';
        const type = Object.keys(msg.message)[0];
        if (type === 'conversation') body = msg.message.conversation;
        else if (type === 'extendedTextMessage') body = msg.message.extendedTextMessage.text;
        else if (type === 'imageMessage') body = msg.message.imageMessage.caption;
        else if (type === 'videoMessage') body = msg.message.videoMessage.caption;

        if (!body) return;

        const isReply = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const sessionKey = remoteJid;

        if (body.startsWith(COMMAND_PREFIX)) {
          const args = body.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
          const commandName = args.shift()?.toLowerCase();

          if (commandName === 'self' && isOwner) {
            botMode = 'self';
            updateSetting('botMode', 'self');
            await sock.sendMessage(remoteJid, { text: '🤖 Switched to SELF mode.' });
            return;
          }
          if (commandName === 'public' && isOwner) {
            botMode = 'public';
            updateSetting('botMode', 'public');
            await sock.sendMessage(remoteJid, { text: '🌐 Switched to PUBLIC mode.' });
            return;
          }

          if (botMode === 'self' && !isOwner) return;

          const command = (botMode === 'self' || isOwner) ? (commands.get(commandName) || selfCommands.get(commandName)) : commands.get(commandName);
          if (command) {
            await command.execute(msg, { sock, args, isOwner, botMode, settings: { prefix: COMMAND_PREFIX } });
          }
        } else if (chatbotHandler && !isFromMe) {
          await chatbotHandler(sock, msg, body, senderJid);
        }
      } catch (err) {
        console.error('[ERROR] messages.upsert:', err);
      }
    });
  } catch (err) {
    console.error(color(`[FATAL] startBot failed: ${err.message}`, 'red'));
    setTimeout(startBot, 10000);
  }
}

startBot();
