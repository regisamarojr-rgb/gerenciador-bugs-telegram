const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const ALLOWED_USER   = process.env.TELEGRAM_USER_ID;
const SB_URL         = process.env.SUPABASE_URL || 'https://vxthbjrdtwlnzzadmrmy.supabase.co';
const SB_KEY         = process.env.SUPABASE_KEY || 'sb_publishable_MUJi3VnZ-f4cMhdLxZfR1A_pFmhhQSi';
const OPENAI_KEY     = process.env.OPENAI_API_KEY;

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

async function sbDelete(table, id) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'DELETE', headers: SB_HDR
  });
  if (!r.ok) throw new Error(`SB DELETE ${table}: ${r.status} ${await r.text()}`);
  return true;
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
  const [contas, fornecedores, gastos] = await Promise.all([
    sbGet('contas', '?order=created_at.desc'),
    sbGet('fornecedores', '?order=nome'),
    sbGet('gastos', '?order=data.desc')
  ]);
  return { contas, fornecedores, gastos };
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

// ─── TOOLS PARA O CLAUDE ───────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'listar_contas',
    description: 'Lista todas as contas de apostas cadastradas, com status, lucro e fornecedor.',
    input_schema: {
      type: 'object',
      properties: {
        filtro_status: { type: 'string', enum: ['Em uso', 'Finalizada', 'todas'], description: 'Filtrar por status' },
        filtro_fornecedor: { type: 'string', description: 'Nome do fornecedor para filtrar (opcional)' }
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
        casa:       { type: 'string', description: 'Casa de apostas (ex: Bet365, Superbet, Novibet)' },
        dono:       { type: 'string', description: 'Nome do dono/titular da conta' },
        depositado: { type: 'number', description: 'Valor depositado em R$' },
        pct:        { type: 'number', description: 'Porcentagem do lucro que fica com o dono da conta (0-100)' },
        fornecedor: { type: 'string', description: 'Nome do fornecedor que indicou a conta (opcional)' },
        data:       { type: 'string', description: 'Data do depósito no formato YYYY-MM-DD (padrão: hoje)' }
      },
      required: ['casa', 'dono', 'depositado', 'pct']
    }
  },
  {
    name: 'registrar_saque',
    description: 'Registra um saque (retirada de lucro) em uma conta existente.',
    input_schema: {
      type: 'object',
      properties: {
        conta_ref: { type: 'string', description: 'Nome do dono ou parte do nome para identificar a conta' },
        valor:     { type: 'number', description: 'Valor sacado em R$' },
        data:      { type: 'string', description: 'Data do saque YYYY-MM-DD (padrão: hoje)' },
        finalizar: { type: 'boolean', description: 'Se true, muda o status para Finalizada após o saque' }
      },
      required: ['conta_ref', 'valor']
    }
  },
  {
    name: 'registrar_perda',
    description: 'Registra uma perda (prejuízo) em uma conta específica de aposta.',
    input_schema: {
      type: 'object',
      properties: {
        conta_ref: { type: 'string', description: 'Nome do dono ou parte do nome para identificar a conta' },
        valor:     { type: 'number', description: 'Valor da perda em R$' },
        descricao: { type: 'string', description: 'Descrição da perda (opcional)' },
        data:      { type: 'string', description: 'Data YYYY-MM-DD (padrão: hoje)' }
      },
      required: ['conta_ref', 'valor']
    }
  },
  {
    name: 'finalizar_conta',
    description: 'Muda o status de uma conta para Finalizada.',
    input_schema: {
      type: 'object',
      properties: {
        conta_ref: { type: 'string', description: 'Nome do dono ou parte do nome da conta' }
      },
      required: ['conta_ref']
    }
  },
  {
    name: 'resumo_lucros',
    description: 'Gera um resumo dos lucros totais (descontando gastos operacionais), por fornecedor ou por casa.',
    input_schema: {
      type: 'object',
      properties: {
        agrupar_por: { type: 'string', enum: ['total', 'fornecedor', 'casa'], description: 'Como agrupar o resumo' }
      },
      required: ['agrupar_por']
    }
  },
  {
    name: 'registrar_gasto',
    description: 'Registra um gasto operacional geral (não vinculado a uma conta específica). Ex: taxa de plataforma, ferramenta paga, comissão paga a alguém, custo de operação.',
    input_schema: {
      type: 'object',
      properties: {
        descricao: { type: 'string', description: 'O que foi gasto (ex: "Assinatura ferramenta X", "Comissão João", "Taxa saque")' },
        valor:     { type: 'number', description: 'Valor em R$' },
        categoria: { type: 'string', description: 'Categoria opcional (ex: "ferramenta", "comissão", "taxa", "outros")' },
        data:      { type: 'string', description: 'Data YYYY-MM-DD (padrão: hoje)' }
      },
      required: ['descricao', 'valor']
    }
  },
  {
    name: 'listar_gastos',
    description: 'Lista os gastos operacionais registrados com total acumulado.',
    input_schema: {
      type: 'object',
      properties: {
        limite: { type: 'number', description: 'Quantidade máxima de gastos a mostrar (padrão: 10)' }
      },
      required: []
    }
  },
  {
    name: 'excluir_gasto',
    description: 'Remove um gasto operacional pela descrição (use listar_gastos primeiro para ver os registros).',
    input_schema: {
      type: 'object',
      properties: {
        descricao_ref: { type: 'string', description: 'Parte da descrição do gasto para identificá-lo' }
      },
      required: ['descricao_ref']
    }
  }
];

