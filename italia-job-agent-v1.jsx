import { useState, useEffect } from "react";

const CITIES = [
  "Milano","Roma","Torino","Bologna","Firenze",
  "Napoli","Venezia","Genova","Bari","Palermo",
  "Verona","Modena","Parma","Brescia","Bergamo",
  "Remote (IT)",
];
const TYPES  = ["Any","Full-time","Part-time","Remote","Stage","Freelance"];
const LEVELS = ["Any level","Entry","Mid","Senior","Lead"];

// Two source modes — waterfall (Indeed → Web fallback) and Web only
const SOURCES = [
  { id: "waterfall", label: "Indeed → Web", icon: "🔀" },
  { id: "web",       label: "Web only",     icon: "🌐" },
];

const POSTED = [
  { id: "any",    label: "Any date"  },
  { id: "week",   label: "This week" },
  { id: "2weeks", label: "2 weeks"   },
  { id: "month",  label: "30 days"   },
];

// Italy-specific: 2000 char CV limit as requested
const CV_CHAR_LIMIT    = 2000;
const INDEED_THRESHOLD = 6;

// Italian job boards for web search prompt.
// Indeed.it is intentionally excluded: in waterfall mode it is already covered
// by the Indeed MCP; in web-only mode the user has bypassed Indeed entirely.
const IT_BOARDS = "LinkedIn Italia, InfoJobs (infojobs.it), Monster.it, Lavoro.it, Subito.it/lavoro, Jobrapido, Adzuna Italia (adzuna.it), TrovoLavoro (trovolavoro.it), Glassdoor Italia, Corriere Lavoro";

// Italian synonym examples by sector to enrich prompts
const IT_SYNONYM_HINT = "Also search in Italian — e.g. 'controllo qualità', 'tecnico di laboratorio', 'addetto produzione', 'responsabile qualità', 'tecnologo alimentare', 'analista di laboratorio', 'ricerca e sviluppo' — as most Italian listings are posted in Italian.";

function postedInstruction(id) {
  return {
    any:      "",
    week:     "IMPORTANTE: Includi solo offerte pubblicate negli ultimi 7 giorni. Escludi annunci più vecchi.",
    "2weeks": "IMPORTANTE: Includi solo offerte pubblicate negli ultimi 14 giorni. Escludi annunci più vecchi.",
    month:    "IMPORTANTE: Includi solo offerte pubblicate negli ultimi 30 giorni. Escludi annunci più vecchi.",
  }[id] || "";
}
function postedLabel(id) {
  return { any: "Any date", week: "This week", "2weeks": "Last 2 weeks", month: "Last 30 days" }[id] || "Any date";
}

const MCPS  = [{ id: "indeed", label: "Indeed", url: "https://mcp.indeed.com/claude/mcp", color: "#003A9B", dot: "#B5D4F4" }];
const MODEL = "claude-sonnet-4-20250514";

// ── Robust JSON extractor ─────────────────────────────────────────────────────
function extractJobs(text, src) {
  if (!text || !text.trim()) return [];
  const arrayMatch = text.match(/\[[\s\S]*?\]/g);
  if (arrayMatch) {
    for (const candidate of arrayMatch) {
      try {
        const arr = JSON.parse(candidate);
        if (Array.isArray(arr) && arr.length > 0 && arr[0].title)
          return arr.map(j => ({ ...j, _src: src, _id: `${src}-${Math.random()}` }));
      } catch {}
    }
  }
  const objMatches = text.match(/\{[^{}]*"title"[^{}]*\}/g);
  if (objMatches && objMatches.length > 0) {
    const jobs = [];
    for (const raw of objMatches) { try { jobs.push(JSON.parse(raw)); } catch {} }
    if (jobs.length > 0) return jobs.map(j => ({ ...j, _src: src, _id: `${src}-${Math.random()}` }));
  }
  const cleaned = text.replace(/```(?:json)?|```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.map(j => ({ ...j, _src: src, _id: `${src}-${Math.random()}` }));
  } catch {}
  return [];
}

