export default async function handler(req, res) {
  // Permite apenas GET
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: "startDate e endDate são obrigatórios" });
  }

  const token = process.env.SEGWARE_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "SEGWARE_TOKEN não configurado nas variáveis de ambiente do Vercel" });
  }

  const url = `https://api.segware.com.br/events?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": token,
        "Content-Type": "application/json"
      }
    });

    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (e) {
    res.status(500).json({ error: "Erro ao chamar API Segware: " + e.message });
  }
}
