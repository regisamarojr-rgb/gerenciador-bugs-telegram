const { Telegraf } = require('telegraf');
const { query, tool, createSdkMcpServer } = require('@anthropic-ai/claude-agent-sdk');
const { z } = require('zod');

// ─── CONFIG ────────────────────────────────────────────────────────────────
// IMPORTANTE: este arquivo NÃO usa ANTHROPIC_API_KEY. Ele usa a sua assinatura
// Claude Pro via CLAUDE_CODE_OAUTH_TOKEN (gerado com `claude setup-token`).
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ALLOWED_USER   = process.env.TELEGRAM_USER_ID; // seu user_id do Telegram
const SB_URL         = process.env.SUPABASE_URL || 'https://vxthbjrdtwlnzzadmrmy.supabase.co';
const SB_KEY         = process.env.SUPABASE_KEY || 'sb_publishable_MUJi3VnZ-f4cMhdLxZfR1A_pFmhhQSi';

const OPENAI_KEY    = process.env.OPENAI_API_KEY;

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.warn('⚠️ CLAUDE_CODE_OAUTH_TOKEN não está definido. Gere um com `claude setup-token` na sua máquina e configure essa variável no Railway.');
}
if (process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠️ ANTHROPIC_API_KEY está definida — isso pode fazer o SDK cobrar por token em vez de usar sua assinatura Pro. Remova essa variável do Railway.');
}

const bot = new Telegraf(TELEGRAM_TOKEN);

