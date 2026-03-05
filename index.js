require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { create } = require('@open-wa/wa-automate');
const axios = require('axios');
const puppeteer = require('puppeteer');
const os = require('os');

const WY_CONFIG = {
  botName: 'WY Bot',
  groupName: 'WILLZINHOSTORE',
  groupId: '120363407359840640@g.us',
  assets: {
    logo: 'img/logo/logo.jpeg',
    bomDia: 'img/comprimentation/good_morning.png',
    boaTarde: 'img/comprimentation/good_afternoon.png',
    boaNoite: 'img/comprimentation/good_night.png',
    ateAmanha: 'img/comprimentation/ate_amanha.png',
    welcome: 'img/comprimentation/bem_vindo.png',
    ban: 'img/comprimentation/ban.png',
    open: 'img/comprimentation/open.jpg',
    close: 'img/comprimentation/close.jpg'
  },
  links: {
    groupInvite: 'https://chat.whatsapp.com/EnnZJ7ddbwa9Alv9muCRW7?mode=gi_t'
  },
  schedule: {
    morningHour: 10,
    afternoonHour: 12,
    eveningHour: 18,
    closingHour: 0
  },
  moderation: {
    enabled: true,
    apiUrl: process.env.MODERATION_API_URL || 'https://api-inference.huggingface.co/models/NotS0L/NSFW-Detector',
    apiToken: process.env.MODERATION_API_TOKEN || process.env.HF_API_TOKEN || process.env.HUGGINGFACE_API_TOKEN,
    nsfwThreshold: 0.6,
    violenceThreshold: 0.4,
    maxBytes: 5 * 1024 * 1024
  },
  security: {
    adminWhitelist: [], // opcional: ['5511999999999@c.us']
    maxMessageLength: 2000,
    commandCooldownMs: 1500
  }
};

// ======================
// CONFIGURAÇÃO GROQ API
// ======================
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ================
// GERAR RESPOSTA
// ================
async function gerarResposta(mensagem) {
  const callStarted = Date.now();
  try {
    const resposta = await axios.post(
      GROQ_API_URL,
      {
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: 'Você é o WY Bot do grupo WILLZINHOSTORE, um assistente atento a regras do grupo e a pedidos dos administradores. Responda de forma objetiva e mantenha o tom profissional.'
          },
          {
            role: 'user',
            content: mensagem
          }
        ],
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const textoGerado = resposta.data.choices?.[0]?.message?.content?.trim();
    groqLastStatus = 'ok';
    groqLastLatencyMs = Date.now() - callStarted;
    groqLastCallTs = Date.now();
    return textoGerado || "❌ Desculpe, não consegui gerar uma resposta.";
  } catch (err) {
    groqLastStatus = 'erro';
    groqLastLatencyMs = null;
    groqLastCallTs = Date.now();
    groqErrorCount += 1;
    logError('Erro na API da Groq', err);
    return "❌ Erro ao se comunicar com a IA.";
  }
}

async function pingGroqHealthIfNeeded() {
  const callStarted = Date.now();
  const stale = !groqLastCallTs || (Date.now() - groqLastCallTs > 60_000) || groqLastStatus === 'desconhecido';
  if (!stale) return;
  if (!GROQ_API_KEY) {
    groqLastStatus = 'sem_api_key';
    groqLastLatencyMs = null;
    groqLastCallTs = Date.now();
    groqErrorCount += 1;
    pushLog('error', 'GROQ_API_KEY ausente', 'Configure a chave para habilitar IA');
    return;
  }
  try {
    await axios.post(
      GROQ_API_URL,
      { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 },
      { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 3000 }
    );
    groqLastStatus = 'ok';
    groqLastLatencyMs = Date.now() - callStarted;
    groqLastCallTs = Date.now();
  } catch (err) {
    groqLastStatus = 'erro';
    groqLastLatencyMs = null;
    groqLastCallTs = Date.now();
    groqErrorCount += 1;
    pushLog('error', 'Ping Groq falhou', err?.message || err);
  }
}

