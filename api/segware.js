export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.SEGWARE_TOKEN;

  // Debug: mostra o início do token para confirmar se está chegando
  const tokenPreview = token 
    ? token.substring(0, 30) + "..." 
    : "NÃO ENCONTRADO";

  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ 
      error: "startDate e endDate são obrigatórios",
      token_preview: tokenPreview
    });
  }

  if (!token) {
    return res.status(500).json({ 
      error: "SEGWARE_TOKEN não encontrado",
      token_preview: tokenPreview
    });
  }

  // Remove qualquer quebra de linha ou espaço extra do token
  const tokenLimpo = token.replace(/[\r\n\s]+/g, ' ').trim();

  const url = `https://api.segware.com.br/events?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&page=0&size=1000`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": tokenLimpo,
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
        body: text.slice(0, 500),
        token_preview: tokenPreview,
        url_chamada: url
      });
    }
  } catch (e) {
    return res.status(500).json({ 
      error: "Erro: " + e.message,
      token_preview: tokenPreview
    });
  }
}
