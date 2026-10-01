import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { ref, onValue } from "firebase/database";
import { database } from "../../../firebase/config"; // ← same config PassIssue / RequestManage use — adjust the relative path if this component sits at a different depth
import "./PassList.css";

/* =====================================================================
   PASS RECORDS — every pass in the school, in one live list
   ---------------------------------------------------------------------
   • FIVE Firebase collections are merged into one timeline:
       – studentPass          → student passes issued directly at the gate
       – studentRequest       → pending day-pass requests
       – daypass              → approved / printed day passes
       – rejectedStudentPass  → rejected requests (permanent records)
       – cancelledStudentPass → cancelled requests (permanent records)
     Records are de-duplicated by _id — a request keeps its _id when it
     moves between collections, so nothing ever shows up twice.
   • READ-ONLY — this section never writes to Firebase. It is a pure
     live view, completely safe next to the gate / approval desks.
   • Every row is compact on purpose: student name, class, ID, pass
     type, live status, slip no, reason and the moment the pass last
     changed. Click a row (or press Enter on it) for the full record.
   • FILTERS — all live, the list re-filters the instant data OR a
     filter changes:
       [All]          → one click resets every filter
       Type dropdown   → Student pass / Day pass
       Status dropdown → Pending / Approved / Issued / Returned /
                         Rejected / Cancelled
       Date dropdown   → All time / Today / Yesterday / Last 7 days /
                         Last 30 days / Custom range (from–to pickers)
   • SMART SEARCH — searches EVERY field at once: name, student ID,
     class, RFID, reason, slip number, who authorized / approved /
     rejected, going-with, status words, type words, even the formatted
     date text. Field-scoped tokens are supported too:
       name:john   class:10a   id:dp23   status:pending
       type:day    slip:dp-20250611-001   reason:medical   who:principal
     "status:pend", "status:out", "type:stud" also work — smart
     aliases resolve unambiguous prefixes. Spaces and dashes are
     ignored while matching ("10 A" matches "10a").
   • SORT dropdown: newest / oldest activity, name A–Z, expected
     return, status grouping. Newest activity sits on top by default.
   • DETAIL MODAL — the full record + a live lifecycle timeline
     (Raised → Approved → Issued → Returned / Rejected / Cancelled).
     Closes via ✕ button, Close button, ESC or backdrop click.
     The open record refreshes live while the modal is open.
   • Stats strip is clickable — each card applies its filter instantly.
   • CSV export of exactly what is on screen (respects filters+search).
   • Skeleton loading, empty states, toasts, "show more" paging.
   ===================================================================== */

/* ---------------- constants ---------------- */
const DB_STUDENTPASS_PATH = "studentPass";          // student passes issued directly at the gate desk
const DB_REQUEST_PATH     = "studentRequest";       // pending day-pass requests
const DB_APPROVED_PATH    = "daypass";              // approved / printed day passes
const DB_REJECTED_PATH    = "rejectedStudentPass";  // rejected requests — permanent records
const DB_CANCELLED_PATH   = "cancelledStudentPass"; // cancelled requests — permanent records

const PAGE_SIZE   = 40;      // rows rendered at once — "Show more" appends another page
const DAY_MS      = 86400000;
const TIME_FIELDS = ["createdAt", "requestedAt", "approvedAt", "issuedAt", "printedAt", "returnedAt", "rejectedAt", "cancelledAt"];

/* ---------------- status / type metadata ---------------- */
const STATUS_ORDER = ["REQUESTED", "APPROVED", "ISSUED", "RETURNED", "REJECTED", "CANCELLED"];

const STATUS_META = {
  REQUESTED: { label: "Pending",   verb: "Requested", icon: "⏳", tone: "amber" },
  APPROVED:  { label: "Approved",  verb: "Approved",  icon: "✓",  tone: "blue"  },
  ISSUED:    { label: "Issued",    verb: "Issued",    icon: "🎫", tone: "green" },
  RETURNED:  { label: "Returned",  verb: "Returned",  icon: "↩",  tone: "slate" },
  REJECTED:  { label: "Rejected",  verb: "Rejected",  icon: "✕",  tone: "red"   },
  CANCELLED: { label: "Cancelled", verb: "Cancelled", icon: "⊘",  tone: "gray"  },
};

const KIND_META = {
  STUDENT_PASS: { label: "Student Pass" },
  DAY_PASS:     { label: "Day Pass" },
};

/* fallbacks when a record's kind / status field is missing or old */
const DEFAULT_KIND = {
  [DB_STUDENTPASS_PATH]: "STUDENT_PASS",   // everything in studentPass came from the gate desk's Issue Pass button
  [DB_REQUEST_PATH]:     "DAY_PASS",
  [DB_APPROVED_PATH]:    "DAY_PASS",
  [DB_REJECTED_PATH]:    "DAY_PASS",
  [DB_CANCELLED_PATH]:   "DAY_PASS",
};
const DEFAULT_STATUS = {
  [DB_STUDENTPASS_PATH]: "ISSUED",
  [DB_REQUEST_PATH]:     "REQUESTED",
  [DB_APPROVED_PATH]:    "APPROVED",
  [DB_REJECTED_PATH]:    "REJECTED",
  [DB_CANCELLED_PATH]:   "CANCELLED",
};