// ─── SUPABASE HELPERS ─────────────────────────────────────────────────────
const SB_HDR = {
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

async function sbGet(table, query = '') {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${query}`, { headers: SB_HDR });
  if (!r.ok) throw new Error(`SB GET ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbPost(table, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST', headers: SB_HDR, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`SB POST ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sbPatch(table, id, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers: SB_HDR, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`SB PATCH ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}

// ─── TRANSCRIÇÃO DE ÁUDIO (WHISPER) ───────────────────────────────────────
async function downloadTelegramFile(fileId) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
  const d = await r.json();
  if (!d.ok) throw new Error('Erro ao obter arquivo do Telegram');
  const filePath = d.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
  if (!fileRes.ok) throw new Error('Erro ao baixar arquivo do Telegram');
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  const ext = filePath.split('.').pop() || 'ogg';
  return { buffer, ext };
}

async function transcribeAudio(fileId) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY não configurada');
  const { buffer, ext } = await downloadTelegramFile(fileId);

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: `audio/${ext}` }), `audio.${ext}`);
  form.append('model', 'whisper-1');
  form.append('language', 'pt');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: form
  });

  if (!res.ok) throw new Error(`Whisper: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.text || '').trim();
}

// ─── DADOS DO PAINEL ───────────────────────────────────────────────────────
async function getContexto() {
  const [contas, fornecedores] = await Promise.all([
    sbGet('contas', '?order=created_at.desc'),
    sbGet('fornecedores', '?order=nome')
  ]);
  return { contas, fornecedores };
}

// ─── FÓRMULA DE LUCRO (mesma do painel) ───────────────────────────────────
function calcLucro(conta) {
  const saques = conta.saques || [];
  const totalSacado = saques.length ? saques.reduce((s, x) => s + x.val, 0) : (conta.sacado || 0);
  const hasSaque = saques.length > 0 || conta.sacado != null;
  if (!hasSaque) return null;

  const totalPerdas = (conta.perdas || []).reduce((s, p) => s + p.val, 0);
  const lucroBase = conta.status !== 'Finalizada' ? totalSacado : totalSacado - conta.depositado;
  const meuLucro = lucroBase >= 0 ? lucroBase * (1 - conta.pct / 100) - totalPerdas : lucroBase - totalPerdas;
  const lucroCliente = Math.max(0, lucroBase) * (conta.pct / 100);
  return { meuLucro, lucroCliente, lucroBase, totalSacado, totalPerdas };
}

// ─── ID ÚNICO ──────────────────────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ─── AÇÕES (mesma lógica de negócio do bot.js original) ───────────────────
`sync function acaoListarContas(input) {
  const { contas, fornecedores } = await getContexto();
  let lista = contas;
  if (input.filtro_status && input.filtro_status !== 'todas')
    lista = lista.filter(c => c.status === input.filtro_status);
  if (input.filtro_fornecedor) {
    const forn = fornecedores.find(f => f.nome.toLowerCase().includes(input.filtro_fornecedor.toLowerCase()));
    if (forn) lista = lista.filter(c => c.fornecedor_id === forn.id);
  }
  if (!lista.length) return '📭 Nenhuma conta encontrada.';

  return lista.map(c => {
    const l = calcLucro(c);
    const forn = fornecedores.find(f => f.id === c.fornecedor_id);
    let texto = `*${c.dono}* — ${c.casa} (${c.status})\n`;
    texto += `  Dep: R$ ${c.depositado?.toFixed(2)} | ${c.pct}%`;
    if (forn) texto += ` | Forn: ${forn.nome}`;
    if (l) texto += `\n  💰 Meu lucro: R$ ${l.meuLucro.toFixed(2)} | Cliente: R$ ${l.lucroCliente.toFixed(2)}`;
    return texto;
  }).join('\n\n');
}

async function acaoAdicionarConta(input) {
  const { fornecedores } = await getContexto();
  const hoje = new Date().toISOString().slice(0, 10);

  let fornecedor_id = null;
  if (input.fornecedor) {
    const forn = fornecedores.find(f => f.nome.toLowerCase().includes(input.fornecedor.toLowerCase()));
    if (forn) fornecedor_id = forn.id;
  }

  const nova = {
    id: uid(),
    casa: input.casa,
    dono: input.dono,
    depositado: input.depositado,
    pct: input.pct,
    status: 'Em uso',
    fornecedor_id,
    dataDeposito: input.data || hoje,
    saques: [],
    perdas: []
  };
  await sbPost('contas', nova);
  return `✅ Conta *${nova.dono}* (${nova.casa}) adicionada!\nDep: R$ ${nova.depositado} | ${nova.pct}% dono${fornecedor_id ? ` | Forn: ${input.fornecedor}` : ''}`;
}

async function acaoRegistrarSaque(input) {
  const { contas } = await getContexto();
  const hoje = new Date().toISOString().slice(0, 10);
  const conta = contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()) && c.status === 'Em uso')
              || contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()));
  if (!conta) return `❌ Conta com "${input.conta_ref}" não encontrada.`;

  const saques = conta.saques || [];
  saques.push({ id: uid(), val: input.valor, data: input.data || hoje });

  const update = { saques };
  if (input.finalizar) update.status = 'Finalizada';

  await sbPatch('contas', conta.id, update);

  const nova = { ...conta, ...update };
  const l = calcLucro(nova);
  let resp = `✅ Saque de R$ ${input.valor} registrado em *${conta.dono}*${input.finalizar ? ' (conta finalizada)' : ''}.`;
  if (l) resp += `\n💰 Meu lucro: R$ ${l.meuLucro.toFixed(2)} | Cliente: R$ ${l.lucroCliente.toFixed(2)}`;
  return resp;
}

async function acaoRegistrarPerda(input) {
  const { contas } = await getContexto();
  const hoje = new Date().toISOString().slice(0, 10);
  const conta = contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()) && c.status === 'Em uso')
              || contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()));
  if (!conta) return `❌ Conta com "${input.conta_ref}" não encontrada.`;

  const perdas = conta.perdas || [];
  perdas.push({ id: uid(), val: input.valor, desc: input.descricao || '', data: input.data || hoje });
  await sbPatch('contas', conta.id, { perdas });
  return `✅ Perda de R$ ${input.valor} registrada em *${conta.dono}*.${input.descricao ? ` (${input.descricao})` : ''}`;
}

async function acaoFinalizarConta(input) {
  const { contas } = await getContexto();
  const conta = contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()));
  if (!conta) return `❌ Conta com "${input.conta_ref}" não encontrada.`;
  await sbPatch('contas', conta.id, { status: 'Finalizada' });
  return `✅ Conta *${conta.dono}* marcada como Finalizada.`;
}