function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter(j => {
    const k = `${(j.title||"").toLowerCase().trim()}|${(j.company||"").toLowerCase().trim()}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function buildPrompt(query, city, type, level, cvText, source, posted) {
  const loc = city === "Remote (IT)" ? "remote Italy" : `${city}, Italy`;
  const f   = [type !== "Any" && type, level !== "Any level" && level].filter(Boolean).join(" ");
  const truncatedCV = cvText.trim().slice(0, CV_CHAR_LIMIT);
  const hasCv = !!truncatedCV;
  const cvSec = hasCv
    ? `\n\nCandidate CV (excerpt):\n${truncatedCV}\n\nFor each job add a "cvNote" field: 2–3 specific actionable tips to tailor this CV for that role, considering the Italian job market.`
    : "";
  const sourceNote = source === "web"
    ? `Search across ${IT_BOARDS}. ${IT_SYNONYM_HINT}`
    : "";
  const dateInstruction = postedInstruction(posted);
  return `Search for ${f ? f + " " : ""}"${query}" jobs in ${loc}. ${sourceNote}${cvSec}

Find 5–8 real current listings. If exact matches are scarce, include closely related roles and use Italian job title synonyms (e.g. for "quality control" also consider "controllo qualità", "addetto CQ", "tecnico qualità alimentare", "responsabile qualità").
${dateInstruction}
IMPORTANT: Return ONLY a valid JSON array starting with [ and ending with ]. No explanation, no markdown, no backticks. Each object: title, company, location, type, salary (string or null), description (2–3 sentences), requirements (array of strings), url (string or null), isRemote (boolean), postedDate (string or null), source (website name)${hasCv ? ", cvNote" : ""}.`;
}

async function callClaude({ prompt, mcpServer, useWebSearch }) {
  const body = {
    model: MODEL,
    max_tokens: 4000,
    system: "You are a job search assistant specialised in the Italian job market. Search for jobs using your available tools. Your ENTIRE response must be a valid JSON array starting with [ and ending with ]. Do not write any text before or after the array.",
    messages: [{ role: "user", content: prompt }],
  };
  if (mcpServer)    body.mcp_servers = [{ type: "url", url: mcpServer.url, name: mcpServer.id }];
  if (useWebSearch) body.tools       = [{ type: "web_search_20250305", name: "web_search" }];

  const timeoutMs  = mcpServer ? 45000 : 60000;
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError")
      throw new Error(`${mcpServer ? mcpServer.label + " MCP" : "Web search"} timed out. Switch to "Web only" if Indeed keeps failing.`);
    throw e;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

async function fetchGemini(key, query, city, type, level, cvText, posted) {
  const loc = city === "Remote (IT)" ? "remote Italy" : `${city}, Italy`;
  const f   = [type !== "Any" && type, level !== "Any level" && level].filter(Boolean).join(" ");
  const truncatedCV = cvText.trim().slice(0, CV_CHAR_LIMIT);
  const hasCv = !!truncatedCV;
  const cvSec = hasCv
    ? `\n\nCandidate CV (excerpt):\n${truncatedCV}\n\nFor each job add a "cvNote" field: 2–3 specific actionable tips for the Italian job market.`
    : "";
  const dateInstruction = postedInstruction(posted);
  const prompt = `Search for ${f ? f + " " : ""}"${query}" jobs in ${loc}. Search ${IT_BOARDS}. ${IT_SYNONYM_HINT}${cvSec}\n\n${dateInstruction}\n\nReturn ONLY a raw JSON array starting with [. Each item: title, company, location, type, salary (or null), description, requirements (array), url (or null), isRemote (boolean), postedDate (or null), source${hasCv ? ", cvNote" : ""}.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key.trim()}`,
    {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
      }),
    }
  );
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `Gemini error (${res.status})`); }
  const d    = await res.json();
  const text = (d.candidates?.[0]?.content?.parts || []).filter(p => p.text).map(p => p.text).join("");
  const jobs = extractJobs(text, "gemini");
  if (!jobs.length) throw new Error("Gemini returned no structured results. Try a different keyword.");
  return jobs;
}

function srcLabel(id) { return { indeed: "Indeed", web: "Web Search", gemini: "Gemini" }[id] || id; }
function srcColor(id) { return { indeed: "#003A9B", web: "#534AB7", gemini: "#1D6F42" }[id] || "#888"; }
function srcDot(id)   { return { indeed: "#B5D4F4", web: "#CED3FA", gemini: "#9FE1CB" }[id] || "#ddd"; }

function toMarkdown(jobs, query, city, type, level, mode, filter) {
  const visible = filter === "all" ? jobs : jobs.filter(j => j._src === filter);
  const now = new Date();
  const ds  = now.toLocaleDateString("it-IT", { year: "numeric", month: "long", day: "numeric" });
  const f   = [type !== "Any" && type, level !== "Any level" && level].filter(Boolean).join(", ") || "None";
  let md = `# 🇮🇹 Italia Job Search Results\n\n| | |\n|---|---|\n| **Search** | ${query} |\n| **Location** | ${city} |\n| **Filters** | ${f} |\n| **Mode** | ${mode} |\n| **Date** | ${ds} |\n| **Results** | ${visible.length} positions |\n\n---\n\n`;
  visible.forEach((job, i) => {
    md += `## ${i + 1}. ${job.title || "Posizione"}\n\n`;
    if (job.company)                          md += `**Azienda:** ${job.company}  \n`;
    if (job.location)                         md += `**Sede:** ${job.location}  \n`;
    if (job.type && job.type !== "null")      md += `**Tipo:** ${job.type}  \n`;
    if (job.salary && job.salary !== "null")  md += `**Retribuzione:** ${job.salary}  \n`;
    if (job.isRemote)                         md += `**Remote:** Sì  \n`;
    if (job.postedDate && job.postedDate !== "null") md += `**Pubblicato:** ${job.postedDate}  \n`;
    if (job._src)                             md += `**Fonte:** ${srcLabel(job._src)}  \n`;
    md += `\n`;
    if (job.description) md += `### Descrizione\n\n${job.description}\n\n`;
    const reqs = (job.requirements || []).filter(r => r && r !== "null");
    if (reqs.length) { md += `### Requisiti\n\n`; reqs.forEach(r => md += `- ${r}\n`); md += `\n`; }
    if (job.cvNote) md += `### ✦ CV Tailoring Tips\n\n${job.cvNote}\n\n`;
    if (job.url && job.url !== "null") md += `### Candidatura\n\n[Candidati per questa posizione →](${job.url})\n\n`;
    md += `---\n\n`;
  });
  md += `*Generato da Italia Job Agent · ${ds}*\n`;
  return md;
}

function downloadMd(jobs, query, city, type, level, mode, filter) {
  const md   = toMarkdown(jobs, query, city, type, level, mode, filter);
  const blob = new Blob([md], { type: "text/markdown" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const slug = query.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const ct   = city.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const d    = new Date();
  const dt   = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  a.href = url; a.download = `it-jobs-${slug}-${ct}-${dt}.md`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── UI primitives ─────────────────────────────────────────────────────────────
function Pill({ children, active, onClick }) {
  return (
    <span onClick={onClick} style={{
      display: "inline-flex", alignItems: "center", padding: "3px 10px",
      borderRadius: 12, fontSize: 12, fontWeight: 500, border: "0.5px solid",
      borderColor: active ? "#AFA9EC" : "#e2e8f0", cursor: "pointer",
      background: active ? "#EEEDFE" : "transparent",
      color: active ? "#3C3489" : "#64748b", transition: "all 0.12s",
    }}>{children}</span>
  );
}

function Tag({ children, color, bg, border }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 10,
      fontSize: 11, fontWeight: 500,
      background: bg || "#f1f5f9", color: color || "#475569",
      border: `0.5px solid ${border || "#e2e8f0"}`,
    }}>{children}</span>
  );
}

function SrcBadge({ id, status, count, error, savedByIndeed }) {
  const done = status === "done", isLoading = status === "loading",
        err  = status === "error", skip      = status === "skipped";
  const c = srcColor(id), d = srcDot(id);
  return (
    <div
      title={
        err && error ? error
        : savedByIndeed ? `Web Search skipped — Indeed returned ${INDEED_THRESHOLD}+ results`
        : undefined
      }
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "4px 10px", borderRadius: 12, fontSize: 11, fontWeight: 500,
        border: "0.5px solid",
        borderColor: done ? d : isLoading ? d+"80" : "#e2e8f0",
        background:  done ? d+"22" : isLoading ? d+"11" : "#f8fafc",
        color:       done ? c : isLoading ? c+"aa" : "#94a3b8",
        transition: "all 0.25s", cursor: (err || savedByIndeed) ? "help" : "default",
      }}>
      {srcLabel(id)}
      {isLoading && <span style={{ width: 10, height: 10, border: `1.5px solid ${c}40`, borderTopColor: c, borderRadius: "50%", animation: "spin 0.8s linear infinite", display: "inline-block" }} />}
      {done && count != null && <span style={{ opacity: 0.8 }}> {count}</span>}
      {err  && <span title={error} style={{ color: "#ef4444" }}> ✕</span>}
      {skip && <span style={{ color: "#94a3b8", fontSize: 10 }}>{savedByIndeed ? " saved" : ""}</span>}
    </div>
  );
}

