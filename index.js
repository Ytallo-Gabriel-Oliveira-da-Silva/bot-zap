require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { create } = require('@open-wa/wa-automate');
const axios = require('axios');

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
            content: 'Você é o Bot Ytallo Shop, um assistente útil para responder perguntas e ajudar em vendas e dúvidas pelo WhatsApp.'
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
let groqLastStatus = 'desconhecido';
let groqLastLatencyMs = null;
let groqErrorCount = 0;
let groqLastCallTs = null;
const errorLogs = [];
const sessionDir = path.join(__dirname, '_IGNORE_session');
const cacheDir = path.join(__dirname, '_IGNORE_BOT');

function logError(message, err) {
  const payload = {
    ts: new Date().toISOString(),
    message: typeof message === 'string' ? message : String(message),
    detail: err?.message || null
  };
  errorLogs.push(payload);
  if (errorLogs.length > 100) errorLogs.shift();
  console.error('❌', payload.message, payload.detail ? `| ${payload.detail}` : '');
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
    useChrome: false,
    qrTimeout: 0
  });
}

async function start(client) {
  console.log('✅ Bot conectado no WhatsApp com sucesso!');
  clientInstance = client;
  whatsappState = 'connected';

  client.onStateChanged((state) => {
    whatsappState = state || 'unknown';
    console.log(`ℹ️ Estado do WhatsApp: ${whatsappState}`);
  });

  client.onMessage(async (message) => {
    try {
      const { body, from, isGroupMsg, chat, sender, mentionedJidList } = message;
      messageCount += 1;
      if (from) conversationIds.add(from);
      const command = body.toLowerCase();
      const groupId = chat?.groupMetadata?.id;
      const senderId = sender.id;
      const isGroupAdmin = chat?.groupMetadata?.participants.find(p => p.id === senderId)?.isAdmin;
      const botNumber = await client.getHostNumber() + "@c.us";
      const isBotAdmin = chat?.groupMetadata?.participants.find(p => p.id === botNumber)?.isAdmin;

      if (isGroupMsg && (body.includes("http://") || body.includes("https://"))) {
        if (!isGroupAdmin) {
          await client.sendText(from, `🚫 ${sender.pushname} você não pode mandar links aqui!`);
          await client.removeParticipant(groupId, senderId);
          console.log(`🚫 Removido ${sender.pushname} por enviar link.`);
          return;
        }
      }

      if (command.startsWith('!')) {
        console.log(`📩 Comando recebido: ${command}`);

        if (command === '!ping') {
          const uptime = formatUptime(Date.now() - startTime);
          const speed = Date.now() - message.t;
          await client.sendText(from, `🏓 *Pong!*\n\nTempo online: ${uptime}\nVelocidade: ${speed}ms`);
        }

        else if (command === '!anuncio1') {
          await client.sendImage(from, 'foto-teste.png', 'foto-teste.png', `texto a ser aparecido à mensagem do watsapp
`);
        }

        else if (command.startsWith('!ban')) {
          if (!isGroupMsg) return await client.sendText(from, '❌ Este comando só pode ser usado em grupos.');
          if (!isGroupAdmin) return await client.sendText(from, '❌ Somente administradores podem usar esse comando.');
          if (!mentionedJidList.length) return await client.sendText(from, '❌ Você precisa marcar a pessoa que quer banir.');
          if (!isBotAdmin) return await client.sendText(from, '❌ Preciso ser administrador para banir alguém.');

          for (let user of mentionedJidList) {
            await client.removeParticipant(groupId, user);
          }
          await client.sendText(from, '👋 Participante removido com sucesso!');
        }

        else if (command.startsWith('!add')) {
          if (!isGroupMsg) return await client.sendText(from, '❌ Este comando só pode ser usado em grupos.');
          if (!isGroupAdmin) return await client.sendText(from, '❌ Somente administradores podem usar esse comando.');
          if (!isBotAdmin) return await client.sendText(from, '❌ Preciso ser administrador para adicionar pessoas.');

          const number = body.split(' ')[1];
          if (!number) return await client.sendText(from, '❌ Você precisa informar o número. Exemplo: !add 5581999999999');

          await client.addParticipant(groupId, number + '@c.us');
          await client.sendText(from, '✅ Usuário adicionado com sucesso!');
        }

        else if (command === '!menu') {
          const menuMessage = `
📋 *Menu - Bot Ytallo Shop*

*Uso do Desenvolvedor do Sistema:*
• !ping - Verifica a conectividade do bot

*Uso Administrativo:*
• !add +55 - Adiciona um número ao grupo
• !ban @usuario - Remove um usuário

*Uso de todos:*
• Pesquisas em formato de perguntas.
• crie img "como quer a img".

Envie sua dúvida ou mensagem para receber uma resposta automática!
          `;
          await client.sendText(from, menuMessage);
        }

        else {
          await client.sendText(from, '❌ Comando não reconhecido.');
        }

      } else {
        const resposta = await gerarResposta(body);
        await client.sendText(from, resposta);
        console.log('✅ Respondeu com Groq:', resposta);
      }

    } catch (err) {
      logError('Erro ao processar mensagem', err);
    }
  }); // <-- FECHANDO client.onMessage
} // <-- FECHANDO corretamente a função start(client)

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
    storage: {
      sessionDirSizeBytes: sessionSize,
      cacheDirSizeBytes: cacheSize
    },
    errors: errorLogs.slice(-50).reverse(),
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
