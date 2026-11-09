// Sincronização Segware → deslocamentos.
// Busca as ocorrências de uma janela na Segware (lado servidor), filtra só as que tiveram
// viatura acionada e devolve linhas prontas para a tabela "dispatches".
// Exige o token de sessão do Supabase (usuário logado no dashboard).

const FILIAL_POR_ESTADO = {
  "CEARA": "SERVIS CEARÁ",
  "PIAUI": "SECOPI PIAUÍ",
  "MARANHAO": "SERVIS MARANHÃO",
  "AMAZONAS": "SERVIS AMAZONAS",
};
const FILIAL_POR_EMPRESA = {
  3244: "SERVIS CEARÁ", 3246: "SERVIS CEARÁ", 8021: "SERVIS CEARÁ", 10635: "SERVIS CEARÁ", 11339: "SERVIS CEARÁ",
  3247: "SECOPI PIAUÍ",
  3249: "SERVIS MARANHÃO", 6699: "SERVIS MARANHÃO",
  3251: "SERVIS AMAZONAS",
};
const STATUS_DESLOCAMENTO = new Set([2, 3, 4, 7]);

const semAcento = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();

function dataHoraBR(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Fortaleza", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year}, ${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
}

function paraDeslocamento(o) {
  const st = Array.isArray(o.statuses) ? o.statuses : [];
  const desl = st.filter(s => STATUS_DESLOCAMENTO.has(Number(s.status)));
  if (!desl.length && !o.patrolCarId) return null;
  const filial = FILIAL_POR_ESTADO[semAcento(o.stateName)] || FILIAL_POR_EMPRESA[o.companyId];
  if (!filial) return { ignorado: true };
  const carros = [...new Set(desl.map(s => (s.patrolCarDescription || "").trim()).filter(Boolean))];
  const noLocal = [...desl].reverse().find(s => Number(s.status) === 4 && s.patrolCarDescription);
  const viatura = (noLocal && noLocal.patrolCarDescription) || o.patrolCarDescription || carros[carros.length - 1] || "";
  const fantasia = String(o.tradeName || o.clientName || "").trim();
  const razao = String(o.clientName || "").trim();
  return {
    segware_id: String(o.id),
    codigo_cliente: String(o.accountCode || "").trim(),
    filial,
    fantasia: razao && razao !== fantasia ? `${fantasia} (${razao})` : fantasia,
    data_hora: dataHoraBR(o.startDate),
    evento: String(o.description || "").trim().slice(0, 300),
    viatura: viatura.trim().slice(0, 100),
    qtd_vtr: Math.max(1, carros.length),
    portaria_inteligente: `${fantasia} ${razao}`.toUpperCase().includes("PORTARIA INTELIGENTE"),
    no_local: desl.some(s => Number(s.status) === 4),
  };
}

async function usuarioValido(req) {
  const auth = req.headers.authorization || "";
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON;
  if (!auth.startsWith("Bearer ") || !url || !anon) return false;
  try {
    const r = await fetch(url.replace(/\/$/, "") + "/auth/v1/user", { headers: { apikey: anon, Authorization: auth } });
    return r.ok;
  } catch { return false; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Método não permitido" });
  if (!(await usuarioValido(req))) return res.status(401).json({ error: "Sessão inválida — faça login no dashboard" });

  const { startDate, endDate } = req.query;
  const ini = new Date(startDate), fim = new Date(endDate);
  if (isNaN(ini) || isNaN(fim) || fim <= ini) return res.status(400).json({ error: "startDate/endDate inválidos" });
  if (fim - ini > 6 * 3600e3) return res.status(400).json({ error: "Janela máxima de 6 horas" });

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
    let ignorados = 0;
    const deslocamentos = [];
    for (const o of lista) {
      const d = paraDeslocamento(o);
      if (!d) continue;
      if (d.ignorado) { ignorados++; continue; }
      if (d.codigo_cliente && d.data_hora) deslocamentos.push(d);
    }
    return res.status(200).json({ total: lista.length, ignorados, deslocamentos });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao consultar a Segware: " + e.message });
  }
}
