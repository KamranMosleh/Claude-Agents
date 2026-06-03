import { useState, useEffect } from "react";

const CITIES = [
  "Milano","Roma","Torino","Bologna","Firenze",
  "Napoli","Venezia","Genova","Bari","Palermo",
  "Verona","Modena","Parma","Brescia","Bergamo",
  "Remote (IT)",
];
const TYPES  = ["Any","Full-time","Part-time","Remote","Stage","Freelance"];
const LEVELS = ["Any level","Entry","Mid","Senior","Lead"];
const SOURCES = [
  { id: "waterfall", label: "Indeed → Web", icon: "🔀" },
  { id: "web",       label: "Web only",     icon: "🌐" },
];
const POSTED = [
  { id: "any",    label: "Any date"   },
  { id: "week",   label: "This week"  },
  { id: "2weeks", label: "2 weeks"    },
  { id: "month",  label: "30 days"    },
];

const CV_CHAR_LIMIT    = 1500;
const INDEED_THRESHOLD = 6;
const MODEL            = "claude-sonnet-4-20250514";
const MCPS = [{ id: "indeed", label: "Indeed", url: "https://mcp.indeed.com/claude/mcp" }];

// Compact board list — long strings were causing web-search prompt overflow
const IT_BOARDS = "LinkedIn Italia, InfoJobs.it, Monster.it, Lavoro.it, Adzuna.it, Jobrapido, Glassdoor Italia, Subito.it/lavoro, TrovoLavoro.it";

function getCutoffDate(id) {
  const days = { week:7, "2weeks":14, month:30 }[id];
  if (!days) return null;
  return new Date(Date.now() - days * 86400000);
}
function postedInstruction(id) {
  const cutoff = getCutoffDate(id);
  if (!cutoff) return "";
  const today  = new Date().toISOString().slice(0,10);
  const cutStr = cutoff.toISOString().slice(0,10);
  return `⚠ DATE FILTER (mandatory): Today is ${today}. Include ONLY jobs posted on or after ${cutStr}. Exclude every listing older than ${cutStr}. Set postedDate as YYYY-MM-DD.`;
}
function postedLabel(id) {
  return { any:"Any date", week:"This week", "2weeks":"Last 2 weeks", month:"Last 30 days" }[id] || "Any date";
}

// Client-side date guard — removes jobs that are clearly outside the requested window
function withinRange(job, posted) {
  const cutoff = getCutoffDate(posted);
  if (!cutoff || !job.postedDate || job.postedDate === "null") return true;
  const s = job.postedDate.trim();
  let d = null;
  // ISO / partial ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s))                             d = new Date(s);
  // "X days ago" / "X giorni fa"
  else if (/(\d+)\s*(day|giorno|giorni)/i.test(s))              { const [,n] = s.match(/(\d+)\s*(day|giorno|giorni)/i); d = new Date(Date.now() - n*86400000); }
  // "X weeks ago" / "X settimane fa"
  else if (/(\d+)\s*(week|settimana|settimane)/i.test(s))       { const [,n] = s.match(/(\d+)\s*(week|settimana|settimane)/i); d = new Date(Date.now() - n*7*86400000); }
  // "X months ago" / "X mesi fa"
  else if (/(\d+)\s*(month|mese|mesi)/i.test(s))                { const [,n] = s.match(/(\d+)\s*(month|mese|mesi)/i); d = new Date(Date.now() - n*30*86400000); }
  // "yesterday" / "ieri"
  else if (/yesterday|ieri/i.test(s))                            d = new Date(Date.now() - 86400000);
  // "today" / "oggi"
  else if (/today|oggi/i.test(s))                                d = new Date();
  // Fallback: try native parse (handles "15 maggio 2025", "May 15 2025", etc.)
  else { const p = Date.parse(s); if (!isNaN(p)) d = new Date(p); }
  if (!d || isNaN(d)) return true; // unparseable → keep
  return d >= cutoff;
}

