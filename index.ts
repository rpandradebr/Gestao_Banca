/* =====================================================================
   BOT DE APOSTAS — Supabase Edge Function (webhook do Telegram)
   Print / áudio / texto  →  casa_bets (pendente)  →  responda a
   confirmação com "green", "red", "anulada" ou "cashout 120,50".
   ===================================================================== */
import { createClient } from "npm:@supabase/supabase-js@2";

const TG_TOKEN = Deno.env.get("TELEGRAM_TOKEN")!;
const TG_SECRET = Deno.env.get("TELEGRAM_SECRET") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY")!;
const USER_ID = Deno.env.get("USER_ID")!;
const BANCA_ID = Deno.env.get("BANCA_ID") ?? ""; // opcional: banca padrão
const CASA_PADRAO = Deno.env.get("CASA_PADRAO") ?? "Bet365";
const ALLOWED_CHAT = Deno.env.get("ALLOWED_CHAT") ?? "";
const FONTES = (Deno.env.get("FONTES") ?? "Junior,Bruno,Minha análise").split(",").map(f => f.trim()).filter(Boolean);

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

/* ---------- Telegram ---------- */
const tg = (metodo: string, corpo: Record<string, unknown>) =>
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/${metodo}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo)
  }).then(r => r.json());
const enviar = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id, text, ...extra });
const tecladoDe = (betId: string) => ({
  inline_keyboard: [
    FONTES.map(f => ({ text: `👤 ${f}`, callback_data: `f|${betId}|${f.slice(0, 20)}` })),
    [
      { text: "✅ Green", callback_data: `r|${betId}|green` },
      { text: "❌ Red", callback_data: `r|${betId}|red` },
      { text: "↩️ Anulada", callback_data: `r|${betId}|anulada` }
    ]
  ]
});
async function baixarArquivo(file_id: string): Promise<Uint8Array> {
  const f = await tg("getFile", { file_id });
  const r = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${f.result.file_path}`);
  return new Uint8Array(await r.arrayBuffer());
}

/* ---------- utilidades ---------- */
const fmt = (v: number) => (+v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const agoraBR = () => new Date(Date.now() - 3 * 3600 * 1000);
const hoje = () => agoraBR().toISOString().slice(0, 10);
const horaAgora = () => agoraBR().toISOString().slice(11, 16);
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const t = String(v).replace(/r\$\s*/i, "");
  const n = parseFloat(t.replace(/\./g, t.includes(",") ? "" : ".").replace(",", "."));
  return isNaN(n) ? null : n;
};

/* ---------- OpenAI ---------- */
const PROMPT = `Você extrai dados de bilhetes de apostas esportivas (print, texto ou fala transcrita, em português).
Responda APENAS com JSON válido, sem markdown:
{"data":"AAAA-MM-DD ou null","hora":"HH:MM ou null","casa":"nome ou null",
"banca":"nome da banca/carteira SE o usuário mencionar (ex.: 'banca Betano'), senão null",
"fonte":"nome da pessoa/tipster que indicou a aposta, SE mencionado pelo usuário, senão null",
"valor":numero,"retorno_potencial":numero ou null,
"selecoes":[{"jogo":"Time A x Time B","mercado":"ex.: Resultado Final, Chutes ao Gol","selecao":"o que foi apostado",
"categoria":"classifique em UMA: Gols | Resultado | Ambas Marcam | Handicap | Escanteios | Cartões | Chutes | Chutes ao Gol | Desarmes | Defesas | Passes | Faltas | Jogador (outras stats) | Outros",
"odd":numero,"competicao":"ou null","esporte":"Futebol se não claro",
"jogador":"nome SE mercado de estatística de jogador (chutes, desarmes, defesas, passes, finalizações), senão null",
"clube":"ou null","linha_ou":"over | under | null","linha":"0.5, 1.5... ou null"}]}
Regras: números com ponto decimal; múltiplas = todas as seleções; não invente valores.
Se o usuário informar casa de apostas ou fonte junto da mensagem, use esses valores.`;

async function chatJSON(mensagens: unknown[]) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: mensagens, max_tokens: 800, temperature: 0 })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return JSON.parse(j.choices[0].message.content.replace(/```json|```/g, "").trim());
}
const extrairDeImagem = (b64: string, legenda = "") => chatJSON([
  { role: "system", content: PROMPT },
  { role: "user", content: [
    { type: "text", text: "Extraia os dados deste bilhete." + (legenda ? ` Informações adicionais do usuário: "${legenda}"` : "") },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }
  ]}
]);
const extrairDeTexto = (t: string) => chatJSON([
  { role: "system", content: PROMPT },
  { role: "user", content: `Extraia os dados desta aposta: "${t}"` }
]);
async function transcrever(bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/ogg" }), "audio.ogg");
  form.append("model", "whisper-1");
  form.append("language", "pt");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: form
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.text;
}

/* ---------- bancas ---------- */
const norm = (t: string) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
async function bancasCasa(): Promise<{ id: string; nome: string }[]> {
  const { data } = await sb.from("bancas").select("id,nome,tipo").eq("user_id", USER_ID).eq("tipo", "casa").order("criado_em");
  return (data || []).map((b: any) => ({ id: b.id, nome: b.nome }));
}
function acharBanca(bancas: { id: string; nome: string }[], texto: string | null | undefined) {
  if (!texto) return null;
  const t = norm(texto);
  if (!t) return null;
  return bancas.find(b => norm(b.nome) === t) || bancas.find(b => norm(b.nome).includes(t) || t.includes(norm(b.nome))) || null;
}

/* ---------- montagem e gravação ---------- */
function montarLinha(ext: any, bancaId: string) {
  const sels = (ext.selecoes || []).map((s: any) => ({
    titulo: s.jogo || "", cotacao: s.odd != null ? String(s.odd) : "",
    esporte: s.esporte || "Futebol", estado: "pendente",
    competicao: s.competicao || "", tipo: s.mercado || s.selecao || "",
    categoria: s.categoria || "", closing: "", proba: "",
    jogador: s.jogador || "", clube: s.jogador ? (s.clube || "") : "", posicao: "",
    linha_ou: s.jogador ? (s.linha_ou || "over") : "over",
    linha: s.jogador ? (s.linha || "") : "", det: false,
    obs_selecao: s.selecao || ""
  }));
  return {
    user_id: USER_ID, banca_id: bancaId,
    data: ext.data || hoje(), hora: ext.hora || horaAgora(),
    casa: ext.casa || CASA_PADRAO,
    formato: sels.length > 1 ? "multipla" : "simples",
    valor: num(ext.valor) || 0, estado: "pendente", retorno: null, pl: 0,
    fonte: ext.fonte || "",
    obs: "BOT" + (ext.retorno_potencial ? ` · retorno potencial ${fmt(+ext.retorno_potencial)}` : ""),
    selecoes: sels
  };
}
const oddTotal = (sels: any[]) => {
  const odds = (sels || []).map(s => num(s.cotacao)).filter((v): v is number => !!v && v > 1);
  return odds.length ? odds.reduce((a, b) => a * b, 1) : null;
};
async function jaExiste(linha: any): Promise<boolean> {
  const { data } = await sb.from("casa_bets").select("id,valor,selecoes")
    .eq("user_id", USER_ID).eq("banca_id", linha.banca_id).eq("data", linha.data).limit(50);
  const t1 = (linha.selecoes[0]?.titulo || "").toLowerCase();
  return (data || []).some((b: any) =>
    Math.abs((+b.valor || 0) - linha.valor) < 0.01 &&
    ((b.selecoes || [])[0]?.titulo || "").toLowerCase() === t1);
}
function textoConfirmacao(linha: any, nomeBanca = "") {
  const ot = oddTotal(linha.selecoes);
  const linhas = linha.selecoes.map((s: any) => {
    const prop = s.jogador ? `${s.jogador}${s.clube ? ` (${s.clube})` : ""} — ${s.linha_ou === "under" ? "Under" : "Over"} ${s.linha} ` : "";
    return `⏳ ${prop}${s.obs_selecao && !s.jogador ? s.obs_selecao + " · " : ""}${s.tipo}${s.titulo ? ` — ${s.titulo}` : ""} @ ${s.cotacao || "?"}`;
  }).join("\n");
  return `🤝 Registrada (pendente):\n\n${linhas}\n\n💰 ${fmt(linha.valor)}${ot ? ` · odd total ${ot.toFixed(2).replace(".", ",")}` : ""}\n🏦 ${linha.casa}${nomeBanca ? `\n📂 Banca: ${nomeBanca}` : ""}\n👤 Fonte: ${linha.fonte || "— (escolha abaixo)"}\n\nToque nos botões pra definir a fonte e o resultado — ou responda com "green", "red", "anulada" ou "cashout 120,50" 🍀`;
}
async function gravar(chat: number, msgId: number, ext: any, banca: { id: string; nome: string }) {
  const linha = montarLinha(ext, banca.id);
  if (await jaExiste(linha))
    return enviar(chat, `⚠️ Essa aposta parece já registrada hoje na banca ${banca.nome} (mesmo jogo e valor). Não dupliquei.`);
  const { data, error } = await sb.from("casa_bets").insert(linha).select().single();
  if (error) return enviar(chat, "❌ Erro ao gravar: " + error.message);
  const conf = await enviar(chat, textoConfirmacao({ ...linha, id: data.id }, banca.nome), { reply_to_message_id: msgId, reply_markup: tecladoDe(data.id) });
  if (conf?.result?.message_id)
    await sb.from("bot_msgs").insert({ msg_id: conf.result.message_id, bet_id: data.id });
}
async function registrar(chat: number, msgId: number, ext: any) {
  const linhaTeste = montarLinha(ext, "teste");
  if (!linhaTeste.valor || !linhaTeste.selecoes.length)
    return enviar(chat, `⚠️ Não consegui identificar o valor ou as seleções. Tenta um print mais nítido ou por texto: "100 na Argentina odd 1.70, Resultado Final".`);
  const bancas = await bancasCasa();
  if (!bancas.length) return enviar(chat, "⚠️ Nenhuma banca de Casa de Aposta encontrada no site. Crie uma na aba Banca primeiro.");
  /* 1) usuário citou a banca · 2) casa bate com o nome de uma banca · 3) só existe uma · 4) banca padrão do secret · 5) perguntar com botões */
  let alvo = acharBanca(bancas, ext.banca) || acharBanca(bancas, ext.casa);
  if (!alvo && bancas.length === 1) alvo = bancas[0];
  if (!alvo && BANCA_ID) alvo = bancas.find(b => b.id === BANCA_ID) ?? null;
  if (alvo) return gravar(chat, msgId, ext, alvo);
  const chave = crypto.randomUUID().slice(0, 8);
  await sb.from("bot_estados").insert({ chave, payload: { ext, msgId } });
  await enviar(chat, "📂 Em qual banca registro essa aposta?", {
    reply_to_message_id: msgId,
    reply_markup: { inline_keyboard: bancas.map(b => ([{ text: `📂 ${b.nome}`, callback_data: `b|${chave}|${b.id}` }])) }
  });
}
async function resolverAposta(chat: number, aposta: any, texto: string, msgId: number, msgTecladoId?: number): Promise<boolean> {
  const t = texto.trim().toLowerCase();
  const ot = oddTotal(aposta.selecoes) || 0;
  let upd: any = null;
  if (/^green/.test(t)) upd = { estado: "green", pl: +(aposta.valor * (ot - 1)).toFixed(2) };
  else if (/^red/.test(t)) upd = { estado: "red", pl: -aposta.valor };
  else if (/^anulad/.test(t)) upd = { estado: "anulada", pl: 0 };
  else if (/^cashout/.test(t)) {
    const v = num(t.replace(/^cashout/, ""));
    if (v == null) { await enviar(chat, "Me diz o valor: cashout 120,50"); return true; }
    upd = { estado: "cashout", retorno: v, pl: +(v - aposta.valor).toFixed(2) };
  }
  if (!upd) return false;
  upd.selecoes = (aposta.selecoes || []).map((s: any) => ({ ...s, estado: upd.estado === "cashout" ? "cashout" : upd.estado }));
  const { error } = await sb.from("casa_bets").update(upd).eq("id", aposta.id);
  if (error) { await enviar(chat, "❌ Erro: " + error.message); return true; }
  const emoji = upd.estado === "green" ? "✅" : upd.estado === "red" ? "❌" : upd.estado === "cashout" ? "💸" : "↩️";
  const nome = (aposta.selecoes || [])[0]?.titulo || "aposta";
  if (msgTecladoId) await tg("editMessageReplyMarkup", { chat_id: chat, message_id: msgTecladoId, reply_markup: { inline_keyboard: [] } });
  await enviar(chat, `${emoji} ${upd.estado.toUpperCase()} registrado (${nome}): P/L ${fmt(upd.pl)}. Já está no site!`, { reply_to_message_id: msgId });
  return true;
}
async function resolver(chat: number, replyMsgId: number, texto: string, msgId: number): Promise<boolean> {
  const { data: vinc } = await sb.from("bot_msgs").select("bet_id").eq("msg_id", replyMsgId).maybeSingle();
  if (!vinc) return false;
  const { data: aposta } = await sb.from("casa_bets").select("*").eq("id", vinc.bet_id).single();
  if (!aposta) return false;
  return resolverAposta(chat, aposta, texto, msgId);
}

/* ---------- processamento de cada update ---------- */
async function processarCallback(cq: any) {
  const chat = cq.message.chat.id;
  if (ALLOWED_CHAT && String(chat) !== String(ALLOWED_CHAT)) return;
  const [acao, betId, arg] = String(cq.data || "").split("|");
  try {
    if (acao === "b") {
      const { data: est } = await sb.from("bot_estados").select("payload").eq("chave", betId).maybeSingle();
      if (!est) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Essa escolha expirou — manda o print de novo." }); return; }
      const bancasB = await bancasCasa();
      const banca = bancasB.find(b => b.id === arg);
      if (!banca) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Banca não encontrada." }); return; }
      await sb.from("bot_estados").delete().eq("chave", betId);
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: `Banca: ${banca.nome} 📂` });
      await tg("editMessageText", { chat_id: chat, message_id: cq.message.message_id, text: `📂 Banca escolhida: ${banca.nome}` });
      await gravar(chat, est.payload.msgId, est.payload.ext, banca);
      return;
    }
    const { data: aposta } = await sb.from("casa_bets").select("*").eq("id", betId).maybeSingle();
    if (!aposta) { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Aposta não encontrada." }); return; }
    if (acao === "f") {
      await sb.from("casa_bets").update({ fonte: arg }).eq("id", betId);
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: `Fonte: ${arg} 👤` });
      await tg("editMessageText", {
        chat_id: chat, message_id: cq.message.message_id,
        text: textoConfirmacao({ ...aposta, fonte: arg }),
        reply_markup: aposta.estado === "pendente" ? tecladoDe(betId) : { inline_keyboard: [] }
      });
      return;
    }
    if (acao === "r") {
      if (aposta.estado !== "pendente") { await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Essa aposta já foi resolvida." }); return; }
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: arg === "green" ? "Green! ✅" : arg === "red" ? "Red ❌" : "Anulada ↩️" });
      await resolverAposta(chat, aposta, arg, cq.message.message_id, cq.message.message_id);
      return;
    }
  } catch (e) {
    console.error(e);
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Erro: " + (e as Error).message });
  }
}
async function processar(update: any) {
  if (update.callback_query) return processarCallback(update.callback_query);
  const msg = update.message;
  if (!msg) return;
  const chat = msg.chat.id;
  try {
    if (msg.text === "/id") return enviar(chat, `Seu chat id: ${chat}\nColoque no secret ALLOWED_CHAT para travar o bot só pra você.`);
    if (ALLOWED_CHAT && String(chat) !== String(ALLOWED_CHAT)) return;
    if (msg.text === "/start")
      return enviar(chat, `📸 Me manda o print do bilhete, um áudio ("apostei 100 na Argentina odd 1.70") ou texto, que eu registro na Gestão de Banca como pendente.\n\n💡 Dicas:\n• Legenda do print: "banca Betano fonte João"\n• Se a casa do print bater com o nome de uma banca, acho sozinho; senão pergunto com botões\n• "fonte João" define a fonte da última aposta\n• /pendentes — lista apostas em aberto`);
    if (msg.text === "/pendentes") {
      const bancasL = await bancasCasa();
      const nomes = Object.fromEntries(bancasL.map(b => [b.id, b.nome]));
      const { data } = await sb.from("casa_bets").select("*").eq("user_id", USER_ID)
        .in("banca_id", bancasL.map(b => b.id)).eq("estado", "pendente").order("data").limit(20);
      if (!data?.length) return enviar(chat, "Nenhuma aposta pendente. 👌");
      for (const b of data) {
        const conf = await enviar(chat, textoConfirmacao(b, nomes[b.banca_id] || ""), { reply_markup: tecladoDe(b.id) });
        if (conf?.result?.message_id) await sb.from("bot_msgs").upsert({ msg_id: conf.result.message_id, bet_id: b.id });
      }
      return;
    }
    /* "fonte João" respondendo a confirmação = define a fonte daquela aposta */
    const mFonte = msg.text?.match(/^fonte\s+(.{1,40})$/i);
    if (mFonte && msg.reply_to_message) {
      const { data: vinc } = await sb.from("bot_msgs").select("bet_id").eq("msg_id", msg.reply_to_message.message_id).maybeSingle();
      if (vinc) {
        await sb.from("casa_bets").update({ fonte: mFonte[1].trim() }).eq("id", vinc.bet_id);
        return enviar(chat, `👤 Fonte definida: ${mFonte[1].trim()}`, { reply_to_message_id: msg.message_id });
      }
    }
    /* "fonte João" solto = última aposta pendente */
    if (mFonte && !msg.reply_to_message) {
      const bancasF = await bancasCasa();
      const { data: pend } = await sb.from("casa_bets").select("id,selecoes")
        .eq("user_id", USER_ID).in("banca_id", bancasF.map(b => b.id)).eq("estado", "pendente")
        .order("data", { ascending: false }).order("criado_em", { ascending: false }).limit(1);
      if (!pend?.length) return enviar(chat, "Não achei aposta pendente pra definir a fonte. 🤔");
      await sb.from("casa_bets").update({ fonte: mFonte[1].trim() }).eq("id", pend[0].id);
      const nome = (pend[0].selecoes || [])[0]?.titulo || "última aposta";
      return enviar(chat, `👤 Fonte definida: ${mFonte[1].trim()} (${nome})`, { reply_to_message_id: msg.message_id });
    }
    if (msg.reply_to_message && msg.text) {
      if (await resolver(chat, msg.reply_to_message.message_id, msg.text, msg.message_id)) return;
    }
    /* "green"/"red"/"anulada"/"cashout X" solto = resolve a aposta pendente mais recente */
    if (msg.text && /^(green|red|anulad\w*|cashout[\s\d.,]*)$/i.test(msg.text.trim())) {
      const bancasP = await bancasCasa();
      const { data: pend } = await sb.from("casa_bets").select("*")
        .eq("user_id", USER_ID).in("banca_id", bancasP.map(b => b.id)).eq("estado", "pendente")
        .order("data", { ascending: false }).order("criado_em", { ascending: false }).limit(1);
      if (!pend?.length) return enviar(chat, "Não achei nenhuma aposta pendente pra resolver. 🤔");
      if (await resolverAposta(chat, pend[0], msg.text, msg.message_id)) return;
      return;
    }
    if (msg.photo) {
      await tg("sendChatAction", { chat_id: chat, action: "typing" });
      const bytes = await baixarArquivo(msg.photo[msg.photo.length - 1].file_id);
      let b64 = ""; const CH = 32768;
      for (let i = 0; i < bytes.length; i += CH) b64 += String.fromCharCode(...bytes.subarray(i, i + CH));
      return registrar(chat, msg.message_id, await extrairDeImagem(btoa(b64), msg.caption || ""));
    }
    if (msg.voice || msg.audio) {
      await tg("sendChatAction", { chat_id: chat, action: "typing" });
      const bytes = await baixarArquivo((msg.voice || msg.audio).file_id);
      const texto = await transcrever(bytes);
      return registrar(chat, msg.message_id, await extrairDeTexto(texto));
    }
    if (msg.text) {
      await tg("sendChatAction", { chat_id: chat, action: "typing" });
      return registrar(chat, msg.message_id, await extrairDeTexto(msg.text));
    }
  } catch (e) {
    console.error(e);
    await enviar(chat, "❌ Deu erro ao processar: " + (e as Error).message);
  }
}

/* ---------- webhook ---------- */
Deno.serve(async (req) => {
  if (TG_SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== TG_SECRET)
    return new Response("forbidden", { status: 403 });
  const update = await req.json().catch(() => null);
  if (update) EdgeRuntime.waitUntil(processar(update));
  return new Response("ok");
});
