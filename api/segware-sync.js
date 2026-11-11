// Sincronização Segware → Dashboard VTR.
// Busca as ocorrências de uma janela na Segware (lado servidor) e devolve, já filtrado:
//  - deslocamentos: viatura chegou no local (igual ao relatório "Deslocamento de viaturas")
//  - eventos: bateria, comunicação, queda de energia e disparos (Saúde do Cliente / Análise de Eventos)
//  - armes: último armado/desarmado de cada cliente na janela ("clientes sem armar")
// Acesso: sessão do Supabase (usuário logado) ou a chave do agendamento do próprio Supabase.

// Empresa cadastrada na Segware (companyId) → filial no dashboard. A empresa manda (ex.: contas da
// Secopi em Timon/MA continuam Secopi Piauí); o estado só é usado para empresa desconhecida.
const FILIAL_POR_EMPRESA = {
  3244: "SERVIS CEARÁ",
  3247: "SECOPI PIAUÍ",
  3249: "SERVIS MARANHÃO",
  3251: "SERVIS AMAZONAS",
  6699: "Maver Monitoramento",
  3246: "1 P3 SOLUCOES",
  7127: "2 PROGUARD",
  10635: "4 PRIORIDADE SERVICOS TERCEIRIZADOS LTDA",
  8021: "OVERTEC",
  11339: "EMPRESA SEGWARE 11339",
  12403: "HISEG BAHIA",
};
const EMPRESA_IGNORADA = new Set([3437]); // "Conta Transmitter" (conta técnica)
const FILIAL_POR_ESTADO = {
  "CEARA": "SERVIS CEARÁ",
  "PIAUI": "SECOPI PIAUÍ",
  "MARANHAO": "SERVIS MARANHÃO",
  "AMAZONAS": "SERVIS AMAZONAS",
};
const STATUS_DESLOCAMENTO = new Set([2, 3, 4, 7]);
const LOG_AUTOMATICO = /CUC n[aã]o permite|Monitoramento desabilitado/i;

const semAcento = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

function partesLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Fortaleza", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d).map(x => [x.type, x.value]));
  if (p.hour === "24") p.hour = "00";
  return p;
}
function dataHoraBR(iso) {
  const p = partesLocal(iso);
  return p ? `${p.day}/${p.month}/${p.year}, ${p.hour}:${p.minute}:${p.second}` : "";
}
function diaISO(iso) {
  const p = partesLocal(iso);
  return p ? `${p.year}-${p.month}-${p.day}` : "";
}
function limparNome(s) {
  return String(s || "").trim().replace(/\s*\(.*?\)\s*$/, "").replace(/^\(.*?\)\s*/, "").trim();
}
const filialDe = o => EMPRESA_IGNORADA.has(Number(o.companyId)) ? null : (FILIAL_POR_EMPRESA[o.companyId] || FILIAL_POR_ESTADO[semAcento(o.stateName)] || null);

function paraDeslocamento(o, filial) {
  const st = Array.isArray(o.statuses) ? o.statuses : [];
  const desl = st.filter(s => STATUS_DESLOCAMENTO.has(Number(s.status)));
  // Igual ao relatório "Deslocamento de viaturas" da Segware: só conta quando a viatura chegou no local (status 4)
  if (!desl.some(s => Number(s.status) === 4)) return null;
  const carros = [...new Set(desl.map(s => (s.patrolCarDescription || "").trim()).filter(Boolean))];
  const noLocal = [...desl].reverse().find(s => Number(s.status) === 4 && s.patrolCarDescription);
  const viatura = (noLocal && noLocal.patrolCarDescription) || o.patrolCarDescription || carros[carros.length - 1] || "";
  const fantasia = String(o.tradeName || o.clientName || "").trim();
  const razao = String(o.clientName || "").trim();
  return {
    segware_id: String(o.id),
    codigo_cliente: String(o.accountCode || "").trim(),
    filial,
    nome: limparNome(fantasia) || String(o.accountCode || "").trim(),
    fantasia: razao && razao !== fantasia ? `${fantasia} (${razao})` : fantasia,
    data_hora: dataHoraBR(o.startDate),
    evento: String(o.description || "").trim().slice(0, 300),
    viatura: viatura.trim().slice(0, 100),
    qtd_vtr: Math.max(1, carros.length),
    portaria_inteligente: `${fantasia} ${razao}`.toUpperCase().includes("PORTARIA INTELIGENTE"),
    no_local: true,
  };
}

