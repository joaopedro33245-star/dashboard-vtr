export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: "startDate e endDate são obrigatórios" });
  }

  const token = process.env.SEGWARE_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "SEGWARE_TOKEN não encontrado nas variáveis de ambiente" });
  }

  // Limpa quebras de linha e espaços extras
  const tokenLimpo = token.replace(/[\r\n\t]+/g, '').trim();
  
  // Garante que começa com "Bearer "
  const tokenFinal = tokenLimpo.startsWith('Bearer ') ? tokenLimpo : 'Bearer ' + tokenLimpo;

  const url = `https://api.segware.com.br/v1/occurrences?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": tokenFinal,
        "Content-Type": "application/json",
        "Accept": "application/json"
      }
    });

    const text = await resp.text();

    try {
      const data = JSON.parse(text);
      return res.status(resp.status).json(data);
    } catch {
      return res.status(resp.status).json({
        error: `Status ${resp.status} — resposta não-JSON`,
        body: text.slice(0, 300),
        url_chamada: url,
        token_inicio: tokenFinal.substring(0, 20) + "..."
      });
    }
  } catch (e) {
    return res.status(500).json({ error: "Erro: " + e.message });
  }
}