// ── JSON extractor ────────────────────────────────────────────────────────────
function extractJobs(text, src) {
  if (!text?.trim()) return [];
  const arrayMatches = text.match(/\[[\s\S]*?\]/g) || [];
  for (const c of arrayMatches) {
    try {
      const a = JSON.parse(c);
      if (Array.isArray(a) && a.length && a[0].title)
        return a.map(j => ({ ...j, _src: src, _id: `${src}-${Math.random()}` }));
    } catch {}
  }
  const objMatches = text.match(/\{[^{}]*"title"[^{}]*\}/g) || [];
  if (objMatches.length) {
    const jobs = [];
    for (const r of objMatches) { try { jobs.push(JSON.parse(r)); } catch {} }
    if (jobs.length) return jobs.map(j => ({ ...j, _src: src, _id: `${src}-${Math.random()}` }));
  }
  try {
    const p = JSON.parse(text.replace(/```(?:json)?|```/g, "").trim());
    if (Array.isArray(p)) return p.map(j => ({ ...j, _src: src, _id: `${src}-${Math.random()}` }));
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

// Separate prompt builders — date instruction is placed FIRST so the model sees it before the task
function buildMcpPrompt(query, city, type, level, cvText, posted) {
  const loc  = city === "Remote (IT)" ? "remote Italy" : `${city}, Italy`;
  const f    = [type !== "Any" && type, level !== "Any level" && level].filter(Boolean).join(" ");
  const cv   = cvText.trim().slice(0, CV_CHAR_LIMIT);
  const cvSec = cv ? `\n\nCandidate CV:\n${cv}\n\nAdd "cvNote" to each job: 2 actionable CV tips for Italian market.` : "";
  const date  = postedInstruction(posted);
  return `${date ? date+"\n\n" : ""}Search for ${f ? f+" " : ""}"${query}" jobs in ${loc}.${cvSec}

Find 5–8 real current listings. Include closely related roles if exact matches are scarce. Also try Italian synonyms (e.g. "controllo qualità", "tecnico qualità", "responsabile qualità").
Return ONLY a valid JSON array [ ... ]. No text before or after. Each object: title, company, location, type, salary (string|null), description (2–3 sentences), requirements (string[]), url (string|null), isRemote (boolean), postedDate (YYYY-MM-DD or null), source${cv ? ", cvNote" : ""}.`;
}

function buildWebPrompt(query, city, type, level, cvText, posted) {
  const loc  = city === "Remote (IT)" ? "remote Italy" : `${city}, Italy`;
  const f    = [type !== "Any" && type, level !== "Any level" && level].filter(Boolean).join(" ");
  const cv   = cvText.trim().slice(0, CV_CHAR_LIMIT);
  const cvSec = cv ? `\n\nCandidate CV:\n${cv}\n\nAdd "cvNote" to each job: 2 actionable CV tips for Italian market.` : "";
  const date  = postedInstruction(posted);
  return `${date ? date+"\n\n" : ""}Search ${IT_BOARDS} for ${f ? f+" " : ""}"${query}" jobs in ${loc}. Also search in Italian (e.g. "controllo qualità", "tecnico qualità", "addetto produzione").${cvSec}

Find 5–8 real current listings. Include related roles if exact matches are scarce.
Return ONLY a valid JSON array [ ... ]. No text before or after. Each object: title, company, location, type, salary (string|null), description (2–3 sentences), requirements (string[]), url (string|null), isRemote (boolean), postedDate (YYYY-MM-DD or null), source${cv ? ", cvNote" : ""}.`;
}

async function callClaude({ prompt, mcpServer, useWebSearch }) {
  const body = {
    model: MODEL,
    max_tokens: 4000,
    system: "You are a job search assistant for the Italian job market. Use your available tools to find jobs. Respond ONLY with a valid JSON array starting with [ and ending with ]. No text before or after.",
    messages: [{ role: "user", content: prompt }],
  };
  if (mcpServer)    body.mcp_servers = [{ type: "url", url: mcpServer.url, name: mcpServer.id }];
  if (useWebSearch) body.tools       = [{ type: "web_search_20250305", name: "web_search" }];

  const ms  = mcpServer ? 50000 : 65000;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), ms);
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(tid);
    if (e.name === "AbortError")
      throw new Error(`${mcpServer ? "Indeed MCP" : "Web search"} timed out. ${mcpServer ? 'Try "Web only" mode.' : "Retry or use a shorter query."}`);
    throw e;
  }
  clearTimeout(tid);
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
  const cv  = cvText.trim().slice(0, CV_CHAR_LIMIT);
  const hasCv = !!cv;
  const date = postedInstruction(posted);
  const prompt = `Search ${IT_BOARDS} for ${f ? f+" " : ""}"${query}" jobs in ${loc}. Also try Italian: "controllo qualità", "tecnico qualità", "addetto produzione".${hasCv ? `\n\nCandidate CV:\n${cv}\n\nAdd "cvNote": 2 CV tips per job.` : ""}

${date}
Return ONLY a raw JSON array []. Each item: title, company, location, type, salary (null ok), description, requirements (array), url (null ok), isRemote (boolean), postedDate (null ok), source${hasCv ? ", cvNote" : ""}.`;

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