function getHostInfo() {
  const nets = os.networkInterfaces();
  let ip = 'n/d';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ip = net.address;
        break;
      }
    }
    if (ip !== 'n/d') break;
  }
  return {
    ip,
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    load: os.loadavg()[0]?.toFixed(2),
    memory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem()
    }
  };
}

// ===================
// TEMPO DE EXECUÇÃO
// ===================
const startTime = Date.now();
function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function formatUptimeDetailed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

let clientInstance = null;
let whatsappState = 'stopped';
let messageCount = 0;
const conversationIds = new Set();
const pausedGroups = new Set();
let groqLastStatus = 'desconhecido';
let groqLastLatencyMs = null;
let groqErrorCount = 0;
let groqLastCallTs = null;
const logs = [];
const sessionDir = path.join(__dirname, '_IGNORE_session');
const cacheDir = path.join(__dirname, '_IGNORE_BOT');
const commandTimestamps = new Map(); // key: senderId, value: ts

function pushLog(level, message, detail = null) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message: typeof message === 'string' ? message : String(message),
    detail: detail ? String(detail) : null
  };
  logs.push(payload);
  if (logs.length > 200) logs.shift();
  if (level === 'error') {
    console.error('❌', payload.message, payload.detail ? `| ${payload.detail}` : '');
  } else {
    console.log(`[${level}]`, payload.message, payload.detail ? `| ${payload.detail}` : '');
  }
}

function logError(message, err) {
  pushLog('error', message, err?.message || null);
}

function createClient() {
  // Headless + useChrome false evita abrir janela gráfica; QR aparece apenas no terminal.
  console.log('🟢 Aguardando conexão: o QR Code será exibido no terminal.');
  return create({
    sessionId: "BOT",
    multiDevice: true,
    authTimeout: 60,
    blockCrashLogs: true,
    disableSpins: true,
    headless: true,
    useChrome: false, // usar o Chromium do puppeteer para evitar CHROME_PATH
    executablePath: puppeteer.executablePath(),
    qrTimeout: 0
  });
}

