const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_USER = process.env.TELEGRAM_USER_ID;
const SB_URL = process.env.SUPABASE_URL || 'https://vxthbjrdtwlnzzadmrmy.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_MUJi3VnZ-f4cMhdLxZfR1A_pFmhhQSi';
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT = process.env.VERCEL_PROJECT || 'gerenciador-bet';
const DASHBOARD_URL = `https://${VERCEL_PROJECT}.vercel.app`;

const bot = new Telegraf(TELEGRAM_TOKEN);
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

// ─── VERCEL HELPERS ────────────────────────────────────────────────────────
async function lerDashboard() {
  const r = await fetch(DASHBOARD_URL, { headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw new Error(`Erro ao buscar dashboard: ${r.status}`);
  return await r.text();
}

async function atualizarDashboard(htmlContent) {
  if (!VERCEL_TOKEN) throw new Error('VERCEL_TOKEN não configurado no Railway');
  const r = await fetch('https://api.vercel.com/v13/deployments', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VERCEL_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: VERCEL_PROJECT,
      target: 'production',
      files: [{ file: 'index.html', data: htmlContent }],
      projectSettings: { framework: null }
    })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.url || data.id || 'deploy iniciado';
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
        casa: { type: 'string', description: 'Casa de apostas (ex: Bet365, Superbet, Novibet)' },
        dono: { type: 'string', description: 'Nome do dono/titular da conta' },
        depositado: { type: 'number', description: 'Valor depositado em R$' },
        pct: { type: 'number', description: 'Porcentagem do lucro que fica com o dono da conta (0-100)' },
        fornecedor: { type: 'string', description: 'Nome do fornecedor que indicou a conta (opcional)' },
        data: { type: 'string', description: 'Data do depósito no formato YYYY-MM-DD (padrão: hoje)' }
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
        valor: { type: 'number', description: 'Valor sacado em R$' },
        data: { type: 'string', description: 'Data do saque YYYY-MM-DD (padrão: hoje)' },
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
        valor: { type: 'number', description: 'Valor da perda em R$' },
        descricao: { type: 'string', description: 'Descrição da perda (opcional)' },
        data: { type: 'string', description: 'Data YYYY-MM-DD (padrão: hoje)' }
      },
      required: ['conta_ref', 'valor']
    }
  },
  {
    name: 'remover_perda',
    description: 'Remove uma perda específica de uma conta. Use listar_contas para ver as perdas registradas antes de remover.',
    input_schema: {
      type: 'object',
      properties: {
        conta_ref: { type: 'string', description: 'Nome do dono ou parte do nome para identificar a conta' },
        valor: { type: 'number', description: 'Valor da perda a remover (R$)' },
        descricao_ref: { type: 'string', description: 'Parte da descrição da perda para identificar qual remover (opcional, usa valor se omitido)' }
      },
      required: ['conta_ref', 'valor']
    }
  },
  {
    name: 'remover_saque',
    description: 'Remove um saque específico de uma conta.',
    input_schema: {
      type: 'object',
      properties: {
        conta_ref: { type: 'string', description: 'Nome do dono ou parte do nome para identificar a conta' },
        valor: { type: 'number', description: 'Valor do saque a remover (R$)' }
      },
      required: ['conta_ref', 'valor']
    }
  },
  {
    name: 'editar_conta',
    description: 'Edita os dados de uma conta existente (depositado, pct, casa, dono, status).',
    input_schema: {
      type: 'object',
      properties: {
        conta_ref: { type: 'string', description: 'Nome do dono ou parte do nome para identificar a conta' },
        depositado: { type: 'number', description: 'Novo valor depositado em R$ (opcional)' },
        pct: { type: 'number', description: 'Nova porcentagem do dono (opcional)' },
        casa: { type: 'string', description: 'Nova casa de apostas (opcional)' },
        dono: { type: 'string', description: 'Novo nome do dono (opcional)' },
        status: { type: 'string', enum: ['Em uso', 'Finalizada'], description: 'Novo status da conta (opcional)' }
      },
      required: ['conta_ref']
    }
  },
  {
    name: 'excluir_conta',
    description: 'Exclui permanentemente uma conta do banco de dados. Use com cautela.',
    input_schema: {
      type: 'object',
      properties: {
        conta_ref: { type: 'string', description: 'Nome do dono ou parte do nome para identificar a conta' }
      },
      required: ['conta_ref']
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
    name: 'reativar_conta',
    description: 'Coloca uma conta Finalizada de volta em uso (status "Em uso").',
    input_schema: {
      type: 'object',
      properties: {
        conta_ref: { type: 'string', description: 'Nome do dono ou parte do nome da conta' }
      },
      required: ['conta_ref']
    }
  },
  {
    name: 'listar_fornecedores',
    description: 'Lista todos os fornecedores cadastrados.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'adicionar_fornecedor',
    description: 'Adiciona um novo fornecedor.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do fornecedor' },
        contato: { type: 'string', description: 'Contato (WhatsApp, Telegram, etc.) — opcional' }
      },
      required: ['nome']
    }
  },
  {
    name: 'excluir_fornecedor',
    description: 'Remove um fornecedor pelo nome.',
    input_schema: {
      type: 'object',
      properties: {
        nome_ref: { type: 'string', description: 'Parte do nome do fornecedor' }
      },
      required: ['nome_ref']
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
        valor: { type: 'number', description: 'Valor em R$' },
        categoria: { type: 'string', description: 'Categoria opcional (ex: "ferramenta", "comissão", "taxa", "outros")' },
        data: { type: 'string', description: 'Data YYYY-MM-DD (padrão: hoje)' }
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
  },
  {
    name: 'ler_dashboard',
    description: 'Lê o HTML atual da dashboard (gerenciador-bet.vercel.app). Use antes de modificar para entender a estrutura atual.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'patch_dashboard',
    description: 'Ferramenta PRINCIPAL para modificar a dashboard. Faz substituição exata de texto no HTML e redeploya no Vercel. Use SEMPRE para: adicionar seções, mudar cores, renomear labels, inserir lógica JS, ajustar layout. Pode fazer mudanças grandes — basta fornecer o trecho HTML a ser substituído e o novo trecho. Para mudanças complexas, chame múltiplas vezes em sequência. Use ler_dashboard primeiro para copiar o trecho exato.',
    input_schema: {
      type: 'object',
      properties: {
        buscar: { type: 'string', description: 'Trecho EXATO do HTML atual (pode ser longo — inclua contexto suficiente para ser único)' },
        substituir: { type: 'string', description: 'Novo HTML que substituirá o trecho encontrado (pode ser completamente diferente e maior)' },
        descricao: { type: 'string', description: 'Descrição da alteração feita' }
      },
      required: ['buscar', 'substituir', 'descricao']
    }
  },
  {
    name: 'atualizar_dashboard',
    description: 'ATENÇÃO: use apenas para redesenho COMPLETO da página. NUNCA use para mudanças parciais — use patch_dashboard. Substitui o HTML completo e redeploya no Vercel.',
    input_schema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'O HTML completo da nova versão da dashboard' },
        descricao: { type: 'string', description: 'Descrição das alterações feitas' }
      },
      required: ['html', 'descricao']
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
      texto += ` Dep: R$ ${c.depositado?.toFixed(2)} | ${c.pct}%`;
      if (forn) texto += ` | Forn: ${forn.nome}`;
      if (l) texto += `\n 💰 Meu lucro: R$ ${l.meuLucro.toFixed(2)} | Cliente: R$ ${l.lucroCliente.toFixed(2)}`;
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

  if (name === 'remover_perda') {
    const conta = contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()));
    if (!conta) return `❌ Conta com "${input.conta_ref}" não encontrada.`;
    const perdas = conta.perdas || [];
    const idx = perdas.findIndex(p =>
      p.val === input.valor &&
      (!input.descricao_ref || p.desc?.toLowerCase().includes(input.descricao_ref.toLowerCase()))
    );
    if (idx === -1) return `❌ Perda de R$ ${input.valor} não encontrada em *${conta.dono}*.`;
    const removida = perdas.splice(idx, 1)[0];
    await sbPatch('contas', conta.id, { perdas });
    return `✅ Perda de R$ ${removida.val} removida de *${conta.dono}*${removida.desc ? ` (${removida.desc})` : ''}.`;
  }

  if (name === 'remover_saque') {
    const conta = contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()));
    if (!conta) return `❌ Conta com "${input.conta_ref}" não encontrada.`;
    const saques = conta.saques || [];
    const idx = saques.findIndex(s => s.val === input.valor);
    if (idx === -1) return `❌ Saque de R$ ${input.valor} não encontrado em *${conta.dono}*.`;
    const removido = saques.splice(idx, 1)[0];
    await sbPatch('contas', conta.id, { saques });
    return `✅ Saque de R$ ${removido.val} removido de *${conta.dono}*.`;
  }

  if (name === 'editar_conta') {
    const conta = contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()));
    if (!conta) return `❌ Conta com "${input.conta_ref}" não encontrada.`;
    const update = {};
    if (input.depositado !== undefined) update.depositado = input.depositado;
    if (input.pct !== undefined) update.pct = input.pct;
    if (input.casa) update.casa = input.casa;
    if (input.dono) update.dono = input.dono;
    if (input.status) update.status = input.status;
    if (!Object.keys(update).length) return `⚠️ Nenhum campo para atualizar informado.`;
    await sbPatch('contas', conta.id, update);
    const campos = Object.entries(update).map(([k, v]) => `${k}: ${v}`).join(', ');
    return `✅ Conta *${conta.dono}* atualizada: ${campos}.`;
  }

  if (name === 'excluir_conta') {
    const conta = contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()));
    if (!conta) return `❌ Conta com "${input.conta_ref}" não encontrada.`;
    await sbDelete('contas', conta.id);
    return `✅ Conta *${conta.dono}* (${conta.casa}) excluída permanentemente.`;
  }

  if (name === 'finalizar_conta') {
    const conta = contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()));
    if (!conta) return `❌ Conta com "${input.conta_ref}" não encontrada.`;
    await sbPatch('contas', conta.id, { status: 'Finalizada' });
    return `✅ Conta *${conta.dono}* marcada como Finalizada.`;
  }

  if (name === 'reativar_conta') {
    const conta = contas.find(c => c.dono.toLowerCase().includes(input.conta_ref.toLowerCase()));
    if (!conta) return `❌ Conta com "${input.conta_ref}" não encontrada.`;
    await sbPatch('contas', conta.id, { status: 'Em uso' });
    return `✅ Conta *${conta.dono}* reativada (Em uso).`;
  }

  if (name === 'listar_fornecedores') {
    if (!fornecedores.length) return '📭 Nenhum fornecedor cadastrado.';
    return '📋 *Fornecedores:*\n' + fornecedores.map(f =>
      `• *${f.nome}*${f.contato ? ` — ${f.contato}` : ''}`
    ).join('\n');
  }

  if (name === 'adicionar_fornecedor') {
    const novo = { id: uid(), nome: input.nome, contato: input.contato || null };
    await sbPost('fornecedores', novo);
    return `✅ Fornecedor *${novo.nome}* adicionado.`;
  }

  if (name === 'excluir_fornecedor') {
    const forn = fornecedores.find(f => f.nome.toLowerCase().includes(input.nome_ref.toLowerCase()));
    if (!forn) return `❌ Fornecedor com "${input.nome_ref}" não encontrado.`;
    await sbDelete('fornecedores', forn.id);
    return `✅ Fornecedor *${forn.nome}* removido.`;
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
        `*${k}* (${v.n} contas)\n 💰 R$ ${v.meu.toFixed(2)} | 👥 R$ ${v.cli.toFixed(2)}`
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

  // ─── DASHBOARD TOOLS ──────────────────────────────────────────────────────
  if (name === 'ler_dashboard') {
    const html = await lerDashboard();
    // Retorna até 80000 chars — suficiente para o Sonnet analisar e fazer patches precisos
    const preview = html.length > 80000 ? html.substring(0, 80000) + '\n\n...[truncado, use offset para ver mais]' : html;
    return `📊 Dashboard carregada! (${html.length} chars totais)\n\n${preview}`;
  }

  if (name === 'patch_dashboard') {
    const htmlAtual = await lerDashboard();
    if (!htmlAtual.includes(input.buscar)) {
      return `❌ Texto não encontrado na dashboard.\nVerifique o trecho exato usando ler_dashboard primeiro.`;
    }
    const novoHtml = htmlAtual.split(input.buscar).join(input.substituir);
    const resultado = await atualizarDashboard(novoHtml);
    return `✅ Dashboard atualizada!\n📝 ${input.descricao}\n🚀 Deploy: ${resultado}\n🌐 ${DASHBOARD_URL}`;
  }

  if (name === 'atualizar_dashboard') {
    const resultado = await atualizarDashboard(input.html);
    return `✅ Dashboard redeplojada com novo HTML!\n📝 ${input.descricao}\n🚀 Deploy: ${resultado}\n🌐 ${DASHBOARD_URL}`;
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

  const systemPrompt = `Você é o assistente pessoal de Régis para gerenciar as contas de BUGS (apostas esportivas) e a dashboard.

CONTEXTO ATUAL:
- ${contas.filter(c => c.status === 'Em uso').length} contas Em Uso
- ${contas.filter(c => c.status === 'Finalizada').length} contas Finalizadas
- Fornecedores: ${fornecedores.map(f => f.nome).join(', ') || 'nenhum'}
- Gastos operacionais: ${gastos.length} registros | Total: R$ ${totalGastos.toFixed(2)}

CONTAS EM USO:
${contas.filter(c => c.status === 'Em uso').map(c => `- ${c.dono} (${c.casa}, dep R$${c.depositado}, ${c.pct}%)`).join('\n') || 'nenhuma'}

REGRAS DO NEGÓIO:
- BUGS são contas de terceiros onde Régis deposita e faz apostas
- Quando "Em uso": lucro bruto = total sacado (o depósito ainda está na conta)
- Quando "Finalizada": lucro bruto = total sacado - depósito
- A % é o que fica com o dono da conta; o restante é de Régis
- Gastos operacionais são despesas gerais que saem do lucro de Régis

AUTONOMIA NA DASHBOARD:
- Você tem acesso completo à dashboard em ${DASHBOARD_URL}
- Use ler_dashboard para ver o HTML atual antes de modificar
- Use patch_dashboard para mudanças pontuais (adicionar seção, mudar cor, texto)
- Use atualizar_dashboard para reescrever a página inteira
- Qualquer alteração de design, layout ou funcionalidade é possível

COMPORTAMENTO:
- Responda SEMPRE em português, de forma direta e amigável
- Use as tools disponíveis para executar ações
- Confirme as ações feitas com clareza
- Se não entender algo, pergunte de forma simples
- Para saques: pergunte se a conta foi finalizada ou continua em uso (a menos que o usuário já disse)
- Para mudanças na dashboard: SEMPRE use ler_dashboard primeiro para ver o HTML atual, depois faça mudanças com patch_dashboard (substituição precisa). NUNCA use atualizar_dashboard para mudanças parciais — só use se for redesenho completo e inevitável
- Para mudanças complexas na dashboard: quebre em múltiplos patch_dashboard em sequência, cada um alterando uma parte específica
- patch_dashboard é poderoso: pode adicionar seções inteiras, mudar estilos, inserir lógica JS — basta encontrar o ponto certo no HTML e substituir
- NUNCA gere o HTML inteiro como resposta — sempre trabalhe com trechos específicos via patch_dashboard`;

  let messages = [...historicos[userId]];
  let resposta = '';

  while (true) {
    const res = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
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

  historicos[userId] = messages
    .filter(m =>
      (m.role === 'user' && typeof m.content === 'string') ||
      (m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'text'))
    )
    .map(m => {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        return { ...m, content: m.content.filter(b => b.type === 'text') };
      }
      return m;
    })
    .slice(-20);

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
    `• "Adiciona a seção de gastos na dashboard"\n` +
    `• "Muda a cor do cabeçalho para azul"`
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
    `📋 *Ver gastos:* "mostra meus gastos"\n` +
    `🎨 *Dashboard:* "adiciona [seção] na dashboard", "muda [elemento]"`
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

// ─── START ─────────────────────────────────────────────────────────────────
bot.launch().then(() => {
  console.log('🤖 Agente BUGS Telegram rodando...');
}).catch(err => {
  console.error('Erro ao iniciar bot:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

