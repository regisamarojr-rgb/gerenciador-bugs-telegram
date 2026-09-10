const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const ALLOWED_USER   = process.env.TELEGRAM_USER_ID;
const SB_URL         = process.env.SUPABASE_URL || 'https://vxthbjrdtwlnzzadmrmy.supabase.co';
const SB_KEY         = process.env.SUPABASE_KEY || 'sb_publishable_MUJi3VnZ-f4cMhdLxZfR1A_pFmhhQSi';

const bot    = new Telegraf(TELEGRAM_TOKEN);
const claude = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ─── SUPABASE HELPERS ──────────────────────────────────────────────────────
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

// ─── DADOS DO PAINEL ───────────────────────────────────────────────────────
async function getContexto() {
  const [contas, fornecedores] = await Promise.all([
    sbGet('contas', '?order=created_at.desc'),
    sbGet('fornecedores', '?order=nome')
  ]);
  return { contas, fornecedores };
}

// ─── FÓRMULA DE LUCRO ─────────────────────────────────────────────────────
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

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ─── TOOLS ────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'listar_contas',
    description: 'Lista todas as contas de apostas cadastradas, com status, lucro e fornecedor.',
    input_schema: {
      type: 'object',
      properties: {
        filtro_status: { type: 'string', enum: ['Em uso', 'Finalizada', 'todas'] },
        filtro_fornecedor: { type: 'string' }
      },
      required: []
    }
  },
  {
    name: 'adicionar_conta',
    description: 'Adiciona uma nova conta de apostas (BUG).',
    input_schema: {
      type: 'object',
      properties: {
        casa:       { type: 'string' },
        dono:       { type: 'string' },
        depositado: { type: 'number' },
        pct:        { type: 'number' },
        fornecedor: { type: 'string' },
        data:       { type: 'string' }
      },
      required: ['casa', 'dono', 'depositado', 'pct']
    }
  },
  {
    name: 'registrar_saque',
    description: 'Registra um saque em uma conta existente.',
    input_schema: {
      type: 'object',
      properties: {
        conta_ref: { type: 'string' },
        valor:     { type: 'number' },
        data:      { type: 'string' },
        finalizar: { type: 'boolean' }
      },
      required: ['conta_ref', 'valor']
    }
  },
  {
    name: 'registrar_perda',
    description: 'Registra uma perda em uma conta.',
    input_schema: {
      type: 'object',
      properties: {
        conta_ref: { type: 'string' },
        valor:     { type: 'number' },
        descricao: { type: 'string' },
        data:      { type: 'string' }
      },
      required: ['conta_ref', 'valor']
    }
  },
  {
    name: 'finalizar_conta',
    description: 'Muda o status de uma conta para Finalizada.',
    input_schema: {
      type: 'object',
      properties: { conta_ref: { type: 'string' } },
      required: ['conta_ref']
    }
  },
  {
    name: 'resumo_lucros',
    description: 'Gera um resumo dos lucros totais, por fornecedor ou por casa.',
    input_schema: {
      type: 'object',
      properties: { agrupar_por: { type: 'string', enum: ['total', 'fornecedor', 'casa'] } },
      required: ['agrupar_por']
    }
  }
];

