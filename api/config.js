module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl  = process.env.SUPABASE_URL  || "";
  const supabaseAnon = process.env.SUPABASE_ANON || "";
  const segwareToken = process.env.SEGWARE_TOKEN || "";

  if (!supabaseUrl || !supabaseAnon) {
    return res.status(500).json({ error: "Variaveis de ambiente nao configuradas no Vercel." });
  }

  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-store");

  res.status(200).send(
    "window._SUPABASE_URL  = " + JSON.stringify(supabaseUrl)  + ";\n" +
    "window._SUPABASE_ANON = " + JSON.stringify(supabaseAnon) + ";\n" +
    "window._SEGWARE_TOKEN = " + JSON.stringify(segwareToken) + ";\n" +
    "window._configMissing = false;\n"
  );
};
