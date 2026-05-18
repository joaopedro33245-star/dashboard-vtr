/**
 * CRON JOB — Sincronização automática Segware
 * Roda de 3 em 3 horas via Vercel Cron (configurado no vercel.json)
 *
 * O que faz:
 *  - Busca eventos IN_PLACE (status 4) dos últimos 2 dias na API Segware
 *  - Detecta a filial de cada evento pelo campo monitoringCenter (automático, todas as filiais)
 *  - Detecta Portaria Inteligente pelo nome do cliente (contém "PORTARIA INTELIGENTE")
 *  - Insere apenas registros novos no Supabase (deduplicação automática)
 */

import { createClient } from "@supabase/supabase-js";

// ── Normalização de filial (espelha a função limparEmpresa do index.html) ──
const ALIAS_FILIAL = {
  "CEARA":          "SERVIS CEARÁ",
  "CEARÁ":          "SERVIS CEARÁ",
  "SERVIS CEARA":   "SERVIS CEARÁ",
  "SERVIS CE":      "SERVIS CEARÁ",
  "PIAUI":          "SECOPI PIAUÍ",
  "PIAUÍ":          "SECOPI PIAUÍ",
  "SECOPI PI":      "SECOPI PIAUÍ",
  "SECOPI":         "SECOPI PIAUÍ",
  "MARANHAO":       "SERVIS MARANHÃO",
  "MARANHÃO":       "SERVIS MARANHÃO",
  "SERVIS MA":      "SERVIS MARANHÃO",
  "PARA":           "SERVIS PARÁ",
  "PARÁ":           "SERVIS PARÁ",
  "SERVIS PA":      "SERVIS PARÁ",
};

function normalizarFilial(raw) {
  if (!raw) return null;
  const upper = raw.toUpperCase().trim();
  for (const [key, val] of Object.entries(ALIAS_FILIAL)) {
    if (upper.includes(key)) return val;
  }
  return raw.trim();
}

