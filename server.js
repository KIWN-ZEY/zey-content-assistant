/**
 * مساعد محتوى زِيّ — الخادم (ZEY Content Assistant — Server)
 * -------------------------------------------------------------
 * يقدّم الواجهة الثابتة، يخفي مفتاح API، ويدير المكتبة المشتركة.
 * كل شيء حسّاس (مفتاح API، البرومبتات، سياق البراند) يعيش هنا فقط.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ZEY_MODEL || "claude-sonnet-4-20250514";
const MAX_TOKENS = 1000;

// يدعم الترتيبين: ملفات داخل مجلّدات (public/ و data/) أو ملفات مسطّحة بجانب server.js
const INDEX_FILE = fs.existsSync(path.join(__dirname, "public", "index.html"))
  ? path.join(__dirname, "public", "index.html")
  : path.join(__dirname, "index.html");
const DATA_DIR = fs.existsSync(path.join(__dirname, "data"))
  ? path.join(__dirname, "data")
  : __dirname;
const LIB_FILE = path.join(DATA_DIR, "library.json");

app.use(express.json({ limit: "1mb" }));

// نقدّم الواجهة فقط (بدون كشف ملفات المصدر الأخرى)
app.get("/", (req, res) => res.sendFile(INDEX_FILE));

// ===== سياق البراند (سرّي عن الواجهة — يُرسل للذكاء فقط) =====
const BRAND = `أنت مساعد المحتوى الرسمي لبراند "زِيّ" (ZEY).

عن البراند:
زِيّ متجر ملابس عمل (يونيفورم) مع خدمات طباعة وتطريز، يخدم عملاء B2B (شركات، مصانع، مستشفيات، فنادق، مدارس)، ويتوسّع نحو الملابس الكاجوال للشباب 18-30. المتجر في إسرائيل ويخدم جمهوراً يتحدث العربية والعبرية.

نبرة البراند: ودودة ومهنية في آن، واثقة، بسيطة وواضحة، تركّز على الجودة والحرفية.

أعمدة المحتوى:
1) منتجات وعروض  2) خلف الكواليس (الطباعة والتطريز)  3) أعمال وعملاء  4) محتوى قيمة/نصائح.

قواعد إلزامية:
- لا تخترع أسعاراً أبداً. لأي سؤال عن سعر كميات كبيرة أو طلب خاص، اذكر بلطف أنه سيتم التأكيد مع الإدارة.
- اكتب بعربية فصحى مبسّطة وواضحة (قريبة من المحكية) ما لم يُطلب غير ذلك.
- حافظ على هوية زِيّ في كل مخرجاتك.`;

const PILLARS = [
  "منتجات وعروض",
  "خلف الكواليس (الطباعة والتطريز)",
  "أعمال وعملاء",
  "محتوى قيمة / نصيحة",
];

// ===== تخزين المكتبة (ملف JSON بسيط) =====
function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LIB_FILE)) fs.writeFileSync(LIB_FILE, "[]", "utf8");
}
function readLib() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(LIB_FILE, "utf8")) || [];
  } catch {
    return [];
  }
}
function writeLib(items) {
  ensureStore();
  fs.writeFileSync(LIB_FILE, JSON.stringify(items, null, 2), "utf8");
}

// ===== بناء البرومبتات (على الخادم) =====
function buildExamplesBlock(pillar) {
  // حتى 3 أمثلة معتمدة (⭐) بنفس العمود لتحسين الإنتاج (few-shot)
  const lib = readLib();
  const examples = lib
    .filter((i) => i.approved && i.type === "caption" && i.pillar === pillar)
    .slice(-3)
    .map((i, n) => `مثال معتمد ${n + 1}:\n${i.output}`)
    .join("\n\n");
  if (!examples) return "";
  return `\n\nهذه أمثلة معتمدة سابقة بنفس العمود — طابِق أسلوبها ومستواها:\n${examples}\n`;
}

function buildTask(body) {
  const { type } = body;
  if (type === "caption") {
    const pillar = PILLARS.includes(body.pillar) ? body.pillar : PILLARS[0];
    const brief = String(body.brief || "").slice(0, 1200);
    return (
      `المهمة: اكتب كابشن لمنشور إنستغرام/فيسبوك.\n` +
      `عمود المحتوى: ${pillar}\n` +
      `الموضوع: ${brief}\n\n` +
      `المطلوب:\n` +
      `1) كابشن بالعربية (2-4 أسطر، جذّاب، مع دعوة للتفاعل).\n` +
      `2) نفس الكابشن بالعبرية.\n` +
      `3) 5-7 هاشتاغات مناسبة.\n` +
      `اكتب بشكل منسّق وواضح.` +
      buildExamplesBlock(pillar)
    );
  }
  if (type === "idea") {
    return (
      `المهمة: اقترح 5 أفكار منشورات لهذا الأسبوع موزّعة على أعمدة المحتوى الأربعة.\n` +
      `لكل فكرة اكتب: العمود، عنوان قصير، ووصف من سطر واحد لما يُصوَّر أو يُنشر.\n` +
      `رقّم الأفكار بوضوح.`
    );
  }
  if (type === "reply") {
    const message = String(body.message || "").slice(0, 2000);
    return (
      `المهمة: اكتب رداً مقترحاً على رسالة عميل بنبرة زِيّ.\n` +
      `رسالة العميل: "${message}"\n\n` +
      `المطلوب:\n` +
      `1) رد بالعربية.\n` +
      `2) رد بالعبرية.\n` +
      `إن كان السؤال عن سعر كميات كبيرة أو طلب خاص، وضّح بلطف أنه سيتم التأكيد مع الإدارة واطلب تفاصيل أكثر.`
    );
  }
  if (type === "analyze") {
    const summary = String(body.summary || "").slice(0, 6000);
    return (
      `المهمة: حلّل سجل محتوى زِيّ التالي وأعطني:\n` +
      `1) ملاحظات عن نمط المحتوى (شو شغّال، شو ناقص).\n` +
      `2) أي عمود محتوى مهمَل ولازم نزيده.\n` +
      `3) ثلاثة اقتراحات عملية لتطوير المحتوى.\n\n` +
      `سجل المحتوى:\n${summary}`
    );
  }
  return null;
}

// ===== استدعاء الذكاء الاصطناعي (بروكسي) =====
async function callClaude(task) {
  const userContent = BRAND + "\n----------\n" + task;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("Anthropic API error " + res.status + ": " + t);
  }
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ===== المسارات (Routes) =====

// توليد محتوى
app.post("/api/generate", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: "مفتاح API غير مُعدّ على الخادم. راجع ملف README.",
      });
    }
    const task = buildTask(req.body || {});
    if (!task) return res.status(400).json({ error: "نوع طلب غير معروف." });
    const output = await callClaude(task);
    res.json({ output: output || "ما وصل رد، جرّبي مرة ثانية." });
  } catch (e) {
    console.error(e);
    res.status(502).json({
      error: "صار خطأ بالاتصال بالذكاء الاصطناعي. جرّبي مرة ثانية.",
      detail: String(e && e.message ? e.message : e),
    });
  }
});

// جلب المكتبة المشتركة
app.get("/api/library", (req, res) => {
  res.json(readLib());
});

// حفظ عنصر جديد
app.post("/api/library", (req, res) => {
  const b = req.body || {};
  if (!b.type || !b.output) {
    return res.status(400).json({ error: "بيانات ناقصة." });
  }
  const lib = readLib();
  const item = {
    id: crypto.randomUUID(),
    type: b.type, // caption | idea | reply
    pillar: b.pillar || "",
    input: b.input || "",
    output: b.output,
    approved: !!b.approved,
    ts: Date.now(),
  };
  lib.push(item);
  writeLib(lib);
  res.json(item);
});

// اعتماد/إلغاء اعتماد عنصر
app.patch("/api/library/:id", (req, res) => {
  const lib = readLib();
  const item = lib.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "العنصر غير موجود." });
  if (typeof req.body.approved === "boolean") item.approved = req.body.approved;
  writeLib(lib);
  res.json(item);
});

// حذف عنصر
app.delete("/api/library/:id", (req, res) => {
  let lib = readLib();
  const before = lib.length;
  lib = lib.filter((i) => i.id !== req.params.id);
  if (lib.length === before)
    return res.status(404).json({ error: "العنصر غير موجود." });
  writeLib(lib);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`مساعد محتوى زِيّ يعمل على http://localhost:${PORT}`);
  if (!API_KEY) console.warn("تحذير: ANTHROPIC_API_KEY غير مُعدّ.");
});
