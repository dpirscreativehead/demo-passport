import React, { useState, useEffect, useRef, useCallback } from "react";
import { ref, onValue, set, update } from "firebase/database";
import { database } from "../../../firebase/config"; // ← same config the Students page uses — adjust the relative path if this component sits at a different depth
import "./PassIssue.css";
import PassIssueSupport from "./PassIssueSupport"; // ← new support section (pass tabs + smart search)

/* =====================================================================
   PASS ISSUE DESK — the gate operator's main working screen
   ---------------------------------------------------------------------
   • RFID scanning with a deliberate rhythm:
       – The scanner is LIVE only when the desk is free: no form open,
         nobody typing in the manual box, and no result under review.
       – After EVERY read — a card scan OR a manual Find — the scanner
         PAUSES right away. It re-arms when the operator presses
         [Next Scan] or automatically after 10 seconds.
       – While the operator types in the manual input, the scanner is
         paused: machine-speed keystrokes are swallowed before they
         reach the field. Only real human input ever lands in the box.
   • Any USB / HID reader that "types" the card code fast and finishes
     with ENTER is caught anywhere on the page — no input has to be
     focused. Human typing never matches the timing pattern.
   • Manual fallback: type an ID number (or RFID) and press Find.
   • FIXED-HEIGHT layout — the scanner row and the result panel never
     change height. Buttons appear / disappear inside a reserved zone.
   • Status flow
       IN        → [Issue Pass]  (reason · return date+time · authorized
                                  by → prints the 80mm thermal slip →
                                  student marked OUT)
                   [Request Day Pass] (reason · return date → stored for
                                  the Principal to approve)
       OUT       → [Mark In]
       REQUESTED → amber "pending approval" state
                   [Cancel Request] → withdraws the request instantly
       APPROVED  → [Print Day Pass] → thermal slip → student OUT
       OUT+pass  → [Mark In] (closes the active day pass)
   • PASS HISTORY — when a student is on the panel, every record found
     for them in ANY pass collection is listed with its live status
     (Pending / Approved / Issued / Returned / Rejected / Cancelled).
   • DATA LIVES IN FIREBASE REALTIME DATABASE (live onValue sync):
       – students             → student master data (shared with the
                                Students page)
       – studentPass          → passes issued directly at this desk
       – requested            → day-pass requests waiting for the
                                Principal (+ old cancelled records)
       – daypass              → Principal-APPROVED passes — the approval
                                desk (RequestManage) moves them here on
                                approval. Printing flips the status to
                                ISSUED in place; returning flips it to
                                RETURNED. Student status follows along.
       – rejectedStudentPass  → rejected requests, kept permanently as
                                records (shown in the history strip)
     Every pass action ALSO updates the student's status field in the
     students collection, so the Students page always matches.
   ===================================================================== */

/* ---------------- constants ---------------- */
const DB_STUDENTS_PATH  = "students";              // student master data (shared with the Students page)
const DB_DAYPASS_PATH   = "studentPass";           // passes issued directly at the gate desk (Issue Pass button)
const DB_REQUEST_PATH   = "studentRequest";        // PENDING day-pass requests ONLY — waiting for the Principal
const DB_APPROVED_PATH  = "daypass";               // Principal-APPROVED passes (RequestManage moves them here)
const DB_REJECTED_PATH  = "rejectedStudentPass";   // rejected requests — permanent records
const DB_CANCELLED_PATH = "cancelledStudentPass";  // requests cancelled at the gate desk — permanent records

const SCHOOL_NAME = "De Paul International Residential School, Mysore";      // ← printed on every slip

const ACTIVE_PASS_STATUSES = ["REQUESTED", "APPROVED", "ISSUED"];
const PRESENCE_VALUES = ["IN", "OUT", "REQUESTED", "APPROVED"];             // statuses the students collection may hold

const SCAN_COOLDOWN_MS = 10000;   // review pause after a card read OR a manual Find — one number for both
const MACHINE_GAP_MS = 45;        // keys arriving faster than this are the reader, never a person

const HISTORY_LIMIT = 5;          // recent records shown in the history strip

const REASON_OPTIONS = [
  "Medical Appointment",
  "Not feeling well, going home",
  "Family function at home",
  "Picked up early by parent",
  "Inter-school competition",
  "National / state-level Competetions",
];
const AUTH_OPTIONS = ["Principal", "Vice Principal", "Class Teacher", "Office / Front Desk"];
const GOING_WITH_OPTIONS = ["Parent", "Guardian", "Staff"];   // who the student leaves with — name asked only for Guardian / Staff

/* ---------------- small helpers ---------------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${d.toLocaleDateString([], { day: "2-digit", month: "short" })}`;
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

/* ---------- Firebase nodes → clean arrays ---------- */
function sanitizeStudents(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return [];
  return Object.entries(val).map(([key, s]) => ({
    ...s,
    _id: String((s && s._id) || key),
    rfid: normalizeRfid(s && s.rfid),
    studentId: String((s && s.studentId) || "").trim(),
    name: String((s && s.name) || "").trim(),
    className: String((s && s.className) || "").trim(),
    status: normalizePresence(s && s.status),
    lastMovement: (s && s.lastMovement) || null,
  }));
}

/* "in" / "IN" → "IN" · anything missing or unknown → "IN" */
function normalizePresence(v) {
  const s = String(v || "").trim().toUpperCase();
  return PRESENCE_VALUES.indexOf(s) !== -1 ? s : "IN";
}

/* a pass collection node ({ "<_id>": { …pass } }) → array */
function sanitizePasses(val) {
  if (!val || typeof val !== "object") return [];
  return Object.entries(val)
    .map(([key, p]) => ({ ...p, _id: String((p && p._id) || key) }))
    .filter((p) => p && p._id);
}

/* latest still-open pass of this student (REQUESTED / APPROVED / ISSUED) */
function findActivePass(passes, student) {
  if (!student) return null;
  const list = (passes || [])
    .filter((p) => (p.studentKey && p.studentKey === student._id) || (p.studentId && p.studentId === student.studentId))
    .filter((p) => ACTIVE_PASS_STATUSES.indexOf(p.status) !== -1)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return list[0] || null;
}

/* what the panel should show for this student right now */
function resolveView(student, passes) {
  const pass = findActivePass(passes, student);
  if (pass) {
    if (pass.status === "REQUESTED") return { state: "REQUESTED", pass };
    if (pass.status === "APPROVED") return { state: "APPROVED", pass };
    return { state: "OUT_PASS", pass };            // out on an issued day pass
  }
  return student.status === "OUT" ? { state: "OUT", pass: null } : { state: "IN", pass: null };
}

/* running slip number for today: DP-YYYYMMDD-001 … */
function makeSlipNo(passes) {
  const d = new Date();
  const today = d.toDateString();
  const n = (passes || []).filter((x) => x.issuedAt && new Date(x.issuedAt).toDateString() === today).length + 1;
  return `DP-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${String(n).padStart(3, "0")}`;
}

/* ---------- pass-history helpers (all collections, live) ---------- */
const HISTORY_KEYS = ["requested", "approved", "issued", "returned", "rejected", "cancelled"];