async function acaoResumoLucros(input) {
  const { contas, fornecedores } = await getContexto();
  const ativas = contas.filter(c => c.status === 'Em uso' && calcLucro(c));
  const finalizadas = contas.filter(c => c.status === 'Finalizada' && calcLucro(c));

  if (input.agrupar_por === 'total') {
    let totalMeu = 0, totalCli = 0;
    [...ativas, ...finalizadas].forEach(c => {
      const l = calcLucro(c); if (!l) return;
      totalMeu += l.meuLucro; totalCli += l.lucroCliente;
    });
    return `📊 *Resumo Geral*\n💰 Meu lucro total: R$ ${totalMeu.toFixed(2)}\n👥 Lucro clientes: R$ ${totalCli.toFixed(2)}\n\nEm uso: ${ativas.length} contas | Finalizadas: ${finalizadas.length}`;
  }

  if (input.agrupar_por === 'fornecedor') {
    const grupos = {};
    contas.forEach(c => {
      const l = calcLucro(c); if (!l) return;
      const forn = fornecedores.find(f => f.id === c.fornecedor_id);
      const key = forn ? forn.nome : 'Sem fornecedor';
      if (!grupos[key]) grupos[key] = { meu: 0, cli: 0, n: 0 };
      grupos[key].meu += l.meuLucro; grupos[key].cli += l.lucroCliente; grupos[key].n++;
    });
    return '📊 *Por Fornecedor*\n' + Object.entries(grupos).map(([k, v]) =>
      `*${k}* (${v.n} contas)\n  💰 R$ ${v.meu.toFixed(2)} | 👥 R$ ${v.cli.toFixed(2)}`
    ).join('\n\n');
  }

  if (input.agrupar_por === 'casa') {
    const grupos = {};
    contas.forEach(c => {
      const l = calcLucro(c); if (!l) return;
      if (!grupos[c.casa]) grupos[c.casa] = { meu: 0, n: 0 };
      grupos[c.casa].meu += l.meuLucro; grupos[c.casa].n++;
    });
    return '📊 *Por Casa*\n' + Object.entries(grupos).map(([k, v]) =>
      `*${k}* (${v.n} contas): R$ ${v.meu.toFixed(2)}`
    ).join('\n');
  }

  return '❓ Agrupamento desconhecido.';
}

// ─── TOOLS (Agent SDK) ──────────────────────────────────────────────────────
const toolText = (texto) => ({ content: [{ type: 'text', text: texto }] });

const bugsServer = createSdkMcpServer({
  name: 'bugs',
  version: '1.0.0',
  tools: [
    tool(
      'listar_contas',
      'Lista todas as contas de apostas cadastradas, com status, lucro e fornecedor.',
      {
        filtro_status: z.enum(['Em uso', 'Finalizada', 'todas']).optional().describe('Filtrar por status'),
        filtro_fornecedor: z.string().optional().describe('Nome do fornecedor para filtrar (opcional)')
      },
      async (input) => toolText(await acaoListarContas(input))
    ),
    tool(
      'adicionar_conta',
      'Adiciona uma nova conta de apostas (BUG).',
      {
        casa: z.string().describe('Casa de apostas (ex: Bet365, Superbet, Novibet)'),
        dono: z.string().describe('Nome do dono/titular da conta'),
        depositado: z.number().describe('Valor depositado em R$'),
        pct: z.number().describe('Porcentagem do lucro que fica com o dono da conta (0-100)'),
        fornecedor: z.string().optional().describe('Nome do fornecedor que indicou a conta (opcional)'),
        data: z.string().optional().describe('Data do depósito no formato YYYY-MM-DD (padrão: hoje)')
      },
      async (input) => toolText(await acaoAdicionarConta(input))
    ),
    tool(
      'registrar_saque',
      'Registra um saque (retirada de lucro) em uma conta existente.',
      {
        conta_ref: z.string().describe('Nome do dono ou parte do nome para identificar a conta'),
        valor: z.number().describe('Valor sacado em R$'),
        data: z.string().optional().describe('Data do saque YYYY-MM-DD (padrão: hoje)'),
        finalizar: z.boolean().optional().describe('Se true, muda o status para Finalizada após o saque')
      },
      async (input) => toolText(await acaoRegistrarSaque(input))
    ),
    tool(
      'registrar_perda',
      'Registra uma perda (prejuízo) em uma conta.',
      {
        conta_ref: z.string().describe('Nome do dono ou parte do nome para identificar a conta'),
        valor: z.number().describe('Valor da perda em R$'),
        descricao: z.string().optional().describe('Descrição da perda (opcional)'),
        data: z.string().optional().describe('Data YYYY-MM-DD (padrão: hoje)')
      },
      async (input) => toolText(await acaoRegistrarPerda(input))
    ),
    tool(
      'finalizar_conta',
      'Muda o status de uma conta para Finalizada.',
      {
        conta_ref: z.string().describe('Nome do dono ou parte do nome da conta')
      },
      async (input) => toolText(await acaoFinalizarConta(input))
    ),
    tool(
      'resumo_lucros',
      'Gera um resumo dos lucros totais, por fornecedor ou por período.',
      {
        agrupar_por: z.enum(['total', 'fornecedor', 'casa']).describe('Como agrupar o resumo')
      },
      async (input) => toolText(await acaoResumoLucros(input))
    )
  ]
});