// Mesmas categorias da aba "Análise de Eventos" + armado/desarmado
function categoriaEvento(o) {
  const d = semAcento(o.description);
  if (!d || /^REST|RESTAUR/.test(d)) return null;                       // restaurações não contam
  if (/^(ARMADO|ARME AUTOMATICO|DESARMADO|ARMOU|DESARMOU)\b/.test(d)) return "arme";
  if (/BATERIA/.test(d)) return "bateria";
  // alarme/disparo conta mesmo vindo de câmera (ex.: "ALARME CAMERA PORTÃO"), igual ao relatório de disparos da Segware
  if (/^(ALARME|DISPARO)\b/.test(d) && !/COACAO|PANICO/.test(d)) {
    // disparo que a central nem recebeu (CUC/monitoramento desabilitado) não conta
    return (o.logs || []).some(l => LOG_AUTOMATICO.test(l.text || "")) ? null : "disparos";
  }
  if (/CAMERA|\bCAM\b|GRAVACAO|PESSOA DETECTADA|DETECCAO DE MOVIMENTO/.test(d)) return null; // falhas de vídeo não são da central
  if (/QUEDA DE ENERGIA|FALTA DE ENERGIA|SEM ENERGIA|FALHA (DE |NA |- )?(AC|ENERGIA|REDE ELETRICA)\b/.test(d)) return "energia";
  if (/KEEP ?ALIVE|FALHA.{0,20}COMUNICA|SEM COMUNICA|PERDA.{0,15}COMUNICA|FALHA DE SUPERVISAO|FALHA.{0,12}TESTE|TESTE PERIODICO|AUTO ?-?TESTE NAO/.test(d)) return "comunicacao";
  return null;
}

// Ocorrência tratada pela central (ignora as que a central nem recebeu): tempos e operadores
const dataISO = d => d ? String(d).replace(/([+-]\d\d)(\d\d)$/, "$1:$2") : null;
const ehOperador = n => !!n && !/^sistema$/i.test(n);
function paraOcorrencia(o, filial, codigo, nome) {
  const st = (Array.isArray(o.statuses) ? o.statuses : []).slice().sort((a, b) => Date.parse(dataISO(a.date)) - Date.parse(dataISO(b.date)));
  const pessoa = s => String(s.personName || "").trim();
  const t0 = Date.parse(dataISO(o.startDate));
  const seg = d => d ? Math.max(0, Math.round((Date.parse(dataISO(d)) - t0) / 1000)) : null;
  const assumiu = st.find(s => Number(s.status) === 1 && ehOperador(pessoa(s)));
  const fech = [...st].reverse().find(s => Number(s.status) === 6);
  const fechadaEm = o.endDate || (fech && fech.date) || null;
  const fechadaPor = String(o.closingPersonName || (fech ? pessoa(fech) : "") || "").trim() || null;
  const d2 = st.find(s => Number(s.status) === 2), d4 = st.find(s => Number(s.status) === 4);
  const comentarios = {};
  (o.logs || []).forEach(l => { const n = String(l.personName || "").trim(); if (ehOperador(n) && !l.canceled) comentarios[n] = (comentarios[n] || 0) + 1; });
  return {
    id: String(o.id), codigo_cliente: codigo, filial, nome, descricao: String(o.description || "").trim().slice(0, 200),
    recebida: dataISO(o.startDate),
    assumida_em: assumiu ? dataISO(assumiu.date) : null, assumida_por: assumiu ? pessoa(assumiu) : null,
    fechada_em: dataISO(fechadaEm), fechada_por: fechadaPor,
    t_ate_atender: assumiu ? seg(assumiu.date) : null,
    t_atendimento: fechadaEm ? seg(fechadaEm) : null,
    t_espera: st.filter(s => Number(s.status) === 5).reduce((n, s) => n + (Number(s.timeInThisStatus) || 0), 0),
    teve_desl: !!d2,
    t_viatura: d2 && d4 ? Math.max(0, Math.round((Date.parse(dataISO(d4.date)) - Date.parse(dataISO(d2.date))) / 1000)) : null,
    comentarios,
    automatica: !assumiu,
    // histórico completo (texto de cada comentário/ação), usado para auditoria dos operadores
    logs: (o.logs || []).filter(l => !l.canceled && String(l.text || "").trim()).map(l => ({
      t: dataISO(l.date || l.logDate || l.createdAt || l.dateTime || l.registerDate || null),
      p: String(l.personName || "").trim() || null,
      x: String(l.text || "").trim().slice(0, 2000),
    })),
  };
}

