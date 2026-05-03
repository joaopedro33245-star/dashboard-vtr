export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: "startDate e endDate são obrigatórios" });
  }

  // A variável SEGWARE_TOKEN no Vercel já inclui "Bearer eyJ..."
  const token = process.env.SEGWARE_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "SEGWARE_TOKEN não encontrado nas variáveis de ambiente do Vercel" });
  }

  const url = `https://api.segware.com.br/events?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;

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
      // Retorna detalhes para diagnóstico
      return res.status(resp.status).json({
        error: `Segware retornou status ${resp.status} com resposta não-JSON`,
        body: text.slice(0, 500)
      });
    }
  } catch (e) {
    return res.status(500).json({ error: "Erro ao chamar API Segware: " + e.message });
  }
}