const SOURCE_LABELS = {
  [DB_STUDENTPASS_PATH]: "studentPass · gate desk",
  [DB_REQUEST_PATH]:     "studentRequest · pending",
  [DB_APPROVED_PATH]:    "daypass · approved",
  [DB_REJECTED_PATH]:    "rejectedStudentPass · records",
  [DB_CANCELLED_PATH]:   "cancelledStudentPass · records",
};

const SORT_OPTIONS = [
  { id: "newest", label: "Newest activity" },
  { id: "oldest", label: "Oldest activity" },
  { id: "name",   label: "Student name (A–Z)" },
  { id: "return", label: "Expected return" },
  { id: "status", label: "Status" },
];

const DATE_MODES = [
  { id: "ALL",       label: "All time" },
  { id: "TODAY",     label: "Today" },
  { id: "YESTERDAY", label: "Yesterday" },
  { id: "WEEK",      label: "Last 7 days" },
  { id: "MONTH",     label: "Last 30 days" },
  { id: "CUSTOM",    label: "Custom range…" },
];

/* ---------------- smart-search support ---------------- */
const FIELD_TOKENS = new Set(["name", "class", "id", "rfid", "reason", "slip", "status", "type", "kind", "who", "going"]);

const STATUS_ALIASES = {
  pending: "REQUESTED", requested: "REQUESTED", waiting: "REQUESTED",
  approved: "APPROVED",
  issued: "ISSUED", out: "ISSUED", printed: "ISSUED",
  returned: "RETURNED", back: "RETURNED", in: "RETURNED",
  rejected: "REJECTED",
  cancelled: "CANCELLED", canceled: "CANCELLED",
};
const TYPE_ALIASES = { student: "STUDENT_PASS", day: "DAY_PASS" };

/* ---------------- small helpers ---------------- */
const normalizeRfid = (v) => String(v || "").trim().toUpperCase().replace(/[\s:\-]/g, "");

const getInitials = (name) =>
  String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join("") || "?";

/* spaces / dashes ignored while matching — "10 A" matches "10a" */
const compact = (s) => String(s || "").toLowerCase().replace(/[\s\-_]+/g, "");

/* "2025-06-11" and "2025-06-11T14:30" → local Date (no UTC surprises) */
function parseLocal(v) {
  const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
}

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function tsMs(v) { if (!v) return 0; const t = new Date(v).getTime(); return isNaN(t) ? 0 : t; }

/* short "04:35 pm · 12 Jun" for ISO timestamps */
function fmtDateTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d)) return "—";
  return `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${d.toLocaleDateString([], { day: "2-digit", month: "short" })}`;
}

/* full "12 Jun 2025, 04:35 pm" for ISO timestamps */
function fmtStamp(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/* expectedReturn is a LOCAL "YYYY-MM-DDTHH:mm" string → parseLocal, never new Date() */
function fmtExpected(v) {
  const d = parseLocal(v);
  if (!d) return "—";
  return /T\d{2}:\d{2}/.test(String(v))
    ? `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${d.toLocaleDateString([], { day: "2-digit", month: "short" })}`
    : d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}

function isTodayDate(v) {
  const d = parseLocal(v);
  if (!d) return false;
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
function isOverdueDate(v) {
  const d = parseLocal(v);
  if (!d) return false;
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  return d < t0;
}

function timeAgo(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d)) return "—";
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr${h > 1 ? "s" : ""} ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString([], { day: "2-digit", month: "short" });
}

/* "Going with" — Parent needs no name · Guardian / Staff show their name */
function fmtGoingWith(p) {
  if (!p) return "—";
  const who = String(p.goingWith || "").trim();
  if (!who) return "—";
  const name = String(p.goingWithName || "").trim();
  return name ? `${who} · ${name}` : who;
}

/* still out on an issued pass beyond the expected return date */
const isRowOverdue = (p) => p.status === "ISSUED" && isOverdueDate(p.expectedReturn);