async function start(client) {
  console.log('✅ Bot conectado no WhatsApp com sucesso!');
  clientInstance = client;
  whatsappState = 'connected';
  pushLog('info', 'Bot conectado no WhatsApp');

  iniciarRotinasAgendadas(client);
  registrarBoasVindas(client);

  const spamTracker = new Map(); // key: groupId|senderId|body

  client.onStateChanged((state) => {
    whatsappState = state || 'unknown';
    console.log(`ℹ️ Estado do WhatsApp: ${whatsappState}`);
    pushLog('info', 'Estado WhatsApp atualizado', whatsappState);
  });

  client.onMessage(async (message) => {
    try {
      const { body = '', from, isGroupMsg, chat, sender, mentionedJidList, type, mimetype, isViewOnce } = message;
      messageCount += 1;
      if (from) conversationIds.add(from);
      const command = body.toLowerCase();
      const groupId = chat?.groupMetadata?.id || (isGroupMsg ? from : null);
      const senderId = sender.id;
      const messageId = getMessageId(message);
      const botNumber = await client.getHostNumber() + "@c.us";
      const isGroupAdmin = await resolveIsAdmin(client, chat, groupId, senderId);
      const isBotAdmin = await resolveIsAdmin(client, chat, groupId, botNumber);
      const botMentioned = Array.isArray(mentionedJidList) && mentionedJidList.includes(botNumber);

      console.log('[MSG]', { from, isGroupMsg, command, isGroupAdmin, groupId });

      // Segurança: limitar tamanho
      if (body.length > WY_CONFIG.security.maxMessageLength) {
        return;
      }

      // Roteamento: PV recebe apresentação; grupo segue regras do WY Bot
      if (!isGroupMsg) {
        await responderPrivado(client, from, sender);
        return;
      }

      // Apenas grupo alvo
      if (WY_CONFIG.groupId && WY_CONFIG.groupId !== groupId) return;

      // Modo pausado: só aceita !init de ADM
      if (pausedGroups.has(groupId)) {
        if (command === '!init' && isGroupAdmin) {
          pausedGroups.delete(groupId);
          await client.sendText(from, '✅ Bot reativado neste grupo.');
        }
        return;
      }

      const moderacao = await moderarMidiaSeNecessario(client, {
        message,
        mimetype,
        type,
        groupId,
        from,
        senderId,
        isGroupAdmin,
        messageId
      });
      if (moderacao === 'blocked') return;

      // Anti-link para não admins
      if (!isGroupAdmin && contemLink(body)) {
        await punir(client, { groupId, targetId: senderId, motivo: 'Envio de link sem permissão', from, messageIds: [messageId] });
        return;
      }

      // Anti-arquivo (exceto foto/vídeo) para não admins
      if (!isGroupAdmin && isArquivoRestrito(type, mimetype, isViewOnce)) {
        await punir(client, { groupId, targetId: senderId, motivo: 'Envio de arquivo não permitido', from, messageIds: [messageId] });
        return;
      }

      // Anti-spam: 7 vezes a mesma mensagem
      if (!isGroupAdmin && isSpamRepetido(spamTracker, groupId, senderId, body)) {
        await punir(client, { groupId, targetId: senderId, motivo: 'Spam detectado (7x mesma mensagem)', from, messageIds: [messageId] });
        return;
      }

      // Comandos só para admins
      if (command.startsWith('!')) {
        if (!isAuthorizedAdmin(senderId, isGroupAdmin)) return;
        if (isOnCooldown(senderId)) return;
        if (command === '!ping') {
          const uptime = formatUptime(Date.now() - startTime);
          const speed = Date.now() - message.t;
          await client.sendText(from, `🏓 ${WY_CONFIG.botName} ativo\nUptime: ${uptime}\nLatência: ${speed}ms`);
          return;
        }
        if (command === '!status') {
          await client.sendText(from, formatStatus());
          return;
        }
        if (command === '!groupid') {
          await client.sendText(from, `ID deste grupo: ${groupId}`);
          return;
        }
        if (command.startsWith('!pesquisa')) {
          const pergunta = body.replace('!pesquisa', '').trim();
          if (!pergunta) return await client.sendText(from, '❌ Informe o que pesquisar. Ex: !pesquisa quem foi cristóvão colombo');
          const resposta = await gerarResposta(pergunta);
          await client.sendText(from, resposta);
          return;
        }
        if (command === '!info') {
          const info = formatInfo(message);
          await client.sendText(from, info);
          return;
        }
        if (command === '!open') {
          await setGroupAdminOnly(client, groupId, false);
          await enviarAberturaFechamento(client, groupId, false);
          return;
        }
        if (command === '!close') {
          await setGroupAdminOnly(client, groupId, true);
          await enviarAberturaFechamento(client, groupId, true);
          return;
        }
        if (command === '!stop') {
          pausedGroups.add(groupId);
          await client.sendText(from, '⏸ Bot pausado neste grupo. Sem respostas ou moderação até usar !init.');
          return;
        }
        if (command === '!init') {
          pausedGroups.delete(groupId);
          await client.sendText(from, '✅ Bot reativado neste grupo.');
          return;
        }
        if (command.startsWith('!ban')) {
          if (!isBotAdmin) return await client.sendText(from, '❌ Preciso ser administrador para banir.');
          const targetNumber = parseNumberFromText(body.replace('!ban', ''));
          const targets = [];
          if (mentionedJidList?.length) targets.push(...mentionedJidList);
          if (targetNumber) targets.push(`${targetNumber}@c.us`);
          if (!targets.length) return await client.sendText(from, '❌ Informe quem banir: marque @ou número (+DDD... ou DDD...).');
          for (const jid of targets) {
            await client.removeParticipant(groupId, jid);
            await avisarBan(client, from, jid, 'Ação administrativa');
          }
          return;
        }
        if (command.startsWith('!add')) {
          if (!isBotAdmin) return await client.sendText(from, '❌ Preciso ser administrador para adicionar.');
          const number = parseNumberFromText(body.replace('!add', ''));
          if (!number) return await client.sendText(from, '❌ Informe o número. Exemplo: !add +5581999999999');
          await client.addParticipant(groupId, `${number}@c.us`);
          await client.sendText(from, `✅ Usuário ${number} adicionado.`);
          return;
        }
        if (command.startsWith('!privelege-adm')) {
          if (!isBotAdmin) return await client.sendText(from, '❌ Preciso ser administrador para promover.');
          if (!mentionedJidList?.length) return await client.sendText(from, '❌ Marque quem promover.');
          for (const jid of mentionedJidList) {
            await promover(client, groupId, jid);
          }
          await client.sendText(from, '✅ Participante(s) promovido(s) a ADM.');
          return;
        }
        if (command.startsWith('!remove-adm')) {
          if (!isBotAdmin) return await client.sendText(from, '❌ Preciso ser administrador para rebaixar.');
          if (!mentionedJidList?.length) return await client.sendText(from, '❌ Marque quem rebaixar.');
          for (const jid of mentionedJidList) {
            await rebaixar(client, groupId, jid);
          }
          await client.sendText(from, '✅ Participante(s) rebaixado(s) de ADM.');
          return;
        }
        return;
      }

      // Responder apenas admins, somente se mencionarem o bot
      if (!isAuthorizedAdmin(senderId, isGroupAdmin)) return;
      if (!botMentioned) return;

      const resposta = await gerarResposta(body);
      await client.sendText(from, resposta);
      console.log('✅ Respondeu com Groq (menção):', resposta);

    } catch (err) {
      logError('Erro ao processar mensagem', err);
    }
  });
}