// ── Portaria Inteligente: detecta pelo nome do cliente ────────────────────
function isPortariaInteligente(nomeCliente) {
  return (nomeCliente || "").toUpperCase().includes("PORTARIA INTELIGENTE");
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtISO(d) {
  return d.toISOString().slice(0, 19);
}

function labelStatus(code) {
  const m = { 2: "Deslocamento", 3: "Desl. Iniciado", 4: "No Local", 7: "Concluído VTR", 8: "URA" };
  return m[code] || ("Status " + code);
}

// ── Converte evento Segware → registro dispatches ──────────────────────────
function segwareToDispatch(ev, filialFallback) {
  const statuses    = Array.isArray(ev.statuses) ? ev.statuses : [];
  const ult         = statuses.length > 0 ? statuses[statuses.length - 1] : null;
  const cod         = ult ? (ult.status ?? ult.code ?? ult.id) : (ev.status ?? ev.lastStatus ?? 0);
  const rawDate     = ev.openedAt || ev.createdAt || ev.date || ev.dataHora || ev.datetime || "";
  const dataHora    = rawDate ? new Date(rawDate).toLocaleString("pt-BR") : "";
  const codCliente  = String(ev.clientCode || ev.clientId || ev.codigoCliente || ev.client?.code || "SEM-COD").trim();
  const nomeCliente = String(ev.clientName  || ev.client?.name || ev.nomeCliente || codCliente).trim();
  const viatura     = String(ev.vehiclePlate || ev.vehicle?.plate || ev.viatura || "").trim();
  const evento      = "[Segware] " + labelStatus(Number(cod)) + " — Ocorrência #" + (ev.id || ev.occurrenceId || "?");

  // Filial: vem do monitoringCenter do próprio evento — cobre TODAS as filiais automaticamente
  const filialRaw           = ev.monitoringCenter || ev.monitoringCenterName || ev.filial || ev.branch || filialFallback || "SEGWARE";
  const filial              = normalizarFilial(filialRaw);
  const portaria_inteligente = isPortariaInteligente(nomeCliente);

  return { codigo_cliente: codCliente, nome_cliente: nomeCliente, filial, data_hora: dataHora, evento, viatura, portaria_inteligente };
}

// ── Busca uma janela de tempo na API Segware ───────────────────────────────
async function fetchJanela(tokenFinal, dataInicio, dataFim) {
  const params = new URLSearchParams({
    receptedDataType: "ALARM",
    startDate:        fmtISO(dataInicio),
    endDate:          fmtISO(dataFim),
    masterCompanyId:  "6319"
  });
  const url  = `https://api.segware.com.br/v2/occurrences?${params.toString()}`;
  const resp = await fetch(url, {
    method:  "GET",
    headers: { Authorization: tokenFinal, Accept: "*/*" },
    signal:  AbortSignal.timeout(20000)
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Segware HTTP ${resp.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  return Array.isArray(json) ? json : (json.data || json.events || json.results || json.content || []);
}

// ── Handler principal ──────────────────────────────────────────────────────
export default async function handler(req, res) {

  // Segurança: só aceita o Vercel Cron ou chamada com CRON_SECRET
  const authHeader = req.headers["authorization"] || "";
  const cronSecret = process.env.CRON_SECRET || "";
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Não autorizado" });
  }

  const segwareToken = process.env.SEGWARE_TOKEN;
  const supabaseUrl  = process.env.SUPABASE_URL;
  const supabaseKey  = process.env.SUPABASE_SERVICE_KEY;

  if (!segwareToken) return res.status(500).json({ error: "SEGWARE_TOKEN não configurado" });
  if (!supabaseUrl)  return res.status(500).json({ error: "SUPABASE_URL não configurado" });
  if (!supabaseKey)  return res.status(500).json({ error: "SUPABASE_SERVICE_KEY não configurado" });

  const tokenLimpo = segwareToken.replace(/[\r\n\t]+/g, "").trim();
  const tokenFinal = tokenLimpo.startsWith("Bearer ") ? tokenLimpo : "Bearer " + tokenLimpo;

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Fallback de filial — usado apenas quando o evento não trouxer monitoringCenter
  const filialFallback = process.env.SEGWARE_FILIAL_PADRAO || "SEGWARE";

  // Janelas de 6h cobrindo as últimas 48h
  const agora  = new Date();
  const inicio = new Date(agora.getTime() - 2 * 86400000);
  const janelas = [];
  let cur = new Date(inicio);
  while (cur < agora) {
    const fim = new Date(Math.min(cur.getTime() + 6 * 3600000, agora.getTime()));
    janelas.push({ inicio: new Date(cur), fim });
    cur = new Date(fim.getTime() + 1000);
  }

  // Busca todas as janelas
  let todos = [];
  const errosJanela = [];
  for (const jan of janelas) {
    try {
      const lote = await fetchJanela(tokenFinal, jan.inicio, jan.fim);
      todos = todos.concat(lote);
    } catch (e) {
      errosJanela.push(e.message);
    }
  }

  if (todos.length === 0) {
    return res.status(200).json({ ok: true, msg: "Nenhum evento retornado pela Segware", novos: 0, total: 0, errosJanela });
  }

  // Filtrar apenas IN_PLACE (status 4)
  const filtrados = todos.filter(ev => {
    const statuses = Array.isArray(ev.statuses) ? ev.statuses : [];
    const ult = statuses.length > 0 ? statuses[statuses.length - 1] : null;
    const cod = Number(ult ? (ult.status ?? ult.code ?? ult.id) : (ev.status ?? ev.lastStatus ?? 0));
    return cod === 4;
  });

  if (filtrados.length === 0) {
    return res.status(200).json({
      ok: true,
      msg: `${todos.length} eventos recebidos, nenhum com status IN_PLACE (4)`,
      novos: 0, total: todos.length, errosJanela
    });
  }

  const dispatches       = filtrados.map(ev => segwareToDispatch(ev, filialFallback));
  const filiaisDetectadas = [...new Set(dispatches.map(d => d.filial))];
  const portariaCount    = dispatches.filter(d => d.portaria_inteligente).length;
  const normalCount      = dispatches.length - portariaCount;

  // Deduplicar
  const { data: existentes } = await supabase
    .from("dispatches")
    .select("codigo_cliente,filial,data_hora,evento,viatura")
    .gte("created_at", inicio.toISOString())
    .limit(5000);

  const existentesSet = new Set();
  for (const e of (existentes || [])) {
    existentesSet.add(`${e.codigo_cliente}||${e.filial}||${e.data_hora}||${e.evento}||${e.viatura}`);
  }

  const novos = dispatches.filter(d =>
    !existentesSet.has(`${d.codigo_cliente}||${d.filial}||${d.data_hora}||${d.evento}||${d.viatura}`)
  );

  // Inserir em lotes de 200
  let inseridos = 0;
  for (let i = 0; i < novos.length; i += 200) {
    const { error } = await supabase.from("dispatches").insert(novos.slice(i, i + 200));
    if (error) return res.status(500).json({ error: "Erro Supabase: " + error.message, inseridos });
    inseridos += Math.min(200, novos.length - i);
  }

  return res.status(200).json({
    ok:               true,
    msg:              `${inseridos} novos deslocamentos importados`,
    novos:            inseridos,
    filtrados:        filtrados.length,
    total:            todos.length,
    normalCount,
    portariaCount,
    filiaisDetectadas,
    errosJanela,
    executadoEm:      new Date().toISOString()
  });
}