function histKey(status) {
  const s = String(status || "").trim().toLowerCase();
  return HISTORY_KEYS.indexOf(s) !== -1 ? s : "other";
}
function histLabel(status) {
  const s = String(status || "").trim().toUpperCase();
  return (
    {
      REQUESTED: "Pending",
      APPROVED: "Approved",
      ISSUED: "Issued",
      RETURNED: "Returned",
      REJECTED: "Rejected",
      CANCELLED: "Cancelled",
    }[s] || s || "—"
  );
}
/* the moment this record last "happened" — used for sorting + display */
function histTime(p) {
  return p.issuedAt || p.printedAt || p.rejectedAt || p.cancelledAt || p.approvedAt || p.requestedAt || p.createdAt || null;
}
function histWho(p) {
  const s = String(p.status || "").toUpperCase();
  if (s === "REJECTED") return p.rejectedBy ? `Rejected by ${p.rejectedBy}` : "";
  if (s === "APPROVED") return p.approvedBy ? `Approved by ${p.approvedBy}` : "";
  if (s === "ISSUED" || s === "RETURNED") return p.authorizedBy ? `Authorized by ${p.authorizedBy}` : "";
  return "";
}

/* ---------- student pass vs day pass ---------- */
/* a pass is a STUDENT pass when it came from the Issue Pass button
   ("studentPass" collection) — request / approved / printed day passes
   keep the DAY PASS labels */
function isStudentPass(p) {
  return String((p && p.kind) || "").toUpperCase() === "STUDENT_PASS";
}

/* "Going with" — Parent needs no name · Guardian / Staff show their name */
function fmtGoingWith(p) {
  if (!p) return "—";
  const who = String(p.goingWith || "").trim();
  if (!who) return "—";
  const name = String(p.goingWithName || "").trim();
  return name ? `${who} · ${name}` : who;
}

/* every record of this student across ALL pass collections, newest first */
function getStudentHistory(allPasses, student) {
  if (!student) return [];
  const seen = new Set();
  return (allPasses || [])
    .filter((p) => (p.studentKey && p.studentKey === student._id) || (p.studentId && p.studentId === student.studentId))
    .filter((p) => { if (seen.has(p._id)) return false; seen.add(p._id); return true; })
    .sort((a, b) => new Date(histTime(b) || 0) - new Date(histTime(a) || 0));
}

/* ---------- little gate-desk beeps (silent if audio is blocked) ---------- */
let _audioCtx = null;
function beep(ok) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _audioCtx = _audioCtx || new AC();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const t0 = _audioCtx.currentTime;
    const blip = (freq, at, dur) => {
      const o = _audioCtx.createOscillator();
      const g = _audioCtx.createGain();
      o.type = "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.14, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g); g.connect(_audioCtx.destination);
      o.start(t0 + at); o.stop(t0 + at + dur + 0.03);
    };
    if (ok) blip(1250, 0, 0.14);
    else { blip(340, 0, 0.12); blip(340, 0.17, 0.12); }
  } catch { /* no audio available — ignore */ }
}

/* ---------- 80 mm thermal slip (printed through a hidden iframe) ---------- */
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

/* ---------- 80 mm thermal ENTRY slip — printed when [Mark In] is pressed.
   Exactly the same look as the exit slip: school title · "ENTRY PASS" ·
   the pass's slip number · student / class / ID No · reason autofilled
   from the pass being closed · check-in time = the moment the button was
   pressed. Printed through the same hidden-iframe method as printSlip. ---------- */