function startBot(io) {
  if (clientInstance) {
    io?.emit('botStatus', 'Bot já está rodando.');
    return Promise.resolve(clientInstance);
  }

  console.log('🚀 Iniciando bot... QR será exibido apenas no terminal.');
  return createClient()
    .then(client => {
      start(client);
      io?.emit('botStatus', 'Bot iniciado com sucesso!');
      return client;
    })
    .catch(err => {
      console.error('❌ Erro ao iniciar bot:', err);
      io?.emit('botStatus', 'Erro ao iniciar bot.');
      throw err;
    });
}

function stopBot() {
  if (clientInstance) {
    console.log('🛑 Parando bot...');
    clientInstance.close();
    clientInstance = null;
    whatsappState = 'stopped';
  }
}

function getBotStatus() {
  return clientInstance ? 'Rodando' : 'Parado';
}

async function getFolderSizeBytes(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await getFolderSizeBytes(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(fullPath);
        total += stat.size;
      }
    }
    return total;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    logError(`Falha ao ler pasta ${dir}`, err);
    return 0;
  }
}

async function getMetrics() {
  const now = Date.now();
  const memory = process.memoryUsage();
  const sessionSize = await getFolderSizeBytes(sessionDir);
  const cacheSize = await getFolderSizeBytes(cacheDir);
  await pingGroqHealthIfNeeded();
  const host = getHostInfo();

  return {
    botStatus: getBotStatus(),
    whatsappState,
    connected: Boolean(clientInstance),
    uptimeMs: now - startTime,
    uptime: formatUptimeDetailed(now - startTime),
    messageCount,
    conversationCount: conversationIds.size,
    groq: {
      status: groqLastStatus,
      latencyMs: groqLastLatencyMs,
      errorCount: groqErrorCount,
      lastCallTs: groqLastCallTs
    },
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external
    },
    host,
    storage: {
      sessionDirSizeBytes: sessionSize,
      cacheDirSizeBytes: cacheSize
    },
    errors: logs.slice(-80).reverse(),
    timestamp: new Date(now).toISOString()
  };
}

module.exports = { startBot, stopBot, getBotStatus, getMetrics };