async function autorizado(req) {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), anon = process.env.SUPABASE_ANON;
  if (!url || !anon) return false;
  try {
    const chave = req.headers["x-sync-key"];
    if (chave) {
      const r = await fetch(url + "/rest/v1/rpc/segware_chave_ok", {
        method: "POST", headers: { apikey: anon, Authorization: "Bearer " + anon, "Content-Type": "application/json" },
        body: JSON.stringify({ k: String(chave) }),
      });
      return r.ok && (await r.json()) === true;
    }
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) return false;
    const r = await fetch(url + "/auth/v1/user", { headers: { apikey: anon, Authorization: auth } });
    return r.ok;
  } catch { return false; }
}

// Grava a "Localização" do painel de alarme de UMA conta (ex.: dados do DVR). Lê a conta, troca só esse campo,
// devolve o cadastro igual e confere depois que nada além dele mudou.
async function gravarLocalizacao(req, res) {
  let b = req.body || {};
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = {}; } }
  const id = Number(b.accountId), codigo = String(b.accountCode || "").trim().toUpperCase(), texto = String(b.texto || "").trim();
  if (!id || !codigo || !texto || texto.length > 500) return res.status(400).json({ error: "Informe accountId, accountCode e texto (até 500 caracteres)" });
  const tk = (process.env.SEGWARE_TOKEN || "").replace(/[\r\n\t]+/g, "").trim();
  const H = { Authorization: tk.startsWith("Bearer ") ? tk : "Bearer " + tk, Accept: "application/json" };
  const versao = /^v[2-6]$/.test(String(b.versao || "")) ? b.versao : "v6";
  const url = "https://api.segware.com.br/" + versao + "/accounts/" + id;
  try {
    const r1 = await fetch(url, { headers: H });
    if (!r1.ok) return res.status(502).json({ error: "Segware respondeu " + r1.status + " ao ler a conta" });
    const conta = await r1.json();
    if (String(conta.accountCode || "").toUpperCase() !== codigo) return res.status(409).json({ error: "A conta " + id + " não é a " + codigo });
    const antes = conta.alarmPanelLocation || "";
    if (b.esperado !== undefined && antes !== String(b.esperado || "")) return res.status(409).json({ error: "A localização mudou desde a prévia — confira de novo", antes });
    // endereço de cobrança vazio (tudo null) é recusado pela validação de CEP — não envia quando não existe
    const semCobranca = c => { const x = { ...c }; if (x.chargingAddress && Object.values(x.chargingAddress).every(v => v === null || v === "")) delete x.chargingAddress; return x; };
    const enviar = c => fetch(url, { method: "PUT", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ ...semCobranca(c), alarmPanelLocation: texto }) });
    let r2 = await enviar(conta), t2 = await r2.text();
    // a validação da Segware exige o CEP com máscara (00000-000), mas a leitura devolve sem — reenvia o MESMO CEP só formatado
    const cep = conta.address && String(conta.address.zipCode || "").replace(/\D/g, "");
    if (!r2.ok && /invalid_zip_code/.test(t2) && cep && cep.length === 8) {
      r2 = await enviar({ ...conta, address: { ...conta.address, zipCode: cep.slice(0, 5) + "-" + cep.slice(5) } }); t2 = await r2.text();
    }
    if (!r2.ok) return res.status(200).json({ ok: false, versao, status: r2.status, erro: t2.slice(0, 800), antes, cepLido: conta.address && conta.address.zipCode });
    const depois = await (await fetch(url, { headers: H })).json();
    const outros = Object.keys(conta).filter(k => k !== "alarmPanelLocation" && JSON.stringify(conta[k]) !== JSON.stringify(depois[k]));
    return res.status(200).json({ ok: true, antes, depois: depois.alarmPanelLocation, outrosCamposAlterados: outros });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "POST") {
    if (!(await autorizado(req))) return res.status(401).json({ error: "Sessão inválida — faça login no dashboard" });
    return gravarLocalizacao(req, res);
  }
  if (req.method !== "GET") return res.status(405).json({ error: "Método não permitido" });
  if (!(await autorizado(req))) return res.status(401).json({ error: "Sessão inválida — faça login no dashboard" });

  // consulta de leitura em outros endpoints da Segware (ex.: cadastro de contas), só para usuário logado
  if (req.query.explorar) {
    const caminho = String(req.query.explorar);
    if (!/^\/(v\d|api|swagger|docs)[A-Za-z0-9\/_\-?=&.%,:]*$/.test(caminho)) return res.status(400).json({ error: "caminho inválido" });
    const tk = (process.env.SEGWARE_TOKEN || "").replace(/[\r\n\t]+/g, "").trim();
    try {
      const r = await fetch("https://api.segware.com.br" + caminho, { headers: { Authorization: tk.startsWith("Bearer ") ? tk : "Bearer " + tk, Accept: "application/json" } });
      const t = await r.text();
      return res.status(200).json({ status: r.status, tipo: r.headers.get("content-type"), corpo: t.slice(0, 200000) });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  const { startDate, endDate } = req.query;
  const ini = new Date(startDate), fim = new Date(endDate);
  if (isNaN(ini) || isNaN(fim) || fim <= ini) return res.status(400).json({ error: "startDate/endDate inválidos" });
  if (fim - ini > 6 * 3600e3 + 60e3) return res.status(400).json({ error: "Janela máxima de 6 horas" });

  const token = (process.env.SEGWARE_TOKEN || "").replace(/[\r\n\t]+/g, "").trim();
  if (!token) return res.status(500).json({ error: "SEGWARE_TOKEN não configurado no Vercel" });

  const params = new URLSearchParams({
    receptedDataType: "ALARM", startDate: ini.toISOString(), endDate: fim.toISOString(), masterCompanyId: "6319",
  });
  try {
    const r = await fetch("https://api.segware.com.br/v2/occurrences?" + params, {
      headers: { Authorization: token.startsWith("Bearer ") ? token : "Bearer " + token, Accept: "application/json" },
    });
    if (!r.ok) return res.status(502).json({ error: `Segware respondeu ${r.status}`, detalhe: (await r.text()).slice(0, 200) });
    const json = await r.json();
    const lista = Array.isArray(json) ? json : (json.content || json.data || []);
    if (req.query.amostra) return res.status(200).json(lista.filter(o => (o.logs || []).length).slice(0, 3).map(o => o.logs));
    let ignorados = 0;
    const deslocamentos = [], eventos = [], ultimoArme = {}, ocorrencias = [];
    for (const o of lista) {
      const codigo = String(o.accountCode || "").trim();
      if (!codigo || !o.startDate) continue;
      const filial = filialDe(o);
      if (!filial) { ignorados++; continue; }
      const d = paraDeslocamento(o, filial);
      if (d && d.data_hora) deslocamentos.push(d);
      if (!(o.logs || []).some(l => LOG_AUTOMATICO.test(l.text || ""))) {
        const pi = /PORTARIA INTELIGENTE/i.test(`${o.tradeName || ""} ${o.clientName || ""}`);
        ocorrencias.push(paraOcorrencia(o, filial, codigo, (pi ? "PORTARIA INTELIGENTE - " : "") + (limparNome(String(o.tradeName || o.clientName || "").replace(/\(?\s*PORTARIA INTELIGENTE\s*\)?/ig, " ")).replace(/^[\s\-–]+|[\s\-–]+$/g, "").replace(/\s+/g, " ") || codigo)));
      }
      const cat = categoriaEvento(o);
      if (!cat) continue;
      // mantém a marca de Portaria Inteligente no nome (é ela que separa "nossos condomínios" no dashboard)
      const pi = /PORTARIA INTELIGENTE/i.test(`${o.tradeName || ""} ${o.clientName || ""}`);
      const base = limparNome(String(o.tradeName || o.clientName || "").replace(/\(?\s*PORTARIA INTELIGENTE\s*\)?/ig, " ")).replace(/^[\s\-–]+|[\s\-–]+$/g, "").replace(/\s+/g, " ");
      const nome = (pi ? "PORTARIA INTELIGENTE - " : "") + (base || codigo);
      if (cat === "arme") {
        const k = codigo + "|" + filial;
        if (!ultimoArme[k] || o.startDate > ultimoArme[k].ts)
          ultimoArme[k] = { codigo_cliente: codigo, filial, nome, ts: o.startDate, evento: String(o.description || "").trim().slice(0, 120) };
      } else {
        eventos.push({ id: String(o.id), codigo_cliente: codigo, filial, nome, categoria: cat, dia: diaISO(o.startDate), ts: o.startDate, descricao: String(o.description || "").trim().slice(0, 200) });
      }
    }
    return res.status(200).json({ total: lista.length, ignorados, deslocamentos, eventos, armes: Object.values(ultimoArme), ocorrencias });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao consultar a Segware: " + e.message });
  }
}