// ─── EXECUÇÃO DAS TOOLS ────────────────────────────────────────────────────
async function executarTool(name, input) {
  const { contas, fornecedores, gastos } = await getContexto();
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
      let texto = `*${c.dono}* — ${c.casa} (${c.status})\n`;
      texto += `  Dep: R$ ${c.depositado?.toFixed(2)} | ${c.pct}%`;
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
    const nova = {
      id: uid(), casa: input.casa, dono: input.dono,
      depositado: input.depositado, pct: input.pct, status: 'Em uso',
      fornecedor_id, dataDeposito: input.data || hoje, saques: [], perdas: []
    };
    await sbPost('contas', nova);
    return `✅ Conta *${nova.dono}* (${nova.casa}) adicionada!\nDep: R$ ${nova.depositado} | ${nova.pct}% dono${fornecedor_id ? ` | Forn: ${input.fornecedor}` : ''}`;
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
    const nova = { ...conta, ...update };
    const l = calcLucro(nova);
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
    return `✅ Perda de R$ ${input.valor} registrada em *${conta.dono}*.${input.descricao ? ` (${input.descricao})` : ''}`;
  }

  if (name === 'finalizar_conta') {
    const conta = contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()));
    if (!conta) return `❌ Conta com "${input.conta_ref}" não encontrada.`;
    await sbPatch('contas', conta.id, { status: 'Finalizada' });
    return `✅ Conta *${conta.dono}* marcada como Finalizada.`;
  }

  if (name === 'resumo_lucros') {
    const ativas = contas.filter(c => c.status === 'Em uso' && calcLucro(c));
    const finalizadas = contas.filter(c => c.status === 'Finalizada' && calcLucro(c));
    const totalGastos = (gastos || []).reduce((s, g) => s + g.valor, 0);

    if (input.agrupar_por === 'total') {
      let totalMeu = 0, totalCli = 0;
      [...ativas, ...finalizadas].forEach(c => {
        const l = calcLucro(c); if (!l) return;
        totalMeu += l.meuLucro; totalCli += l.lucroCliente;
      });
      const liquido = totalMeu - totalGastos;
      let resp = `📊 *Resumo Geral*\n💰 Lucro bruto: R$ ${totalMeu.toFixed(2)}`;
      if (totalGastos > 0) resp += `\n💸 Gastos operacionais: R$ ${totalGastos.toFixed(2)}\n✨ Lucro líquido: R$ ${liquido.toFixed(2)}`;
      resp += `\n👥 Lucro clientes: R$ ${totalCli.toFixed(2)}\n\nEm uso: ${ativas.length} contas | Finalizadas: ${finalizadas.length}`;
      return resp;
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
      let resp = '📊 *Por Fornecedor*\n' + Object.entries(grupos).map(([k, v]) =>
        `*${k}* (${v.n} contas)\n  💰 R$ ${v.meu.toFixed(2)} | 👥 R$ ${v.cli.toFixed(2)}`
      ).join('\n\n');
      if (totalGastos > 0) resp += `\n\n💸 Gastos operacionais totais: R$ ${totalGastos.toFixed(2)}`;
      return resp;
    }

    if (input.agrupar_por === 'casa') {
      const grupos = {};
      contas.forEach(c => {
        const l = calcLucro(c); if (!l) return;
        if (!grupos[c.casa]) grupos[c.casa] = { meu: 0, n: 0 };
        grupos[c.casa].meu += l.meuLucro; grupos[c.casa].n++;
      });
      let resp = '📊 *Por Casa*\n' + Object.entries(grupos).map(([k, v]) =>
        `*${k}* (${v.n} contas): R$ ${v.meu.toFixed(2)}`
      ).join('\n');
      if (totalGastos > 0) resp += `\n\n💸 Gastos operacionais totais: R$ ${totalGastos.toFixed(2)}`;
      return resp;
    }
  }

  if (name === 'registrar_gasto') {
    const novo = {
      id: uid(),
      descricao: input.descricao,
      valor: input.valor,
      categoria: input.categoria || null,
      data: input.data || hoje
    };
    await sbPost('gastos', novo);
    return `✅ Gasto registrado: *${novo.descricao}* — R$ ${novo.valor.toFixed(2)}${novo.categoria ? ` [${novo.categoria}]` : ''}`;
  }

  if (name === 'listar_gastos') {
    if (!gastos || !gastos.length) return '📭 Nenhum gasto operacional registrado.';
    const limite = input.limite || 10;
    const lista = gastos.slice(0, limite);
    const total = gastos.reduce((s, g) => s + g.valor, 0);
    const linhas = lista.map((g, i) =>
      `${i + 1}. ${g.data} — *${g.descricao}*: R$ ${g.valor.toFixed(2)}${g.categoria ? ` [${g.categoria}]` : ''}`
    ).join('\n');
    return `📋 *Gastos Operacionais* (${gastos.length} total)\n${linhas}\n\n💸 Total: R$ ${total.toFixed(2)}`;
  }

  if (name === 'excluir_gasto') {
    const gasto = (gastos || []).find(g => g.descricao.toLowerCase().includes(input.descricao_ref.toLowerCase()));
    if (!gasto) return `❌ Gasto com "${input.descricao_ref}" não encontrado. Use listar_gastos para ver os registros.`;
    await sbDelete('gastos', gasto.id);
    return `✅ Gasto *${gasto.descricao}* (R$ ${gasto.valor.toFixed(2)}) removido.`;
  }

  return '❓ Ação desconhecida.';
}