// Permite executar "node index.js" diretamente para iniciar o bot.
if (require.main === module) {
  startBot().catch(() => {
    // Erro já foi logado; manter processo vivo para facilitar debug se necessário.
  });
}

function contemLink(texto = '') {
  return /(https?:\/\/|chat\.whatsapp\.com|wa\.me)/i.test(texto);
}

function isArquivoRestrito(type, mimetype = '', isViewOnce = false) {
  if (isViewOnce) return false; // liberar fotos/vídeos de visualização única
  const isImage = mimetype.startsWith('image/');
  const isVideo = mimetype.startsWith('video/');
  const isDocument = type === 'document' || mimetype.startsWith('application/');
  const isAudio = mimetype.startsWith('audio/') || type === 'ptt' || type === 'audio';
  // Permitido: foto, vídeo e áudio
  if (isImage || isVideo || isAudio) return false;
  // Bloquear documentos e demais anexos
  return isDocument;
}

function isSpamRepetido(store, groupId, senderId, body) {
  if (!body) return false;
  const key = `${groupId}|${senderId}|${body.trim().toLowerCase()}`;
  const data = store.get(key) || { count: 0, last: Date.now() };
  const now = Date.now();
  if (now - data.last > 10 * 60 * 1000) { // zera após 10 minutos
    store.set(key, { count: 1, last: now });
    return false;
  }
  data.count += 1;
  data.last = now;
  store.set(key, data);
  return data.count >= 7;
}

async function responderPrivado(client, to, sender) {
  const nome = sender?.pushname || 'visitante';
  const legend = `👋 Olá ${nome}! Eu sou o ${WY_CONFIG.botName} do grupo ${WY_CONFIG.groupName}.
❗️ Atendo apenas dentro do grupo, siga o link: ${WY_CONFIG.links.groupInvite}.
📎 Mensagens em PV não são respondidas.`;
  try {
    await client.sendImage(to, WY_CONFIG.assets.logo, 'logo.png', legend);
  } catch (err) {
    logError('Falha ao responder no PV', err);
    await client.sendText(to, legend);
  }
}

async function punir(client, { groupId, targetId, motivo, from, messageIds }) {
  try {
    if (Array.isArray(messageIds)) {
      for (const mid of messageIds) {
        await apagarMensagem(client, from || groupId, mid);
      }
    }
    await client.removeParticipant(groupId, targetId);
    await avisarBan(client, from, targetId, motivo);
  } catch (err) {
    logError('Falha ao punir usuário', err);
  }
}

async function apagarMensagem(client, chatId, messageId) {
  const id = normalizeMessageId(messageId);
  if (!chatId || !id) return;
  try {
    await client.deleteMessage(chatId, id);
  } catch (err) {
    logError('Falha ao apagar mensagem', err);
  }
}

async function avisarBan(client, to, jid, motivo) {
  const numero = jid?.split('@')[0] || 'desconhecido';
  const ts = nowInBRT().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const caption = `🚫 Usuário banido\n👤 Número: ${numero}\n🕒 Horário: ${ts}\n📄 Motivo: ${motivo || 'Violação de regras'}`;
  const banImg = WY_CONFIG.assets.ban;
  try {
    if (banImg) {
      await client.sendImage(to, banImg, path.basename(banImg), caption);
      return;
    }
    await client.sendText(to, caption);
  } catch (err) {
    logError('Falha ao avisar ban', err);
    await client.sendText(to, caption);
  }
}

async function enviarAberturaFechamento(client, groupId, fechar) {
  const img = fechar ? WY_CONFIG.assets.close : WY_CONFIG.assets.open;
  const caption = fechar
    ? `🔒 Grupo fechado pelos ADM. Respeite as regras; reabriremos no horário programado.`
    : `🔓 Grupo aberto pelos ADM. Participe com respeito e sem spam.`;
  try {
    if (img) {
      await client.sendImage(groupId, img, path.basename(img), caption);
      return;
    }
    await client.sendText(groupId, caption);
  } catch (err) {
    logError('Falha ao enviar aviso de abertura/fechamento', err);
    await client.sendText(groupId, caption);
  }
}