function srcLabel(id) { return { indeed:"Indeed", web:"Web Search", gemini:"Gemini" }[id] || id; }
function srcColor(id) { return { indeed:"#003A9B", web:"#534AB7", gemini:"#1D6F42" }[id] || "#888"; }
function srcDot(id)   { return { indeed:"#B5D4F4", web:"#CED3FA", gemini:"#9FE1CB" }[id] || "#ddd"; }

function toMarkdown(jobs, query, city, type, level, mode, filter) {
  const vis = filter === "all" ? jobs : jobs.filter(j => j._src === filter);
  const ds  = new Date().toLocaleDateString("it-IT", { year:"numeric", month:"long", day:"numeric" });
  const f   = [type !== "Any" && type, level !== "Any level" && level].filter(Boolean).join(", ") || "None";
  let md = `# 🇮🇹 Italia Job Search Results\n\n| | |\n|---|---|\n| **Search** | ${query} |\n| **Location** | ${city} |\n| **Filters** | ${f} |\n| **Mode** | ${mode} |\n| **Date** | ${ds} |\n| **Results** | ${vis.length} |\n\n---\n\n`;
  vis.forEach((job, i) => {
    md += `## ${i+1}. ${job.title||"Posizione"}\n\n`;
    if (job.company)                              md += `**Azienda:** ${job.company}  \n`;
    if (job.location)                             md += `**Sede:** ${job.location}  \n`;
    if (job.type && job.type !== "null")          md += `**Tipo:** ${job.type}  \n`;
    if (job.salary && job.salary !== "null")      md += `**Retribuzione:** ${job.salary}  \n`;
    if (job.isRemote)                             md += `**Remote:** Sì  \n`;
    if (job.postedDate && job.postedDate !== "null") md += `**Pubblicato:** ${job.postedDate}  \n`;
    if (job._src)                                 md += `**Fonte:** ${srcLabel(job._src)}  \n`;
    md += `\n`;
    if (job.description) md += `### Descrizione\n\n${job.description}\n\n`;
    const reqs = (job.requirements || []).filter(r => r && r !== "null");
    if (reqs.length) { md += `### Requisiti\n\n`; reqs.forEach(r => md += `- ${r}\n`); md += `\n`; }
    if (job.cvNote) md += `### ✦ CV Tips\n\n${job.cvNote}\n\n`;
    if (job.url && job.url !== "null") md += `### Candidatura\n\n[Candidati →](${job.url})\n\n`;
    md += `---\n\n`;
  });
  return md + `*Italia Job Agent · ${ds}*\n`;
}