// ─── EXECUÇÃO DAS TOOLS ────────────────────────────────────────────────────
async function executarTool(name, input) {
  const { contas, fornecedores } = await getContexto();
  const hoje = new Date().toISOString().slice(0, 10);

  if (name === 'listar_contas') {
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
      let texto = `*${c.dono}* — ${c.casa} (${c.status})\n  Dep: R$ ${c.depositado?.toFixed(2)} | ${c.pct}%`;
      if (forn) texto += ` | Forn: ${forn.nome}`;
      if (l) texto += `\n  💰 Meu lucro: R$ ${l.meuLucro.toFixed(2)} | Cliente: R$ ${l.lucroCliente.toFixed(2)}`;
      return texto;
    }).join('\n\n');
  }

  if (name === 'adicionar_conta') {
    let fornecedor_id = null;
    if (input.fornecedor) {
      const forn = fornecedores.find(f => f.nome.toLowerCase().includes(input.fornecedor.toLowerCase()));
      if (forn) fornecedor_id = forn.id;
    }
    const nova = { id: uid(), casa: input.casa, dono: input.dono, depositado: input.depositado, pct: input.pct, status: 'Em uso', fornecedor_id, dataDeposito: input.data || hoje, saques: [], perdas: [] };
    await sbPost('contas', nova);
    return `✅ Conta *${nova.dono}* (${nova.casa}) adicionada!\nDep: R$ ${nova.depositado} | ${nova.pct}% dono`;
  }

  if (name === 'registrar_saque') {
    const conta = contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()) && c.status === 'Em uso')
                || contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()));
    if (!conta) return `❌ Conta com "${input.conta_ref}" não encontrada.`;
    const saques = conta.saques || [];
    saques.push({ id: uid(), val: input.valor, data: input.data || hoje });
    const update = { saques };
    if (input.finalizar) update.status = 'Finalizada';
    await sbPatch('contas', conta.id, update);
    const l = calcLucro({ ...conta, ...update });
    let resp = `✅ Saque de R$ ${input.valor} registrado em *${conta.dono}*${input.finalizar ? ' (conta finalizada)' : ''}.`;
    if (l) resp += `\n💰 Meu lucro: R$ ${l.meuLucro.toFixed(2)} | Cliente: R$ ${l.lucroCliente.toFixed(2)}`;
    return resp;
  }

  if (name === 'registrar_perda') {
    const conta = contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()) && c.status === 'Em uso')
                || contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()));
    if (!conta) return `❌ Conta com "${input.conta_ref}" não encontrada.`;
    const perdas = conta.perdas || [];
    perdas.push({ id: uid(), val: input.valor, desc: input.descricao || '', data: input.data || hoje });
    await sbPatch('contas', conta.id, { perdas });
    return `✅ Perda de R$ ${input.valor} registrada em *${conta.dono}*.`;
  }

  if (name === 'finalizar_conta') {
    const conta = contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()));
    if (!conta) return `❌ Conta com "${input.conta_ref}" não encontrada.`;
    await sbPatch('contas', conta.id, { status: 'Finalizada' });
    return `✅ Conta *${conta.dono}* marcada como Finalizada.`;
  }

  if (name === 'resumo_lucros') {
    const todas = contas.filter(c => calcLucro(c));
    if (input.agrupar_por === 'total') {
      let totalMeu = 0, totalCli = 0;
      todas.forEach(c => { const l = calcLucro(c); if (!l) return; totalMeu += l.meuLucro; totalCli += l.lucroCliente; });
      return `📊 *Resumo Geral*\n💰 Meu lucro total: R$ ${totalMeu.toFixed(2)}\n👥 Lucro clientes: R$ ${totalCli.toFixed(2)}\n\nEm uso: ${contas.filter(c=>c.status==='Em uso').length} | Finalizadas: ${contas.filter(c=>c.status==='Finalizada').length}`;
    }
    if (input.agrupar_por === 'fornecedor') {
      const grupos = {};
      contas.forEach(c => { const l = calcLucro(c); if (!l) return; const forn = fornecedores.find(f => f.id === c.fornecedor_id); const key = forn ? forn.nome : 'Sem fornecedor'; if (!grupos[key]) grupos[key] = { meu: 0, cli: 0, n: 0 }; grupos[key].meu += l.meuLucro; grupos[key].cli += l.lucroCliente; grupos[key].n++; });
      return '📊 *Por Fornecedor*\n' + Object.entries(grupos).map(([k, v]) => `*${k}* (${v.n} contas)\n  💰 R$ ${v.meu.toFixed(2)} | 👥 R$ ${v.cli.toFixed(2)}`).join('\n\n');
    }
    if (input.agrupar_por === 'casa') {
      const grupos = {};
      contas.forEach(c => { const l = calcLucro(c); if (!l) return; if (!grupos[c.casa]) grupos[c.casa] = { meu: 0, n: 0 }; grupos[c.casa].meu += l.meuLucro; grupos[c.casa].n++; });
      return '📊 *Por Casa*\n' + Object.entries(grupos).map(([k, v]) => `*${k}* (${v.n} contas): R$ ${v.meu.toFixed(2)}`).join('\n');
    }
  }
  return '❓ Ação desconhecida.';
}