async function promover(client, groupId, jid) {
  try {
    if (typeof client.promoteParticipant === 'function') {
      await client.promoteParticipant(groupId, jid);
      return true;
    }
    if (typeof client.groupParticipantsUpdate === 'function') {
      await client.groupParticipantsUpdate(groupId, [jid], 'promote');
      return true;
    }
  } catch (err) {
    logError('Falha ao promover ADM', err);
  }
  return false;
}

async function rebaixar(client, groupId, jid) {
  try {
    if (typeof client.demoteParticipant === 'function') {
      await client.demoteParticipant(groupId, jid);
      return true;
    }
    if (typeof client.groupParticipantsUpdate === 'function') {
      await client.groupParticipantsUpdate(groupId, [jid], 'demote');
      return true;
    }
  } catch (err) {
    logError('Falha ao rebaixar ADM', err);
  }
  return false;
}

function formatStatus() {
  const uptime = formatUptimeDetailed(Date.now() - startTime);
  return `${WY_CONFIG.botName} online\nGrupo: ${WY_CONFIG.groupName}\nUptime: ${uptime}\nMensagens: ${messageCount}\nConversas únicas: ${conversationIds.size}`;
}

function formatInfo(message) {
  const mem = process.memoryUsage();
  const rssMb = (mem.rss / 1024 / 1024).toFixed(2);
  const rssKb = (mem.rss / 1024).toFixed(0);
  const speed = message?.t ? (Date.now() - message.t) : null;
  const ip = getLocalIp();
  return [
    `ℹ️ ${WY_CONFIG.botName} - Info`,
    `IP: ${ip}`,
    speed !== null ? `Velocidade: ${speed}ms` : 'Velocidade: n/d',
    `Ping/Lag: ${speed !== null ? speed + 'ms' : 'n/d'}`,
    `Memória: ${rssMb} MB (${rssKb} KB)`,
    `Mensagens processadas: ${messageCount}`,
    `Conversas únicas: ${conversationIds.size}`,
    `Status: ${whatsappState}`
  ].join('\n');
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'n/d';
}

function parseNumberFromText(text = '') {
  const digits = (text.match(/\d+/g) || []).join('');
  if (!digits) return null;
  // se vier sem país, assumimos +55
  if (digits.length <= 11 && !digits.startsWith('55')) {
    return `55${digits}`;
  }
  return digits;
}

function isAuthorizedAdmin(senderId, isGroupAdmin) {
  const wl = WY_CONFIG.security.adminWhitelist;
  if (Array.isArray(wl) && wl.length > 0) {
    return wl.includes(senderId);
  }
  return isGroupAdmin;
}

function isOnCooldown(senderId) {
  const now = Date.now();
  const last = commandTimestamps.get(senderId) || 0;
  if (now - last < WY_CONFIG.security.commandCooldownMs) return true;
  commandTimestamps.set(senderId, now);
  return false;
}

function shouldCheckMidia(mimetype = '', type = '') {
  const isImage = mimetype.startsWith('image/') || type === 'image';
  const isVideo = mimetype.startsWith('video/') || type === 'video';
  return isImage || isVideo;
}

function getMessageId(message) {
  return message?.id?._serialized || message?.id || null;
}

function normalizeMessageId(messageId) {
  if (!messageId) return null;
  if (typeof messageId === 'string') return messageId;
  if (messageId.id) return messageId.id;
  return messageId._serialized || null;
}