// ─── HISTÓRICO DE CONVERSA POR USUÁRIO ────────────────────────────────────
const historicos = {};

async function processarMensagem(userId, texto) {
  if (!historicos[userId]) historicos[userId] = [];
  historicos[userId].push({ role: 'user', content: texto });
  if (historicos[userId].length > 20) historicos[userId] = historicos[userId].slice(-20);

  const { contas, fornecedores, gastos } = await getContexto();
  const totalGastos = (gastos || []).reduce((s, g) => s + g.valor, 0);

  const systemPrompt = `Você é o assistente pessoal de Régis para gerenciar as contas de BUGS (apostas esportivas).

CONTEXTO ATUAL:
- ${contas.filter(c => c.status === 'Em uso').length} contas Em Uso
- ${contas.filter(c => c.status === 'Finalizada').length} contas Finalizadas
- Fornecedores: ${fornecedores.map(f => f.nome).join(', ') || 'nenhum'}
- Gastos operacionais: ${gastos.length} registros | Total: R$ ${totalGastos.toFixed(2)}

CONTAS EM USO:
${contas.filter(c => c.status === 'Em uso').map(c => `- ${c.dono} (${c.casa}, dep R$${c.depositado}, ${c.pct}%)`).join('\n') || 'nenhuma'}

REGRAS DO NEGÓCIO:
- BUGS são contas de terceiros onde Régis deposita e faz apostas
- Quando "Em uso": lucro bruto = total sacado (o depósito ainda está na conta)
- Quando "Finalizada": lucro bruto = total sacado - depósito
- A % é o que fica com o dono da conta; o restante é de Régis
- Gastos operacionais são despesas gerais (ferramentas, taxas, comissões) que saem do lucro de Régis

COMPORTAMENTO:
- Responda SEMPRE em português, de forma direta e amigável
- Use as tools disponíveis para executar ações
- Confirme as ações feitas com clareza
- Se não entender algo, pergunte de forma simples
- Para saques: pergunte se a conta foi finalizada ou continua em uso (a menos que o usuário já disse)
- Para gastos: use registrar_gasto para despesas operacionais gerais (não vinculadas a conta específica)`;

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
    m.role === 'user' && typeof m.content === 'string'
    || m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'text')
  ).slice(-20);

  return resposta || '⚠️ Não consegui processar sua mensagem.';
}

