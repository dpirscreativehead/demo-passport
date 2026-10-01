import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { ref, onValue, update } from "firebase/database";
import { database } from "../../../firebase/config"; // ← identical path to PassIssue — keep this file in the SAME folder
import "./PassIssueSupport.css";

/* =====================================================================
   PASS DESK SUPPORT — the gate desk's second screen (below Pass Issue)
   ---------------------------------------------------------------------
   WHY THIS EXISTS
   After a pass is issued or requested, the student leaves the Pass
   Issue panel — until now the only way back was to re-scan the card or
   re-type the ID. This section keeps every recent pass one click away.

   PART 1 — PASS QUICK VIEW (three tabs, 5 rows visible, inner scroll)
     · RECENT   → the latest 25 passes of ANY status from ANY collection
                  (studentPass · studentRequest · daypass ·
                   rejectedStudentPass · cancelledStudentPass), newest
                  on top — day passes AND student passes together.
     · APPROVED → every pass the Principal approved (status APPROVED),
                  each with a 🖨 print button — the exact action of the
                  Pass Issue desk: prints the 80 mm slip, flips the
                  status to ISSUED (the pass then moves to Recent) and
                  marks the student OUT. No re-scanning needed.
     · PENDING  → every request awaiting approval (status REQUESTED),
                  each with ✎ edit and ✕ cancel icon buttons.
                    – edit   → reason · return date+time · going with
                    – cancel → same atomic move as the Pass Issue desk:
                               studentRequest → cancelledStudentPass,
                               student restored to IN
                  When the Principal approves, the request leaves
                  Pending and appears in Approved — automatically,
                  through live Firebase sync.

   PART 2 — SMART STUDENT SEARCH
     · searches name, class and ID number — and for RFID every card
       CONTAINING the typed digits (partial match), results keeping
       the students-sheet order (newest first).
     · every result shows name, class and RFID, plus an ↵ ENTER button
       that drops the RFID straight into the manual entry box of the
       Pass Issue desk above (props onUseRfid / onSearchFocus — the
       search box also pauses the RFID scanner while it is focused).

   Everything is LIVE (onValue). The only writes this section ever
   makes: printing an approved pass, editing or cancelling a pending
   request. It never touches anything else.
   ===================================================================== */

/* ---------------- constants ---------------- */
const DB_STUDENTS_PATH    = "students";              // student master data (search + status writes)
const DB_STUDENTPASS_PATH = "studentPass";           // passes issued directly at the gate desk
const DB_REQUEST_PATH     = "studentRequest";        // PENDING day-pass requests
const DB_APPROVED_PATH    = "daypass";               // Principal-APPROVED passes (print from here)
const DB_REJECTED_PATH    = "rejectedStudentPass";   // rejected records
const DB_CANCELLED_PATH   = "cancelledStudentPass";  // cancelled-request records

const SCHOOL_NAME = "De Paul International Residential School, Mysore";   // printed on every slip

const RECENT_LIMIT = 25;      // rows kept in the Recent tab
const RESULT_LIMIT = 30;      // search results rendered at once (scroll inside)

const REASON_OPTIONS = [
  "Medical Appointment",
  "Not feeling well, going home",
  "Family function at home",
  "Picked up early by parent",
  "Inter-school competition",
  "National / state-level Competetions",
];
const GOING_WITH_OPTIONS = ["Parent", "Guardian", "Staff"];

const STATUS_META = {
  REQUESTED: { label: "Pending",   verb: "Requested", icon: "⏳", tone: "amber"  },
  APPROVED:  { label: "Approved",  verb: "Approved",  icon: "✓",  tone: "blue"   },
  ISSUED:    { label: "Issued",    verb: "Printed",   icon: "🎫", tone: "green"  },
  RETURNED:  { label: "Returned",  verb: "Returned",  icon: "↩",  tone: "slate"  },
  REJECTED:  { label: "Rejected",  verb: "Rejected",  icon: "✕",  tone: "red"    },
  CANCELLED: { label: "Cancelled", verb: "Cancelled", icon: "⊘",  tone: "gray"   },
};

const DEFAULT_STATUS = {
  [DB_STUDENTPASS_PATH]: "ISSUED",
  [DB_REQUEST_PATH]:     "REQUESTED",
  [DB_APPROVED_PATH]:    "APPROVED",
  [DB_REJECTED_PATH]:    "REJECTED",
  [DB_CANCELLED_PATH]:   "CANCELLED",
};

const TIME_FIELDS = ["createdAt", "requestedAt", "approvedAt", "issuedAt", "printedAt", "returnedAt", "rejectedAt", "cancelledAt"];

/* ---------------- small helpers ---------------- */
const p2 = (n) => String(n).padStart(2, "0");

const normalizeRfid = (v) => String(v || "").trim().toUpperCase().replace(/[\s:\-]/g, "");

const getInitials = (name) =>
  String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join("") || "?";