/* deterministic avatar colour per student name */
const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#6366f1,#8b5cf6)",
  "linear-gradient(135deg,#0ea5e9,#2563eb)",
  "linear-gradient(135deg,#10b981,#059669)",
  "linear-gradient(135deg,#f59e0b,#ea580c)",
  "linear-gradient(135deg,#ec4899,#db2777)",
  "linear-gradient(135deg,#14b8a6,#0d9488)",
  "linear-gradient(135deg,#f43f5e,#be123c)",
];
const avatarGradient = (name) =>
  AVATAR_GRADIENTS[Math.abs(String(name || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % AVATAR_GRADIENTS.length];

/* ---------------- pass normalization ---------------- */
function normalizePass(raw, key, source) {
  const p = raw && typeof raw === "object" ? raw : {};
  const kindRaw = String(p.kind || "").toUpperCase();
  const kind = source === DB_STUDENTPASS_PATH
    ? "STUDENT_PASS"                                     // old records stored before the kind fix also display correctly
    : (kindRaw === "STUDENT_PASS" ? "STUDENT_PASS" : "DAY_PASS");
  const statusRaw = String(p.status || "").toUpperCase();
  return {
    ...p,
    _id: String(p._id || key),
    source,
    kind,
    status: STATUS_ORDER.indexOf(statusRaw) !== -1 ? statusRaw : DEFAULT_STATUS[source],
    studentKey: String(p.studentKey || ""),
    studentId: String(p.studentId || "—").trim(),
    rfid: normalizeRfid(p.rfid),
    name: String(p.name || "Unknown student").trim(),
    className: String(p.className || "—").trim(),
    reason: String(p.reason || "—"),
    expectedReturn: p.expectedReturn || null,
    slipNo: p.slipNo ? String(p.slipNo) : null,
    goingWith: p.goingWith ? String(p.goingWith) : "",
    goingWithName: p.goingWithName ? String(p.goingWithName) : "",
    authorizedBy: p.authorizedBy ? String(p.authorizedBy) : "",
    approvedBy: p.approvedBy ? String(p.approvedBy) : "",
    rejectedBy: p.rejectedBy ? String(p.rejectedBy) : "",
    rejectionReason: p.rejectionReason ? String(p.rejectionReason) : "",
    createdAt: p.createdAt || null,
    requestedAt: p.requestedAt || null,
    approvedAt: p.approvedAt || null,
    issuedAt: p.issuedAt || null,
    printedAt: p.printedAt || null,
    returnedAt: p.returnedAt || null,
    rejectedAt: p.rejectedAt || null,
    cancelledAt: p.cancelledAt || null,
  };
}

/* a collection node ({ "<_id>": { …pass } }) → clean array */
function sanitizeNode(val, source) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return [];
  return Object.entries(val)
    .map(([key, raw]) => normalizePass(raw, key, source))
    .filter((p) => p && p._id);
}

/* the LATEST moment anything happened on this record — "recent on top" */
function activityTime(p) {
  return TIME_FIELDS.reduce((max, f) => Math.max(max, tsMs(p[f])), 0);
}

/* the moment matching the CURRENT status — the time shown & date-filtered */
function statusTimeValue(p) {
  switch (p.status) {
    case "RETURNED":  return p.returnedAt  || p.printedAt || p.issuedAt  || p.createdAt  || null;
    case "REJECTED": return p.rejectedAt   || p.requestedAt || p.createdAt || null;
    case "CANCELLED":return p.cancelledAt  || p.requestedAt || p.createdAt || null;
    case "ISSUED":   return p.printedAt    || p.issuedAt   || p.createdAt  || null;
    case "APPROVED": return p.approvedAt   || p.createdAt  || null;
    default:         return p.requestedAt  || p.createdAt  || null;   // REQUESTED
  }
}
function statusTimeMs(p) { return tsMs(statusTimeValue(p)); }

/* ---------------- smart search ---------------- */
function parseQuery(q) {
  return String(q || "").trim().toLowerCase()
    .split(/\s+/).filter(Boolean)
    .map((tok) => {
      const m = tok.match(/^([a-z]+):(.*)$/);
      if (m && FIELD_TOKENS.has(m[1])) return { field: m[1] === "kind" ? "type" : m[1], value: m[2] };
      return { field: null, value: tok };
    });
}

/* "pend" → REQUESTED · "out" → ISSUED · only unambiguous prefixes resolve */
function resolveAlias(v, map) {
  if (!v) return null;
  const keys = Object.keys(map);
  const exact = keys.find((k) => k === v);
  if (exact) return map[exact];
  const hits = keys.filter((k) => k.startsWith(v));
  return hits.length === 1 ? map[hits[0]] : null;
}

function fieldTarget(p, field) {
  switch (field) {
    case "name":   return p.name;
    case "class":  return p.className;
    case "id":     return p.studentId;
    case "rfid":   return p.rfid;
    case "reason": return p.reason;
    case "slip":   return p.slipNo || "";
    case "who":    return [p.authorizedBy, p.approvedBy, p.rejectedBy].filter(Boolean).join(" ");
    case "going":  return fmtGoingWith(p);
    default:       return "";
  }
}

/* every scrap of text a plain word should be able to hit */
function searchHaystack(p) {
  const bits = [
    p.name, p.studentId, p.className, p.rfid, p.reason, p.slipNo,
    (STATUS_META[p.status] || {}).label, p.status,
    (KIND_META[p.kind] || {}).label, p.kind,
    p.authorizedBy, p.approvedBy, p.rejectedBy,
    fmtGoingWith(p),
    compact(p.className), compact(p.studentId), compact(p.slipNo),   // "10a" finds "10 A", "dp2025…" finds "DP-2025…"
  ];
  if (p.status === "ISSUED")    bits.push("out");
  if (p.status === "RETURNED")  bits.push("back", "in");
  if (p.status === "REQUESTED") bits.push("waiting");
  const t = statusTimeValue(p);
  if (t) {
    const d = new Date(t);
    if (!isNaN(d)) {
      bits.push(
        d.toLocaleDateString(),
        d.toLocaleDateString([], { day: "2-digit", month: "short" }),   // "12 Jun"
        d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      );
    }
  }
  return bits.filter(Boolean).join(" ").toLowerCase();
}

function tokenMatches(p, tok) {
  if (tok.field && !tok.value) return true;                 // "class:" with nothing after → ignored
  if (tok.field === "status") { const s = resolveAlias(tok.value, STATUS_ALIASES); return !!s && p.status === s; }
  if (tok.field === "type")   { const k = resolveAlias(tok.value, TYPE_ALIASES);   return !!k && p.kind === k; }
  if (tok.field) {
    const target = String(fieldTarget(p, tok.field) || "").toLowerCase();
    const cv = compact(tok.value);
    return target.includes(tok.value) || (cv !== "" && compact(target).includes(cv));
  }
  return searchHaystack(p).includes(tok.value);
}
const matchesQuery = (p, tokens) => tokens.every((t) => tokenMatches(p, t));

/* ---------------- date range filter ---------------- */
function dateRange(mode, from, to) {
  if (mode === "ALL") return null;
  const t0 = startOfToday().getTime();
  if (mode === "TODAY")     return { from: t0,             to: t0 + DAY_MS - 1 };
  if (mode === "YESTERDAY") return { from: t0 - DAY_MS,    to: t0 - 1 };
  if (mode === "WEEK")      return { from: t0 - 6 * DAY_MS, to: Infinity };
  if (mode === "MONTH")     return { from: t0 - 29 * DAY_MS, to: Infinity };
  if (mode === "CUSTOM") {
    let f = from ? parseLocal(from) : null;
    let t = to ? parseLocal(to) : null;
    if (f && t && f.getTime() > t.getTime()) [f, t] = [t, f];   // tolerate a reversed range
    return { from: f ? f.getTime() : 0, to: t ? t.getTime() + DAY_MS - 1 : Infinity };
  }
  return null;
}

/* ---------------- modal lifecycle timeline ---------------- */
function timelineItems(p) {
  const items = [{
    key: "raised",
    icon: "📝",
    label: p.kind === "STUDENT_PASS" ? "Student pass created at the gate desk" : "Day-pass request raised",
    time: p.requestedAt || p.createdAt,
    note: p.kind === "STUDENT_PASS" ? "Issued directly — no approval needed" : "Sent to the Principal for approval",
  }];
  if (p.approvedAt) items.push({ key: "approved", icon: "✓", label: p.approvedBy ? `Approved by ${p.approvedBy}` : "Approved", time: p.approvedAt });
  if (p.issuedAt || p.printedAt) items.push({ key: "issued", icon: "🎫", label: "Issued & slip printed", time: p.printedAt || p.issuedAt, note: p.slipNo ? `Slip ${p.slipNo} · student marked OUT` : "Student marked OUT" });
  if (p.returnedAt)  items.push({ key: "returned",  icon: "↩", label: "Returned to campus", time: p.returnedAt, note: "Pass closed · student marked IN" });
  if (p.rejectedAt)  items.push({ key: "rejected",  icon: "✕", label: p.rejectedBy ? `Rejected by ${p.rejectedBy}` : "Rejected", time: p.rejectedAt, note: p.rejectionReason || undefined });
  if (p.cancelledAt) items.push({ key: "cancelled", icon: "⊘", label: "Cancelled at the gate desk", time: p.cancelledAt, note: "Request withdrawn" });
  return items;
}

/* ===================================================================== */

export default function PassList() {
  /* ================= LIVE DATA ================= */
  const [studentPasses, setStudentPasses] = useState([]);   // "studentPass"
  const [requests, setRequests]         = useState([]);     // "studentRequest"
  const [daypasses, setDaypasses]       = useState([]);     // "daypass"
  const [rejected, setRejected]         = useState([]);     // "rejectedStudentPass"
  const [cancelled, setCancelled]       = useState([]);     // "cancelledStudentPass"
  const [synced, setSynced]             = useState(false);

  /* ================= UI STATE ================= */
  const [clock, setClock]         = useState(() => new Date());
  const [search, setSearch]       = useState("");
  const [typeFilter, setTypeFilter]     = useState("ALL");   // ALL | STUDENT_PASS | DAY_PASS
  const [statusFilter, setStatusFilter] = useState("ALL");   // ALL | REQUESTED | … | CANCELLED
  const [dateMode, setDateMode]   = useState("ALL");         // ALL | TODAY | … | CUSTOM
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo]     = useState("");
  const [sortBy, setSortBy]       = useState("newest");
  const [limit, setLimit]         = useState(PAGE_SIZE);
  const [detail, setDetail]       = useState(null);          // the pass whose modal is open
  const [toast, setToast]         = useState(null);
  const toastTimerRef = useRef(null);

  /* ================= CLOCK ================= */
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  /* ================= TOAST ================= */
  const showToast = useCallback((text, type = "success") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), text, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  /* ================= FIREBASE REAL-TIME SYNC =================
     Five live subscriptions — the list, the stats, the filters and any
     open modal all update the moment anything changes, from any tab
     or device. This component only READS. */
  useEffect(() => {
    const bind = (path, setter) => onValue(ref(database, path),
      (snap) => { setter(sanitizeNode(snap.val(), path)); setSynced(true); },
      (err)   => { setSynced(true); showToast(`⚠ Could not read "${path}" — ${err.message}`, "error"); });
    const unsubs = [
      bind(DB_STUDENTPASS_PATH, setStudentPasses),
      bind(DB_REQUEST_PATH,     setRequests),
      bind(DB_APPROVED_PATH,    setDaypasses),
      bind(DB_REJECTED_PATH,    setRejected),
      bind(DB_CANCELLED_PATH,   setCancelled),
    ];
    return () => unsubs.forEach((u) => u());
  }, [showToast]);

  /* ================= DERIVED DATA ================= */

  /* all five collections merged, de-duplicated by _id — when a request
     moves between collections the newest copy wins, so the list never
     blinks or doubles */
  const allPasses = useMemo(() => {
    const byId = new Map();
    const push = (list) => list.forEach((p) => {
      const prev = byId.get(p._id);
      if (!prev || activityTime(p) > activityTime(prev)) byId.set(p._id, p);
    });
    push(studentPasses); push(requests); push(daypasses); push(rejected); push(cancelled);
    return [...byId.values()];
  }, [studentPasses, requests, daypasses, rejected, cancelled]);

  /* search string → tokens (plain words + field:value pairs) */
  const searchTokens = useMemo(() => parseQuery(search), [search]);

  /* filter → search → sort = the list on screen */
  const visible = useMemo(() => {
    let list = allPasses;
    if (typeFilter !== "ALL")   list = list.filter((p) => p.kind === typeFilter);
    if (statusFilter !== "ALL") list = list.filter((p) => p.status === statusFilter);

    const range = dateRange(dateMode, customFrom, customTo);
    if (range) list = list.filter((p) => { const t = statusTimeMs(p); return t >= range.from && t <= range.to; });

    if (searchTokens.length) list = list.filter((p) => matchesQuery(p, searchTokens));

    const ret = (p) => { const d = parseLocal(p.expectedReturn); return d ? d.getTime() : Infinity; };
    const sorters = {
      newest: (a, b) => activityTime(b) - activityTime(a),
      oldest: (a, b) => activityTime(a) - activityTime(b),
      name:   (a, b) => a.name.localeCompare(b.name) || activityTime(b) - activityTime(a),
      return: (a, b) => ret(a) - ret(b) || activityTime(b) - activityTime(a),
      status: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || activityTime(b) - activityTime(a),
    };
    return [...list].sort(sorters[sortBy] || sorters.newest);
  }, [allPasses, searchTokens, typeFilter, statusFilter, dateMode, customFrom, customTo, sortBy]);

  /* page window */
  const shown = useMemo(() => visible.slice(0, limit), [visible, limit]);

  /* "Show more" always restarts when the filters change */
  useEffect(() => { setLimit(PAGE_SIZE); }, [search, typeFilter, statusFilter, dateMode, customFrom, customTo, sortBy]);

  /* stats strip — all live */
  const stats = useMemo(() => {
    const t0 = startOfToday().getTime();
    let today = 0, out = 0, pending = 0, rejectedN = 0, cancelledN = 0;
    allPasses.forEach((p) => {
      if (statusTimeMs(p) >= t0) today++;
      if (p.status === "ISSUED") out++;
      else if (p.status === "REQUESTED") pending++;
      else if (p.status === "REJECTED") rejectedN++;
      else if (p.status === "CANCELLED") cancelledN++;
    });
    return { total: allPasses.length, today, out, pending, rejected: rejectedN, cancelled: cancelledN };
  }, [allPasses]);

  /* ================= FILTER HELPERS ================= */
  const resetFilters = useCallback(() => {
    setSearch(""); setTypeFilter("ALL"); setStatusFilter("ALL"); setDateMode("ALL");
    setCustomFrom(""); setCustomTo("");
  }, []);

  const filtersClean = typeFilter === "ALL" && statusFilter === "ALL" && dateMode === "ALL" && !search.trim();

  /* is the CURRENT filter exactly one single quick-view? (stats highlighting) */
  const isSolo = useCallback((patch) => {
    const cur  = { type: typeFilter, status: statusFilter, date: dateMode, q: search.trim() };
    const want = { type: "ALL", status: "ALL", date: "ALL", q: "", ...patch };
    return cur.type === want.type && cur.status === want.status && cur.date === want.date && cur.q === want.q;
  }, [typeFilter, statusFilter, dateMode, search]);

  const statCards = [
    
    { key: "today",     icon: "📅", label: "Movements today",  value: stats.today,     tone: "blue",   active: isSolo({ date: "TODAY" }),     apply: () => { resetFilters(); setDateMode("TODAY"); } },
    { key: "out",       icon: "🚶", label: "Out on pass now",  value: stats.out,       tone: "green",  active: isSolo({ status: "ISSUED" }),   apply: () => { resetFilters(); setStatusFilter("ISSUED"); } },
    { key: "pending",   icon: "⏳", label: "Pending requests", value: stats.pending,   tone: "amber",  active: isSolo({ status: "REQUESTED" }),apply: () => { resetFilters(); setStatusFilter("REQUESTED"); } },
    { key: "rejected",  icon: "⛔", label: "Rejected records", value: stats.rejected,  tone: "red",    active: isSolo({ status: "REJECTED" }), apply: () => { resetFilters(); setStatusFilter("REJECTED"); } },
    { key: "cancelled", icon: "⊘", label: "Cancelled records", value: stats.cancelled, tone: "gray",   active: isSolo({ status: "CANCELLED" }),apply: () => { resetFilters(); setStatusFilter("CANCELLED"); } },
  ];

  /* smart-token chips under the search bar — click to add */
  const addToken = (t) => setSearch((s) => `${s.trim()} ${t}`.trim());

  /* ================= DETAIL MODAL ================= */
  const closeDetail = useCallback(() => setDetail(null), []);

  /* the live version of the open record — refreshes while the modal is open */
  const livePass = useMemo(
    () => (detail ? (allPasses.find((p) => p._id === detail._id) || detail) : null),
    [detail, allPasses]
  );

  /* ESC + backdrop + body scroll lock */
  useEffect(() => {
    if (!detail) return;
    const onKey = (e) => { if (e.key === "Escape") closeDetail(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [detail, closeDetail]);

  /* ================= CSV EXPORT (respects the current filter) ================= */
  const exportCsv = () => {
    if (!visible.length) { showToast("Nothing to export — the current filter shows no passes.", "error"); return; }
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["Slip No", "Pass Type", "Status", "Student", "Class", "ID No", "RFID",
      "Reason", "Going With", "Expected Return", "Raised", "Approved", "Issued / Printed", "Closed",
      "Authorized By", "Approved By", "Rejected By"];
    const rows = visible.map((p) => [
      p.slipNo || "—",
      (KIND_META[p.kind] || {}).label || p.kind,
      (STATUS_META[p.status] || {}).label || p.status,
      p.name, p.className, p.studentId, p.rfid || "—",
      p.reason, fmtGoingWith(p), fmtExpected(p.expectedReturn),
      fmtStamp(p.requestedAt || p.createdAt), fmtStamp(p.approvedAt), fmtStamp(p.printedAt || p.issuedAt),
      fmtStamp(p.returnedAt || p.rejectedAt || p.cancelledAt),
      p.authorizedBy || "—", p.approvedBy || "—", p.rejectedBy || "—",
    ]);
    const csv = "\uFEFF" + [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pass-records-${todayStr()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast(`✓ Exported ${visible.length} pass record${visible.length === 1 ? "" : "s"} (current filter) to CSV`, "success");
  };

     /* ================= MODAL RENDER =================
     Rendered through a React PORTAL straight into document.body — the
     modal escapes EVERY parent wrapper (sidebars, page-transition
     transforms, overflow containers), so it ALWAYS sits dead-center
     of the screen no matter where it was opened from. */
  const renderModal = () => {
    if (!livePass) return null;
    const meta = STATUS_META[livePass.status] || STATUS_META.REQUESTED;
    const kindClass = livePass.kind === "STUDENT_PASS" ? "student" : "day";
    return createPortal(
      <div className="pl-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeDetail(); }}>
        <div className="pl-modal" role="dialog" aria-modal="true" aria-labelledby="pl-modal-title">
          <button type="button" className="pl-modal-x" onClick={closeDetail} aria-label="Close details" autoFocus>✕</button>

          {/* ---------- head: who + badges ---------- */}
          <div className="pl-modal-head">
            <span className="pl-avatar pl-avatar-lg" style={{ background: avatarGradient(livePass.name) }}>{getInitials(livePass.name)}</span>
            <div className="pl-modal-id">
              <h3 id="pl-modal-title">{livePass.name}</h3>
              <div className="pl-modal-chips">
                <span className="pl-chip">{livePass.className}</span>
                <span className="pl-chip pl-chip-mono">{livePass.studentId}</span>
                {livePass.rfid && <span className="pl-chip pl-chip-mono pl-chip-soft">RFID {livePass.rfid}</span>}
              </div>
            </div>
            <div className="pl-modal-badges">
              <span className={`pl-type pl-type-${kindClass}`}>{(KIND_META[livePass.kind] || {}).label || livePass.kind}</span>
              <span className={`pl-status pl-status-${meta.tone}`}>{meta.icon} {meta.label}</span>
              {isRowOverdue(livePass) && <span className="pl-tag pl-tag-overdue">Overdue</span>}
            </div>
          </div>

          {/* ---------- body: full record ---------- */}
          <div className="pl-modal-body">
            <div className="pl-grid">
              <div className="pl-field pl-field-wide">
                <span className="pl-field-label">Reason</span>
                <p className="pl-field-value">{livePass.reason}</p>
              </div>

              <div className="pl-field">
                <span className="pl-field-label">Expected return</span>
                <span className="pl-field-value">
                  {fmtExpected(livePass.expectedReturn)}
                  {isTodayDate(livePass.expectedReturn) && <span className="pl-tag pl-tag-today">Today</span>}
                  {livePass.status === "ISSUED" && isOverdueDate(livePass.expectedReturn) && <span className="pl-tag pl-tag-overdue">Overdue</span>}
                </span>
              </div>

              <div className="pl-field">
                <span className="pl-field-label">Going with</span>
                <span className={`pl-field-value ${livePass.goingWith ? "" : "pl-field-dim"}`}>{fmtGoingWith(livePass)}</span>
              </div>

              {livePass.slipNo && (
                <div className="pl-field">
                  <span className="pl-field-label">Slip number</span>
                  <span className="pl-field-value pl-field-mono">{livePass.slipNo}</span>
                </div>
              )}

              {livePass.authorizedBy && (
                <div className="pl-field">
                  <span className="pl-field-label">Authorized by</span>
                  <span className="pl-field-value">{livePass.authorizedBy}</span>
                </div>
              )}
              {livePass.approvedBy && (
                <div className="pl-field">
                  <span className="pl-field-label">Approved by</span>
                  <span className="pl-field-value">{livePass.approvedBy}</span>
                </div>
              )}
              {livePass.rejectedBy && (
                <div className="pl-field">
                  <span className="pl-field-label">Rejected by</span>
                  <span className="pl-field-value">
                    {livePass.rejectedBy}
                    {livePass.rejectionReason && <span className="pl-field-note">“{livePass.rejectionReason}”</span>}
                  </span>
                </div>
              )}

              <div className="pl-field">
                <span className="pl-field-label">Record stored in</span>
                <span className="pl-field-value pl-field-mono">{SOURCE_LABELS[livePass.source] || livePass.source}</span>
              </div>
            </div>

            {/* ---------- lifecycle timeline ---------- */}
            <h4 className="pl-timeline-title">Pass timeline</h4>
            <ol className="pl-timeline">
              {timelineItems(livePass).map((it, idx, arr) => {
                const isCurrent = idx === arr.length - 1;
                return (
                  <li key={it.key} className={`pl-tl-item ${isCurrent ? "pl-tl-current" : ""} ${isCurrent ? `pl-tl-tone-${meta.tone}` : ""}`}>
                    <span className="pl-tl-dot">{it.icon}</span>
                    <div className="pl-tl-body">
                      <span className="pl-tl-label">{it.label}</span>
                      {it.note && <span className="pl-tl-note">{it.note}</span>}
                      <span className="pl-tl-time">{fmtStamp(it.time)}{it.time ? ` · ${timeAgo(it.time)}` : ""}</span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>

                    <footer className="pl-modal-foot">
            <button type="button" className="pl-btn pl-btn-ghost" onClick={closeDetail}>Close</button>
          </footer>
        </div>
      </div>,
      document.body
    );
  };
  /* ================= RENDER ================= */
  const loading = !synced;

  return (
    <section className="pl">
      {/* ---------- header ---------- */}
     

      {/* ---------- stats (clickable quick filters) ---------- */}
      <div className="pl-stats">
        {statCards.map((s) => (
          <button
            type="button"
            key={s.key}
            className={`pl-stat pl-stat-${s.tone} ${s.active ? "pl-stat-on" : ""}`}
            onClick={s.apply}
            title={s.active ? "This quick view is active" : `Show ${s.label.toLowerCase()}`}
          >
            <span className="pl-stat-icon">{s.icon}</span>
            <span className="pl-stat-nums">
              <span className="pl-stat-value">{loading ? "—" : s.value}</span>
              <span className="pl-stat-label">{s.label}</span>
            </span>
          </button>
        ))}
      </div>

      {/* ---------- controls ---------- */}
      <div className="pl-controls">
        {/* row 1 — search · sort · export */}
        <div className="pl-toolbar">
          <div className="pl-search">
            <span className="pl-search-icon" aria-hidden="true">🔍</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Search anything — name, ID, class, reason, slip… try "class:10a" or "status:pending"'
              spellCheck={false}
              aria-label="Search passes"
            />
            {search && (
              <button type="button" className="pl-search-clear" onClick={() => setSearch("")} aria-label="Clear search">✕</button>
            )}
          </div>

          <label className="pl-select">
            <span className="pl-select-label">Sort</span>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Sort passes">
              {SORT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>

          <button type="button" className="pl-btn pl-btn-ghost pl-export" onClick={exportCsv} title="Export the passes currently on screen to CSV">
            ⤓ Export CSV
          </button>
        </div>

        {/* row 2 — All · type · status · date · count */}
        <div className="pl-filters">
          <div className="pl-allwrap">
            <span className="pl-select-label">Show</span>
            <button
              type="button"
              className={`pl-all ${filtersClean ? "pl-all-on" : ""}`}
              onClick={resetFilters}
              title="Show every pass — clears type, status, date and search"
            >
              All
              {!loading && <span className="pl-all-count">{stats.total}</span>}
            </button>
          </div>

          <label className={`pl-select ${typeFilter !== "ALL" ? "pl-select-on" : ""}`}>
            <span className="pl-select-label">Pass type</span>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by pass type">
              <option value="ALL">All types</option>
              <option value="STUDENT_PASS">Student pass</option>
              <option value="DAY_PASS">Day pass</option>
            </select>
          </label>

          <label className={`pl-select ${statusFilter !== "ALL" ? "pl-select-on" : ""}`}>
            <span className="pl-select-label">Status</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
              <option value="ALL">All statuses</option>
              {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
            </select>
          </label>

          <label className={`pl-select ${dateMode !== "ALL" ? "pl-select-on" : ""}`}>
            <span className="pl-select-label">Date</span>
            <select value={dateMode} onChange={(e) => setDateMode(e.target.value)} aria-label="Filter by date">
              {DATE_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>

          <div className="pl-count">
            {loading ? "Loading…" : `${visible.length} of ${stats.total} ${stats.total === 1 ? "pass" : "passes"}`}
          </div>
        </div>

        {/* custom date range — appears only when "Custom range…" is chosen */}
        {dateMode === "CUSTOM" && (
          <div className="pl-custom">
            <span className="pl-custom-label">Custom range</span>
            <input type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} aria-label="From date" />
            <span className="pl-custom-arrow">→</span>
            <input type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} aria-label="To date" />
            {(customFrom || customTo) && (
              <button type="button" className="pl-custom-clear" onClick={() => { setCustomFrom(""); setCustomTo(""); }}>clear</button>
            )}
            {!customFrom && !customTo && <span className="pl-custom-hint">pick a from / to date — the list filters live</span>}
          </div>
        )}

        {/* smart-search token hints */}
        <div className="pl-smart">
          <span className="pl-smart-label">Smart search</span>
          {["name:", "class:", "id:", "status:pending", "type:day", "slip:"].map((t) => (
            <button key={t} type="button" className="pl-smart-chip" onClick={() => addToken(t)}>{t}</button>
          ))}
          <span className="pl-smart-hint">click a token to add it — plain words search every field</span>
        </div>
      </div>

      {/* ---------- list / loading / empty ---------- */}
      <div className="pl-listwrap">
        {loading ? (
          <div className="pl-list">
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className="pl-skel" style={{ animationDelay: `${i * 80}ms` }} />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="pl-empty">
            <div className="pl-empty-icon">{stats.total === 0 ? "🗃️" : "🔍"}</div>
            <h3>{stats.total === 0 ? "No pass records yet" : "No matching passes"}</h3>
            <p>
              {stats.total === 0
                ? " "
                : "Nothing matches the current search"}
            </p>
            {stats.total > 0 && (
              <button type="button" className="pl-btn pl-btn-ghost" onClick={resetFilters}>Clear search &amp; filters</button>
            )}
          </div>
        ) : (
          <>
            <div className="pl-list">
              {shown.map((p, i) => {
                const meta = STATUS_META[p.status] || STATUS_META.REQUESTED;
                return (
                  <article
                    key={p._id}
                    className={`pl-row pl-row-st-${p.status.toLowerCase()}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setDetail(p)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDetail(p); } }}
                    aria-label={`Pass details — ${p.name}, ${(KIND_META[p.kind] || {}).label || p.kind}, ${meta.label}`}
                    style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}
                  >
                    <span className="pl-avatar" style={{ background: avatarGradient(p.name) }}>{getInitials(p.name)}</span>

                    <div className="pl-row-main">
                      <div className="pl-row-line1">
                        <h3 className="pl-row-name" title={p.name}>{p.name}</h3>
                        <span className={`pl-type pl-type-${p.kind === "STUDENT_PASS" ? "student" : "day"}`}>{(KIND_META[p.kind] || {}).label || p.kind}</span>
                        <span className={`pl-status pl-status-${meta.tone}`}>{meta.icon} {meta.label}</span>
                        {isRowOverdue(p) && <span className="pl-tag pl-tag-overdue">Overdue</span>}
                      </div>
                      <div className="pl-row-line2">
                        <span className="pl-chip">{p.className}</span>
                        <span className="pl-chip pl-chip-mono">{p.studentId}</span>
                        {p.slipNo && <span className="pl-chip pl-chip-mono pl-chip-soft">{p.slipNo}</span>}
                        {p.reason && p.reason !== "—" && <span className="pl-row-reason" title={p.reason}>{p.reason}</span>}
                      </div>
                    </div>

                    <div className="pl-row-time" title={fmtStamp(statusTimeValue(p))}>
                      <span className="pl-row-time-label">{meta.verb}</span>
                      <span className="pl-row-time-value">{fmtDateTime(statusTimeValue(p))}</span>
                      <span className="pl-row-time-ago">{timeAgo(statusTimeValue(p))}</span>
                    </div>

                    <span className="pl-row-chevron" aria-hidden="true">›</span>
                  </article>
                );
              })}
            </div>

            {visible.length > shown.length && (
              <div className="pl-more">
                <button type="button" className="pl-more-btn" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                  Show {Math.min(PAGE_SIZE, visible.length - shown.length)} more · {visible.length - shown.length} remaining
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ---------- detail modal ---------- */}
      {renderModal()}

      {/* ---------- toast ---------- */}
      <div aria-live="polite">
        {toast && (
          <div key={toast.id} className={`pl-toast pl-toast-${toast.type}`}>
            <span className="pl-toast-icon">{toast.type === "success" ? "✓" : "⚠"}</span>
            <span>{toast.text}</span>
          </div>
        )}
      </div>
    </section>
  );
}