async function moderarMidiaSeNecessario(client, { message, mimetype, type, groupId, from, senderId, isGroupAdmin, messageId }) {
  if (!WY_CONFIG.moderation?.enabled) return 'skipped';
  if (!shouldCheckMidia(mimetype, type)) return 'skipped';
  if (isGroupAdmin) return 'skipped';

  try {
    const mediaBuffer = await client.decryptFile(message);
    if (!mediaBuffer) return 'skipped';
    if (WY_CONFIG.moderation.maxBytes && mediaBuffer.length > WY_CONFIG.moderation.maxBytes) {
      pushLog('warn', 'Midia ignorada por tamanho', mediaBuffer.length);
      return 'skipped';
    }

    const analise = await analisarMidia(mediaBuffer, mimetype, type);
    if (!analise) return 'skipped';
    if (analise.flagged) {
      const motivo = analise.reason || 'Conteúdo proibido detectado';
      await punir(client, { groupId, targetId: senderId, motivo, from, messageIds: [messageId] });
      return 'blocked';
    }
    return 'allowed';
  } catch (err) {
    logError('Erro ao moderar mídia', err);
    return 'skipped';
  }
}

async function analisarMidia(buffer, mimetype = 'application/octet-stream', type = '') {
  const cfg = WY_CONFIG.moderation;
  if (!cfg?.enabled) return null;
  if (!cfg.apiToken || !cfg.apiUrl) {
    pushLog('warn', 'Moderação desligada: token ou URL ausente');
    return null;
  }

  try {
    const resp = await axios.post(cfg.apiUrl, buffer, {
      headers: {
        'Authorization': `Bearer ${cfg.apiToken}`,
        'Content-Type': mimetype || 'application/octet-stream'
      },
      timeout: 15000
    });

    const labels = normalizeLabels(resp.data);
    const nsfwScore = getLabelScore(labels, /(nsfw|porn|sexual|explicit|nudity)/i);
    const violenceScore = getLabelScore(labels, /(violence|gore|bloody|weapon|death|murder)/i);
    const flagged = (nsfwScore >= cfg.nsfwThreshold) || (violenceScore >= cfg.violenceThreshold);
    const reason = flagged ? `Conteúdo proibido detectado (NSFW ${nsfwScore.toFixed(2)}, Violência ${violenceScore.toFixed(2)})` : null;

    return { flagged, nsfwScore, violenceScore, reason, labels, type };
  } catch (err) {
    logError('Falha na API de moderação', err);
    return null;
  }
}

function normalizeLabels(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[0])) return data[0];
  if (Array.isArray(data?.labels)) return data.labels;
  return [];
}

function getLabelScore(labels, regex) {
  if (!Array.isArray(labels)) return 0;
  return labels.reduce((max, item) => {
    const label = item?.label || item?.class || item?.category || '';
    const score = typeof item?.score === 'number' ? item.score
      : typeof item?.probability === 'number' ? item.probability
      : typeof item?.confidence === 'number' ? item.confidence
      : 0;
    if (regex.test(String(label))) return Math.max(max, score);
    return max;
  }, 0);
}

// ====== ROTINAS AGENDADAS ======
let greetingTimersStarted = false;
function iniciarRotinasAgendadas(client) {
  if (greetingTimersStarted) return;
  greetingTimersStarted = true;

  const lastSent = {
    morning: null,
    afternoon: null,
    evening: null,
    closing: null
  };

  setInterval(async () => {
    if (!WY_CONFIG.groupId) return;
    const now = nowInBRT();
    const h = now.getHours();
    const dayKey = now.toISOString().slice(0, 10);

    try {
      if (h === WY_CONFIG.schedule.morningHour && lastSent.morning !== dayKey) {
        await enviarGreeting(client, 'bomDia');
        await setGroupAdminOnly(client, WY_CONFIG.groupId, false); // abre
        lastSent.morning = dayKey;
      }

      if (h === WY_CONFIG.schedule.afternoonHour && lastSent.afternoon !== dayKey) {
        await enviarGreeting(client, 'boaTarde');
        lastSent.afternoon = dayKey;
      }

      if (h === WY_CONFIG.schedule.eveningHour && lastSent.evening !== dayKey) {
        await enviarGreeting(client, 'boaNoite');
        lastSent.evening = dayKey;
      }

      if (h === WY_CONFIG.schedule.closingHour && lastSent.closing !== dayKey) {
        await enviarGreeting(client, 'ateAmanha');
        await setGroupAdminOnly(client, WY_CONFIG.groupId, true); // fecha
        lastSent.closing = dayKey;
      }
    } catch (err) {
      logError('Erro em rotina agendada', err);
    }
  }, 60 * 1000);
}

