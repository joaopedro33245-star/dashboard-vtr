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
    return res.status(500).json({ error: "SEGWARE_TOKEN não encontrado nas variáveis de ambiente do Vercel" });
  }

  // Tenta os dois formatos de parâmetro que a Segware pode usar
  const params = new URLSearchParams({
    startDate: startDate,
    endDate: endDate,
    page: 0,
    size: 1000
  });

  const url = `https://api.segware.com.br/events?${params.toString()}`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": token,
        "Content-Type": "application/json",
        "Accept": "application/json"
      }
    });

    const text = await resp.text();

    // Verifica se é JSON válido
    try {
      const data = JSON.parse(text);
      return res.status(resp.status).json(data);
    } catch {
      return res.status(resp.status).json({
        error: `Segware retornou status ${resp.status} com resposta não-JSON`,
        body: text.slice(0, 1000),
        url_chamada: url
      });
    }
  } catch (e) {
    return res.status(500).json({ error: "Erro ao chamar API Segware: " + e.message });
  }
}