function downloadMd(jobs, query, city, type, level, mode, filter) {
  const md   = toMarkdown(jobs, query, city, type, level, mode, filter);
  const blob = new Blob([md], { type: "text/markdown" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const slug = query.toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,"");
  const ct   = city.toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,"");
  const d    = new Date();
  const dt   = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  a.href = url; a.download = `it-jobs-${slug}-${ct}-${dt}.md`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── UI primitives ─────────────────────────────────────────────────────────────
function Pill({ children, active, onClick }) {
  return (
    <span onClick={onClick} style={{
      display:"inline-flex", alignItems:"center", padding:"3px 10px",
      borderRadius:12, fontSize:12, fontWeight:500, border:"0.5px solid",
      borderColor: active ? "#AFA9EC" : "#e2e8f0", cursor:"pointer",
      background: active ? "#EEEDFE" : "transparent",
      color: active ? "#3C3489" : "#64748b", transition:"all 0.12s",
    }}>{children}</span>
  );
}

function Tag({ children, color, bg, border }) {
  return (
    <span style={{
      display:"inline-block", padding:"2px 8px", borderRadius:10,
      fontSize:11, fontWeight:500,
      background: bg||"#f1f5f9", color: color||"#475569",
      border:`0.5px solid ${border||"#e2e8f0"}`,
    }}>{children}</span>
  );
}

function SrcBadge({ id, status, count, error, savedByIndeed }) {
  const done = status==="done", isLoad = status==="loading",
        err  = status==="error", skip  = status==="skipped";
  const c = srcColor(id), d = srcDot(id);
  return (
    <div
      title={err && error ? error : savedByIndeed ? `Web Search skipped — Indeed returned ${INDEED_THRESHOLD}+ results` : undefined}
      style={{
        display:"inline-flex", alignItems:"center", gap:5,
        padding:"4px 10px", borderRadius:12, fontSize:11, fontWeight:500, border:"0.5px solid",
        borderColor: done ? d : isLoad ? d+"80" : "#e2e8f0",
        background:  done ? d+"22" : isLoad ? d+"11" : "#f8fafc",
        color:       done ? c : isLoad ? c+"aa" : "#94a3b8",
        transition:"all 0.25s", cursor:(err||savedByIndeed)?"help":"default",
      }}>
      {srcLabel(id)}
      {isLoad && <span style={{ width:10, height:10, border:`1.5px solid ${c}40`, borderTopColor:c, borderRadius:"50%", animation:"spin 0.8s linear infinite", display:"inline-block" }} />}
      {done  && count != null && <span style={{ opacity:0.8 }}> {count}</span>}
      {err   && <span style={{ color:"#ef4444" }}> ✕</span>}
      {skip  && <span style={{ color:"#94a3b8", fontSize:10 }}>{savedByIndeed ? " saved" : ""}</span>}
    </div>
  );
}

function JobCard({ job, open, onToggle }) {
  const reqs = (job.requirements || []).filter(r => r && r !== "null");
  const sc   = srcColor(job._src);
  return (
    <div
      onClick={onToggle}
      style={{ background:"#fff", border:"0.5px solid #e2e8f0", borderLeft:`3px solid ${sc}`, borderRadius:"0 8px 8px 0", padding:"14px 16px", marginBottom:8, cursor:"pointer", transition:"background 0.12s" }}
      onMouseEnter={e => e.currentTarget.style.background="#f8fafc"}
      onMouseLeave={e => e.currentTarget.style.background="#fff"}>
      <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:6 }}>
        {job._src    && <Tag color={sc} bg={sc+"18"} border={sc+"40"}>{srcLabel(job._src)}</Tag>}
        {job.isRemote && <Tag color="#16a34a" bg="#f0fdf4" border="#bbf7d0">Remote</Tag>}
        {job.type && job.type !== "null" && <Tag>{job.type}</Tag>}
        {job.cvNote  && <Tag color="#92400e" bg="#fffbeb" border="#fde68a">CV tips ✦</Tag>}
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
        <div style={{ flex:1, minWidth:0 }}>
          <p style={{ margin:"0 0 2px", fontSize:15, fontWeight:500, lineHeight:1.3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{job.title||"Posizione"}</p>
          <p style={{ margin:"0 0 6px", fontSize:13, color:"#6366f1", fontWeight:500 }}>{job.company||""}</p>
          <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
            {job.location                                  && <span style={{ fontSize:12, color:"#94a3b8" }}>📍 {job.location}</span>}
            {job.salary && job.salary !== "null"           && <span style={{ fontSize:12, color:"#16a34a", fontWeight:500 }}>💶 {job.salary}</span>}
            {job.postedDate && job.postedDate !== "null"   && <span style={{ fontSize:12, color:"#94a3b8" }}>🗓 {job.postedDate}</span>}
          </div>
        </div>
        <span style={{ color:"#cbd5e1", fontSize:16, flexShrink:0, transition:"transform 0.15s", transform:open?"rotate(180deg)":"none", marginTop:2 }}>⌄</span>
      </div>
      {open && (
        <div onClick={e => e.stopPropagation()} style={{ marginTop:12, paddingTop:12, borderTop:"0.5px solid #f1f5f9" }}>
          {job.description && <p style={{ margin:"0 0 10px", fontSize:13, lineHeight:1.75, color:"#475569" }}>{job.description}</p>}
          {reqs.length > 0 && (
            <div style={{ marginBottom:12 }}>
              <p style={{ margin:"0 0 5px", fontSize:12, fontWeight:500 }}>Requirements</p>
              <ul style={{ margin:0, paddingLeft:18 }}>
                {reqs.map((r,i) => <li key={i} style={{ fontSize:13, color:"#475569", marginBottom:3, lineHeight:1.55 }}>{r}</li>)}
              </ul>
            </div>
          )}
          {job.cvNote && (
            <div style={{ background:"#fffbeb", border:"0.5px solid #fde68a", borderRadius:8, padding:"10px 12px", marginBottom:12 }}>
              <p style={{ margin:"0 0 4px", fontSize:12, fontWeight:500, color:"#92400e" }}>✦ CV tailoring tips</p>
              <p style={{ margin:0, fontSize:13, color:"#78350f", lineHeight:1.7 }}>{job.cvNote}</p>
            </div>
          )}
          {job.url && job.url !== "null" && (
            <a href={job.url} target="_blank" rel="noopener noreferrer"
              style={{ display:"inline-flex", alignItems:"center", gap:4, padding:"6px 14px", background:"#EEEDFE", color:"#3C3489", border:"0.5px solid #AFA9EC", borderRadius:6, fontSize:12, fontWeight:500, textDecoration:"none" }}>
              Candidati ora →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function ItaliaJobAgent() {
  const [key,    setKey]    = useState(() => { try { return localStorage.getItem("ita_gemini_key")||""; } catch { return ""; } });
  const [cvText, setCvText] = useState(() => { try { return localStorage.getItem("ita_cv_text")||"";    } catch { return ""; } });

  const [showKey,  setShowKey]  = useState(false);
  const [showCV,   setShowCV]   = useState(false);
  const [query,    setQuery]    = useState("");
  const [city,     setCity]     = useState("Milano");
  const [type,     setType]     = useState("Any");
  const [level,    setLevel]    = useState("Any level");
  const [jobs,     setJobs]     = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [searched, setSearched] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [srcStatus,setSrcStatus]= useState({});
  const [srcCount, setSrcCount] = useState({});
  const [srcErrors,setSrcErrors]= useState({});
  const [wSaved,   setWSaved]   = useState(false);
  const [filter,   setFilter]   = useState("all");
  const [saved,    setSaved]    = useState(false);
  const [srcMode,  setSrcMode]  = useState("waterfall");
  const [posted,   setPosted]   = useState("any");

  useEffect(() => {
    const s = document.createElement("style");
    s.textContent = `@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@keyframes spin{to{transform:rotate(360deg)}}`;
    document.head.appendChild(s); return () => document.head.removeChild(s);
  }, []);

  useEffect(() => { try { localStorage.setItem("ita_gemini_key", key);   } catch {} }, [key]);
  useEffect(() => { try { localStorage.setItem("ita_cv_text",   cvText); } catch {} }, [cvText]);

  const using       = !!key.trim();
  const cvWords     = cvText.trim().split(/\s+/).filter(Boolean).length;
  const cvTruncated = cvText.trim().length > CV_CHAR_LIMIT;

  const setS = (id, st)  => setSrcStatus(p => ({ ...p, [id]: st }));
  const setC = (id, n)   => setSrcCount(p  => ({ ...p, [id]: n }));
  const setE = (id, msg) => setSrcErrors(p => ({ ...p, [id]: msg }));

  const handleSearch = async () => {
    if (!query.trim() || loading) return;
    setLoading(true); setJobs([]); setError(""); setSearched(true);
    setExpanded({}); setFilter("all"); setSaved(false); setWSaved(false);
    setSrcStatus({}); setSrcCount({}); setSrcErrors({});

    if (using) {
      setS("gemini","loading");
      try {
        const j = await fetchGemini(key, query, city, type, level, cvText, posted);
        const jf = j.filter(x => withinRange(x, posted));
        setJobs(jf); setS("gemini","done"); setC("gemini", jf.length);
      } catch (e) { setError(e.message); setS("gemini","error"); setE("gemini", e.message); }

    } else {
      let indeedJobs = [], webJobs = [];

      if (srcMode === "waterfall") {
        setS("indeed","loading"); setS("web","skipped");
        try {
          const txt = await callClaude({ prompt: buildMcpPrompt(query, city, type, level, cvText, posted), mcpServer: MCPS[0] });
          indeedJobs = extractJobs(txt, "indeed");
          setS("indeed","done"); setC("indeed", indeedJobs.length);
        } catch (err) {
          setS("indeed","error"); setE("indeed", err.message||"Connection failed");
        }

        if (indeedJobs.length >= INDEED_THRESHOLD) {
          setS("web","skipped"); setWSaved(true);
        } else {
          setS("web","loading");
          try {
            const txt = await callClaude({ prompt: buildWebPrompt(query, city, type, level, cvText, posted), useWebSearch: true });
            webJobs = extractJobs(txt, "web");
            setS("web","done"); setC("web", webJobs.length);
          } catch (err) {
            setS("web","error"); setE("web", err.message||"Web search failed");
          }
        }

      } else {
        setS("web","loading");
        try {
          const txt = await callClaude({ prompt: buildWebPrompt(query, city, type, level, cvText, posted), useWebSearch: true });
          webJobs = extractJobs(txt, "web");
          setS("web","done"); setC("web", webJobs.length);
        } catch (err) {
          setS("web","error"); setE("web", err.message||"Web search failed");
        }
      }

      const merged   = dedupe([...indeedJobs, ...webJobs]);
      const filtered = merged.filter(j => withinRange(j, posted));
      setJobs(filtered);
      if (!filtered.length) {
        const dateHint = posted !== "any" && merged.length > 0
          ? ` ${merged.length} result(s) found but all were outside the selected date range — try "Any date".`
          : "";
        const hint = srcMode === "waterfall"
          ? "If Indeed shows ✕, re-connect it at claude.ai/settings/integrations, or switch to Web only."
          : "Try a different keyword or city.";
        setError("No results found. " + hint + dateHint);
      }
    }
    setLoading(false);
  };

  const handleSave = () => {
    const modeLabel = using
      ? "Gemini + Google Search"
      : `Claude · ${SOURCES.find(s => s.id === srcMode)?.label||srcMode} · ${postedLabel(posted)}`;
    downloadMd(jobs, query, city, type, level, modeLabel, filter);
    setSaved(true); setTimeout(() => setSaved(false), 3000);
  };

  const visible  = filter === "all" ? jobs : jobs.filter(j => j._src === filter);
  const srcIds   = [...new Set(jobs.map(j => j._src))];
  const badgeIds = using ? ["gemini"] : srcMode === "waterfall" ? ["indeed","web"] : ["web"];

  return (
    <div style={{ fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", maxWidth:700, margin:"0 auto", padding:"24px 16px", color:"#0f172a" }}>

      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:22 }}>🇮🇹</span>
          <div>
            <div style={{ fontSize:16, fontWeight:500 }}>Italia Job Agent</div>
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:1 }}>
              {using ? "Gemini + Google Search" : "Claude · Indeed → Web waterfall"}
            </div>
          </div>
          {using
            ? <Tag color="#16a34a" bg="#f0fdf4" border="#bbf7d0">Gemini</Tag>
            : <Tag color="#6366f1" bg="#eff6ff" border="#c7d2fe">Claude mode</Tag>}
        </div>
        <div style={{ display:"flex", gap:6 }}>
          <Pill active={showCV} onClick={() => { setShowCV(v => !v); setShowKey(false); }}>
            📄 {cvText.trim() ? `CV (${cvWords}w)` : "Add CV"}
          </Pill>
          <Pill active={showKey} onClick={() => { setShowKey(v => !v); setShowCV(false); }}>
            ⚙ API key
          </Pill>
        </div>
      </div>

      {/* API key panel */}
      {showKey && (
        <div style={{ background:"#f8fafc", border:"0.5px solid #e2e8f0", borderRadius:10, padding:16, marginBottom:12 }}>
          <p style={{ margin:"0 0 8px", fontSize:13, fontWeight:500 }}>Gemini API key</p>
          <div style={{ display:"flex", gap:8, marginBottom:10 }}>
            <input type="password" value={key} onChange={e => setKey(e.target.value)}
              placeholder="AIza… (leave empty for Claude + Indeed/Web mode)"
              style={{ flex:1, padding:"8px 12px", fontSize:13, border:"0.5px solid #e2e8f0", borderRadius:6, background:"#fff", fontFamily:"monospace", outline:"none" }} />
            {key && <button onClick={() => setKey("")} style={{ padding:"8px 12px", border:"0.5px solid #e2e8f0", borderRadius:6, background:"#fff", fontSize:12 }}>Clear</button>}
          </div>
          <p style={{ margin:0, fontSize:11, color:"#94a3b8" }}>
            Get your key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color:"#6366f1" }}>aistudio.google.com/apikey</a> · Auto-saved in browser.
          </p>
        </div>
      )}

      {/* CV panel */}
      {showCV && (
        <div style={{ background:"#f8fafc", border:"0.5px solid #e2e8f0", borderRadius:10, padding:16, marginBottom:12 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <p style={{ margin:0, fontSize:13, fontWeight:500 }}>Your CV — key skills & experience</p>
            {cvText && <button onClick={() => setCvText("")} style={{ padding:"3px 8px", fontSize:11, border:"0.5px solid #e2e8f0", borderRadius:4, background:"#fff" }}>Clear</button>}
          </div>
          <textarea value={cvText} onChange={e => setCvText(e.target.value)} rows={7}
            placeholder={"Paste highlights:\n• Job titles & companies\n• Technical skills and tools\n• Years of experience\n• Education / certifications\n• Work preferences\n\nThe agent will add personalised tips for each listing."}
            style={{ width:"100%", boxSizing:"border-box", padding:"10px 12px", fontSize:13, lineHeight:1.7, border:"0.5px solid #e2e8f0", borderRadius:6, background:"#fff", resize:"vertical", fontFamily:"inherit", outline:"none" }}
            onFocus={e => e.target.style.borderColor="#6366f1"}
            onBlur={e  => e.target.style.borderColor="#e2e8f0"} />
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
            <span style={{ fontSize:11, color:"#94a3b8" }}>
              ≈{Math.round(Math.min(cvText.trim().length, CV_CHAR_LIMIT)/4)} tokens · auto-saved
              {cvTruncated && <span style={{ color:"#f59e0b", marginLeft:4 }}>· trimmed to {CV_CHAR_LIMIT} chars</span>}
            </span>
            {cvText.trim() && <span style={{ fontSize:11, color:"#16a34a" }}>✓ CV tips on each result</span>}
          </div>
        </div>
      )}

      {/* Search bar */}
      <div style={{ display:"flex", gap:8, marginBottom:10, flexWrap:"wrap" }}>
        <input
          value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSearch()}
          placeholder='Role or skill  e.g. "Tecnico Qualità", "BIM Engineer", "Controllo Qualità"…'
          style={{ flex:"1 1 200px", padding:"10px 14px", fontSize:14, border:"0.5px solid #e2e8f0", borderRadius:8, background:"#fff", outline:"none", transition:"border-color 0.15s" }}
          onFocus={e => e.target.style.borderColor="#6366f1"}
          onBlur={e  => e.target.style.borderColor="#e2e8f0"} />
        <select value={city} onChange={e => setCity(e.target.value)}
          style={{ flex:"0 1 148px", padding:"10px 10px", fontSize:13, border:"0.5px solid #e2e8f0", borderRadius:8, background:"#fff", outline:"none", cursor:"pointer" }}>
          {CITIES.map(c => <option key={c}>{c}</option>)}
        </select>
        <button onClick={handleSearch} disabled={loading || !query.trim()}
          style={{ flex:"0 0 auto", padding:"10px 20px", background: loading||!query.trim() ? "#f1f5f9":"#EEEDFE", color: loading||!query.trim() ? "#94a3b8":"#3C3489", border:"0.5px solid", borderColor: loading||!query.trim() ? "#e2e8f0":"#AFA9EC", borderRadius:8, fontWeight:500, minWidth:96, cursor: loading||!query.trim() ? "not-allowed":"pointer", transition:"all 0.15s" }}>
          {loading ? "Searching…" : "Search →"}
        </button>
      </div>

      {/* Type / Level */}
      <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:12, alignItems:"center" }}>
        <span style={{ fontSize:11, color:"#94a3b8", marginRight:2 }}>Type</span>
        {TYPES.map(t => <Pill key={t} active={type===t} onClick={() => setType(t)}>{t}</Pill>)}
        <span style={{ width:1, height:14, background:"#e2e8f0", margin:"0 4px", display:"inline-block" }} />
        <span style={{ fontSize:11, color:"#94a3b8", marginRight:2 }}>Level</span>
        {LEVELS.map(l => <Pill key={l} active={level===l} onClick={() => setLevel(l)}>{l}</Pill>)}
      </div>

      {/* Source mode */}
      {!using && (
        <div style={{ marginBottom:12 }}>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center", marginBottom:6 }}>
            <span style={{ fontSize:11, color:"#94a3b8", minWidth:44 }}>Source</span>
            {SOURCES.map(s => <Pill key={s.id} active={srcMode===s.id} onClick={() => setSrcMode(s.id)}>{s.icon} {s.label}</Pill>)}
          </div>
          <p style={{ margin:0, fontSize:11, color:"#64748b", paddingLeft:50, lineHeight:1.6 }}>
            {srcMode === "waterfall" ? (
              <><strong>Indeed → Web:</strong> Indeed.it runs first. If it returns {INDEED_THRESHOLD}+ jobs, Web Search is skipped. Otherwise Web Search fires as fallback. Requires Indeed connected at <a href="https://claude.ai/settings/integrations" target="_blank" rel="noopener noreferrer" style={{ color:"#6366f1" }}>claude.ai/settings/integrations</a>.</>
            ) : (
              <><strong>Web only:</strong> No MCP needed — searches {IT_BOARDS}. Best when Indeed MCP is unavailable or on Claude desktop.</>
            )}
          </p>
        </div>
      )}

      {/* Posted filter */}
      <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:16, alignItems:"center" }}>
        <span style={{ fontSize:11, color:"#94a3b8", marginRight:2, minWidth:44 }}>Posted</span>
        {POSTED.map(p => <Pill key={p.id} active={posted===p.id} onClick={() => setPosted(p.id)}>{p.label}</Pill>)}
      </div>

      {/* Status badges */}
      {searched && (
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:12 }}>
          {badgeIds.map(id => (
            <SrcBadge key={id} id={id} status={srcStatus[id]||"idle"} count={srcCount[id]} error={srcErrors[id]} savedByIndeed={id==="web" && wSaved} />
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ textAlign:"center", padding:"44px 0" }}>
          <div style={{ width:26, height:26, border:"2.5px solid #e2e8f0", borderTopColor:"#6366f1", borderRadius:"50%", animation:"spin 0.8s linear infinite", margin:"0 auto 12px" }} />
          <p style={{ fontSize:13, color:"#64748b", margin:"0 0 4px" }}>
            {using ? "Searching via Gemini + Google Search…"
              : srcMode==="waterfall" ? "Searching Indeed.it — Web Search on standby…"
              : "Searching Italian job boards via Web…"}
          </p>
          <p style={{ fontSize:11, color:"#94a3b8", margin:0 }}>Usually 15–45 seconds</p>
        </div>
      )}

      {/* Error */}
      {!loading && error && !jobs.length && (
        <div style={{ background:"#fef2f2", border:"0.5px solid #fecaca", borderRadius:8, padding:"12px 16px", fontSize:13, color:"#b91c1c", lineHeight:1.65 }}>
          <strong>⚠ {error}</strong>
          {!using && srcMode==="waterfall" && (
            <p style={{ margin:"8px 0 0", fontSize:12, color:"#7f1d1d" }}>
              Re-connect Indeed at <a href="https://claude.ai/settings/integrations" target="_blank" rel="noopener noreferrer" style={{ color:"#7c3aed" }}>claude.ai/settings/integrations</a> or switch to <strong>Web only</strong>.
            </p>
          )}
        </div>
      )}

      {/* Results */}
      {!loading && jobs.length > 0 && (
        <div>
          <div style={{ marginBottom:10 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <p style={{ margin:0, fontSize:13, color:"#64748b" }}>
                <strong style={{ color:"#0f172a" }}>{visible.length}</strong> position{visible.length!==1?"s":""}{filter!=="all"?` from ${srcLabel(filter)}`:" found"}{cvText.trim()?" · CV tips included":""}
              </p>
              <button onClick={saved ? undefined : handleSave}
                style={{ display:"inline-flex", alignItems:"center", gap:6, padding:"6px 12px", background: saved?"#f8fafc":"#f0fdf4", color: saved?"#94a3b8":"#16a34a", border:`0.5px solid ${saved?"#e2e8f0":"#86efac"}`, borderRadius:8, fontSize:12, fontWeight:500, cursor: saved?"default":"pointer", transition:"all 0.15s" }}>
                {saved ? "✓ Saved!" : "⬇ Save list (.md)"}
              </button>
            </div>
            {srcIds.length > 1 && (
              <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                {[{ id:"all", label:`All (${jobs.length})` }, ...srcIds.map(id => ({ id, label:`${srcLabel(id)} (${jobs.filter(j=>j._src===id).length})` }))].map(tab => (
                  <Pill key={tab.id} active={filter===tab.id} onClick={() => setFilter(tab.id)}>{tab.label}</Pill>
                ))}
              </div>
            )}
          </div>
          {visible.map((job,i) => (
            <JobCard key={job._id} job={job} open={!!expanded[i]} onToggle={() => setExpanded(p => ({ ...p, [i]:!p[i] }))} />
          ))}
        </div>
      )}

      {/* No results */}
      {!loading && !error && searched && jobs.length===0 && (
        <div style={{ textAlign:"center", padding:"44px 0" }}>
          <p style={{ fontSize:13, color:"#64748b", margin:"0 0 4px" }}>No results found</p>
          <p style={{ fontSize:12, color:"#94a3b8", margin:"0 0 12px" }}>
            Try a different keyword or city.{srcMode==="waterfall" && " Or switch to Web only if Indeed keeps failing."}
          </p>
          {srcMode==="waterfall" && (
            <a href="https://claude.ai/settings/integrations" target="_blank" rel="noopener noreferrer"
              style={{ fontSize:12, color:"#6366f1", padding:"6px 14px", border:"0.5px solid #c7d2fe", borderRadius:6, textDecoration:"none" }}>
              Open integrations settings →
            </a>
          )}
        </div>
      )}

      {/* Hero */}
      {!searched && !loading && (
        <div style={{ textAlign:"center", padding:"40px 0 24px" }}>
          <p style={{ fontSize:32, margin:"0 0 12px" }}>🇮🇹</p>
          <p style={{ fontSize:16, fontWeight:500, margin:"0 0 8px" }}>Find your next role in Italy</p>
          <p style={{ fontSize:13, color:"#64748b", lineHeight:1.8, margin:"0 0 6px" }}>
            Indeed.it first → Web fallback if needed<br />
            Add a Gemini key for Google Search · filter by recency
          </p>
          <p style={{ fontSize:11, color:"#94a3b8", margin:"0 0 18px" }}>
            Covers InfoJobs, Monster.it, LinkedIn Italia, Adzuna, Glassdoor and more
          </p>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", justifyContent:"center" }}>
            {["Indeed → Web waterfall","CV & key auto-saved","Italian synonym search","Save results as .md"].map(t => (
              <span key={t} style={{ fontSize:11, color:"#64748b", background:"#f8fafc", border:"0.5px solid #e2e8f0", borderRadius:12, padding:"3px 10px" }}>✓ {t}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