// Nomes namespaced que o SDK expõe ao modelo: mcp__<servidor>__<tool>
const BUGS_TOOL_NAMES = [
  'mcp__bugs__listar_contas',
  'mcp__bugs__adicionar_conta',
  'mcp__bugs__registrar_saque',
  'mcp__bugs__registrar_perda',
  'mcp__bugs__finalizar_conta',
  'mcp__bugs__resumo_lucros'
];

// Ferramentas nativas do Claude Code que NÃO queremos que o bot use nunca
// (bash, leitura/escrita de arquivo, web etc). allowedTools sozinho não
// bloqueia essas ferramentas embutidas quando permissionMode é permissivo,
// então bloqueamos explicitamente com disallowedTools.
const BUILTIN_TOOLS_BLOQUEADAS = [
  'Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'NotebookEdit',
  'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'ExitPlanMode'
];

// ─── SESSÃO POR USUÁRIO (Agent SDK mantém o histórico, não precisamos mais
// guardar as mensagens manualmente — só o session_id de cada usuário) ──────
const sessions = {};

async function processarMensagem(userId, texto) {
  const { contas, fornecedores } = await getContexto();

  const systemPrompt = `Você é o assistente pessoal de Régis para gerenciar as contas de BUGS (apostas esportivas).

CONTEXTO ATUAL:
- ${contas.filter(c => c.status === 'Em uso').length} contas Em Uso
- ${contas.filter(c => c.status === 'Finalizada').length} contas Finalizadas
- Fornecedores: ${fornecedores.map(f => f.nome).join(', ') || 'nenhum'}

CONTAS EM USO:
${contas.filter(c => c.status === 'Em uso').map(c => `- ${c.dono} (${c.casa}, dep R$${c.depositado}, ${c.pct}%)`).join('\n') || 'nenhuma'}

REGRAS DO NEGÓCIO:
- BUGS são contas de terceiros onde Régis deposita e faz apostas
- Quando "Em uso": lucro bruto = total sacado (o depósito ainda está na conta)
- Quando "Finalizada": lucro bruto = total sacado - depósito
- A % é o que fica com o dono da conta; o restante é de Régis

COMPORTAMENTO:
- Responda SEMPRE em português, de forma direta e amigável
- Use as tools disponíveis para executar ações
- Confirme as ações feitas com clareza
- Se não entender algo, pergunte de forma simples
- Para saques: pergunte se a conta foi finalizada ou continua em uso (a menos que o usuário já disse)`;

  const opts = {
    systemPrompt,
    model: 'claude-haiku-4-5-20251001',
    mcpServers: { bugs: bugsServer },
    allowedTools: BUGS_TOOL_NAMES,
    disallowedTools: BUILTIN_TOOLS_BLOQUEADAS,
    permissionMode: 'default',
    maxTurns: 8
  };
  if (sessions[userId]) opts.resume = sessions[userId];

  let resposta = '';
  try {
    for await (const msg of query({ prompt: texto, options: opts })) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        sessions[userId] = msg.session_id;
      }
      if (msg.type === 'result') {
        sessions[userId] = msg.session_id || sessions[userId];
        if (msg.subtype === 'success') {
          resposta = msg.result;
        } else {
          console.error('Agent SDK terminou sem sucesso:', msg.subtype, msg);
          resposta = '⚠️ Não consegui concluir essa ação (tentei demais ou deu erro interno). Tenta reformular?';
        }
      }
    }
  } catch (err) {
    console.error('Erro no query():', err);
    throw err;
  }

  return resposta || '⚠️ Não consegui processar sua mensagem.';
}

