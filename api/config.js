export default function handler(req, res) {
  // Permite apenas GET
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Lê variáveis de ambiente do Vercel (nunca expostas no GitHub)
  const supabaseUrl   = process.env.SUPABASE_URL   || "";
  const supabaseAnon  = process.env.SUPABASE_ANON  || "";
  const segwareToken  = process.env.SEGWARE_TOKEN  || "";

  // Valida se as variáveis estão configuradas
  if (!supabaseUrl || !supabaseAnon) {
    return res.status(500).json({ error: "Variáveis de ambiente não configuradas no Vercel." });
  }

  // Retorna um script JS que define as variáveis globais no browser
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-store"); // nunca cachear — dados sensíveis

  res.status(200).send(`
window._SUPABASE_URL  = ${JSON.stringify(supabaseUrl)};
window._SUPABASE_ANON = ${JSON.stringify(supabaseAnon)};
window._SEGWARE_TOKEN = ${JSON.stringify(segwareToken)};
window._configMissing = false;
  `.trim());
}