function nowInBRT() {
  const str = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
  return new Date(str);
}

async function setGroupAdminOnly(client, groupId, adminOnly) {
  if (!groupId) return false;
  try {
    if (typeof client.setGroupToAdminsOnly === 'function') {
      await client.setGroupToAdminsOnly(groupId, adminOnly);
      return true;
    }
    if (typeof client.groupSettingChange === 'function') {
      const setting = adminOnly ? 'announcement' : 'not_announcement';
      await client.groupSettingChange(groupId, setting);
      return true;
    }
    if (typeof client.setGroupSetting === 'function') {
      await client.setGroupSetting(groupId, 'announcement', adminOnly);
      return true;
    }
  } catch (err) {
    logError('Falha ao ajustar modo ADM', err);
  }
  return false;
}

async function resolveIsAdmin(client, chat, groupId, userId) {
  if (!groupId || !userId) return false;
  try {
    const fromChat = chat?.groupMetadata?.participants;
    if (fromChat?.length) {
      const found = fromChat.find(p => p.id === userId);
      if (found) return Boolean(found.isAdmin || found.isSuperAdmin);
    }
    const admins = await client.getGroupAdmins(groupId);
    return Array.isArray(admins) ? admins.includes(userId) : false;
  } catch (err) {
    logError('Falha ao checar admin', err);
    return false;
  }
}

async function enviarGreeting(client, tipo) {
  const assetMap = {
    bomDia: {
      path: WY_CONFIG.assets.bomDia,
      caption: `🌅 Bom dia, família ${WY_CONFIG.groupName}! Grupo liberado, compartilhe suas novidades.`
    },
    boaTarde: {
      path: WY_CONFIG.assets.boaTarde,
      caption: `☀️ Boa tarde, ${WY_CONFIG.groupName}! Continuem interagindo com respeito.`
    },
    boaNoite: {
      path: WY_CONFIG.assets.boaNoite,
      caption: `🌙 Boa noite, ${WY_CONFIG.groupName}! Mantenham o foco e evitem spam.`
    },
    ateAmanha: {
      path: WY_CONFIG.assets.ateAmanha,
      caption: `🌛 Até amanhã, ${WY_CONFIG.groupName}! Grupo fechado, apenas ADM até às ${WY_CONFIG.schedule.morningHour}h.`
    }
  };

  const item = assetMap[tipo];
  if (!item) return;
  try {
    await client.sendImage(WY_CONFIG.groupId, item.path, path.basename(item.path), item.caption);
  } catch (err) {
    logError('Falha ao enviar greeting', err);
    await client.sendText(WY_CONFIG.groupId, item.caption);
  }
}

// ====== BOAS-VINDAS ======
function registrarBoasVindas(client) {
  client.onGlobalParticipantsChanged(async (event) => {
    try {
      if (!WY_CONFIG.groupId || event.chat !== WY_CONFIG.groupId) return;
      if (event.action !== 'add') return;
      const numero = event.who?.split('@')[0] || 'novo membro';
      const legenda = `👋 Bem-vindo(a) ${numero}!\n📌 Grupo: ${WY_CONFIG.groupName}\n🔢 Número: ${numero}\n📝 Apresente-se e leia as regras. Respeito é obrigatório.`;
      const welcomeImg = WY_CONFIG.assets.welcome || WY_CONFIG.assets.logo;
      try {
        await client.sendImage(WY_CONFIG.groupId, welcomeImg, path.basename(welcomeImg), legenda);
      } catch (errImg) {
        logError('Falha ao enviar welcome', errImg);
        await client.sendText(WY_CONFIG.groupId, legenda);
      }
    } catch (err) {
      logError('Erro no welcome', err);
    }
  });
}