// ─── TELEGRAM HANDLERS ──────────────────────────────────────────────────────
bot.start(ctx => {
  ctx.replyWithMarkdown(
    `🤖 *Agente BUGS ativo! (rodando na sua assinatura Claude Pro)*\n\nOlá Régis! Pode me mandar qualquer coisa, por exemplo:\n\n` +
    `• "Adiciona conta Bet365, João Silva, dep 500, 30%"\n` +
    `• "Saquei 2000 da conta do João"\n` +
    `• "Registra perda de 300 no Ricardo"\n` +
    `• "Quanto tô lucrando no total?"\n` +
    `• "Lista as contas em uso"`
  );
});

bot.help(ctx => {
  ctx.replyWithMarkdown(
    `*Comandos disponíveis:*\n\n` +
    `📋 *Ver contas:* "lista as contas", "quais contas em uso"\n` +
    `➕ *Adicionar:* "adiciona conta [casa], [dono], dep [valor], [pct]%"\n` +
    `💸 *Saque:* "saquei [valor] da conta [nome]"\n` +
    `📉 *Perda:* "registra perda de [valor] no [nome]"\n` +
    `✅ *Finalizar:* "finaliza a conta do [nome]"\n` +
    `📊 *Resumo:* "quanto lucrei total?", "resumo por fornecedor"`
  );
});

bot.on('text', async ctx => {
  const userId = ctx.from.id.toString();

  if (ALLOWED_USER && userId !== ALLOWED_USER) {
    return ctx.reply('⛔ Acesso não autorizado.');
  }

  const typing = ctx.sendChatAction('typing');

  try {
    const resposta = await processarMensagem(userId, ctx.message.text);
    await ctx.replyWithMarkdownresposta);
  } catch (err) {
    console.error('Erro:', err);
    await ctx.reply(`❌ Erro: ${err.message}`);
  }
});

// ─── HANDLERS DE ÁUDIO ───────────────────────────────────────────────────────
async function handleAudioMsg(ctx, fileId) {
  const userId = ctx.from.id.toString();
  if (ALLOWED_USER && userId !== ALLOWED_USER) return ctx.reply('⛔ Acesso não autorizado.');

  if (!OPENAI_KEY) {
    return ctx.reply('⚠️ Transcrição de áudio requer OPENAI_API_KEY.\nAdicione nas variáveis de ambiente do Railway.');
  }

  await ctx.sendChatAction('typing');
  try {
    const texto = await transcribeAudio(fileId);
    if (!texto) return ctx.reply('⚠️ Não consegui entender o áudio. Tente falar novamente.');

    await ctx.reply(`🎤 _"${texto}"_`, { parse_mode: 'Markdown' });
    const resposta = await processarMensagem(userId, texto);
    await ctx.replyWithMarkdown(resposta);
  } catch (err) {
    console.error('Erro áudio:', err);
    await ctx.reply(`❌ Erro ao transcrever áudio: ${err.message}`);
  }
}

bot.on('voice', ctx => handleAudioMsg(ctx, ctx.message.voice.file_id));
bot.on('audio', ctx => handleAudioMsg(ctx, ctx.message.audio.file_id));

// ─── START ───────────────────────────────────────────────────────────────
bot.launch().then(() => {
  console.log('🤖 Agente BUGS Telegram rodando (Agent SDK / Claude Pro)...');
}).catch(err => {
  console.error('Erro ao iniciar bot:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