// ─── TELEGRAM HANDLERS ─────────────────────────────────────────────────────
bot.start(ctx => {
  ctx.replyWithMarkdown(
    `🤖 *Agente BUGS ativo!*\n\nOlá Régis! Pode me mandar qualquer coisa, por exemplo:\n\n` +
    `• "Adiciona conta Bet365, João Silva, dep 500, 30%"\n` +
    `• "Saquei 2000 da conta do João"\n` +
    `• "Registra perda de 300 no Ricardo"\n` +
    `• "Gasto de 50 com assinatura ferramenta"\n` +
    `• "Quanto tô lucrando no total?"\n` +
    `• "Lista as contas em uso"\n` +
    `• "Mostra meus gastos"`
  );
});

bot.help(ctx => {
  ctx.replyWithMarkdown(
    `*Comandos disponíveis:*\n\n` +
    `📋 *Ver contas:* "lista as contas", "quais contas em uso"\n` +
    `➕ *Adicionar:* "adiciona conta [casa], [dono], dep [valor], [pct]%"\n` +
    `💸 *Saque:* "saquei [valor] da conta [nome]"\n` +
    `📉 *Perda em conta:* "registra perda de [valor] no [nome]"\n` +
    `✅ *Finalizar:* "finaliza a conta do [nome]"\n` +
    `📊 *Resumo:* "quanto lucrei total?", "resumo por fornecedor"\n` +
    `💸 *Gasto geral:* "gasto de [valor] com [descrição]"\n` +
    `📋 *Ver gastos:* "mostra meus gastos", "lista gastos"`
  );
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

// ─── HANDLERS DE ÁUDIO ────────────────────────────────────────────────────
async function handleAudioMsg(ctx, fileId) {
  const userId = ctx.from.id.toString();
  if (ALLOWED_USER && userId !== ALLOWED_USER) return ctx.reply('⛔ Acesso não autorizado.');
  if (!OPENAI_KEY) return ctx.reply('⚠️ Transcrição de áudio requer OPENAI_API_KEY.\nAdicione nas variáveis de ambiente do Railway.');
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

// ─── START ─────────────────────────────────────────────────────────────────
bot.launch().then(() => {
  console.log('🤖 Agente BUGS Telegram rodando...');
}).catch(err => {
  console.error('Erro ao iniciar bot:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