// ─── HISTÓRICO ─────────────────────────────────────────────────────────────
const historicos = {};

async function processarMensagem(userId, texto) {
  if (!historicos[userId]) historicos[userId] = [];
  historicos[userId].push({ role: 'user', content: texto });
  if (historicos[userId].length > 20) historicos[userId] = historicos[userId].slice(-20);

  const { contas, fornecedores } = await getContexto();
  const systemPrompt = `Você é o assistente pessoal de Régis para gerenciar contas de BUGS (apostas esportivas).

CONTEXTO:
- ${contas.filter(c => c.status === 'Em uso').length} contas Em Uso
- ${contas.filter(c => c.status === 'Finalizada').length} contas Finalizadas
- Fornecedores: ${fornecedores.map(f => f.nome).join(', ') || 'nenhum'}

CONTAS EM USO:
${contas.filter(c => c.status === 'Em uso').map(c => `- ${c.dono} (${c.casa}, dep R$${c.depositado}, ${c.pct}%)`).join('\n') || 'nenhuma'}

REGRAS:
- Em uso: lucro bruto = total sacado (depósito ainda na conta)
- Finalizada: lucro bruto = total sacado - depósito
- A % fica com o dono; o restante é de Régis

Responda SEMPRE em português, direto e amigável. Use as tools para executar ações.`;

  let messages = [...historicos[userId]];
  let resposta = '';

  while (true) {
    const res = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages
    });
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'end_turn') {
      resposta = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
      break;
    }
    if (res.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const bloco of res.content) {
        if (bloco.type !== 'tool_use') continue;
        const resultado = await executarTool(bloco.name, bloco.input);
        toolResults.push({ type: 'tool_result', tool_use_id: bloco.id, content: resultado });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }
    break;
  }

  historicos[userId] = messages.filter(m =>
    (m.role === 'user' && typeof m.content === 'string') ||
    (m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'text'))
  ).slice(-20);

  return resposta || '⚠️ Não consegui processar sua mensagem.';
}

// ─── HANDLERS ──────────────────────────────────────────────────────────────
bot.start(ctx => {
  ctx.replyWithMarkdown(`🤖 *Agente BUGS ativo!*\n\nOlá Régis! Exemplos:\n• "Adiciona conta Bet365, João Silva, dep 500, 30%"\n• "Saquei 2000 da conta do João"\n• "Registra perda de 300 no Ricardo"\n• "Quanto tô lucrando no total?"\n• "Lista as contas em uso"`);
});

bot.help(ctx => {
  ctx.replyWithMarkdown(`*Comandos:*\n📋 "lista as contas"\n➕ "adiciona conta [casa], [dono], dep [valor], [pct]%"\n💸 "saquei [valor] da conta [nome]"\n📉 "registra perda de [valor] no [nome]"\n✅ "finaliza a conta do [nome]"\n📊 "quanto lucrei total?"`);
});

bot.on('text', async ctx => {
  const userId = ctx.from.id.toString();
  if (ALLOWED_USER && userId !== ALLOWED_USER) return ctx.reply('⛔ Acesso não autorizado.');
  ctx.sendChatAction('typing');
  try {
    const resposta = await processarMensagem(userId, ctx.message.text);
    await ctx.replyWithMarkdown(resposta);
  } catch (err) {
    console.error('Erro:', err);
    await ctx.reply(`❌ Erro: ${err.message}`);
  }
});

bot.launch().then(() => console.log('🤖 Agente BUGS Telegram rodando...')).catch(err => { console.error(err); process.exit(1); });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