function JobCard({ job, open, onToggle }) {
  const reqs = (job.requirements || []).filter(r => r && r !== "null");
  const sc   = srcColor(job._src);
  return (
    <div
      onClick={onToggle}
      style={{ background: "#fff", border: "0.5px solid #e2e8f0", borderLeft: `3px solid ${sc}`, borderRadius: "0 8px 8px 0", padding: "14px 16px", marginBottom: 8, cursor: "pointer", transition: "background 0.12s" }}
      onMouseEnter={e => e.currentTarget.style.background = "#f8fafc"}
      onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 6 }}>
        {job._src    && <Tag color={sc} bg={sc+"18"} border={sc+"40"}>{srcLabel(job._src)}</Tag>}
        {job.isRemote && <Tag color="#16a34a" bg="#f0fdf4" border="#bbf7d0">Remote</Tag>}
        {job.type && job.type !== "null" && <Tag>{job.type}</Tag>}
        {job.cvNote  && <Tag color="#92400e" bg="#fffbeb" border="#fde68a">CV tips ✦</Tag>}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 500, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.title || "Posizione"}</p>
          <p style={{ margin: "0 0 6px", fontSize: 13, color: "#6366f1", fontWeight: 500 }}>{job.company || ""}</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {job.location  && <span style={{ fontSize: 12, color: "#94a3b8" }}>📍 {job.location}</span>}
            {job.salary && job.salary !== "null" && <span style={{ fontSize: 12, color: "#16a34a", fontWeight: 500 }}>💶 {job.salary}</span>}
            {job.postedDate && job.postedDate !== "null" && <span style={{ fontSize: 12, color: "#94a3b8" }}>🗓 {job.postedDate}</span>}
          </div>
        </div>
        <span style={{ color: "#cbd5e1", fontSize: 16, flexShrink: 0, transition: "transform 0.15s", transform: open ? "rotate(180deg)" : "none", marginTop: 2 }}>⌄</span>
      </div>
      {open && (
        <div onClick={e => e.stopPropagation()} style={{ marginTop: 12, paddingTop: 12, borderTop: "0.5px solid #f1f5f9" }}>
          {job.description && <p style={{ margin: "0 0 10px", fontSize: 13, lineHeight: 1.75, color: "#475569" }}>{job.description}</p>}
          {reqs.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ margin: "0 0 5px", fontSize: 12, fontWeight: 500 }}>Requisiti</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {reqs.map((r, i) => <li key={i} style={{ fontSize: 13, color: "#475569", marginBottom: 3, lineHeight: 1.55 }}>{r}</li>)}
              </ul>
            </div>
          )}
          {job.cvNote && (
            <div style={{ background: "#fffbeb", border: "0.5px solid #fde68a", borderRadius: 8, padding: "10px 12px", marginBottom: 12 }}>
              <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 500, color: "#92400e" }}>✦ CV tailoring tips</p>
              <p style={{ margin: 0, fontSize: 13, color: "#78350f", lineHeight: 1.7 }}>{job.cvNote}</p>
            </div>
          )}
          {job.url && job.url !== "null" && (
            <a href={job.url} target="_blank" rel="noopener noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 14px", background: "#EEEDFE", color: "#3C3489", border: "0.5px solid #AFA9EC", borderRadius: 6, fontSize: 12, fontWeight: 500, textDecoration: "none" }}>
              Candidati ora →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ItaliaJobAgent() {
  // localStorage keys namespaced for Italy agent (won't clash with NL agent)
  const [key, setKey] = useState(() => {
    try { return localStorage.getItem("ita_gemini_key") || ""; } catch { return ""; }
  });
  const [cvText, setCvText] = useState(() => {
    try { return localStorage.getItem("ita_cv_text") || ""; } catch { return ""; }
  });

  const [showKey,   setShowKey]   = useState(false);
  const [showCV,    setShowCV]    = useState(false);
  const [query,     setQuery]     = useState("");
  const [city,      setCity]      = useState("Milano");
  const [type,      setType]      = useState("Any");
  const [level,     setLevel]     = useState("Any level");
  const [jobs,      setJobs]      = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");
  const [searched,  setSearched]  = useState(false);
  const [expanded,  setExpanded]  = useState({});
  const [srcStatus, setSrcStatus] = useState({});
  const [srcCount,  setSrcCount]  = useState({});
  const [srcErrors, setSrcErrors] = useState({});
  const [webSavedByIndeed, setWebSavedByIndeed] = useState(false);
  const [filter,    setFilter]    = useState("all");
  const [saved,     setSaved]     = useState(false);
  const [srcMode,   setSrcMode]   = useState("waterfall");
  const [posted,    setPosted]    = useState("any");

  useEffect(() => {
    const s = document.createElement("style");
    s.textContent = `@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@keyframes spin{to{transform:rotate(360deg)}}`;
    document.head.appendChild(s); return () => document.head.removeChild(s);
  }, []);

  useEffect(() => { try { localStorage.setItem("ita_gemini_key", key); } catch {} }, [key]);
  useEffect(() => { try { localStorage.setItem("ita_cv_text", cvText); } catch {} }, [cvText]);

  const using       = !!key.trim();
  const cvWords     = cvText.trim().split(/\s+/).filter(Boolean).length;
  const cvTruncated = cvText.trim().length > CV_CHAR_LIMIT;

  const setS = (id, st)  => setSrcStatus(p => ({ ...p, [id]: st }));
  const setC = (id, n)   => setSrcCount(p  => ({ ...p, [id]: n }));
  const setE = (id, msg) => setSrcErrors(p => ({ ...p, [id]: msg }));

  const handleSearch = async () => {
    if (!query.trim() || loading) return;
    setLoading(true); setJobs([]); setError(""); setSearched(true);
    setExpanded({}); setFilter("all"); setSaved(false); setWebSavedByIndeed(false);
    setSrcStatus({}); setSrcCount({}); setSrcErrors({});

    // ── Gemini mode ───────────────────────────────────────────────────────────
    if (using) {
      setS("gemini", "loading");
      try {
        const j = await fetchGemini(key, query, city, type, level, cvText, posted);
        setJobs(j); setS("gemini", "done"); setC("gemini", j.length);
      } catch (e) { setError(e.message); setS("gemini", "error"); setE("gemini", e.message); }

    // ── Claude mode ───────────────────────────────────────────────────────────
    } else {
      const prompt    = buildPrompt(query, city, type, level, cvText, "mcp", posted);
      const webPrompt = buildPrompt(query, city, type, level, cvText, "web", posted);
      let indeedJobs = [];
      let webJobs    = [];

      // Waterfall: Indeed first → Web fallback
      if (srcMode === "waterfall") {
        setS("indeed", "loading");
        setS("web",    "skipped");

        try {
          const text = await callClaude({ prompt, mcpServer: MCPS[0] });
          indeedJobs = extractJobs(text, "indeed");
          setS("indeed", "done"); setC("indeed", indeedJobs.length);
        } catch (err) {
          setS("indeed", "error"); setE("indeed", err.message || "Connessione fallita");
        }

        if (indeedJobs.length >= INDEED_THRESHOLD) {
          setS("web", "skipped");
          setWebSavedByIndeed(true);
        } else {
          setS("web", "loading");
          try {
            const text = await callClaude({ prompt: webPrompt, useWebSearch: true });
            webJobs = extractJobs(text, "web");
            setS("web", "done"); setC("web", webJobs.length);
          } catch (err) {
            setS("web", "error"); setE("web", err.message || "Ricerca web fallita");
          }
        }

      // Web only mode
      } else {
        setS("web", "loading");
        try {
          const text = await callClaude({ prompt: webPrompt, useWebSearch: true });
          webJobs = extractJobs(text, "web");
          setS("web", "done"); setC("web", webJobs.length);
        } catch (err) {
          setS("web", "error"); setE("web", err.message || "Ricerca web fallita");
        }
      }

      const merged = dedupe([...indeedJobs, ...webJobs]);
      setJobs(merged);
      if (merged.length === 0) {
        const hint = srcMode === "waterfall"
          ? "Se Indeed mostra ✕, ricollegalo su claude.ai/settings/integrations, oppure passa a Web only."
          : "Prova un'altra parola chiave o città.";
        setError("Nessun risultato trovato. " + hint);
      }
    }
    setLoading(false);
  };

  const handleSave = () => {
    const modeLabel = using
      ? "Gemini + Google Search"
      : `Claude · ${SOURCES.find(s => s.id === srcMode)?.label || srcMode} · ${postedLabel(posted)}`;
    downloadMd(jobs, query, city, type, level, modeLabel, filter);
    setSaved(true); setTimeout(() => setSaved(false), 3000);
  };

  const visible  = filter === "all" ? jobs : jobs.filter(j => j._src === filter);
  const srcIds   = [...new Set(jobs.map(j => j._src))];
  const badgeIds = using ? ["gemini"] : srcMode === "waterfall" ? ["indeed", "web"] : ["web"];

  return (
    <div style={{ fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", maxWidth: 700, margin: "0 auto", padding: "24px 16px", color: "#0f172a" }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🇮🇹</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 500 }}>Italia Job Agent</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>
              {using ? "Gemini + Google Search" : "Claude · Indeed → Web waterfall"}
            </div>
          </div>
          {using
            ? <Tag color="#16a34a" bg="#f0fdf4" border="#bbf7d0">Gemini</Tag>
            : <Tag color="#6366f1" bg="#eff6ff" border="#c7d2fe">Claude mode</Tag>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Pill active={showCV} onClick={() => { setShowCV(v => !v); setShowKey(false); }}>
            📄 {cvText.trim() ? `CV (${cvWords}w)` : "Add CV"}
          </Pill>
          <Pill active={showKey} onClick={() => { setShowKey(v => !v); setShowCV(false); }}>
            ⚙ API key
          </Pill>
        </div>
      </div>

      {/* ── API key panel ── */}
      {showKey && (
        <div style={{ background: "#f8fafc", border: "0.5px solid #e2e8f0", borderRadius: 10, padding: 16, marginBottom: 12 }}>
          <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 500 }}>Gemini API key</p>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input type="password" value={key} onChange={e => setKey(e.target.value)}
              placeholder="AIza… (lascia vuoto per Claude + Indeed/Web mode)"
              style={{ flex: 1, padding: "8px 12px", fontSize: 13, border: "0.5px solid #e2e8f0", borderRadius: 6, background: "#fff", fontFamily: "monospace", outline: "none" }} />
            {key && (
              <button onClick={() => setKey("")}
                style={{ padding: "8px 12px", border: "0.5px solid #e2e8f0", borderRadius: 6, background: "#fff", fontSize: 12, flexShrink: 0 }}>
                Cancella
              </button>
            )}
          </div>
          <p style={{ margin: 0, fontSize: 11, color: "#94a3b8" }}>
            Gemini key da <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: "#6366f1" }}>aistudio.google.com/apikey</a> · Salvata automaticamente nel browser.
          </p>
        </div>
      )}

      {/* ── CV panel ── */}
      {showCV && (
        <div style={{ background: "#f8fafc", border: "0.5px solid #e2e8f0", borderRadius: 10, padding: 16, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 500 }}>Il tuo CV — competenze ed esperienze chiave</p>
            {cvText && (
              <button onClick={() => setCvText("")}
                style={{ padding: "3px 8px", fontSize: 11, border: "0.5px solid #e2e8f0", borderRadius: 4, background: "#fff" }}>
                Cancella
              </button>
            )}
          </div>
          <textarea value={cvText} onChange={e => setCvText(e.target.value)} rows={7}
            placeholder={"Incolla i punti chiave:\n• Titoli e aziende\n• Competenze tecniche e strumenti\n• Anni di esperienza\n• Formazione e certificazioni\n• Preferenze di lavoro\n\nL'agente aggiungerà consigli personalizzati per ogni offerta."}
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", fontSize: 13, lineHeight: 1.7, border: "0.5px solid #e2e8f0", borderRadius: 6, background: "#fff", resize: "vertical", fontFamily: "inherit", outline: "none" }}
            onFocus={e => e.target.style.borderColor = "#6366f1"}
            onBlur={e  => e.target.style.borderColor = "#e2e8f0"} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
            <span style={{ fontSize: 11, color: "#94a3b8" }}>
              ≈{Math.round(Math.min(cvText.trim().length, CV_CHAR_LIMIT) / 4)} token · salvato automaticamente
              {cvTruncated && <span style={{ color: "#f59e0b", marginLeft: 4 }}>· ridotto a {CV_CHAR_LIMIT} caratteri per il prompt</span>}
            </span>
            {cvText.trim() && <span style={{ fontSize: 11, color: "#16a34a" }}>✓ CV tips su ogni risultato</span>}
          </div>
        </div>
      )}

      {/* ── Search bar ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <input
          value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSearch()}
          placeholder='Ruolo o competenza  es. "Tecnico Qualità Alimentare", "Controllo Qualità"…'
          style={{ flex: "1 1 200px", padding: "10px 14px", fontSize: 14, border: "0.5px solid #e2e8f0", borderRadius: 8, background: "#fff", outline: "none", transition: "border-color 0.15s" }}
          onFocus={e => e.target.style.borderColor = "#6366f1"}
          onBlur={e  => e.target.style.borderColor = "#e2e8f0"} />
        <select value={city} onChange={e => setCity(e.target.value)}
          style={{ flex: "0 1 148px", padding: "10px 10px", fontSize: 13, border: "0.5px solid #e2e8f0", borderRadius: 8, background: "#fff", outline: "none", cursor: "pointer" }}>
          {CITIES.map(c => <option key={c}>{c}</option>)}
        </select>
        <button onClick={handleSearch} disabled={loading || !query.trim()}
          style={{ flex: "0 0 auto", padding: "10px 20px", background: loading || !query.trim() ? "#f1f5f9" : "#EEEDFE", color: loading || !query.trim() ? "#94a3b8" : "#3C3489", border: "0.5px solid", borderColor: loading || !query.trim() ? "#e2e8f0" : "#AFA9EC", borderRadius: 8, fontWeight: 500, minWidth: 96, cursor: loading || !query.trim() ? "not-allowed" : "pointer", transition: "all 0.15s" }}>
          {loading ? "Ricerca…" : "Cerca →"}
        </button>
      </div>

      {/* ── Type / Level filters ── */}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "#94a3b8", marginRight: 2 }}>Tipo</span>
        {TYPES.map(t => <Pill key={t} active={type === t} onClick={() => setType(t)}>{t}</Pill>)}
        <span style={{ width: 1, height: 14, background: "#e2e8f0", margin: "0 4px", display: "inline-block" }} />
        <span style={{ fontSize: 11, color: "#94a3b8", marginRight: 2 }}>Livello</span>
        {LEVELS.map(l => <Pill key={l} active={level === l} onClick={() => setLevel(l)}>{l}</Pill>)}
      </div>

      {/* ── Source mode ── */}
      {!using && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: "#94a3b8", minWidth: 44 }}>Fonte</span>
            {SOURCES.map(s => (
              <Pill key={s.id} active={srcMode === s.id} onClick={() => setSrcMode(s.id)}>
                {s.icon} {s.label}
              </Pill>
            ))}
          </div>
          <p style={{ margin: 0, fontSize: 11, color: "#64748b", paddingLeft: 50, lineHeight: 1.6 }}>
            {srcMode === "waterfall" ? (
              <>
                <strong>Indeed → Web:</strong> Indeed.it parte per primo. Se restituisce {INDEED_THRESHOLD}+ offerte la Web Search viene saltata, risparmiando token. Altrimenti la Web Search scatta come fallback automatico. Richiede Indeed connesso su{" "}
                <a href="https://claude.ai/settings/integrations" target="_blank" rel="noopener noreferrer" style={{ color: "#6366f1" }}>claude.ai/settings/integrations</a>.
              </>
            ) : (
              <>
                <strong>Web only:</strong> Nessun MCP necessario — cerca su {IT_BOARDS}. Scelta migliore se Indeed non è disponibile o su Claude desktop.
              </>
            )}
          </p>
        </div>
      )}

      {/* ── Posted filter ── */}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "#94a3b8", marginRight: 2, minWidth: 44 }}>Data</span>
        {POSTED.map(p => <Pill key={p.id} active={posted === p.id} onClick={() => setPosted(p.id)}>{p.label}</Pill>)}
      </div>

      {/* ── Source status badges ── */}
      {searched && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {badgeIds.map(id => (
            <SrcBadge
              key={id} id={id}
              status={srcStatus[id] || "idle"}
              count={srcCount[id]}
              error={srcErrors[id]}
              savedByIndeed={id === "web" && webSavedByIndeed}
            />
          ))}
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <div style={{ textAlign: "center", padding: "44px 0" }}>
          <div style={{ width: 26, height: 26, border: "2.5px solid #e2e8f0", borderTopColor: "#6366f1", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} />
          <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 4px" }}>
            {using
              ? "Ricerca tramite Gemini + Google Search…"
              : srcMode === "waterfall"
                ? "Cerco su Indeed.it — Web Search in standby…"
                : "Cerco sui portali italiani via Web…"}
          </p>
          <p style={{ fontSize: 11, color: "#94a3b8", margin: 0 }}>Di solito 15–30 secondi</p>
        </div>
      )}

      {/* ── Error ── */}
      {!loading && error && !jobs.length && (
        <div style={{ background: "#fef2f2", border: "0.5px solid #fecaca", borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "#b91c1c", lineHeight: 1.65 }}>
          <strong>⚠ {error}</strong>
          {!using && srcMode === "waterfall" && (
            <p style={{ margin: "8px 0 0", fontSize: 12, color: "#7f1d1d" }}>
              Se Indeed mostra ✕, ricollegalo su{" "}
              <a href="https://claude.ai/settings/integrations" target="_blank" rel="noopener noreferrer" style={{ color: "#7c3aed" }}>claude.ai/settings/integrations</a>{" "}
              oppure passa a <strong>Web only</strong>.
            </p>
          )}
        </div>
      )}

      {/* ── Results ── */}
      {!loading && jobs.length > 0 && (
        <div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>
                <strong style={{ color: "#0f172a" }}>{visible.length}</strong> offert{visible.length !== 1 ? "e" : "a"}
                {filter !== "all" ? ` da ${srcLabel(filter)}` : " trovate"}
                {cvText.trim() ? " · CV tips inclusi" : ""}
              </p>
              <button onClick={saved ? undefined : handleSave}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", background: saved ? "#f8fafc" : "#f0fdf4", color: saved ? "#94a3b8" : "#16a34a", border: `0.5px solid ${saved ? "#e2e8f0" : "#86efac"}`, borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: saved ? "default" : "pointer", transition: "all 0.15s" }}>
                {saved ? "✓ Salvato!" : "⬇ Salva lista (.md)"}
              </button>
            </div>
            {srcIds.length > 1 && (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {[
                  { id: "all", label: `Tutti (${jobs.length})` },
                  ...srcIds.map(id => ({ id, label: `${srcLabel(id)} (${jobs.filter(j => j._src === id).length})` })),
                ].map(tab => (
                  <Pill key={tab.id} active={filter === tab.id} onClick={() => setFilter(tab.id)}>{tab.label}</Pill>
                ))}
              </div>
            )}
          </div>
          {visible.map((job, i) => (
            <JobCard key={job._id} job={job} open={!!expanded[i]} onToggle={() => setExpanded(p => ({ ...p, [i]: !p[i] }))} />
          ))}
        </div>
      )}

      {/* ── No results ── */}
      {!loading && !error && searched && jobs.length === 0 && (
        <div style={{ textAlign: "center", padding: "44px 0" }}>
          <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 4px" }}>Nessun risultato trovato</p>
          <p style={{ fontSize: 12, color: "#94a3b8", margin: "0 0 12px" }}>
            Prova un altro ruolo o città.
            {srcMode === "waterfall" && " Oppure passa a Web only se Indeed continua a fallire."}
          </p>
          {srcMode === "waterfall" && (
            <a href="https://claude.ai/settings/integrations" target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 12, color: "#6366f1", padding: "6px 14px", border: "0.5px solid #c7d2fe", borderRadius: 6, textDecoration: "none" }}>
              Apri impostazioni integrazioni →
            </a>
          )}
        </div>
      )}

      {/* ── Hero (pre-search) ── */}
      {!searched && !loading && (
        <div style={{ textAlign: "center", padding: "40px 0 24px" }}>
          <p style={{ fontSize: 32, margin: "0 0 12px" }}>🇮🇹</p>
          <p style={{ fontSize: 16, fontWeight: 500, margin: "0 0 8px" }}>Trova il tuo prossimo lavoro in Italia</p>
          <p style={{ fontSize: 13, color: "#64748b", lineHeight: 1.8, margin: "0 0 6px" }}>
            Indeed.it prima → Web fallback se necessario<br />
            Aggiunge la chiave Gemini per Google Search · filtra per data
          </p>
          <p style={{ fontSize: 11, color: "#94a3b8", margin: "0 0 18px" }}>
            Cerca su InfoJobs, Lavoro.it, Monster.it, LinkedIn Italia e altro
          </p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
            {[
              "Indeed → Web waterfall",
              "CV e chiave salvati localmente",
              "CV ridotto a 2 000 caratteri",
              "Sinonimi italiani automatici",
              "Salva risultati in .md",
            ].map(t => (
              <span key={t} style={{ fontSize: 11, color: "#64748b", background: "#f8fafc", border: "0.5px solid #e2e8f0", borderRadius: 12, padding: "3px 10px" }}>✓ {t}</span>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