function printEntrySlip(pass, nowIso) {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const checkedInAt = new Date(nowIso || Date.now());

  const rows = [
    ["Student", pass.name || "—"],
    ["Class", pass.className || "—"],
    ["ID No", pass.studentId || "—"],
    ["Reason", pass.reason || "—"],
  ]
    .map(([k, v]) => `<div class="r"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
    .join("");

  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Entry Pass ${esc(pass.slipNo || "")}</title><style>` +
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
    `<div class="c slip">ENTRY PASS</div>` +
    `<div class="c no">${esc(pass.slipNo || "")}</div>` +
    `<div class="hr"></div>${rows}<div class="hr"></div>` +
    `<div class="c stamp">Checked in: ${esc(checkedInAt.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }))}</div>` +
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

export default function PassIssue() {
  /* ================= STATE ================= */
  const [current, setCurrent] = useState(null);     // student shown in the panel
  const [view, setView] = useState(null);           // { state, pass } resolved for current
  const [notFound, setNotFound] = useState(null);   // { type, value } unknown card / ID
  const [scan, setScan] = useState({ status: "ready", code: "" });
  const [manualId, setManualId] = useState("");

  const [manualFocus, setManualFocus] = useState(false);   // operator is typing in the manual box → scanner paused
  const [cooldown, setCooldown] = useState(null);          // { endsAt } → review pause after a read (card OR manual)
  const [cooldownLeft, setCooldownLeft] = useState(0);     // seconds remaining on the review pause

  const [issueOpen, setIssueOpen] = useState(false);
  const [issueForm, setIssueForm] = useState({ reason: "", returnDate: "", returnTime: "", authorizedBy: "", goingWith: "Parent", goingWithName: "" });
  const [issueError, setIssueError] = useState("");

  const [requestOpen, setRequestOpen] = useState(false);
  const [requestForm, setRequestForm] = useState({ reason: "", returnDate: "", returnTime: "", goingWith: "Parent", goingWithName: "" });
  const [requestError, setRequestError] = useState("");

  const [toast, setToast] = useState(null);
  const [clock, setClock] = useState(() => new Date());

  /* ================= REFS ================= */
  const currentKeyRef = useRef(null);
  const scanHandlerRef = useRef(null);
  const overlayOpenRef = useRef(false);
  const issueStudentRef = useRef(null);
  const requestStudentRef = useRef(null);

  /* live Firebase mirrors — these ARE the store now */
  const studentsRef = useRef([]);       // "students"
  const issuedRef = useRef([]);         // "studentPass" — issued at this desk
  const requestedRef = useRef([]);      // "requested" — requests (+ old cancelled records)
  const approvedRef = useRef([]);       // "daypass" — Principal-approved passes
  const rejectedRef = useRef([]);       // "rejectedStudentPass" — rejected records
  const cancelledRef = useRef([]);      // "cancelledStudentPass" — cancelled-request records
  const storesReadyRef = useRef(false); // first students snapshot arrived from Firebase?

  const manualFocusRef = useRef(false);      // mirrors manualFocus for the key listener
  const cooldownRef = useRef(false);         // mirrors cooldown for the key listener
  const cooldownTimerRef = useRef(null);     // the 10 s auto re-arm timeout

  const manualInputRef = useRef(null);
  const issueReasonRef = useRef(null);
  const issueDateRef = useRef(null);
  const issueTimeRef = useRef(null);
  const issueAuthRef = useRef(null);
  const requestReasonRef = useRef(null);
  const requestDateRef = useRef(null);

  const toastTimerRef = useRef(null);
  const scanResetRef = useRef(null);

  /* clock — ticks every second */
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  /* the scanner pauses while one of our forms is open */
  useEffect(() => { overlayOpenRef.current = issueOpen || requestOpen; }, [issueOpen, requestOpen]);

  /* countdown display while the review pause is running */
  useEffect(() => {
    if (!cooldown) { setCooldownLeft(0); return; }
    const tick = () => setCooldownLeft(Math.max(0, Math.ceil((cooldown.endsAt - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 200);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => () => { if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current); }, []);

  /* ================= TOAST ================= */
  const showToast = useCallback((text, type = "success") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), text, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  /* ================= SCAN BOX FLASH ================= */
  const setScanResult = useCallback((ok, code) => {
    setScan({ status: ok ? "ok" : "error", code });
    if (scanResetRef.current) clearTimeout(scanResetRef.current);
    scanResetRef.current = setTimeout(() => setScan((s) => ({ ...s, status: "ready" })), 2400);
  }, []);
  useEffect(() => () => { if (scanResetRef.current) clearTimeout(scanResetRef.current); }, []);

  /* ================= SCANNER ARM / PAUSE ================= */
  const armScanner = useCallback(() => {
    if (cooldownTimerRef.current) { clearTimeout(cooldownTimerRef.current); cooldownTimerRef.current = null; }
    cooldownRef.current = false;
    setCooldown(null);
  }, []);

  const startCooldown = useCallback(() => {
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
    cooldownRef.current = true;
    const endsAt = Date.now() + SCAN_COOLDOWN_MS;
    setCooldown({ endsAt });
    cooldownTimerRef.current = setTimeout(() => {
      cooldownTimerRef.current = null;
      cooldownRef.current = false;
      setCooldown(null);
    }, SCAN_COOLDOWN_MS);
  }, []);

  const handleNextScan = useCallback(() => {
    armScanner();
    setScan((s) => (s.status === "ready" ? s : { status: "ready", code: s.code }));
  }, [armScanner]);

  /* ================= FIREBASE LIVE STORES ================= */

  /* passes that can still be "active" for a student — used by resolveView,
     findActivePass and makeSlipNo */
  const readPasses = useCallback(
    () => [...issuedRef.current, ...approvedRef.current, ...requestedRef.current],
    []
  );

  /* EVERY pass record in EVERY collection — used by the history strip */
    const readAllPasses = useCallback(
    () => [...issuedRef.current, ...approvedRef.current, ...requestedRef.current, ...rejectedRef.current, ...cancelledRef.current],
    []
  );

  const readStudents = useCallback(() => studentsRef.current, []);

  const findLiveStudent = useCallback((student) =>
    studentsRef.current.find((s) =>
      (student._id && s._id === student._id) ||
      (student.studentId && s.studentId === student.studentId)) || null
  , []);

  /* write a presence change back into the students collection in Firebase */
  const setStudentStatus = useCallback((student, status, isoTime) => {
    const live = findLiveStudent(student);
    if (!live) return;
    const patch = isoTime ? { status, lastMovement: isoTime } : { status };
    studentsRef.current = studentsRef.current.map((s) => (s._id === live._id ? { ...s, ...patch } : s));
    update(ref(database, `${DB_STUDENTS_PATH}/${live._id}`), patch)
      .catch(() => showToast("⚠ Could not update the student's status — check your Firebase connection / rules.", "error"));
  }, [findLiveStudent, showToast]);

  /* store a brand-new pass record in its Firebase collection */
  const writePass = useCallback((node, pass) => {
    if (node === DB_REQUEST_PATH) requestedRef.current = [pass, ...requestedRef.current];
    else if (node === DB_APPROVED_PATH) approvedRef.current = [pass, ...approvedRef.current];
    else issuedRef.current = [pass, ...issuedRef.current];
    set(ref(database, `${node}/${pass._id}`), pass)
      .catch(() => showToast("⚠ Could not save the pass — check your Firebase connection / rules.", "error"));
  }, [showToast]);

  /* patch a few fields of an existing pass, wherever it is stored —
     the pass may live in "studentPass", "daypass" or "requested" */
  const patchPass = useCallback((pass, patch) => {
    const inIssued = issuedRef.current.some((p) => p._id === pass._id);
    const inApproved = !inIssued && approvedRef.current.some((p) => p._id === pass._id);
    const apply = (list) => list.map((p) => (p._id === pass._id ? { ...p, ...patch } : p));
    if (inIssued) issuedRef.current = apply(issuedRef.current);
    else if (inApproved) approvedRef.current = apply(approvedRef.current);
    else requestedRef.current = apply(requestedRef.current);
    const node = inIssued ? DB_DAYPASS_PATH : inApproved ? DB_APPROVED_PATH : DB_REQUEST_PATH;
    update(ref(database, `${node}/${pass._id}`), patch)
      .catch(() => showToast("⚠ Could not update the pass — check your Firebase connection / rules.", "error"));
  }, [showToast]);

  /* ================= SHOW / REFRESH STUDENT ================= */
  const showStudent = useCallback((student) => {
    currentKeyRef.current = student._id || student.studentId;
    setNotFound(null);
    setCurrent(student);
    setView(resolveView(student, readPasses()));
  }, [readPasses]);

  /* re-read the live mirrors and re-resolve the student on the panel */
  const refreshCurrent = useCallback(() => {
    const key = currentKeyRef.current;
    if (!key) return;
    const students = readStudents();
    const student = students.find((s) => s._id === key) || students.find((s) => s.studentId === key) || null;
    if (!student) { currentKeyRef.current = null; setCurrent(null); setView(null); return; }
    setCurrent(student);
    setView(resolveView(student, readPasses()));
  }, [readStudents, readPasses]);

  /* ================= FIREBASE REAL-TIME SYNC =================
     Five live subscriptions:
       · students             — master data
       · studentPass          — passes issued at this desk
       · requested            — day-pass requests
       · daypass              — Principal-APPROVED passes  ← the approval desk writes here
       · rejectedStudentPass  — rejected records           ← the approval desk writes here
     Every mirror refresh re-resolves the student on the panel AND the
     history strip, the moment anything changes — here, in another tab,
     or on any other device. */
  useEffect(() => {
    const onStudents = (snap) => {
      studentsRef.current = sanitizeStudents(snap.val());
      storesReadyRef.current = true;
      refreshCurrent();
    };
    const onIssued = (snap) => {
      /* everything in the "studentPass" collection comes from the Issue Pass
         button → STUDENT pass. Force the kind in the local mirror so OLD
         records (stored with kind "DAY_PASS" before the fix) also display
         correctly. New records are written with the right kind already. */
      issuedRef.current = sanitizePasses(snap.val()).map((p) => ({ ...p, kind: "STUDENT_PASS" }));
      refreshCurrent();
    };
    const onRequested = (snap) => {
      requestedRef.current = sanitizePasses(snap.val());
      refreshCurrent();
    };
    const onApproved = (snap) => {
      approvedRef.current = sanitizePasses(snap.val());
      refreshCurrent();
    };
        const onRejected = (snap) => {
      rejectedRef.current = sanitizePasses(snap.val());
      refreshCurrent();
    };
    const onCancelled = (snap) => {
      cancelledRef.current = sanitizePasses(snap.val());
      refreshCurrent();
    };

    const unsubs = [
      onValue(ref(database, DB_STUDENTS_PATH), onStudents, (err) => {
        storesReadyRef.current = true;
        showToast(`⚠ Firebase sync error: ${err.message}`, "error");
      }),
      onValue(ref(database, DB_DAYPASS_PATH), onIssued, () => { /* node absent / not readable — requests still work */ }),
      onValue(ref(database, DB_REQUEST_PATH), onRequested, () => { /* node absent / not readable — issued passes still work */ }),
      onValue(ref(database, DB_APPROVED_PATH), onApproved, () => { /* node absent / not readable yet */ }),
      onValue(ref(database, DB_REJECTED_PATH), onRejected, () => { /* node absent / not readable yet */ }),
      onValue(ref(database, DB_CANCELLED_PATH), onCancelled, () => { /* node absent / not readable yet */ }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [refreshCurrent, showToast]);

  /* ================= RFID SCAN ================= */
  const handleScan = useCallback((code) => {
    const norm = normalizeRfid(code);
    if (!norm) return;

    if (!storesReadyRef.current) {
      beep(false);
      showToast("⚠ Loading....Please Wait", "error");
      startCooldown();
      return;
    }

    setManualId("");
    const student = readStudents().find((s) => normalizeRfid(s.rfid) === norm) || null;

    if (student) {
      showStudent(student);
      setScanResult(true, norm);
      beep(true);
    } else {
      currentKeyRef.current = null;
      setCurrent(null); setView(null);
      setNotFound({ type: "rfid", value: norm });
      setScanResult(false, norm);
      beep(false);
      showToast(`⚠ Card ${norm} is not registered.`, "error");
    }

    startCooldown();
  }, [showStudent, setScanResult, showToast, startCooldown, readStudents]);

  useEffect(() => { scanHandlerRef.current = handleScan; }, [handleScan]);

  /* ================= GLOBAL KEY LISTENER =================
     (unchanged — RFID burst detection + field protection) */
  useEffect(() => {
    let buf = "";
    let lastKeyAt = 0;
    let fastRun = 0;
    let pendingLeak = null;
    let resetTimer = null;

    const snapshotFor = (t) => {
      if (!t || (t.tagName !== "INPUT" && t.tagName !== "TEXTAREA")) return null;
      if (t.readOnly || t.disabled) return null;
      return { el: t, value: t.value };
    };

    const restoreLeak = () => {
      const p = pendingLeak;
      pendingLeak = null;
      if (!p || !p.el || !p.el.isConnected) return;
      if (p.el.value === p.value) return;
      try {
        const proto = p.el.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(p.el, p.value); else p.el.value = p.value;
        p.el.dispatchEvent(new Event("input", { bubbles: true }));
      } catch { /* ignore */ }
    };

    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const now = Date.now();
      const gap = now - lastKeyAt;
      lastKeyAt = now;

      const paused =
        overlayOpenRef.current ||
        cooldownRef.current ||
        manualFocusRef.current ||
        !!document.querySelector(".ds-overlay, .sm-overlay");

      /* ---------- scanner paused — protect whatever is focused ---------- */
      if (paused) {
        if (e.key === "Enter") {
          if (fastRun >= 1 && gap > 0 && gap <= 100) {
            e.preventDefault();
            restoreLeak();
          }
          fastRun = 0;
          pendingLeak = null;
          return;
        }
        if (e.key.length === 1) {
          if (e.repeat) { pendingLeak = null; return; }
          if (gap > 0 && gap <= MACHINE_GAP_MS) {
            e.preventDefault();
            fastRun += 1;
            if (fastRun >= 2) restoreLeak();
            return;
          }
          fastRun = 0;
          pendingLeak = snapshotFor(e.target);
          return;
        }
        fastRun = 0;
        pendingLeak = null;
        return;
      }

      /* ---------- scanner live ---------- */
      if (e.key === "Enter") {
        const code = buf;
        buf = "";
        if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
        if (code.length >= 4 && gap > 0 && gap <= 100) {
          e.preventDefault();
          if (scanHandlerRef.current) scanHandlerRef.current(code);
        } else if (fastRun >= 1 && gap > 0 && gap <= 100) {
          e.preventDefault();
        }
        fastRun = 0;
        return;
      }

      if (e.key.length === 1) {
        if (e.repeat) return;
        if (/[a-zA-Z0-9]/.test(e.key)) {
          if (gap > 100) { buf = ""; fastRun = 0; }
          fastRun += 1;
          buf += e.key;
          if (resetTimer) clearTimeout(resetTimer);
          resetTimer = setTimeout(() => { buf = ""; }, 400);
        } else {
          buf = "";
          if (gap > 100) fastRun = 0;
        }
        return;
      }

      buf = "";
      fastRun = 0;
    };

    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); if (resetTimer) clearTimeout(resetTimer); };
  }, []);

  /* ================= SUPPORT SECTION CALLBACKS ================= */
  /* the smart-search box below borrows the manual input's pause
     mechanism — while the operator types there, the RFID scanner is
     paused so keystrokes can never be mistaken for a card read */
  const handleSupportFocus = (focused) => {
    manualFocusRef.current = focused;
    setManualFocus(focused);
  };

  /* ↵ Enter on a search result → the RFID lands in the manual box,
     focused and selected — one Find click away, no re-scanning */
  const handleUseRfid = (rfid) => {
    const norm = normalizeRfid(rfid);
    if (!norm) return;
    setManualId(norm);
    setTimeout(() => {
      manualInputRef.current?.focus();
      manualInputRef.current?.select();
    }, 40);
  };

  /* ================= MANUAL LOOKUP ================= */
    const handleManualFind = () => {
    const q = manualId.trim();

    if (!storesReadyRef.current) {
      beep(false);
      showToast("⚠ Loading...Please Wait.", "error");
      return;
    }

    const students = readStudents();
    const ql = q.toLowerCase();
    const student =
      students.find((s) => s.studentId.toLowerCase() === ql) ||
      students.find((s) => normalizeRfid(s.rfid) === normalizeRfid(q)) ||
      null;

    if (student) {
      showStudent(student);
      setManualId("");
      manualInputRef.current?.blur();
      beep(true);
      startCooldown();
    } else {
      currentKeyRef.current = null;
      setCurrent(null); setView(null);
      setNotFound({ type: "manual", value: q });
      beep(false);
      showToast(`⚠ No student found for "${q}".`, "error");
    }
  };

  /* ================= ISSUE PASS (form → print → OUT) ================= */
  const openIssueForm = () => {
    if (!current) return;
    issueStudentRef.current = current;
    setIssueForm({ reason: "", returnDate: todayStr(), returnTime: nextHalfHour(1), authorizedBy: "", goingWith: "Parent", goingWithName: "" });
    setIssueError("");
    setIssueOpen(true);
  };
  const closeIssue = () => setIssueOpen(false);

  useEffect(() => { if (issueOpen) setTimeout(() => issueReasonRef.current?.focus(), 60); }, [issueOpen]);

    const handleIssueChange = (e) => {
    const { name, value } = e.target;
    setIssueForm((f) => ({
      ...f,
      [name]: value,
      /* the name is only kept for Guardian / Staff — cleared otherwise */
      ...(name === "goingWith" && value !== "Guardian" && value !== "Staff" ? { goingWithName: "" } : {}),
    }));
    setIssueError("");
  };

  const handleIssue = () => {
    const student = issueStudentRef.current;
    if (!student) { setIssueOpen(false); return; }

        const reason = issueForm.reason.trim();
    const authorizedBy = issueForm.authorizedBy.trim();
    const { returnDate, returnTime, goingWith, goingWithName } = issueForm;

    if (!reason) { setIssueError("Please enter the reason for the pass."); return; }
    if (!returnDate || !returnTime) { setIssueError("Please fill in the expected return date and time."); return; }
    if (parseLocal(`${returnDate}T${returnTime}`) < new Date()) { setIssueError("Expected return date & time must be in the future."); return; }
    if (!authorizedBy) { setIssueError("Please enter who authorized this pass (e.g. Principal)."); return; }
    if (!goingWith) { setIssueError("Please select who is going with the student."); return; }

    const now = new Date().toISOString();
    const slipNo = makeSlipNo(readPasses());

        const pass = {
      _id: uid(),
      studentKey: student._id,
      studentId: student.studentId,
      rfid: normalizeRfid(student.rfid),
      name: student.name,
      className: student.className,
      kind: "STUDENT_PASS",
      status: "ISSUED",
      reason,
      expectedReturn: `${returnDate}T${returnTime}`,
      authorizedBy,
      goingWith,
      goingWithName: (goingWith === "Guardian" || goingWith === "Staff") ? goingWithName.trim() : null,
      createdAt: now,
      requestedAt: null, approvedAt: null, approvedBy: null,
      issuedAt: now, printedAt: now, returnedAt: null,
      slipNo,
    };

    writePass(DB_DAYPASS_PATH, pass);
    setStudentStatus(student, "OUT", now);
    setIssueOpen(false);
    printSlip(pass);
    refreshCurrent();
    beep(true);
    showToast(`✓ Student pass issued for ${student.name} — slip ${slipNo} sent to the printer · student marked OUT`, "success");
  };

  /* ================= REQUEST DAY PASS (stored for the Principal) ================= */
  const openRequestForm = () => {
    if (!current) return;
    requestStudentRef.current = current;
    setRequestForm({ reason: "", returnDate: todayStr(), returnTime: nextHalfHour(1), goingWith: "Parent", goingWithName: "" });
    setRequestError("");
    setRequestOpen(true);
  };
  const closeRequest = () => setRequestOpen(false);

  useEffect(() => { if (requestOpen) setTimeout(() => requestReasonRef.current?.focus(), 60); }, [requestOpen]);

    const handleRequestChange = (e) => {
    const { name, value } = e.target;
    setRequestForm((f) => ({
      ...f,
      [name]: value,
      /* the name is only kept for Guardian / Staff — cleared otherwise */
      ...(name === "goingWith" && value !== "Guardian" && value !== "Staff" ? { goingWithName: "" } : {}),
    }));
    setRequestError("");
  };

  const handleRequest = () => {
    const student = requestStudentRef.current;
    if (!student) { setRequestOpen(false); return; }

        const reason = requestForm.reason.trim();
    const { returnDate, returnTime, goingWith, goingWithName } = requestForm;

    if (!reason) { setRequestError("Please enter the reason for the day pass."); return; }
    if (!returnDate || !returnTime) { setRequestError("Please fill in the expected return date and time."); return; }
    if (parseLocal(`${returnDate}T${returnTime}`) < new Date()) { setRequestError("Expected return date & time must be in the future."); return; }
    if (!goingWith) { setRequestError("Please select who is going with the student."); return; }

    const now = new Date().toISOString();
    const pass = {
      _id: uid(),
      studentKey: student._id,
      studentId: student.studentId,
      rfid: normalizeRfid(student.rfid),
      name: student.name,
      className: student.className,
      kind: "DAY_PASS",
      status: "REQUESTED",
      reason,
      expectedReturn: `${returnDate}T${returnTime}`,
      authorizedBy: null,
      goingWith,
      goingWithName: (goingWith === "Guardian" || goingWith === "Staff") ? goingWithName.trim() : null,
      createdAt: now,
      requestedAt: now,
      approvedAt: null, approvedBy: null,
      issuedAt: null, printedAt: null, returnedAt: null,
      slipNo: null,
    };

    writePass(DB_REQUEST_PATH, pass);
    setStudentStatus(student, "REQUESTED");
    setRequestOpen(false);
    refreshCurrent();
    beep(true);
    showToast(`✓ Day pass request for ${student.name} submitted — waiting for the Principal's approval`, "success");
  };

  /* ================= CANCEL A PENDING REQUEST ================= */
    /* ================= CANCEL A PENDING REQUEST =================
     ONE atomic multi-path write — nothing is left behind:
       · the request LEAVES "studentRequest" (the request collection
         keeps ONLY genuinely pending requests)
       · the record is MOVED into the NEW "cancelledStudentPass"
         collection and kept there permanently as a record
       · the student's status is restored to IN */
  const handleCancelRequest = () => {
    if (!current || !view || !view.pass) return;

    const fresh = readPasses().find((p) => p._id === view.pass._id) || view.pass;

    /* the Principal may have approved it in another tab in the meantime —
       then there is nothing to cancel, just refresh the panel */
    if (fresh.status !== "REQUESTED") { refreshCurrent(); return; }

    const now = new Date().toISOString();
    const cancelledRecord = { ...fresh, status: "CANCELLED", cancelledAt: now };

    /* MOVE: "studentRequest" → "cancelledStudentPass" in one atomic write */
    const updates = {
      [`${DB_REQUEST_PATH}/${fresh._id}`]: null,              // removed from the request collection…
      [`${DB_CANCELLED_PATH}/${fresh._id}`]: cancelledRecord, // …moved into the cancelled collection
    };
    update(ref(database), updates)
      .catch(() => showToast("⚠ Could not cancel the request.", "error"));

    /* keep the local mirrors in sync instantly (Firebase pushes the same change) */
    requestedRef.current = requestedRef.current.filter((p) => p._id !== fresh._id);
    cancelledRef.current = [cancelledRecord, ...cancelledRef.current];

    const live = findLiveStudent(current);
    if (live && live.status === "REQUESTED") setStudentStatus(current, "IN");

    refreshCurrent();
    beep(true);
    showToast(`✓ Day-pass request for ${current.name} cancelled — record moved to the Cancelled collection`, "success");
  };

  /* ================= MARK IN ================= */
    const handleMarkIn = () => {
    if (!current) return;
    const now = new Date().toISOString();
    const active = findActivePass(readPasses(), current);
    const openPass = active && active.status === "ISSUED" ? active : null;

    if (openPass) {
      patchPass(openPass, { status: "RETURNED", returnedAt: now });   // works wherever the pass lives
    }
    setStudentStatus(current, "IN", now);

    /* DIRECT PRINT — entry slip, exactly like the exit slips:
       school title · ENTRY PASS · the pass's slip number · student /
       class / ID No · reason autofilled from the pass being closed ·
       check-in time = this exact moment. If the student was OUT with
       no pass on file, the slip still prints from the student details. */
    printEntrySlip(
      openPass || {
        name: current.name,
        className: current.className,
        studentId: current.studentId,
        reason: "",
        slipNo: "",
      },
      now
    );

    refreshCurrent();
    beep(true);
    showToast(`✓ ${current.name} marked IN${openPass ? ` — ${isStudentPass(openPass) ? "student pass" : "day pass"} closed` : ""} · entry slip sent to the printer`, "success");
  };

  /* ================= PRINT AN APPROVED DAY PASS =================
     The approved pass already lives in the "daypass" collection (the
     Principal's approval desk moved it there). Printing flips its status
     to ISSUED IN PLACE — one targeted write — and the student is marked
     OUT. No record moves between collections. */
  const handlePrintApproved = () => {
    if (!current || !view || !view.pass) return;

    const fresh = readPasses().find((p) => p._id === view.pass._id) || view.pass;
    const now = new Date().toISOString();
    const slipNo = fresh.slipNo || makeSlipNo(readPasses());

    const patch = {
      status: "ISSUED",
      slipNo,
      authorizedBy: fresh.authorizedBy || fresh.approvedBy || "Principal",
      issuedAt: fresh.issuedAt || now,
      printedAt: now,
    };

    patchPass(fresh, patch);          // stays in "daypass" — status → ISSUED
    setStudentStatus(current, "OUT", now);
    printSlip({ ...fresh, ...patch });
    refreshCurrent();
    beep(true);
    showToast(`✓ Approved day pass printed for ${current.name} — slip ${slipNo} · student marked OUT`, "success");
  };

  /* ================= ESC closes the open form ================= */
  useEffect(() => {
    if (!issueOpen && !requestOpen) return;
    const onEsc = (e) => {
      if (e.key !== "Escape") return;
      if (requestOpen) setRequestOpen(false);
      else setIssueOpen(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [issueOpen, requestOpen]);

  /* ================= RENDER ================= */
  const scannerLive = !issueOpen && !requestOpen && !cooldown && !manualFocus;
  const issueStudent = issueStudentRef.current;
  const requestStudent = requestStudentRef.current;
  const pass = view && view.pass;
  const scanFlash = scan.status === "ok" || scan.status === "error";
  const scanTone = scanFlash
    ? (scan.status === "ok" ? "pi-scan-ok" : "pi-scan-error")
    : ((cooldown || manualFocus) ? "pi-scan-paused" : "");

  /* pass history — every record of this student in EVERY collection,
     recomputed on every live mirror refresh */
  const passHistory = current ? getStudentHistory(readAllPasses(), current) : [];
  const historyShown = passHistory.slice(0, HISTORY_LIMIT);
  const historyMore = passHistory.length - historyShown.length;

  return (
    <section className="pi">
      {/* ---------- header ---------- */}
      <header className="pi-header">
        <div>
        

        </div>

        <div className="pi-live">
          <span className={`pi-live-dot ${scannerLive ? "" : "pi-live-dot-paused"}`} />
          <span className={`pi-live-label ${scannerLive ? "" : "pi-live-label-paused"}`}>
            {scannerLive ? "Scanner ready" : "Scanner paused"}
          </span>
          <span className="pi-live-clock">
            {clock.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" })}
            {"  ·  "}
            {clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        </div>
      </header>

      <div className="pi-card">
        {/* ---------- scanner row (fixed height) ---------- */}
        <div className="pi-scanner">
          <div
            className={`pi-scanbox ${scanTone}`}
            role="status"
            aria-live="polite"
          >
            <span className="pi-scan-icon">
              {scanFlash
                ? (scan.status === "ok" ? "✅" : "⚠️")
                : (cooldown || manualFocus) ? "⏸️" : "📡"}
            </span>
            <div className="pi-scan-text">
              <span className="pi-scan-label">
                {scanFlash
                  ? (scan.status === "ok" ? "Card read" : "Unknown card")
                  : (cooldown || manualFocus) ? "Scanner paused" : "RFID card scan"}
              </span>
              <span className="pi-scan-sub">
                {scan.status === "ok" && (
                  <><code className="pi-scan-code">{scan.code}</code> — student loaded below{cooldown ? ` · next scan in ${cooldownLeft}s` : ""}</>
                )}
                {scan.status === "error" && (
                  <><code className="pi-scan-code">{scan.code}</code> — not registered{cooldown ? ` · next scan in ${cooldownLeft}s` : ""}</>
                )}
                {scan.status === "ready" && (cooldown ? (
                  <>Result shown below — press <strong>Next Scan</strong> or wait {cooldownLeft}s</>
                ) : manualFocus ? (
                  <>Paused while you type</>
                ) : !scan.code ? "Always live — tap a card on the reader" : (
                  <>Last read — <code className="pi-scan-code">{scan.code}</code></>
                ))}
              </span>
            </div>

            {cooldown && (
              <button type="button" className="pi-btn pi-btn-ghost pi-scan-next" onClick={handleNextScan}>
                Next Scan ▸
              </button>
            )}
          </div>

            <div className="pi-manual">
            <span className="pi-manual-label">Or enter manually</span>
            <div className="pi-manual-form">
              <input
                ref={manualInputRef}
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                onFocus={() => { manualFocusRef.current = true; setManualFocus(true); }}
                onBlur={() => { manualFocusRef.current = false; setManualFocus(false); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault(); e.stopPropagation();
                    handleManualFind();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault(); e.stopPropagation();
                    setManualId("");
                    manualInputRef.current?.blur();
                  }
                }}
                placeholder="ID number (or RFID)…"
                autoComplete="off"
                spellCheck={false}
                aria-label="Student ID number"
              />
              <button type="button" className="pi-btn pi-btn-ghost" onClick={handleManualFind}>Find</button>
            </div>
          </div>
        </div>

        {/* ---------- result panel — FIXED height, never changes ---------- */}
        <div className="pi-panel">
          {current && view ? (
            <div className="pi-view">
              {/* student details — top zone (scrolls only if needed) */}
              <div className="pi-details">
                <div className="pi-info">
                  <span className="pi-avatar">{getInitials(current.name)}</span>
                  <div className="pi-identity">
                    <div className="pi-name-row">
                      <h3 className="pi-name">{current.name}</h3>
                      <span className={`pi-badge pi-badge-${view.state === "OUT_PASS" ? "out" : view.state.toLowerCase()}`}>
                        {view.state === "OUT_PASS" ? "OUT" : view.state}
                      </span>
                                            {view.state === "OUT_PASS" && (
                        <span className="pi-chip pi-chip-onpass">{isStudentPass(pass) ? "ON STUDENT PASS" : "ON DAY PASS"}</span>
                      )}
                    </div>
                    <div className="pi-meta">
                      <span className="pi-chip">{current.className}</span>
                      <span className="pi-chip">{current.studentId}</span>
                      <span className="pi-chip pi-chip-mono">{normalizeRfid(current.rfid)}</span>
                    </div>
                  </div>
                  <div className="pi-since">
                    <span className="pi-since-label">Last movement</span>
                    <span className="pi-since-value">{current.lastMovement ? fmtDateTime(current.lastMovement) : "—"}</span>
                  </div>
                </div>

                {/* open pass details (request / approval / issued) */}
                {pass && (
                  <div className={`pi-passinfo pi-passinfo-${pass.status.toLowerCase()}`}>
                    <div className="pi-passinfo-head">
                      <span className="pi-passinfo-title">
                        {pass.status === "REQUESTED" && "⏳ Pending Approval"}
                        {pass.status === "APPROVED" && "✅ Day Pass Approved"}
                        {pass.status === "ISSUED" && (isStudentPass(pass) ? "🎫 Student pass issued" : "🎫 Day pass issued")}
                      </span>
                      {pass.slipNo && <span className="pi-passinfo-slip">Slip {pass.slipNo}</span>}
                    </div>
                    <div className="pi-passinfo-grid">
                      <div className="pi-stat pi-stat-reason" title={pass.reason}>
                        <span className="pi-stat-label">Reason</span>
                        <span className="pi-stat-value">{pass.reason}</span>
                      </div>
                      <div className="pi-stat">
                        <span className="pi-stat-label">Expected return</span>
                        <span className="pi-stat-value">{fmtExpected(pass.expectedReturn)}</span>
                      </div>
                      {pass.goingWith && (
                        <div className="pi-stat">
                          <span className="pi-stat-label">Going with</span>
                          <span className="pi-stat-value">{fmtGoingWith(pass)}</span>
                        </div>
                      )}
                      {pass.status === "REQUESTED" && (
                        <div className="pi-stat">
                          <span className="pi-stat-label">Requested</span>
                          <span className="pi-stat-value">{fmtDateTime(pass.requestedAt || pass.createdAt)}</span>
                        </div>
                      )}
                      {pass.status === "APPROVED" && (
                        <div className="pi-stat">
                          <span className="pi-stat-label">Approved by</span>
                          <span className="pi-stat-value">{pass.approvedBy || "Principal"}</span>
                        </div>
                      )}
                      {pass.status === "APPROVED" && (
                        <div className="pi-stat">
                          <span className="pi-stat-label">Approved at</span>
                          <span className="pi-stat-value">{fmtDateTime(pass.approvedAt)}</span>
                        </div>
                      )}
                      {pass.status === "ISSUED" && (
                        <div className="pi-stat">
                          <span className="pi-stat-label">Authorized by</span>
                          <span className="pi-stat-value">{pass.authorizedBy || "—"}</span>
                        </div>
                      )}
                      {pass.status === "ISSUED" && (
                        <div className="pi-stat">
                          <span className="pi-stat-label">Issued</span>
                          <span className="pi-stat-value">{fmtDateTime(pass.issuedAt)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ---------- pass history — every collection, live ---------- */}
                {passHistory.length > 0 && (
                  <div className="pi-history">
                    <div className="pi-history-head">
                      <span className="pi-history-title">Pass history</span>
                      <span className="pi-history-note">
                        {passHistory.length} record{passHistory.length !== 1 ? "s" : ""} found
                      </span>
                    </div>
                    <ul className="pi-history-list">
                      {historyShown.map((p) => (
                        <li key={p._id} className={`pi-hist-row pi-hist-${histKey(p.status)}`}>
                          <span className="pi-hist-badge">{histLabel(p.status)}</span>
                          <div className="pi-hist-body">
                            <span className="pi-hist-reason" title={p.reason}>{p.reason}</span>
                            <span className="pi-hist-meta">
                              {p.slipNo && <>Slip <code className="pi-hist-slip">{p.slipNo}</code> · </>}
                              {histWho(p) && <>{histWho(p)} · </>}
                              Return {fmtExpected(p.expectedReturn)}
                            </span>
                          </div>
                          <span className="pi-hist-time">{fmtDateTime(histTime(p))}</span>
                        </li>
                      ))}
                    </ul>
                    {historyMore > 0 && (
                      <span className="pi-history-more">
                        + {historyMore} earlier record{historyMore !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* reserved action zone — buttons swap inside it, nothing moves */}
              <div className="pi-actions">
                {view.state === "IN" && (
                  <>
                    <button type="button" className="pi-btn pi-btn-primary pi-btn-xl" onClick={openIssueForm}>
                      <span className="pi-btn-line">🎫 Issue Pass</span>
                      
                    </button>
                    <button type="button" className="pi-btn pi-btn-request pi-btn-xl" onClick={openRequestForm}>
                      <span className="pi-btn-line">✉ Request Day Pass</span>
                      
                    </button>
                  </>
                )}

                {view.state === "OUT" && (
                  <button type="button" className="pi-btn pi-btn-success pi-btn-xl" onClick={handleMarkIn}>
                    <span className="pi-btn-line">↩ Mark In</span>
                    <span className="pi-btn-sub">Student has returned to campus</span>
                  </button>
                )}

                {view.state === "REQUESTED" && (
                  <>
                    <div className="pi-action-note">
                      ⏳ Day-pass request waiting for the Principal's approval.
                    </div>
                    <button type="button" className="pi-btn pi-btn-danger" onClick={handleCancelRequest}>
                      Cancel Request
                    </button>
                  </>
                )}

                {view.state === "APPROVED" && (
                  <button type="button" className="pi-btn pi-btn-primary pi-btn-xl" onClick={handlePrintApproved}>
                    <span className="pi-btn-line">🖨️ Print Day Pass</span>
                    
                  </button>
                )}

                {view.state === "OUT_PASS" && (
                  <button type="button" className="pi-btn pi-btn-success pi-btn-xl" onClick={handleMarkIn}>
                    <span className="pi-btn-line">↩ Mark In</span>
                    
                  </button>
                )}
              </div>
            </div>
          ) : notFound ? (
            /* ---------- unknown card / ID ---------- */
            <div className="pi-center">
              <div className="pi-center-icon pi-center-error">⚠️</div>
              <h3 className="pi-center-title">
                {notFound.type === "rfid" ? "Unknown card" : "No student found"}
              </h3>
              <p className="pi-center-sub">
                {notFound.type === "rfid"
                  ? `Card ${notFound.value} is not registered. Add the student first, then scan again.`
                  : `No student matches "${notFound.value}". Check the ID number and try again.`}
              </p>
              <p className="pi-center-hint">Press [Next Scan] or wait for the scanner to reset.</p>
            </div>
          ) : (
            /* ---------- idle ---------- */
            <div className="pi-center">
              <div className="pi-center-icon">📡</div>
              <h3 className="pi-center-title">Waiting for a card</h3>
              
              
            </div>
          )}
        </div>
      </div>

      {/* ---------- issue-pass modal ---------- */}
      {issueOpen && issueStudent && (
        <div className="pi-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeIssue(); }}>
          <div className="pi-modal">
            <div className="pi-modal-head">
              <h2>Issue Student Pass</h2>
              <button type="button" className="pi-modal-close" onClick={closeIssue} aria-label="Close">✕</button>
            </div>
            <div className="pi-modal-body">
              <div className="pi-modal-student">
                <span className="pi-modal-avatar">{getInitials(issueStudent.name)}</span>
                <div className="pi-modal-student-text">
                  <strong>{issueStudent.name}</strong>
                  <span>{issueStudent.className} · {issueStudent.studentId}</span>
                </div>
              </div>
              <div className="pi-modal-fields">
                <div className="pi-field">
                  <label htmlFor="pi-issue-reason">Reason</label>
                  <input
                    id="pi-issue-reason"
                    ref={issueReasonRef}
                    className="pi-input"
                    name="reason"
                    value={issueForm.reason}
                    onChange={handleIssueChange}
                    list="pi-reason-options"
                    placeholder="Why is the student leaving?"
                  />
                  <datalist id="pi-reason-options">
                    {REASON_OPTIONS.map((r) => <option key={r} value={r} />)}
                  </datalist>
                </div>
                <div className="pi-field-row">
                  <div className="pi-field">
                    <label htmlFor="pi-issue-date">Return date</label>
                    <input id="pi-issue-date" ref={issueDateRef} className="pi-input" type="date" name="returnDate" value={issueForm.returnDate} onChange={handleIssueChange} />
                  </div>
                  <div className="pi-field">
                    <label htmlFor="pi-issue-time">Return time</label>
                    <input id="pi-issue-time" ref={issueTimeRef} className="pi-input" type="time" name="returnTime" value={issueForm.returnTime} onChange={handleIssueChange} />
                  </div>
                </div>
                <div className="pi-field">
                  <label htmlFor="pi-issue-auth">Authorized by</label>
                  <input
                    id="pi-issue-auth"
                    ref={issueAuthRef}
                    className="pi-input"
                    name="authorizedBy"
                    value={issueForm.authorizedBy}
                    onChange={handleIssueChange}
                    list="pi-auth-options"
                    placeholder="e.g. Principal"
                  />
                  <datalist id="pi-auth-options">
                    {AUTH_OPTIONS.map((a) => <option key={a} value={a} />)}
                  </datalist>
                </div>
                                      {/* ---------- Going With (required) ---------- */}
                      <div className="pi-field">
                        <label htmlFor="issue-goingWith">
                          Going With <span className="pi-req-star">*</span>
                        </label>
                        <select
                          id="issue-goingWith"
                          name="goingWith"
                          className={`pi-input pi-select-gw ${issueError && issueError.includes("who is going with") ? "pi-input-invalid" : ""}`}
                          value={issueForm.goingWith}
                          onChange={handleIssueChange}
                        >
                          
                          {GOING_WITH_OPTIONS.map((o) => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </select>
                      </div>

                      {/* ---------- Guardian / Staff name (required) ---------- */}
                      {(issueForm.goingWith === "Guardian" || issueForm.goingWith === "Staff") && (
                        <div className="pi-field pi-gw-name-field">
                          <label htmlFor="issue-goingWithName">
                            {issueForm.goingWith} Name <span className="pi-req-star">*</span>
                          </label>
                          <input
                            id="issue-goingWithName"
                            name="goingWithName"
                            type="text"
                            className={`pi-input ${issueError && issueError.includes("name of the") ? "pi-input-invalid" : ""}`}
                            placeholder={`Enter the ${issueForm.goingWith.toLowerCase()}'s name`}
                            value={issueForm.goingWithName}
                            onChange={handleIssueChange}
                            autoComplete="off"
                          />
                        </div>
                      )}
                {issueError && <div className="pi-alert pi-alert-error">{issueError}</div>}
                
              </div>
            </div>
            <div className="pi-modal-footer">
              <button type="button" className="pi-btn pi-btn-ghost" onClick={closeIssue}>Cancel</button>
              <button type="button" className="pi-btn pi-btn-primary" onClick={handleIssue}>Issue &amp; Print</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- request-day-pass modal ---------- */}
      {requestOpen && requestStudent && (
        <div className="pi-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeRequest(); }}>
          <div className="pi-modal">
            <div className="pi-modal-head">
              <h2>Request Day Pass</h2>
              <button type="button" className="pi-modal-close" onClick={closeRequest} aria-label="Close">✕</button>
            </div>
            <div className="pi-modal-body">
              <div className="pi-modal-student">
                <span className="pi-modal-avatar">{getInitials(requestStudent.name)}</span>
                <div className="pi-modal-student-text">
                  <strong>{requestStudent.name}</strong>
                  <span>{requestStudent.className} · {requestStudent.studentId}</span>
                </div>
              </div>
              <div className="pi-modal-fields">
                <div className="pi-field">
                  <label htmlFor="pi-req-reason">Reason</label>
                  <input
                    id="pi-req-reason"
                    ref={requestReasonRef}
                    className="pi-input"
                    name="reason"
                    value={requestForm.reason}
                    onChange={handleRequestChange}
                    list="pi-reason-options"
                    placeholder="Why is the day pass needed?"
                  />
                  <datalist id="pi-reason-options">
                    {REASON_OPTIONS.map((r) => <option key={r} value={r} />)}
                  </datalist>
                </div>
                <div className="pi-field">
  <label htmlFor="pi-req-date">Expected return Date</label>
  <input
    id="pi-req-date"
    ref={requestDateRef}
    className="pi-input"
    type="date"
    name="returnDate"
    value={requestForm.returnDate}
    onChange={handleRequestChange}
  />
</div>

<div className="pi-field">
  <label htmlFor="pi-req-time">Expected return Time</label>
  <input
    id="pi-req-time"
    className="pi-input"
    type="time"
    name="returnTime"
    value={requestForm.returnTime}
    onChange={handleRequestChange}
  />
</div>
                      {/* ---------- Going With (required) ---------- */}
                      <div className="pi-field">
                        <label htmlFor="request-goingWith">
                          Going With <span className="pi-req-star">*</span>
                        </label>
                        <select
                          id="request-goingWith"
                          name="goingWith"
                          className={`pi-input pi-select-gw ${requestError && requestError.includes("who is going with") ? "pi-input-invalid" : ""}`}
                          value={requestForm.goingWith}
                          onChange={handleRequestChange}
                        >
                          
                          {GOING_WITH_OPTIONS.map((o) => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </select>
                      </div>

                      {/* ---------- Guardian / Staff name (required) ---------- */}
                      {(requestForm.goingWith === "Guardian" || requestForm.goingWith === "Staff") && (
                        <div className="pi-field pi-gw-name-field">
                          <label htmlFor="request-goingWithName">
                            {requestForm.goingWith} Name <span className="pi-req-star">*</span>
                          </label>
                          <input
                            id="request-goingWithName"
                            name="goingWithName"
                            type="text"
                            className={`pi-input ${requestError && requestError.includes("name of the") ? "pi-input-invalid" : ""}`}
                            placeholder={`Enter the ${requestForm.goingWith.toLowerCase()}'s name`}
                            value={requestForm.goingWithName}
                            onChange={handleRequestChange}
                            autoComplete="off"
                          />
                        </div>
                      )}
                {requestError && <div className="pi-alert pi-alert-error">{requestError}</div>}
                
              </div>
            </div>
            <div className="pi-modal-footer">
              <button type="button" className="pi-btn pi-btn-ghost" onClick={closeRequest}>Cancel</button>
              <button type="button" className="pi-btn pi-btn-request" onClick={handleRequest}>Send Request</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- toast ---------- */}
      {toast && (
        <div key={toast.id} className={`pi-toast pi-toast-${toast.type}`}>{toast.text}</div>
      )}
          {/* ---------- support section: pass tabs + smart search ---------- */}
      <PassIssueSupport onUseRfid={handleUseRfid} onSearchFocus={handleSupportFocus} />

    </section>
  );
}