/* "2025-06-11" and "2025-06-11T14:30" → local Date (no UTC surprises) */
function parseLocal(v) {
  const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function nextHalfHour(hoursAhead = 1) {
  const d = new Date(Date.now() + hoursAhead * 3600000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const tsMs = (v) => { if (!v) return 0; const t = new Date(v).getTime(); return isNaN(t) ? 0 : t; };

function fmtDateTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d)) return "—";
  return `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${d.toLocaleDateString([], { day: "2-digit", month: "short" })}`;
}
function fmtStamp(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtExpected(v) {
  const d = parseLocal(v);
  if (!d) return "—";
  return /T\d{2}:\d{2}/.test(String(v))
    ? `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${d.toLocaleDateString([], { day: "2-digit", month: "short" })}`
    : d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}
function fmtFull(v) {
  const d = parseLocal(v);
  if (!d) return String(v || "—");
  return /T\d{2}:\d{2}/.test(String(v))
    ? d.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
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

/* a pass is a STUDENT pass when it came from the Issue Pass button */
const isStudentPass = (p) => String((p && p.kind) || "").toUpperCase() === "STUDENT_PASS";

/* ---------------- pass normalization ---------------- */
function normalizePass(raw, key, source) {
  const p = raw && typeof raw === "object" ? raw : {};
  const statusRaw = String(p.status || "").toUpperCase();
  const kindRaw = String(p.kind || "").toUpperCase();
  return {
    ...p,
    _id: String(p._id || key),
    source,
    kind: source === DB_STUDENTPASS_PATH
      ? "STUDENT_PASS"                                  // old records display correctly too
      : (kindRaw === "STUDENT_PASS" ? "STUDENT_PASS" : "DAY_PASS"),
    status: statusRaw || DEFAULT_STATUS[source],
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
function sanitizePasses(val, source) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return [];
  return Object.entries(val)
    .map(([key, raw]) => normalizePass(raw, key, source))
    .filter((p) => p && p._id);
}

/* students node → clean array for the smart search */
function sanitizeStudents(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return [];
  return Object.entries(val).map(([key, s]) => ({
    _id: String((s && s._id) || key),
    rfid: normalizeRfid(s && s.rfid),
    studentId: String((s && s.studentId) || "").trim(),
    name: String((s && s.name) || "").trim(),
    className: String((s && s.className) || "").trim(),
    status: String((s && s.status) || "IN").toUpperCase(),
    createdAt: (s && s.createdAt) || null,
  })).filter((s) => s._id);
}

/* ---------------- pass logic ---------------- */
/* the LATEST moment anything happened on this record — "recent on top" */
function activityTime(p) {
  return TIME_FIELDS.reduce((max, f) => Math.max(max, tsMs(p[f])), 0);
}

/* the moment matching the CURRENT status — the time shown on rows */
function statusTimeValue(p) {
  switch (p.status) {
    case "RETURNED":  return p.returnedAt || p.printedAt || p.issuedAt || p.createdAt  || null;
    case "REJECTED":  return p.rejectedAt  || p.requestedAt || p.createdAt || null;
    case "CANCELLED": return p.cancelledAt || p.requestedAt || p.createdAt || null;
    case "ISSUED":    return p.printedAt   || p.issuedAt  || p.createdAt  || null;
    case "APPROVED":  return p.approvedAt  || p.createdAt || null;
    default:          return p.requestedAt || p.createdAt || null;   // REQUESTED
  }
}

/* running slip number for today: DP-YYYYMMDD-001 … (same rule as the desk) */
function makeSlipNo(studentPasses, daypasses, requests) {
  const d = new Date();
  const today = d.toDateString();
  const pool = [...(studentPasses || []), ...(daypasses || []), ...(requests || [])];
  const n = pool.filter((x) => x.issuedAt && new Date(x.issuedAt).toDateString() === today).length + 1;
  return `DP-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${String(n).padStart(3, "0")}`;
}

/* ---------------- modal lifecycle timeline ---------------- */
function timelineItems(p) {
  const items = [{
    key: "raised",
    icon: "📝",
    label: isStudentPass(p) ? "Student pass issued at the gate desk" : "Day-pass request raised",
    time: isStudentPass(p) ? (p.issuedAt || p.createdAt) : (p.requestedAt || p.createdAt),
    note: isStudentPass(p) ? "Issued directly — no approval needed" : "Sent to the Principal for approval",
  }];
  if (p.approvedAt)          items.push({ key: "approved",  icon: "✓",  label: p.approvedBy ? `Approved by ${p.approvedBy}` : "Approved", time: p.approvedAt });
  if (p.issuedAt || p.printedAt) items.push({ key: "issued", icon: "🎫", label: "Issued & slip printed", time: p.printedAt || p.issuedAt, note: p.slipNo ? `Slip ${p.slipNo} · student marked OUT` : "Student marked OUT" });
  if (p.returnedAt)          items.push({ key: "returned",  icon: "↩",  label: "Returned to campus", time: p.returnedAt, note: "Pass closed · student marked IN" });
  if (p.rejectedAt)          items.push({ key: "rejected",  icon: "✕",  label: p.rejectedBy ? `Rejected by ${p.rejectedBy}` : "Rejected", time: p.rejectedAt, note: p.rejectionReason || undefined });
  if (p.cancelledAt)         items.push({ key: "cancelled", icon: "⊘",  label: "Cancelled at the gate desk", time: p.cancelledAt, note: "Request withdrawn" });
  return items;
}

/* ---------- 80 mm thermal slip — IDENTICAL to the Pass Issue desk ---------- */
function printSlip(pass) {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const issuedAt = new Date(pass.printedAt || pass.issuedAt || Date.now());

  const rows = [
    ["Student", pass.name],
    ["Class", pass.className],
    ["ID No", pass.studentId],
    ["Reason", pass.reason],
    ...(pass.goingWith ? [["Going with", fmtGoingWith(pass)]] : []),
    ["Return by", fmtFull(pass.expectedReturn)],
    ["Authorized", pass.authorizedBy || "Principal"],
  ]
    .map(([k, v]) => `<div class="r"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
    .join("");

  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${isStudentPass(pass) ? "Student Pass" : "Day Pass"} ${esc(pass.slipNo || "")}</title><style>` +
    `@page{size:80mm auto;margin:2mm}html,body{margin:0;padding:0}` +
    `body{width:76mm;font-family:"Consolas","Courier New",monospace;color:#000}` +
    `.c{text-align:center}.school{font-size:12px;font-weight:bold;letter-spacing:.4px}` +
    `.slip{font-size:17px;font-weight:bold;letter-spacing:5px;margin:1.5mm 0 .5mm}` +
    `.no{font-size:11px;letter-spacing:1px}.hr{border-top:1px dashed #000;margin:2mm 0}` +
    `.r{display:flex;font-size:11px;line-height:1.55}.k{width:24mm;flex-shrink:0;font-weight:bold}` +
    `.v{flex:1;word-break:break-word}.stamp{font-size:10.5px;line-height:1.6}` +
    `.note{font-size:9.5px;line-height:1.5}.foot{font-size:9.5px;margin-top:1.5mm}` +
    `</style></head><body>` +
    `<div class="c school">${esc(SCHOOL_NAME)}</div>` +
    `<div class="c slip">${isStudentPass(pass) ? "STUDENT PASS" : "DAY PASS"}</div>` +
    `<div class="c no">${esc(pass.slipNo || "")}</div>` +
    `<div class="hr"></div>${rows}<div class="hr"></div>` +
    `<div class="c stamp">Issued: ${esc(issuedAt.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }))}</div>` +
    `<div class="hr"></div>` +
    `<div class="c foot">— DPIRS PassPort —</div>` +
    `</body></html>`;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(iframe);
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) { iframe.remove(); return; }
    const remove = () => { try { iframe.remove(); } catch (err) { /* ignore */ } };
    try { win.focus(); win.print(); } catch (err) { remove(); return; }
    win.onafterprint = remove;
    setTimeout(remove, 60000);
  };
  iframe.srcdoc = html;
}

/* ===================================================================== */

export default function PassDeskSupport({ onUseRfid, onSearchFocus }) {
  /* ================= LIVE DATA ================= */
  const [studentPasses, setStudentPasses] = useState([]);   // "studentPass"
  const [requests, setRequests]           = useState([]);   // "studentRequest" — pending
  const [daypasses, setDaypasses]         = useState([]);   // "daypass" — approved / printed
  const [rejected, setRejected]           = useState([]);   // "rejectedStudentPass"
  const [cancelled, setCancelled]         = useState([]);   // "cancelledStudentPass"
  const [students, setStudents]           = useState([]);   // "students" — smart search
  const [synced, setSynced]               = useState(false);

  /* ================= UI STATE ================= */
  const [tab, setTab]         = useState("recent");   // recent | approved | pending
  const [detail, setDetail]   = useState(null);       // pass whose detail modal is open
  const [editPass, setEditPass] = useState(null);     // pending pass being edited
  const [editForm, setEditForm] = useState(null);
  const [editError, setEditError] = useState("");
  const [search, setSearch]   = useState("");
  const [toast, setToast]     = useState(null);

  const toastTimerRef = useRef(null);
  const printBusyRef  = useRef(false);                 // double-print guard

  /* ================= TOAST ================= */
  const showToast = useCallback((text, type = "success") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), text, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  /* ================= FIREBASE REAL-TIME SYNC ================= */
  useEffect(() => {
    const bindPass = (path, setter) => onValue(ref(database, path),
      (snap) => { setter(sanitizePasses(snap.val(), path)); setSynced(true); },
      () => { setSynced(true); }                        /* node absent — tabs still work */);
    const unsubs = [
      bindPass(DB_STUDENTPASS_PATH, setStudentPasses),
      bindPass(DB_REQUEST_PATH,     setRequests),
      bindPass(DB_APPROVED_PATH,    setDaypasses),
      bindPass(DB_REJECTED_PATH,    setRejected),
      bindPass(DB_CANCELLED_PATH,   setCancelled),
      onValue(ref(database, DB_STUDENTS_PATH), (snap) => setStudents(sanitizeStudents(snap.val())), () => {}),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  /* ================= DERIVED DATA ================= */

  /* all five collections merged, de-duplicated by _id — a record keeps
     its _id when it moves between collections, so nothing shows twice */
  const allPasses = useMemo(() => {
    const byId = new Map();
    const push = (list) => list.forEach((p) => {
      const prev = byId.get(p._id);
      if (!prev || activityTime(p) > activityTime(prev)) byId.set(p._id, p);
    });
    push(studentPasses); push(requests); push(daypasses); push(rejected); push(cancelled);
    return [...byId.values()];
  }, [studentPasses, requests, daypasses, rejected, cancelled]);

  /* RECENT — the latest 25, whatever the status, newest on top */
  const recentList = useMemo(
    () => [...allPasses].sort((a, b) => activityTime(b) - activityTime(a)).slice(0, RECENT_LIMIT),
    [allPasses]);

  /* APPROVED — everything the Principal approved, waiting to print */
  const approvedList = useMemo(
    () => allPasses.filter((p) => p.status === "APPROVED").sort((a, b) => activityTime(b) - activityTime(a)),
    [allPasses]);

  /* PENDING — every request still awaiting approval */
  const pendingList = useMemo(
    () => allPasses.filter((p) => p.status === "REQUESTED").sort((a, b) => tsMs(b.requestedAt || b.createdAt) - tsMs(a.requestedAt || a.createdAt)),
    [allPasses]);

  /* the live version of the open record — refreshes while the modal is open */
  const liveDetail = useMemo(
    () => (detail ? (allPasses.find((p) => p._id === detail._id) || detail) : null),
    [detail, allPasses]);

  /* students newest-first (the students-sheet order) for the smart search */
  const studentsSorted = useMemo(
    () => [...students].sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)),
    [students]);

  /* SMART SEARCH — name / class / ID substring · RFID: every card that
     CONTAINS the typed digits, list order preserved */
  const searchResults = useMemo(() => {
    const raw = search.trim();
    if (!raw) return [];
    const q = raw.toLowerCase();
    const qn = normalizeRfid(raw);
    return studentsSorted.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.studentId.toLowerCase().includes(q) ||
      s.className.toLowerCase().includes(q) ||
      (qn !== "" && s.rfid.includes(qn))
    );
  }, [studentsSorted, search]);

  /* find the live student record of a pass (by key, fallback ID) */
  const studentFor = useCallback((p) => students.find((s) =>
    (p.studentKey && s._id === p.studentKey) ||
    (p.studentId && s.studentId === p.studentId)) || null, [students]);

  /* ================= DETAIL MODAL ================= */
  const closeDetail = useCallback(() => setDetail(null), []);
  const closeEdit   = useCallback(() => { setEditPass(null); setEditError(""); }, []);

  /* ESC closes · backdrop scroll lock */
  useEffect(() => {
    if (!detail && !editPass) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (editPass) closeEdit();
      else closeDetail();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [detail, editPass, closeDetail, closeEdit]);

  /* if the request is decided elsewhere while its EDIT modal is open,
     close the modal politely */
  useEffect(() => {
    if (!editPass) return;
    const fresh = allPasses.find((p) => p._id === editPass._id);
    if (!fresh || fresh.status !== "REQUESTED") {
      setEditPass(null);
      showToast("This request is no longer pending — it may have been approved or withdrawn elsewhere.", "error");
    }
  }, [allPasses, editPass, showToast]);

  /* ================= PRINT AN APPROVED DAY PASS =================
     The exact action of the Pass Issue desk: the pass stays in the
     "daypass" collection, its status flips to ISSUED, the slip is
     printed and the student is marked OUT — after which the pass
     leaves the Approved tab and sits on top of the Recent tab. */
  const handlePrint = (pass) => {
    if (printBusyRef.current) return;
    const fresh = allPasses.find((p) => p._id === pass._id) || pass;
    if (fresh.status !== "APPROVED") {
      setDetail(null);
      showToast("This pass is no longer approved — it may already be printed or withdrawn.", "error");
      return;
    }

    printBusyRef.current = true;
    setTimeout(() => { printBusyRef.current = false; }, 1200);

    const now = new Date().toISOString();
    const slipNo = fresh.slipNo || makeSlipNo(studentPasses, daypasses, requests);
    const patch = {
      status: "ISSUED",
      slipNo,
      authorizedBy: fresh.authorizedBy || fresh.approvedBy || "Principal",
      issuedAt: fresh.issuedAt || now,
      printedAt: now,
    };

    /* optimistic — the row leaves the Approved tab instantly */
    setDaypasses((prev) => prev.map((p) => (p._id === fresh._id ? { ...p, ...patch } : p)));

    update(ref(database, `${DB_APPROVED_PATH}/${fresh._id}`), patch)
      .then(() => {
        const student = studentFor(fresh);
        if (student) {
          update(ref(database, `${DB_STUDENTS_PATH}/${student._id}`), { status: "OUT", lastMovement: now })
            .catch(() => { /* best-effort — Firebase pushes the corrected state */ });
        }
      })
      .catch(() => showToast("⚠ Could not save the print — check your Firebase connection / rules.", "error"));

    printSlip({ ...fresh, ...patch });
    setDetail(null);
    showToast(`✓ Day pass printed for ${fresh.name} — slip ${slipNo} · student marked OUT`, "success");
  };

  /* ================= CANCEL A PENDING REQUEST =================
     ONE atomic multi-path write — the same move the Pass Issue desk makes:
       · the request LEAVES "studentRequest"
       · the record is MOVED into "cancelledStudentPass" and kept there
       · the student's status is restored to IN (only if still REQUESTED) */
  const handleCancelRequest = (pass) => {
    const fresh = allPasses.find((p) => p._id === pass._id) || pass;
    if (fresh.status !== "REQUESTED") {
      setDetail(null);
      showToast("This request is no longer pending — nothing to cancel.", "error");
      return;
    }

    const now = new Date().toISOString();
    const { source, ...record } = fresh;
    const cancelledRecord = { ...record, status: "CANCELLED", cancelledAt: now };

    const updates = {
      [`${DB_REQUEST_PATH}/${fresh._id}`]: null,               // removed from requests…
      [`${DB_CANCELLED_PATH}/${fresh._id}`]: cancelledRecord,  // …kept as a permanent record
    };
    const student = studentFor(fresh);
    if (student && student.status === "REQUESTED") updates[`${DB_STUDENTS_PATH}/${student._id}/status`] = "IN";

    update(ref(database), updates)
      .then(() => showToast(`✓ Day-pass request for ${fresh.name} cancelled — record kept in the Cancelled collection`, "success"))
      .catch(() => showToast("⚠ Could not cancel the request — check your Firebase connection / rules.", "error"));

    /* optimistic mirrors — Firebase pushes the same change right after */
    setRequests((prev) => prev.filter((p) => p._id !== fresh._id));
    setCancelled((prev) => [normalizePass(cancelledRecord, fresh._id, DB_CANCELLED_PATH), ...prev]);

    setDetail(null);
    setEditPass(null);
  };

  /* ================= EDIT A PENDING REQUEST ================= */
  const openEdit = (pass) => {
    const fresh = allPasses.find((p) => p._id === pass._id) || pass;
    if (fresh.status !== "REQUESTED") {
      setDetail(null);
      showToast("Only pending requests can be edited.", "error");
      return;
    }
    const m = String(fresh.expectedReturn || "").match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
    setEditForm({
      reason: fresh.reason && fresh.reason !== "—" ? fresh.reason : "",
      returnDate: (m && m[1]) || todayStr(),
      returnTime: (m && m[2]) || nextHalfHour(1),
      goingWith: fresh.goingWith || "Parent",
      goingWithName: fresh.goingWithName || "",
    });
    setEditError("");
    setDetail(null);
    setEditPass(fresh);
  };

  const handleEditFormChange = (e) => {
    const { name, value } = e.target;
    setEditForm((f) => ({
      ...f,
      [name]: value,
      /* the name is only kept for Guardian / Staff — cleared otherwise */
      ...(name === "goingWith" && value !== "Guardian" && value !== "Staff" ? { goingWithName: "" } : {}),
    }));
    setEditError("");
  };

  const handleEditSave = () => {
    if (!editPass || !editForm) { setEditPass(null); return; }

    const reason = String(editForm.reason || "").trim();
    const { returnDate, returnTime, goingWith, goingWithName } = editForm;

    if (!reason) { setEditError("Please enter the reason for the day pass."); return; }
    if (!returnDate || !returnTime) { setEditError("Please fill in the expected return date and time."); return; }
    if (parseLocal(`${returnDate}T${returnTime}`) < new Date()) { setEditError("Expected return date & time must be in the future."); return; }
    if (!goingWith) { setEditError("Please select who is going with the student."); return; }

    const patch = {
      reason,
      expectedReturn: `${returnDate}T${returnTime}`,
      goingWith,
      goingWithName: (goingWith === "Guardian" || goingWith === "Staff") ? String(goingWithName || "").trim() : null,
    };

    update(ref(database, `${DB_REQUEST_PATH}/${editPass._id}`), patch)
      .then(() => {
        setRequests((prev) => prev.map((p) => (p._id === editPass._id ? { ...p, ...patch } : p)));
        showToast(`✓ Pending request updated for ${editPass.name}`, "success");
        setEditPass(null);
      })
      .catch(() => setEditError("Could not save the change — check your Firebase connection / rules."));
  };

  /* reason dropdown = the desk's options, plus the record's own reason
     when it was written before this list existed */
  const reasonOptions = useMemo(() => {
    const list = [...REASON_OPTIONS];
    if (editPass) {
      const cur = String(editPass.reason || "");
      if (cur && cur !== "—" && !list.includes(cur)) list.unshift(cur);
    }
    return list;
  }, [editPass]);

  /* ================= SMART SEARCH → MANUAL BOX ================= */
  const useStudent = (s) => {
    const rfid = normalizeRfid(s.rfid);
    if (!rfid) {
      showToast(`⚠ ${s.name} has no RFID on record — search by ID number instead.`, "error");
      return;
    }
    onUseRfid?.(rfid);      // → PassIssue fills + focuses its manual entry box
    setSearch("");
  };

  /* ================= RENDER ================= */
  const loading  = !synced;
  const tabList  = tab === "approved" ? approvedList : tab === "pending" ? pendingList : recentList;

  const TABS = [
    { id: "recent",   label: "Recent",   sub: "latest 25 · any status", count: recentList.length },
    { id: "approved", label: "Approved", sub: "ready to print",         count: approvedList.length },
    { id: "pending",  label: "Pending",  sub: "awaiting approval",      count: pendingList.length },
  ];

  const emptyState = tab === "recent" ? {
    icon: "🗂️", title: "No passes yet",
    
  } : tab === "approved" ? {
    icon: "✅", title: "Nothing waiting to print",
    
  } : {
    icon: "⏳", title: "No pending requests",
    
  };

  const footNote = loading ? "Loading live data…"
    : tab === "recent"   ? `Showing the latest ${recentList.length} of ${allPasses.length} pass${allPasses.length === 1 ? "" : "es"} · newest on top`
    : tab === "approved" ? `${approvedList.length} approved pass${approvedList.length === 1 ? "" : "es"} · printing moves the pass to Recent`
    :                       `${pendingList.length} pending request${pendingList.length === 1 ? "" : "s"} · approval moves it to the Approved tab`;

  return (
    <div className="ds">
      {/* ---------- header ---------- */}
      

      {/* ---------- part 1 · pass quick view ---------- */}
      <div className="ds-card">
        <div className="ds-tabs" role="tablist" aria-label="Pass quick views">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`ds-tab ${tab === t.id ? "ds-tab-on" : ""}`}
              onClick={() => setTab(t.id)}
            >
              <span className="ds-tab-line">
                <span className="ds-tab-label">{t.label}</span>
                <span className="ds-tab-count">{loading ? "…" : t.count}</span>
              </span>
              <span className="ds-tab-sub">{t.sub}</span>
            </button>
          ))}
        </div>

        <div className="ds-listwrap">
          {loading ? (
            <div className="ds-list">
              {[0, 1, 2, 3, 4].map((i) => <div key={i} className="ds-skel" style={{ animationDelay: `${i * 80}ms` }} />)}
            </div>
          ) : tabList.length === 0 ? (
            <div className="ds-empty">
              <div className="ds-empty-icon">{emptyState.icon}</div>
              <h3>{emptyState.title}</h3>
              <p>{emptyState.text}</p>
            </div>
          ) : (
            <div className="ds-list" role="tabpanel">
              {tabList.map((p) => {
                const meta = STATUS_META[p.status] || { label: p.status, verb: p.status, icon: "•", tone: "slate" };
                const t = statusTimeValue(p);
                return (
                  <article
                    key={p._id}
                    className={`ds-row ds-row-st-${String(p.status).toLowerCase()}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setDetail(p)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDetail(p); } }}
                    aria-label={`Pass details — ${p.name}, ${p.kind === "STUDENT_PASS" ? "student pass" : "day pass"}, ${meta.label}`}
                  >
                    <span className="ds-avatar">{getInitials(p.name)}</span>

                    <div className="ds-row-main">
                      <div className="ds-row-line1">
                        <span className="ds-row-name" title={p.name}>{p.name}</span>
                        <span className={`ds-kind ds-kind-${p.kind === "STUDENT_PASS" ? "student" : "day"}`}>
                          {p.kind === "STUDENT_PASS" ? "Student" : "Day"}
                        </span>
                        <span className={`ds-badge ds-badge-${meta.tone}`}>{meta.icon} {meta.label}</span>
                      </div>
                      <div className="ds-row-line2">
                        <span className="ds-chip">{p.className}</span>
                        <span className="ds-chip ds-chip-mono">{p.studentId}</span>
                        {p.reason && p.reason !== "—" && <span className="ds-row-reason" title={p.reason}>{p.reason}</span>}
                      </div>
                    </div>

                    <div className="ds-row-time" title={fmtStamp(t)}>
                      <span className="ds-row-time-label">{meta.verb}</span>
                      <span className="ds-row-time-value">{fmtDateTime(t)}</span>
                      <span className="ds-row-time-ago">{timeAgo(t)}</span>
                    </div>

                    {p.status === "APPROVED" && (
                      <button
                        type="button"
                        className="ds-iconbtn ds-iconbtn-print"
                        title="Print this approved day pass (same as the desk above)"
                        aria-label={`Print approved pass for ${p.name}`}
                        onClick={(e) => { e.stopPropagation(); handlePrint(p); }}
                      >🖨</button>
                    )}
                    {p.status === "REQUESTED" && (
                      <>
                        <button
                          type="button"
                          className="ds-iconbtn ds-iconbtn-edit"
                          title="Edit this pending request"
                          aria-label={`Edit pending request for ${p.name}`}
                          onClick={(e) => { e.stopPropagation(); openEdit(p); }}
                        >✎</button>
                        <button
                          type="button"
                          className="ds-iconbtn ds-iconbtn-cancel"
                          title="Cancel this pending request"
                          aria-label={`Cancel pending request for ${p.name}`}
                          onClick={(e) => { e.stopPropagation(); handleCancelRequest(p); }}
                        >✕</button>
                      </>
                    )}

                    <span className="ds-row-chevron" aria-hidden="true">›</span>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <footer className="ds-foot">
          <span className="ds-foot-note">{footNote}</span>
          <span className="ds-foot-hint">click a pass for its full details</span>
        </footer>
      </div>

      {/* ---------- part 2 · smart student search ---------- */}
      <div className="ds-card ds-searchcard">
        <div className="ds-searchbar">
          <div className="ds-searchbar-head">
            <span className="ds-searchbar-label">Smart student search</span>
            <span className="ds-searchbar-sub">results load straight into the manual box above</span>
          </div>
          <div className="ds-searchfield">
            <span className="ds-searchicon" aria-hidden="true">🔍</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => onSearchFocus?.(true)}   /* typing here pauses the RFID scanner */
              onBlur={() => onSearchFocus?.(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); if (searchResults.length > 0) useStudent(searchResults[0]); }
                else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setSearch(""); }
              }}
              placeholder="Name, class, ID no — or any part of an RFID number…"
              spellCheck={false}
              autoComplete="off"
              aria-label="Smart student search"
            />
            {search && (
              <button type="button" className="ds-searchclear" onClick={() => setSearch("")} aria-label="Clear search">✕</button>
            )}
          </div>
        </div>

        {search.trim() === "" ? (
          <p className="ds-searchhint">
           
          </p>
        ) : (
          <div className="ds-resultswrap">
            {!synced ? (
              <p className="ds-searchhint">Loading students…</p>
            ) : searchResults.length === 0 ? (
              <div className="ds-empty ds-empty-slim">
                <p>No student matches “{search}” — try the surname, the class, the ID number, or part of the RFID.</p>
              </div>
            ) : (
              <>
                <div className="ds-results-meta">
                  <strong>{searchResults.length}</strong> match{searchResults.length === 1 ? "" : "es"} for “{search}”
                  {searchResults.length > RESULT_LIMIT && <span> · showing the first {RESULT_LIMIT} — refine the search</span>}
                </div>
                <div className="ds-results">
                  {searchResults.slice(0, RESULT_LIMIT).map((s) => (
                    <div
                      key={s._id}
                      className="ds-result"
                      role="button"
                      tabIndex={0}
                      onClick={() => useStudent(s)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); useStudent(s); } }}
                      aria-label={`Use ${s.name} — enter RFID into the manual box`}
                    >
                      <span className="ds-avatar">{getInitials(s.name)}</span>
                      <div className="ds-result-main">
                        <span className="ds-result-name" title={s.name}>{s.name}</span>
                        <div className="ds-result-meta">
                          <span className="ds-chip">{s.className}</span>
                          <span className="ds-chip ds-chip-mono">{s.rfid || "no RFID"}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="ds-enterbtn"
                        disabled={!s.rfid}
                        title={s.rfid ? "Enter this RFID into the manual box above" : "No RFID on record for this student"}
                        onClick={(e) => { e.stopPropagation(); useStudent(s); }}
                      >↵ Enter</button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ---------- detail modal ---------- */}
      {liveDetail && (() => {
        const meta = STATUS_META[liveDetail.status] || { label: liveDetail.status, icon: "•", tone: "slate" };
        return (
          <div className="ds-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeDetail(); }}>
            <div className="ds-modal ds-modal-detail" role="dialog" aria-modal="true" aria-labelledby="ds-detail-title">
              <button type="button" className="ds-modal-x" onClick={closeDetail} aria-label="Close details">✕</button>

              <div className="ds-modal-head">
                <span className="ds-avatar ds-avatar-lg">{getInitials(liveDetail.name)}</span>
                <div className="ds-modal-id">
                  <h3 id="ds-detail-title">{liveDetail.name}</h3>
                  <div className="ds-modal-chips">
                    <span className="ds-chip">{liveDetail.className}</span>
                    <span className="ds-chip ds-chip-mono">{liveDetail.studentId}</span>
                    {liveDetail.rfid && <span className="ds-chip ds-chip-mono ds-chip-soft">{liveDetail.rfid}</span>}
                  </div>
                </div>
                <div className="ds-modal-badges">
                  <span className={`ds-kind ds-kind-${liveDetail.kind === "STUDENT_PASS" ? "student" : "day"}`}>
                    {liveDetail.kind === "STUDENT_PASS" ? "Student Pass" : "Day Pass"}
                  </span>
                  <span className={`ds-badge ds-badge-${meta.tone}`}>{meta.icon} {meta.label}</span>
                </div>
              </div>

              <div className="ds-modal-body">
                <div className="ds-grid">
                  <div className="ds-mfield ds-mfield-wide">
                    <span className="ds-mfield-label">Reason</span>
                    <p className="ds-mfield-value">{liveDetail.reason}</p>
                  </div>
                  <div className="ds-mfield">
                    <span className="ds-mfield-label">Expected return</span>
                    <span className="ds-mfield-value">{fmtExpected(liveDetail.expectedReturn)}</span>
                  </div>
                  <div className="ds-mfield">
                    <span className="ds-mfield-label">Going with</span>
                    <span className={`ds-mfield-value ${liveDetail.goingWith ? "" : "ds-mfield-dim"}`}>{fmtGoingWith(liveDetail)}</span>
                  </div>
                  {liveDetail.slipNo && (
                    <div className="ds-mfield">
                      <span className="ds-mfield-label">Slip number</span>
                      <span className="ds-mfield-value ds-mfield-mono">{liveDetail.slipNo}</span>
                    </div>
                  )}
                  {liveDetail.authorizedBy && (
                    <div className="ds-mfield">
                      <span className="ds-mfield-label">Authorized by</span>
                      <span className="ds-mfield-value">{liveDetail.authorizedBy}</span>
                    </div>
                  )}
                  {liveDetail.approvedBy && (
                    <div className="ds-mfield">
                      <span className="ds-mfield-label">Approved by</span>
                      <span className="ds-mfield-value">{liveDetail.approvedBy}</span>
                    </div>
                  )}
                  <div className="ds-mfield">
                    <span className="ds-mfield-label">Raised</span>
                    <span className="ds-mfield-value">{fmtStamp(liveDetail.requestedAt || liveDetail.createdAt)}</span>
                  </div>
                  <div className="ds-mfield">
                    <span className="ds-mfield-label">Last activity</span>
                    <span className="ds-mfield-value">{fmtStamp(activityTime(liveDetail))}</span>
                  </div>
                </div>

                <h4 className="ds-timeline-title">Pass timeline</h4>
                <ol className="ds-timeline">
                  {timelineItems(liveDetail).map((it, idx, arr) => {
                    const isCurrent = idx === arr.length - 1;
                    return (
                      <li key={it.key} className={`ds-tl-item ${isCurrent ? "ds-tl-current ds-tl-tone-" + meta.tone : ""}`}>
                        <span className="ds-tl-dot">{it.icon}</span>
                        <div className="ds-tl-body">
                          <span className="ds-tl-label">{it.label}</span>
                          {it.note && <span className="ds-tl-note">{it.note}</span>}
                          <span className="ds-tl-time">{fmtStamp(it.time)}{it.time ? ` · ${timeAgo(it.time)}` : ""}</span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>

              <footer className="ds-modal-foot">
                <button type="button" className="ds-btn ds-btn-ghost" onClick={closeDetail}>Close</button>
                {liveDetail.status === "REQUESTED" && (
                  <>
                    <button type="button" className="ds-btn ds-btn-ghost" onClick={() => openEdit(liveDetail)}>✎ Edit Request</button>
                    <button type="button" className="ds-btn ds-btn-danger" onClick={() => handleCancelRequest(liveDetail)}>✕ Cancel Request</button>
                  </>
                )}
                {liveDetail.status === "APPROVED" && (
                  <button type="button" className="ds-btn ds-btn-primary" onClick={() => handlePrint(liveDetail)}>🖨 Print Pass</button>
                )}
              </footer>
            </div>
          </div>
        );
      })()}

      {/* ---------- edit request modal ---------- */}
      {editPass && editForm && (
        <div className="ds-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeEdit(); }}>
          <div className="ds-modal ds-modal-edit" role="dialog" aria-modal="true" aria-labelledby="ds-edit-title">
            <div className="ds-modal-head">
              <div className="ds-modal-id">
                <h3 id="ds-edit-title">✎ Edit Pending Request</h3>
                <p className="ds-modal-sub">{editPass.name} · {editPass.className} · {editPass.studentId}</p>
              </div>
              <button type="button" className="ds-modal-x" onClick={closeEdit} aria-label="Close editor">✕</button>
            </div>

            <div className="ds-modal-body">
              <div className="ds-fields">
                <div className="ds-field">
                  <label htmlFor="ds-edit-reason">Reason *</label>
                  <select id="ds-edit-reason" name="reason" className="ds-input ds-select" value={editForm.reason} onChange={handleEditFormChange}>
                    <option value="" disabled>— select a reason —</option>
                    {reasonOptions.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>

                <div className="ds-field-row">
                  <div className="ds-field">
                    <label htmlFor="ds-edit-date">Return date *</label>
                    <input id="ds-edit-date" name="returnDate" type="date" className="ds-input" value={editForm.returnDate} onChange={handleEditFormChange} />
                  </div>
                  <div className="ds-field">
                    <label htmlFor="ds-edit-time">Return time *</label>
                    <input id="ds-edit-time" name="returnTime" type="time" className="ds-input" value={editForm.returnTime} onChange={handleEditFormChange} />
                  </div>
                </div>

                <div className="ds-field">
                  <label htmlFor="ds-edit-gw">Going with *</label>
                  <select id="ds-edit-gw" name="goingWith" className="ds-input ds-select" value={editForm.goingWith} onChange={handleEditFormChange}>
                    {GOING_WITH_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>

                {(editForm.goingWith === "Guardian" || editForm.goingWith === "Staff") && (
                  <div className="ds-field ds-gw-name">
                    <label htmlFor="ds-edit-gwname">Name of the {editForm.goingWith.toLowerCase()}</label>
                    <input
                      id="ds-edit-gwname"
                      name="goingWithName"
                      className="ds-input"
                      value={editForm.goingWithName}
                      onChange={handleEditFormChange}
                      placeholder={editForm.goingWith === "Staff" ? "e.g. Mr. Suresh" : "e.g. Mrs. Mary Thomas"}
                      autoComplete="off"
                    />
                  </div>
                )}

                {editError && <p className="ds-alert">⚠ {editError}</p>}

                <p className="ds-modal-note">
                  Only the request details change — the student stays in the pending list until the Principal decides.
                </p>
              </div>
            </div>

            <footer className="ds-modal-foot">
              <button type="button" className="ds-btn ds-btn-ghost" onClick={closeEdit}>Cancel</button>
              <button type="button" className="ds-btn ds-btn-primary" onClick={handleEditSave}>Save Changes</button>
            </footer>
          </div>
        </div>
      )}

      {/* ---------- toast ---------- */}
      <div aria-live="polite">
        {toast && (
          <div key={toast.id} className={`ds-toast ds-toast-${toast.type}`}>
            <span className="ds-toast-icon">{toast.type === "success" ? "✓" : "⚠"}</span>
            <span>{toast.text}</span>
          </div>
        )}
      </div>
    </div>
  );
}