import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { ref, onValue, update } from "firebase/database";
import { database } from "../../firebase/config"; // ← same config the other desk sections use — adjust the relative path if this component sits at a different depth
import "./bulk.css";

/* =====================================================================
   BULK PASS DESK — one pass for a group of students going out together
   ---------------------------------------------------------------------
   • "Issue Bulk Pass" opens a LARGE overlay form:
       – Reason (preset list + custom "Other")
       – Exit date & time (defaults to NOW, with a [Now] reset button)
         · NO expected-return field — bulk passes are exit-only
       – Incharges (type a name → Enter → chip; paste comma-separated too)
       – ADD STUDENTS — a big box with two modes (top right):
           📡 RFID  → the USB/HID reader is LIVE anywhere in the form.
                      Machine-speed keystrokes are swallowed before they
                      reach any field (typed text is never corrupted) and
                      the burst+ENTER pattern identifies a card read.
                      The scanned student appears on a card with an
                      [＋ Add to Pass] button (or auto-adds instantly if
                      the Auto-add switch is on). Unknown cards, cards
                      already on the pass and students already OUT are
                      clearly flagged. Beeps on every read.
           🔍 SEARCH → the RFID scanner is fully PAUSED (no listener at
                      all). Smart search across Name / ID No / Class /
                      RFID (partial). Class + status filters. Picking a
                      class AUTO-SELECTS every addable student of that
                      class — deselect the few that stay back and add
                      the whole class in one click. Individual ＋ add,
                      "Add Selected (N)" bulk add, Select all / none.
                      Students already OUT are blocked (must be marked
                      IN first); students already on the pass show ✓.
       – Selected students live as removable chips + class summary.
       – Review & Issue → a confirm step (mass operation safety) shows
         the full summary before anything is written.

   • ISSUING = ONE ATOMIC multi-path Firebase write:
       – the pass record → "bulkPass" node (NEW, owned by this section)
       – every student   → students/{id} status "OUT" + lastMovement
     so Student Manage (live onValue) updates instantly. Then the
     80 mm BULK PASS slip prints — visually IDENTICAL to the Pass Issue
     desk's slip: same school header, same fonts/sizes/dashed rules,
     same "Issued:" stamp, same DPIRS footer. Title: BULK PASS, then
     Reason / Exit at / Incharge rows, then the STUDENTS (N) block with
     every "Name (Class)" comma-separated, then the Issued stamp.

   • RECORDS LIST below: All / Active / Returned tabs + search (slip
     no, reason, incharge, student name/class/ID). Every row shows a
     live "N still out" count. Click → expanded view with the FULL
     student list frozen at issue time, each student's LIVE status,
     a return-progress bar, list search, copy-list, 🖨 reprint
     (only printedAt changes — the stamp on the slip updates) and
     ↩ BULK MARK IN.

   • BULK MARK IN opens its own window listing ONLY students from the
     pass who are currently OUT (live check — anyone already IN is not
     listed). All are selected by default; deselect who you want and
     [Mark Selected In] writes one atomic update: students → IN,
     returned-times recorded on the pass; when the last student is in,
     the pass closes itself (status RETURNED). Students that came back
     through the gate desk are detected live and back-filled.

   • COMPATIBILITY: while any Bulk overlay is open, a hidden sentinel
     element pauses the Pass Issue desk's global RFID listener (it
     looks for ".ds-overlay") — no code changes needed over there.
   ===================================================================== */

/* ---------------- constants ---------------- */
const DB_STUDENTS_PATH = "students";    // student master data (shared with Student Manage)
const DB_BULK_PATH     = "bulkPass";    // ← NEW node owned by this section

const SCHOOL_NAME = "De Paul International Residential School, Mysore";

const PRESENCE_VALUES = ["IN", "OUT", "REQUESTED", "APPROVED"];

const MACHINE_GAP_MS = 45;     // keys arriving faster than this are the reader, never a person
const RESULT_LIMIT   = 200;    // search rows rendered at once
const RECORDS_LIMIT  = 150;    // pass rows rendered at once

const BULK_REASONS = [
  "Inter-school competition",
  "Sports meet / tournament",
  "Cultural programme / competition",
  "Educational / field trip",
  "Olympiad / entrance examination",
  "Group medical checkup",
  "NCC / Scout camp",
];

const ST_META = {
  IN:        { label: "In",        cls: "bp-st-in"   },
  OUT:       { label: "Out",       cls: "bp-st-out"  },
  REQUESTED: { label: "Requested", cls: "bp-st-req"  },
  APPROVED:  { label: "Approved",  cls: "bp-st-appr" },
};

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
function nowTimeStr() {
  const d = new Date();
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const tsMs = (v) => { if (!v) return 0; const t = new Date(v).getTime(); return isNaN(t) ? 0 : t; };

function fmtFull(v) {
  const d = parseLocal(v);
  if (!d) return String(v || "—");
  return /T\d{2}:\d{2}/.test(String(v))
    ? d.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
}
function fmtStamp(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDateTime(v) {
  const d = parseLocal(v) || (v ? new Date(v) : null);
  if (!d || isNaN(d)) return "—";
  return `${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${d.toLocaleDateString([], { day: "2-digit", month: "short" })}`;
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

/* "in" / "IN" → "IN" · anything missing or unknown → "IN" */
function normalizePresence(v) {
  const s = String(v || "").trim().toUpperCase();
  return PRESENCE_VALUES.indexOf(s) !== -1 ? s : "IN";
}

/* ---------- little beeps (silent if audio is blocked) ---------- */
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
    createdAt: (s && s.createdAt) || null,
  }));
}

function sanitizeBulkPasses(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return [];
  return Object.entries(val)
    .map(([key, p]) => {
      const o = p && typeof p === "object" ? p : {};
      return {
        ...o,
        _id: String(o._id || key),
        kind: "BULK_PASS",
        status: String(o.status || "ISSUED").toUpperCase() === "RETURNED" ? "RETURNED" : "ISSUED",
        reason: String(o.reason || "—"),
        exitAt: o.exitAt || null,
        incharges: Array.isArray(o.incharges) ? o.incharges.map((x) => String(x).trim()).filter(Boolean) : [],
        students: Array.isArray(o.students)
          ? o.students.map((s) => ({
              _id: String((s && s._id) || ""),
              studentId: String((s && s.studentId) || "").trim(),
              name: String((s && s.name) || "Unknown").trim(),
              className: String((s && s.className) || "—").trim(),
              rfid: normalizeRfid(s && s.rfid),
            }))
          : [],
        returned: o.returned && typeof o.returned === "object" && !Array.isArray(o.returned) ? o.returned : {},
        createdAt: o.createdAt || null,
        issuedAt: o.issuedAt || null,
        printedAt: o.printedAt || null,
        returnedAt: o.returnedAt || null,
        slipNo: o.slipNo ? String(o.slipNo) : null,
      };
    })
    .filter((p) => p._id);
}

/* running slip number for today: BP-YYYYMMDD-001 … */
function makeBulkSlipNo(bulkPasses) {
  const d = new Date();
  const today = d.toDateString();
  const n = (bulkPasses || []).filter((x) => x.issuedAt && new Date(x.issuedAt).toDateString() === today).length + 1;
  return `BP-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${String(n).padStart(3, "0")}`;
}

/* ---------- 80 mm thermal BULK PASS slip — IDENTICAL styling to the Pass Issue desk ---------- */
function printBulkSlip(pass) {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const printedAt = new Date(pass.printedAt || pass.issuedAt || Date.now());

  const rows = [
    ["Reason", pass.reason],
    ["Exit at", fmtFull(pass.exitAt)],
    ["Incharge", (pass.incharges || []).join(", ")],
  ]
    .map(([k, v]) => `<div class="r"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
    .join("");

  const studentList = (pass.students || [])
    .map((s) => `${s.name} (${s.className})`)
    .join(", ");

  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bulk Pass ${esc(pass.slipNo || "")}</title><style>` +
    `@page{size:80mm auto;margin:2mm}html,body{margin:0;padding:0}` +
    `body{width:76mm;font-family:"Consolas","Courier New",monospace;color:#000}` +
    `.c{text-align:center}.school{font-size:12px;font-weight:bold;letter-spacing:.4px}` +
    `.slip{font-size:17px;font-weight:bold;letter-spacing:5px;margin:1.5mm 0 .5mm}` +
    `.no{font-size:11px;letter-spacing:1px}.hr{border-top:1px dashed #000;margin:2mm 0}` +
    `.r{display:flex;font-size:11px;line-height:1.55}.k{width:24mm;flex-shrink:0;font-weight:bold}` +
    `.v{flex:1;word-break:break-word}.stamp{font-size:10.5px;line-height:1.6}` +
    `.stu{font-size:10px;font-weight:bold;letter-spacing:1px;margin-bottom:.8mm}` +
    `.note{font-size:9.5px;line-height:1.5}.foot{font-size:9.5px;margin-top:1.5mm}` +
    `</style></head><body>` +
    `<div class="c school">${esc(SCHOOL_NAME)}</div>` +
    `<div class="c slip">BULK PASS</div>` +
    `<div class="c no">${esc(pass.slipNo || "")}</div>` +
    `<div class="hr"></div>` +
    rows +
    `<div class="hr"></div>` +
    `<div class="c stu">STUDENTS (${(pass.students || []).length})</div>` +
    `<div class="note">${esc(studentList)}</div>` +
    `<div class="hr"></div>` +
    `<div class="c stamp">Issued: ${esc(printedAt.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }))}</div>` +
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

/* hidden sentinel — the Pass Issue desk's global RFID listener pauses whenever
   it sees a ".ds-overlay" element in the DOM. Dropping one (hidden) inside
   every Bulk overlay pauses that scanner while we are on top, without
   touching a single line of the PassIssue code. */
const ScannerSentinel = () => (
  <div className="ds-overlay sm-overlay" style={{ display: "none" }} aria-hidden="true" />
);

/* ===================================================================== */

export default function BulkPass() {
  /* ================= LIVE DATA ================= */
  const [students, setStudents] = useState([]);       // "students" — master data (live)
  const [bulkPasses, setBulkPasses] = useState([]);   // "bulkPass" — records (live)
  const [synced, setSynced] = useState(false);

  const studentsRef = useRef([]);
  const bulkRef = useRef([]);
  const syncedRef = useRef(false);
  useEffect(() => { syncedRef.current = synced; }, [synced]);

  /* ================= UI STATE ================= */
  const [clock, setClock] = useState(() => new Date());
  const [toast, setToast] = useState(null);

  /* — the big issue form — */
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ reason: "", customReason: "", exitDate: todayStr(), exitTime: nowTimeStr(), incharges: [] });
  const [inchargeInput, setInchargeInput] = useState("");
  const [selected, setSelected] = useState([]);        // students added to the pass
  const [addMode, setAddMode] = useState("search");    // "rfid" | "search"
  const [formError, setFormError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  /* — RFID add mode — */
  const [scanView, setScanView] = useState(null);      // { status, code, student }
  const [autoAdd, setAutoAdd] = useState(false);

  /* — search add mode — */
  const [searchQuery, setSearchQuery] = useState("");
  const [classFilter, setClassFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [resultSelection, setResultSelection] = useState(() => new Set());

  /* — records list — */
  const [recordTab, setRecordTab] = useState("all");
  const [recordSearch, setRecordSearch] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [expandedSearch, setExpandedSearch] = useState("");

  /* — bulk mark in — */
  const [markInId, setMarkInId] = useState(null);
  const [markInSelection, setMarkInSelection] = useState(() => new Set());

  /* ================= REFS ================= */
  const selectedRef = useRef([]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const autoAddRef = useRef(false);
  useEffect(() => { autoAddRef.current = autoAdd; }, [autoAdd]);

  const hasDraftRef = useRef(false);
  useEffect(() => {
    hasDraftRef.current =
      selected.length > 0 || form.incharges.length > 0 || !!form.reason || !!form.customReason;
  }, [selected, form]);

  const toastTimerRef = useRef(null);
  const scanHandlerRef = useRef(null);
  const scanAddRef = useRef(null);
  const reasonRef = useRef(null);
  const inchargeRef = useRef(null);

  /* ================= CLOCK / TOAST ================= */
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const showToast = useCallback((text, type = "success") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), text, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  /* ================= FIREBASE REAL-TIME SYNC ================= */
  useEffect(() => {
    const unsubStudents = onValue(ref(database, DB_STUDENTS_PATH), (snap) => {
      studentsRef.current = sanitizeStudents(snap.val());
      setStudents(studentsRef.current);
      setSynced(true);
    }, (err) => {
      setSynced(true);
      showToast(`⚠ Firebase sync error: ${err.message}`, "error");
    });
    const unsubBulk = onValue(ref(database, DB_BULK_PATH), (snap) => {
      bulkRef.current = sanitizeBulkPasses(snap.val());
      setBulkPasses(bulkRef.current);
      setSynced(true);
    }, () => { setSynced(true); /* node absent yet — fine */ });
    return () => { unsubStudents(); unsubBulk(); };
  }, [showToast]);

  /* ================= LOOKUPS & DERIVED ================= */
  const findLive = useCallback((s) =>
    studentsRef.current.find((x) => (s._id && x._id === s._id) || (s.studentId && x.studentId === s.studentId)) || null
  , []);

  const sortedPasses = useMemo(
    () => [...bulkPasses].sort((a, b) => tsMs(b.issuedAt || b.createdAt) - tsMs(a.issuedAt || a.createdAt)),
    [bulkPasses]
  );

  /* live "still out" info for every pass — students who are recorded as
     returned OR whose live status is anything but OUT count as back */
  const passInfoMap = useMemo(() => {
    const m = new Map();
    sortedPasses.forEach((p) => {
      let out = 0;
      (p.students || []).forEach((s) => {
        if (p.returned && p.returned[s._id]) return;
        const live = findLive(s);
        if (live && live.status === "OUT") out++;
      });
      m.set(p._id, { out, total: (p.students || []).length, done: out === 0 });
    });
    return m;
  }, [sortedPasses, students, findLive]);

  const classes = useMemo(
    () => [...new Set(students.map((s) => s.className).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [students]
  );
  const classCounts = useMemo(() => {
    const m = new Map();
    students.forEach((s) => { if (s.className) m.set(s.className, (m.get(s.className) || 0) + 1); });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [students]);

  const studentsSorted = useMemo(
    () => [...students].sort((a, b) => (a.className || "").localeCompare(b.className || "") || (a.name || "").localeCompare(b.name || "")),
    [students]
  );

  const selectedIds = useMemo(() => new Set(selected.map((s) => s._id)), [selected]);
  const isAddableNow = useCallback((s) => !selectedIds.has(s._id) && s.status !== "OUT", [selectedIds]);

  /* SEARCH results — only when there is something to search / filter */
  const searchResults = useMemo(() => {
    if (!(searchQuery.trim() || classFilter || statusFilter)) return [];
    const q = searchQuery.trim().toLowerCase();
    const qn = q ? normalizeRfid(q) : "";
    return studentsSorted.filter((s) => {
      if (classFilter && s.className !== classFilter) return false;
      if (statusFilter && s.status !== statusFilter) return false;
      if (q) {
        const hit =
          s.name.toLowerCase().includes(q) ||
          s.studentId.toLowerCase().includes(q) ||
          s.className.toLowerCase().includes(q) ||
          (qn !== "" && s.rfid.includes(qn));
        if (!hit) return false;
      }
      return true;
    }).slice(0, RESULT_LIMIT);
  }, [studentsSorted, searchQuery, classFilter, statusFilter]);

  const selectedClassSummary = useMemo(() => {
    const m = new Map();
    selected.forEach((s) => m.set(s.className || "—", (m.get(s.className || "—") || 0) + 1));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, n]) => `${c} ×${n}`).join(" · ");
  }, [selected]);

  /* the students that can actually be issued the pass right now
     (someone may have gone OUT on another desk after being added) */
  const issueList = useMemo(
    () => selected.filter((s) => { const live = findLive(s); return live && live.status !== "OUT"; }),
    [selected, students, findLive]
  );
  const skippedAtIssue = selected.length - issueList.length;
  const pendingWarnCount = useMemo(
    () => issueList.filter((s) => s.status === "REQUESTED" || s.status === "APPROVED").length,
    [issueList]
  );
  const confirmClassSummary = useMemo(() => {
    const m = new Map();
    issueList.forEach((s) => m.set(s.className || "—", (m.get(s.className || "—") || 0) + 1));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, n]) => `${c} ×${n}`).join(" · ");
  }, [issueList]);

  /* records list */
  const filteredRecords = useMemo(() => {
    let list = sortedPasses;
    if (recordTab === "active") list = list.filter((p) => !(passInfoMap.get(p._id) || {}).done);
    else if (recordTab === "returned") list = list.filter((p) => !!(passInfoMap.get(p._id) || {}).done);
    const q = recordSearch.trim().toLowerCase();
    if (q) {
      list = list.filter((p) =>
        (p.slipNo || "").toLowerCase().includes(q) ||
        p.reason.toLowerCase().includes(q) ||
        p.incharges.some((n) => n.toLowerCase().includes(q)) ||
        p.students.some((s) =>
          s.name.toLowerCase().includes(q) ||
          s.className.toLowerCase().includes(q) ||
          (s.studentId || "").toLowerCase().includes(q))
      );
    }
    return list;
  }, [sortedPasses, recordTab, recordSearch, passInfoMap]);

  const activeCount = useMemo(() => sortedPasses.filter((p) => !(passInfoMap.get(p._id) || {}).done).length, [sortedPasses, passInfoMap]);
  const issuedToday = useMemo(() => {
    const today = new Date().toDateString();
    return sortedPasses.filter((p) => p.issuedAt && new Date(p.issuedAt).toDateString() === today).length;
  }, [sortedPasses]);
  const outOnBulk = useMemo(() => [...passInfoMap.values()].reduce((a, v) => a + v.out, 0), [passInfoMap]);

  /* live versions of the open modals */
  const expandedPass = useMemo(() => bulkPasses.find((p) => p._id === expandedId) || null, [bulkPasses, expandedId]);
  const markInPass = useMemo(() => bulkPasses.find((p) => p._id === markInId) || null, [bulkPasses, markInId]);

  const expandedStudents = useMemo(() => {
    if (!expandedPass) return [];
    const q = expandedSearch.trim().toLowerCase();
    if (!q) return expandedPass.students;
    return expandedPass.students.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.className.toLowerCase().includes(q) ||
      (s.studentId || "").toLowerCase().includes(q));
  }, [expandedPass, expandedSearch]);

  /* mark-in list — ONLY students of this pass who are currently OUT */
  const markInList = useMemo(() => {
    if (!markInPass) return [];
    return markInPass.students.filter((s) => {
      if (markInPass.returned && markInPass.returned[s._id]) return false;
      const live = findLive(s);
      return live && live.status === "OUT";
    });
  }, [markInPass, students, findLive]);
  const miSelCount = useMemo(() => markInList.filter((s) => markInSelection.has(s._id)).length, [markInList, markInSelection]);

  /* ================= FORM: OPEN / CLOSE ================= */
  const openForm = () => {
    setForm({ reason: "", customReason: "", exitDate: todayStr(), exitTime: nowTimeStr(), incharges: [] });
    setInchargeInput("");
    setSelected([]);
    setAddMode("search");
    setSearchQuery(""); setClassFilter(""); setStatusFilter("");
    setResultSelection(new Set());
    setScanView(null);
    setFormError("");
    setFormOpen(true);
    setTimeout(() => reasonRef.current?.focus(), 60);
  };

  const closeForm = useCallback(() => {
    if (hasDraftRef.current) {
      const ok = window.confirm("Discard this bulk pass? All added students and incharges will be cleared.");
      if (!ok) return;
    }
    setFormOpen(false);
    setConfirmOpen(false);
  }, []);

  const setExitNow = () => setForm((f) => ({ ...f, exitDate: todayStr(), exitTime: nowTimeStr() }));

  const resolveReason = () => (form.reason === "Other" ? form.customReason.trim() : form.reason);

  const validateForm = () => {
    if (!resolveReason()) return "Please select or enter the reason for the bulk pass.";
    if (!form.exitDate || !form.exitTime) return "Please fill in the exit date and time.";
    if (form.incharges.length === 0) return "Add at least one incharge accompanying the group.";
    if (selected.length === 0) return "Add at least one student to the pass.";
    if (issueList.length === 0) return "None of the selected students can be issued a pass — all are already OUT.";
    return "";
  };

  /* ================= INCHARGES (chips) ================= */
  const addIncharges = () => {
    const names = inchargeInput.split(",").map((s) => s.trim()).filter(Boolean);
    if (!names.length) { setFormError("Type an incharge name first."); return; }
    setForm((f) => {
      const list = [...f.incharges];
      names.forEach((n) => { if (!list.some((x) => x.toLowerCase() === n.toLowerCase())) list.push(n); });
      return { ...f, incharges: list };
    });
    setInchargeInput("");
    setFormError("");
    setTimeout(() => inchargeRef.current?.focus(), 30);
  };
  const removeIncharge = (i) =>
    setForm((f) => ({ ...f, incharges: f.incharges.filter((_, idx) => idx !== i) }));

  /* ================= ADD / REMOVE STUDENTS ================= */
  const addStudents = useCallback((list) => {
    const have = new Set(selectedRef.current.map((s) => s._id));
    const additions = [];
    let skippedDup = 0, skippedOut = 0;
    list.forEach((s) => {
      if (have.has(s._id)) { skippedDup++; return; }
      if (s.status === "OUT") { skippedOut++; return; }
      have.add(s._id);
      additions.push(s);
    });
    if (additions.length) setSelected((prev) => [...prev, ...additions]);
    return { additions, skippedDup, skippedOut };
  }, []);

  const addOne = (s) => {
    const { additions, skippedDup, skippedOut } = addStudents([s]);
    if (additions.length) { beep(true); showToast(`✓ ${s.name} added to the pass`, "success"); }
    else showToast(skippedOut ? `⚠ ${s.name} is currently OUT — mark them IN first.` : `⚠ ${s.name} is already on this pass.`, "error");
  };

  const removeStudent = (id) => {
    setSelected((prev) => prev.filter((s) => s._id !== id));
    setResultSelection((prev) => { const n = new Set(prev); n.delete(id); return n; });
  };
  const clearSelected = () => setSelected([]);

  /* ================= RFID SCAN (add mode) ================= */
  const handleRfidScan = useCallback((rawCode) => {
    const code = normalizeRfid(rawCode);
    if (!code) return;
    if (!syncedRef.current) { beep(false); setScanView({ status: "loading", code }); return; }

    const student = studentsRef.current.find((s) => normalizeRfid(s.rfid) === code) || null;

    if (!student) { beep(false); setScanView({ status: "notfound", code }); return; }
    if (selectedRef.current.some((s) => s._id === student._id)) {
      beep(false); setScanView({ status: "duplicate", code, student }); return;
    }
    if (student.status === "OUT") { beep(false); setScanView({ status: "out", code, student }); return; }

    if (autoAddRef.current) {
      addStudents([student]);
      beep(true);
      setScanView({ status: "added", code, student });
    } else {
      beep(true);
      setScanView({ status: "found", code, student });
    }
  }, [addStudents]);

  useEffect(() => { scanHandlerRef.current = handleRfidScan; }, [handleRfidScan]);

  const handleScanAdd = () => {
    if (!scanView || scanView.status !== "found" || !scanView.student) return;
    addStudents([scanView.student]);
    beep(true);
    setScanView({ ...scanView, status: "added" });
  };

  /* focus the Add button when a scanned student awaits confirmation —
     the operator can simply press ↵ Enter to add */
  useEffect(() => {
    if (scanView && scanView.status === "found") setTimeout(() => scanAddRef.current?.focus(), 40);
  }, [scanView]);

  /* ---- the global RFID listener: LIVE only while the form is open,
          in RFID mode, and no confirm dialog sits on top. In SEARCH
          mode there is NO listener at all — scanning is fully paused. ---- */
  useEffect(() => {
    if (!formOpen || addMode !== "rfid" || confirmOpen) return;

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

      /* ----- ENTER — the burst terminator ----- */
      if (e.key === "Enter") {
        const code = buf;
        buf = "";
        if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
        /* a real card read: 4+ chars, at least two of them machine-speed,
           and ENTER right behind the last character */
        if (code.length >= 4 && fastRun >= 2 && gap > 0 && gap <= 120) {
          e.preventDefault();
          restoreLeak();
          fastRun = 0; pendingLeak = null;
          if (scanHandlerRef.current) scanHandlerRef.current(code);
          return;
        }
        if (fastRun >= 1 && gap > 0 && gap <= 120) { e.preventDefault(); restoreLeak(); }
        fastRun = 0; pendingLeak = null;
        return;
      }

      /* ----- character keys ----- */
      if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) {
        if (e.repeat) return;
        if (gap > 100) { buf = ""; fastRun = 0; }
        if (gap > 0 && gap <= MACHINE_GAP_MS) {
          /* machine speed — swallow before it can reach any field */
          e.preventDefault();
          fastRun += 1;
          if (fastRun >= 2) restoreLeak();
        } else {
          /* human speed — let it through normally */
          fastRun = 0;
          pendingLeak = snapshotFor(e.target);
        }
        buf += e.key;
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => { buf = ""; }, 400);
        return;
      }

      buf = "";
      fastRun = 0;
      pendingLeak = null;
    };

    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (resetTimer) clearTimeout(resetTimer);
    };
  }, [formOpen, addMode, confirmOpen]);

  const switchMode = (m) => {
    setAddMode(m);
    if (m === "search") setScanView(null);   // entering search mode pauses the reader
  };

  /* ================= SEARCH MODE ACTIONS ================= */
  const handleClassFilterChange = (cls) => {
    setClassFilter(cls);
    if (!cls) { setResultSelection(new Set()); return; }
    /* picking a class AUTO-SELECTS every addable student of that class —
       deselect the few that stay back, then Add Selected */
    const q = searchQuery.trim().toLowerCase();
    const qn = q ? normalizeRfid(q) : "";
    const matches = studentsSorted.filter((s) => {
      if (s.className !== cls) return false;
      if (statusFilter && s.status !== statusFilter) return false;
      if (q) {
        const hit =
          s.name.toLowerCase().includes(q) ||
          s.studentId.toLowerCase().includes(q) ||
          s.className.toLowerCase().includes(q) ||
          (qn !== "" && s.rfid.includes(qn));
        if (!hit) return false;
      }
      return isAddableNow(s);
    });
    setResultSelection(new Set(matches.map((s) => s._id)));
  };

  const toggleResultSel = (s) => {
    if (s.status === "OUT" || selectedIds.has(s._id)) return;
    setResultSelection((prev) => {
      const n = new Set(prev);
      if (n.has(s._id)) n.delete(s._id); else n.add(s._id);
      return n;
    });
  };

  const selectAllResults = () =>
    setResultSelection(new Set(searchResults.filter(isAddableNow).map((s) => s._id)));
  const deselectAllResults = () => setResultSelection(new Set());

  const addSelectedResults = () => {
    const list = searchResults.filter((s) => resultSelection.has(s._id));
    if (!list.length) return;
    const { additions, skippedDup, skippedOut } = addStudents(list);
    setResultSelection((prev) => {
      const n = new Set(prev);
      additions.forEach((s) => n.delete(s._id));
      return n;
    });
    const skipped = skippedDup + skippedOut;
    if (additions.length) {
      beep(true);
      let msg = `✓ ${additions.length} student${additions.length === 1 ? "" : "s"} added`;
      if (skipped > 0) msg += ` · ${skipped} skipped (already added / already out)`;
      showToast(msg, "success");
    } else {
      showToast(`⚠ ${skipped} skipped — already on the pass or already out.`, "error");
    }
  };

  /* ================= ISSUE ================= */
  const handleIssueClick = () => {
    const err = validateForm();
    if (err) { setFormError(err); return; }
    setFormError("");
    setConfirmOpen(true);
  };

  const handleIssueConfirmed = () => {
    const reason = resolveReason();
    const err = validateForm();
    if (err || !reason) { setConfirmOpen(false); setFormError(err || "Please fill the reason."); return; }

    const now = new Date().toISOString();
    const studentsOnPass = [...issueList]
      .sort((a, b) => (a.className || "").localeCompare(b.className || "") || (a.name || "").localeCompare(b.name || ""))
      .map((s) => ({ _id: s._id, studentId: s.studentId, name: s.name, className: s.className, rfid: normalizeRfid(s.rfid) }));

    const slipNo = makeBulkSlipNo(bulkRef.current);
    const pass = {
      _id: uid(),
      kind: "BULK_PASS",
      status: "ISSUED",
      reason,
      exitAt: `${form.exitDate}T${form.exitTime}`,
      incharges: [...form.incharges],
      students: studentsOnPass,
      returned: {},
      createdAt: now,
      issuedAt: now,
      printedAt: now,
      returnedAt: null,
      slipNo,
    };

    /* ONE ATOMIC multi-path write: the pass record + every student → OUT */
    const updates = { [`${DB_BULK_PATH}/${pass._id}`]: pass };
    studentsOnPass.forEach((s) => {
      const live = findLive(s);
      if (live) {
        updates[`students/${live._id}/status`] = "OUT";
        updates[`students/${live._id}/lastMovement`] = now;
      }
    });

    update(ref(database), updates)
      .then(() => showToast(`✓ Bulk pass ${slipNo} issued — ${studentsOnPass.length} student${studentsOnPass.length === 1 ? "" : "s"} marked OUT`, "success"))
      .catch(() => showToast("⚠ Could not save the bulk pass — check your Firebase connection / rules.", "error"));

    printBulkSlip(pass);
    beep(true);

    setConfirmOpen(false);
    setFormOpen(false);
    setSelected([]);
    setForm({ reason: "", customReason: "", exitDate: todayStr(), exitTime: nowTimeStr(), incharges: [] });
  };

  /* ================= RECORDS: EXPAND / REPRINT ================= */
  const openExpanded = (p) => { setExpandedId(p._id); setExpandedSearch(""); };

  const handleReprint = (passId) => {
    const pass = bulkRef.current.find((p) => p._id === passId);
    if (!pass) return;
    const now = new Date().toISOString();
    /* same pass — only the printed time changes */
    update(ref(database, `${DB_BULK_PATH}/${pass._id}`), { printedAt: now })
      .then(() => showToast(`✓ Bulk pass ${pass.slipNo} reprinted — print time updated`, "success"))
      .catch(() => showToast("⚠ Could not update the pass — check your Firebase connection / rules.", "error"));
    printBulkSlip({ ...pass, printedAt: now });
  };

  const copyStudentList = (pass) => {
    const text = (pass.students || []).map((s) => `${s.name} (${s.className})`).join(", ");
    const done = () => showToast(`✓ ${pass.students.length} names copied to the clipboard`, "success");
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); ta.remove(); done();
      } catch { showToast("⚠ Could not copy the list.", "error"); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else fallback();
  };

  /* ================= BULK MARK IN ================= */
  const openMarkIn = (pass) => {
    const info = passInfoMap.get(pass._id) || { out: pass.students.length };
    if (info.out === 0) { showToast("Everyone on this pass is already back in campus.", "info"); return; }
    /* only students currently OUT are listed — all selected by default */
    const outStudents = pass.students.filter((s) => {
      if (pass.returned && pass.returned[s._id]) return false;
      const live = findLive(s);
      return live && live.status === "OUT";
    });
    setMarkInSelection(new Set(outStudents.map((s) => s._id)));
    setMarkInId(pass._id);
  };

  const toggleMarkIn = (id) => setMarkInSelection((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const handleBulkMarkIn = () => {
    if (!markInPass) return;
    const now = new Date().toISOString();
    const updates = {};
    let marked = 0;

    markInPass.students.forEach((s) => {
      const sel = markInSelection.has(s._id);
      const live = findLive(s);
      if (sel && live && live.status === "OUT") {
        updates[`students/${live._id}/status`] = "IN";
        updates[`students/${live._id}/lastMovement`] = now;
        updates[`${DB_BULK_PATH}/${markInPass._id}/returned/${s._id}`] = now;
        marked++;
      } else if (!sel && live && live.status !== "OUT" && !(markInPass.returned || {})[s._id]) {
        /* came back through another desk — record it on the pass too */
        updates[`${DB_BULK_PATH}/${markInPass._id}/returned/${s._id}`] = now;
      }
    });

    if (marked === 0) { showToast("No selected student is currently OUT.", "error"); return; }

    /* does this close the pass? */
    const anyoneLeft = markInPass.students.some((s) => {
      if (updates[`${DB_BULK_PATH}/${markInPass._id}/returned/${s._id}`]) return false;
      if ((markInPass.returned || {})[s._id]) return false;
      const live = findLive(s);
      return live && live.status === "OUT";
    });
    if (!anyoneLeft) {
      updates[`${DB_BULK_PATH}/${markInPass._id}/status`] = "RETURNED";
      updates[`${DB_BULK_PATH}/${markInPass._id}/returnedAt`] = now;
    }

    update(ref(database), updates)
      .then(() => showToast(`✓ ${marked} student${marked === 1 ? "" : "s"} marked IN${!anyoneLeft ? " — bulk pass closed (all returned)" : ""}`, "success"))
      .catch(() => showToast("⚠ Could not mark in — check your Firebase connection / rules.", "error"));

    beep(true);
    setMarkInId(null);
  };

  /* ================= ESC + SCROLL LOCK ================= */
  useEffect(() => {
    const anyOverlay = formOpen || confirmOpen || !!expandedId || !!markInId;
    if (!anyOverlay) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (confirmOpen) setConfirmOpen(false);
      else if (markInId) setMarkInId(null);
      else if (expandedId) setExpandedId(null);
      else if (formOpen) closeForm();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [formOpen, confirmOpen, expandedId, markInId, closeForm]);

  /* ================= RENDER HELPERS ================= */
  const scanState = scanView ? scanView.status : null;
  const scanTone =
    scanState === "found" || scanState === "added" ? "bp-scan-ok"
    : (scanState === "notfound" || scanState === "duplicate" || scanState === "out" || scanState === "loading") ? "bp-scan-err"
    : "";
  const scanLabel =
    scanState === "found" ? "Card read"
    : scanState === "added" ? "Added to pass"
    : scanState === "duplicate" ? "Already on this pass"
    : scanState === "out" ? "Student is OUT"
    : scanState === "notfound" ? "Unknown card"
    : scanState === "loading" ? "Loading…"
    : "RFID scanner live";
  const scanSub =
  scanState === "found" ? (
    <>
      Card <code className="bp-scan-code">{scanView.code}</code> — press Add or ↵ Enter
    </>
  )
  : scanState === "added" ? (
    <>
      {scanView.student.name} added — ready for the next card
    </>
  )
  : scanState === "duplicate" ? (
    <>
      {scanView.student.name} is already on this pass
    </>
  )
  : scanState === "out" ? (
    <>
      {scanView.student.name} must be marked IN first
    </>
  )
  : scanState === "notfound" ? (
    <>
      <code className="bp-scan-code">{scanView.code}</code> is not registered
    </>
  )
  : scanState === "loading" ? (
    <>
      Waiting for the student data…
    </>
  )
  : "Tap a card on the reader — works anywhere in this form";

  const renderResult = (s) => {
    const onPass = selectedIds.has(s._id);
    const out = s.status === "OUT";
    const checked = resultSelection.has(s._id);
    return (
      <div
        key={s._id}
        className={`bp-result ${onPass ? "bp-result-onpass" : ""} ${out ? "bp-result-out" : ""}`}
        onClick={(e) => { if (e.target.closest("button")) return; toggleResultSel(s); }}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleResultSel(s); } }}
        aria-label={`${s.name}, ${s.className}${out ? " — already out" : ""}`}
      >
        <span className={`bp-check ${checked ? "bp-check-on" : ""} ${(onPass || out) ? "bp-check-off" : ""}`}>{checked ? "✓" : ""}</span>
        <span className="bp-avatar bp-avatar-sm">{getInitials(s.name)}</span>
        <div className="bp-result-main">
          <span className="bp-result-name" title={s.name}>{s.name}</span>
          <span className="bp-result-meta">{s.className || "—"} · {s.studentId || "—"}{s.rfid ? ` · ${s.rfid}` : ""}</span>
        </div>
        <span className={`bp-stchip ${(ST_META[s.status] || {}).cls || ""}`}>{(ST_META[s.status] || {}).label || s.status}</span>
        {onPass ? (
          <span className="bp-onpass-tag">✓ On pass</span>
        ) : out ? (
          <span className="bp-out-tag" title="This student is already OUT — mark them IN first">Out</span>
        ) : (
          <button type="button" className="bp-addbtn" title={`Add ${s.name}`} onClick={(e) => { e.stopPropagation(); addOne(s); }}>＋</button>
        )}
      </div>
    );
  };

  const stChipFor = (pass, s) => {
    const returnedAt = (pass.returned || {})[s._id];
    if (returnedAt) return <span className="bp-stchip bp-st-returned">↩ Returned {fmtDateTime(returnedAt)}</span>;
    const live = findLive(s);
    if (!live) return <span className="bp-stchip bp-st-missing">Not in student list</span>;
    const meta = ST_META[live.status] || { label: live.status, cls: "" };
    return <span className={`bp-stchip ${meta.cls}`}>{meta.label}</span>;
  };

  const TABS = [
    { id: "all", label: "All", count: sortedPasses.length },
    { id: "active", label: "Active", count: activeCount },
    { id: "returned", label: "Returned", count: sortedPasses.length - activeCount },
  ];

  /* ================= RENDER ================= */
  return (
    <section className="bp">
      {/* ---------- header ---------- */}
      <header className="bp-header">
        <div className="bp-head-left">
          
          
        </div>
        <div className="bp-head-right">
          <span className="bp-clock">
            {clock.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" })}
            {"  ·  "}
            {clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
          <button type="button" className="bp-btn bp-btn-primary bp-btn-issue" onClick={openForm}>
            ＋ Issue Bulk Pass
          </button>
        </div>
      </header>

      {/* ---------- records card ---------- */}
      <div className="bp-card">
        <div className="bp-listbar">
          <div className="bp-tabs" role="tablist" aria-label="Bulk pass filters">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={recordTab === t.id}
                className={`bp-tab ${recordTab === t.id ? "bp-tab-on" : ""}`}
                onClick={() => setRecordTab(t.id)}
              >
                {t.label}
                <span className="bp-tab-count">{synced ? t.count : "…"}</span>
              </button>
            ))}
          </div>
          <div className="bp-listsearch">
            <span className="bp-searchicon" aria-hidden="true">🔍</span>
            <input
              value={recordSearch}
              onChange={(e) => setRecordSearch(e.target.value)}
              placeholder="Search slip no, reason, incharge, student…"
              spellCheck={false}
              autoComplete="off"
              aria-label="Search bulk passes"
            />
            {recordSearch && (
              <button type="button" className="bp-searchclear" onClick={() => setRecordSearch("")} aria-label="Clear search">✕</button>
            )}
          </div>
        </div>

        <div className="bp-listwrap">
          {!synced ? (
            <div className="bp-list">
              {[0, 1, 2, 3].map((i) => <div key={i} className="bp-skel" style={{ animationDelay: `${i * 80}ms` }} />)}
            </div>
          ) : filteredRecords.length === 0 ? (
            <div className="bp-empty">
              <div className="bp-empty-icon">🎫</div>
              <h3>{bulkPasses.length === 0 ? "No bulk passes yet" : "No matches"}</h3>
              <p>
                {bulkPasses.length === 0
                  ? "Issue the first bulk pass with the button above — reason, exit time, incharges and the student list."
                  : `No bulk pass matches “${recordSearch}” in this tab.`}
              </p>
            </div>
          ) : (
            <div className="bp-list">
              {filteredRecords.slice(0, RECORDS_LIMIT).map((p) => {
                const info = passInfoMap.get(p._id) || { out: 0, total: p.students.length, done: true };
                return (
                  <article
                    key={p._id}
                    className={`bp-row ${info.done ? "" : "bp-row-active"}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => openExpanded(p)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openExpanded(p); } }}
                    aria-label={`Bulk pass ${p.slipNo} — ${p.reason}`}
                  >
                    <span className="bp-rowicon" aria-hidden="true">🎫</span>
                    <div className="bp-row-main">
                      <div className="bp-row-line1">
                        <span className="bp-row-slip">{p.slipNo || "—"}</span>
                        <span className="bp-row-reason" title={p.reason}>{p.reason}</span>
                        <span className={`bp-badge ${info.done ? "bp-badge-returned" : "bp-badge-active"}`}>
                          {info.done ? "Returned" : "Active"}
                        </span>
                      </div>
                      <div className="bp-row-line2">
                        <span className="bp-chip">{info.total} student{info.total === 1 ? "" : "s"}</span>
                        <span className="bp-chip">Exit {fmtDateTime(p.exitAt)}</span>
                        <span className="bp-chip" title={p.incharges.join(", ")}>
                          Incharge: {p.incharges[0] || "—"}{p.incharges.length > 1 ? ` +${p.incharges.length - 1}` : ""}
                        </span>
                        {info.out > 0 && <span className="bp-chip bp-chip-warn">{info.out} still out</span>}
                      </div>
                    </div>
                    <div className="bp-row-time" title={fmtStamp(p.issuedAt)}>
                      <span className="bp-row-time-label">Issued</span>
                      <span className="bp-row-time-value">{fmtDateTime(p.issuedAt)}</span>
                      <span className="bp-row-time-ago">{timeAgo(p.issuedAt)}</span>
                    </div>
                    <button
                      type="button"
                      className="bp-iconbtn"
                      title="Print this pass again"
                      onClick={(e) => { e.stopPropagation(); handleReprint(p._id); }}
                    >🖨</button>
                    <span className="bp-row-chevron" aria-hidden="true">›</span>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <footer className="bp-listfoot">
          <span className="bp-listfoot-note">
            {synced && filteredRecords.length > RECORDS_LIMIT
              ? `Showing the latest ${RECORDS_LIMIT} of ${filteredRecords.length} — use the search for older records`
              : `Showing ${Math.min(filteredRecords.length, RECORDS_LIMIT)} of ${bulkPasses.length} bulk pass${bulkPasses.length === 1 ? "" : "es"} · newest first`}
          </span>
          <span className="bp-listfoot-hint">click a pass for full details, reprint & bulk mark in</span>
        </footer>
      </div>

      {/* ================= ISSUE FORM OVERLAY ================= */}
      {formOpen && (
        <div className="bp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeForm(); }}>
          <ScannerSentinel />
          <div className="bp-modal bp-modal-form" role="dialog" aria-modal="true" aria-labelledby="bp-form-title">
            <div className="bp-modal-head">
              <div>
                <h2 id="bp-form-title">Issue Bulk Pass</h2>
                <p className="bp-modal-sub">One pass for the whole group — prints an 80&nbsp;mm slip and marks every student OUT.</p>
              </div>
              <button type="button" className="bp-modal-close" onClick={closeForm} aria-label="Close form">×</button>
            </div>

            <div className="bp-modal-body">
              {/* ---------- 1 · pass details ---------- */}
              <div className="bp-fsection">
                <div className="bp-fsection-head">
                  <span className="bp-fsection-title">1 · Pass details</span>
                </div>
                <div className="bp-fields">
                  <div className="bp-field-row">
                    <div className="bp-field">
                      <label htmlFor="bp-reason">Reason <span className="bp-req">*</span></label>
                      <select
                        id="bp-reason"
                        ref={reasonRef}
                        className="bp-input bp-select"
                        value={form.reason}
                        onChange={(e) => { setForm((f) => ({ ...f, reason: e.target.value })); setFormError(""); }}
                      >
                        <option value="" disabled>— select the reason —</option>
                        {BULK_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                        <option value="Other">Other (type below)</option>
                      </select>
                    </div>
                    {form.reason === "Other" && (
                      <div className="bp-field">
                        <label htmlFor="bp-reason-custom">Custom reason <span className="bp-req">*</span></label>
                        <input
                          id="bp-reason-custom"
                          className="bp-input"
                          value={form.customReason}
                          onChange={(e) => { setForm((f) => ({ ...f, customReason: e.target.value })); setFormError(""); }}
                          placeholder="Type the reason for going out together…"
                          autoComplete="off"
                        />
                      </div>
                    )}
                  </div>

                  <div className="bp-field-row bp-field-row-3">
                    <div className="bp-field">
                      <label htmlFor="bp-exit-date">Exit date <span className="bp-req">*</span></label>
                      <input
                        id="bp-exit-date"
                        type="date"
                        className="bp-input"
                        value={form.exitDate}
                        onChange={(e) => { setForm((f) => ({ ...f, exitDate: e.target.value })); setFormError(""); }}
                      />
                    </div>
                    <div className="bp-field">
                      <label htmlFor="bp-exit-time">Exit time <span className="bp-req">*</span></label>
                      <input
                        id="bp-exit-time"
                        type="time"
                        className="bp-input"
                        value={form.exitTime}
                        onChange={(e) => { setForm((f) => ({ ...f, exitTime: e.target.value })); setFormError(""); }}
                      />
                    </div>
                    <div className="bp-field bp-field-btn">
                      <label>&nbsp;</label>
                      <button type="button" className="bp-btn bp-btn-ghost" onClick={setExitNow} title="Reset the exit date & time to right now">Now</button>
                    </div>
                  </div>
                  <p className="bp-field-hint">Bulk passes have no expected-return time — the group is marked IN with “Bulk Mark In” when they come back.</p>

                  <div className="bp-field">
                    <label htmlFor="bp-incharge">Incharges accompanying the group <span className="bp-req">*</span></label>
                    <div className="bp-incharge-row">
                      <input
                        id="bp-incharge"
                        ref={inchargeRef}
                        className="bp-input"
                        value={inchargeInput}
                        onChange={(e) => { setInchargeInput(e.target.value); setFormError(""); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); addIncharges(); }
                          if (e.key === "Escape") { e.preventDefault(); setInchargeInput(""); }
                        }}
                        placeholder="Type a name and press Enter — or paste several separated by commas…"
                        autoComplete="off"
                      />
                      <button type="button" className="bp-btn bp-btn-ghost" onClick={addIncharges}>＋ Add</button>
                    </div>
                    {form.incharges.length > 0 && (
                      <div className="bp-chips">
                        {form.incharges.map((n, i) => (
                          <span key={`${n}-${i}`} className="bp-chipname">
                            {n}
                            <button type="button" onClick={() => removeIncharge(i)} aria-label={`Remove ${n}`}>×</button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ---------- 2 · add students ---------- */}
              <div className="bp-fsection">
                <div className="bp-fsection-head">
                  <span className="bp-fsection-title">2 · Add students</span>
                  <div className="bp-modes" role="tablist" aria-label="Add-student mode">
                    <button
                      type="button" role="tab" aria-selected={addMode === "rfid"}
                      className={`bp-mode ${addMode === "rfid" ? "bp-mode-on" : ""}`}
                      onClick={() => switchMode("rfid")}
                    >📡 RFID</button>
                    <button
                      type="button" role="tab" aria-selected={addMode === "search"}
                      className={`bp-mode ${addMode === "search" ? "bp-mode-on" : ""}`}
                      onClick={() => switchMode("search")}
                    >🔍 Search</button>
                  </div>
                </div>

                {addMode === "rfid" ? (
                  <div className="bp-rfid">
                    <div className={`bp-scanbox ${scanTone}`} role="status" aria-live="polite">
                      <span className="bp-scan-icon" aria-hidden="true">
                        {scanState === "found" || scanState === "added" ? "✅"
                          : (scanState && scanState !== "loading") ? "⚠️" : "📡"}
                      </span>
                      <div className="bp-scan-text">
                        <span className="bp-scan-label">{scanLabel}</span>
                        <span className="bp-scan-sub">{scanSub}</span>
                      </div>
                      <label className="bp-switch" title="Add scanned students instantly, without confirmation">
                        <input type="checkbox" checked={autoAdd} onChange={(e) => setAutoAdd(e.target.checked)} />
                        <span className="bp-switch-track" aria-hidden="true" />
                        <span className="bp-switch-text">Auto-add</span>
                      </label>
                    </div>

                    {scanView && scanView.student && (
                      <div className={`bp-scancard bp-scancard-${scanView.status}`}>
                        <span className="bp-avatar">{getInitials(scanView.student.name)}</span>
                        <div className="bp-scancard-main">
                          <span className="bp-scancard-name">{scanView.student.name}</span>
                          <div className="bp-scancard-meta">
                            <span className="bp-chip">{scanView.student.className}</span>
                            <span className="bp-chip bp-chip-mono">{scanView.student.studentId}</span>
                            <span className={`bp-stchip ${(ST_META[scanView.student.status] || {}).cls || ""}`}>
                              {(ST_META[scanView.student.status] || {}).label || scanView.student.status}
                            </span>
                          </div>
                        </div>
                        {scanView.status === "found" && (
                          <div className="bp-scancard-actions">
                            <button type="button" ref={scanAddRef} className="bp-btn bp-btn-primary" onClick={handleScanAdd}>
                              ＋ Add to Pass
                            </button>
                            <span className="bp-scancard-hint">or press ↵ Enter</span>
                          </div>
                        )}
                        {scanView.status === "added" && <span className="bp-scanmsg bp-scanmsg-ok">✓ Added — ready for the next card</span>}
                        {scanView.status === "duplicate" && <span className="bp-scanmsg bp-scanmsg-err">⚠ Already on this pass</span>}
                        {scanView.status === "out" && <span className="bp-scanmsg bp-scanmsg-err">⚠ Currently OUT — mark IN first</span>}
                      </div>
                    )}
                    {scanView && scanView.status === "notfound" && (
                      <div className="bp-scancard bp-scancard-notfound">
                        <span className="bp-scanmsg bp-scanmsg-err">
                          ⚠ Card <code className="bp-scan-code">{scanView.code}</code> is not registered in Student Manage.
                        </span>
                      </div>
                    )}

                    <p className="bp-mode-note">
                      The reader is live only in RFID mode — switching to Search pauses it completely. Scanning works even while a field is focused: machine keystrokes never reach the form.
                    </p>
                  </div>
                ) : (
                  <div className="bp-searchmode">
                    <div className="bp-searchbar">
                      <input
                        className="bp-input bp-searchinput"
                        value={searchQuery}
                        onChange={(e) => { setSearchQuery(e.target.value); setFormError(""); }}
                        placeholder="Search name, ID no, class — or any part of an RFID…"
                        spellCheck={false}
                        autoComplete="off"
                        aria-label="Search students"
                      />
                      <select
                        className="bp-input bp-select bp-filter"
                        value={classFilter}
                        onChange={(e) => handleClassFilterChange(e.target.value)}
                        aria-label="Filter by class"
                      >
                        <option value="">All classes</option>
                        {classes.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <select
                        className="bp-input bp-select bp-filter"
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                        aria-label="Filter by status"
                      >
                        <option value="">Any status</option>
                        <option value="IN">In</option>
                        <option value="OUT">Out</option>
                        <option value="REQUESTED">Requested</option>
                        <option value="APPROVED">Approved</option>
                      </select>
                    </div>

                    {!(searchQuery.trim() || classFilter || statusFilter) ? (
                      <div className="bp-searchidle">
                        <p className="bp-searchhint">
                          Type to search, or pick a class to load its full list — every student of the class is selected automatically; deselect the few who stay back and add the rest in one click.
                        </p>
                        <div className="bp-classchips">
                          {classCounts.map(([c, n]) => (
                            <button key={c} type="button" className="bp-classchip" onClick={() => handleClassFilterChange(c)}>
                              {c} <span>{n}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="bp-resultbar">
                          <span className="bp-resultmeta">
                            {!synced ? "Loading students…"
                              : <>{searchResults.length} match{searchResults.length === 1 ? "" : "es"} · {resultSelection.size} selected</>}
                          </span>
                          <div className="bp-resultbtns">
                            <button type="button" className="bp-linkbtn" onClick={selectAllResults}>Select all</button>
                            <button type="button" className="bp-linkbtn" onClick={deselectAllResults}>Deselect all</button>
                          </div>
                        </div>
                        <div className="bp-results">
                          {!synced ? (
                            <p className="bp-searchhint">Loading students…</p>
                          ) : searchResults.length === 0 ? (
                            <p className="bp-searchhint">
                              No student matches — try the surname, the class, the ID number, or part of the RFID.
                            </p>
                          ) : (
                            searchResults.map(renderResult)
                          )}
                        </div>
                        <div className="bp-resultfoot">
                          <button
                            type="button"
                            className="bp-btn bp-btn-primary"
                            disabled={resultSelection.size === 0}
                            onClick={addSelectedResults}
                          >
                            ＋ Add Selected ({resultSelection.size})
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* ---------- 3 · selected students ---------- */}
              <div className="bp-fsection">
                <div className="bp-fsection-head">
                  <span className="bp-fsection-title">
                    3 · Students on this pass <span className="bp-count-pill">{selected.length}</span>
                  </span>
                  {selected.length > 0 && (
                    <button type="button" className="bp-linkbtn" onClick={clearSelected}>Clear all</button>
                  )}
                </div>
                {selected.length === 0 ? (
                  <p className="bp-empty-note">No students added yet — scan their cards or search above.</p>
                ) : (
                  <>
                    <div className="bp-chips bp-chips-students">
                      {selected.map((s) => (
                        <span key={s._id} className="bp-stuchip">
                          <span className="bp-stuchip-name">{s.name}</span>
                          <span className="bp-stuchip-class">{s.className}</span>
                          <button type="button" onClick={() => removeStudent(s._id)} aria-label={`Remove ${s.name}`}>×</button>
                        </span>
                      ))}
                    </div>
                    <p className="bp-summary-line">{selectedClassSummary}</p>
                  </>
                )}
              </div>
            </div>

            <footer className="bp-modal-foot bp-modal-foot-form">
              <div className="bp-formfoot-left">
                {formError ? (
                  <p className="bp-alert">⚠ {formError}</p>
                ) : (
                  <p className="bp-formsummary">
                    {selected.length} student{selected.length === 1 ? "" : "s"} · {new Set(selected.map((s) => s.className)).size} class{new Set(selected.map((s) => s.className)).size === 1 ? "" : "es"}
                    {" · Exit "}{fmtFull(`${form.exitDate || todayStr()}T${form.exitTime || nowTimeStr()}`)}
                  </p>
                )}
              </div>
              <div className="bp-formfoot-btns">
                <button type="button" className="bp-btn bp-btn-ghost" onClick={closeForm}>Cancel</button>
                <button type="button" className="bp-btn bp-btn-primary" onClick={handleIssueClick}>Review &amp; Issue →</button>
              </div>
            </footer>
          </div>
        </div>
      )}

      {/* ================= CONFIRM & ISSUE ================= */}
      {formOpen && confirmOpen && (
        <div className="bp-overlay bp-overlay-top" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmOpen(false); }}>
          <ScannerSentinel />
          <div className="bp-modal bp-modal-confirm" role="dialog" aria-modal="true" aria-labelledby="bp-confirm-title">
            <div className="bp-modal-head">
              <h2 id="bp-confirm-title">Confirm &amp; Issue</h2>
              <button type="button" className="bp-modal-close" onClick={() => setConfirmOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="bp-modal-body">
              <div className="bp-grid">
                <div className="bp-mfield bp-mfield-wide">
                  <span className="bp-mfield-label">Reason</span>
                  <p className="bp-mfield-value">{resolveReason()}</p>
                </div>
                <div className="bp-mfield">
                  <span className="bp-mfield-label">Exit at</span>
                  <span className="bp-mfield-value">{fmtFull(`${form.exitDate}T${form.exitTime}`)}</span>
                </div>
                <div className="bp-mfield">
                  <span className="bp-mfield-label">Incharges</span>
                  <span className="bp-mfield-value">{form.incharges.join(", ")}</span>
                </div>
                <div className="bp-mfield bp-mfield-wide">
                  <span className="bp-mfield-label">Students ({issueList.length})</span>
                  <p className="bp-mfield-value">{confirmClassSummary}</p>
                </div>
              </div>
              {skippedAtIssue > 0 && (
                <p className="bp-alert">⚠ {skippedAtIssue} selected student{skippedAtIssue === 1 ? "" : "s"} went OUT or left Student Manage after being added — they will be skipped.</p>
              )}
              {pendingWarnCount > 0 && (
                <p className="bp-alert bp-alert-warn">⚠ {pendingWarnCount} student{pendingWarnCount === 1 ? " has" : "s have"} a pending / approved day-pass request — those requests stay as they are.</p>
              )}
              <p className="bp-modal-note">
                Issuing marks all <strong>{issueList.length}</strong> student{issueList.length === 1 ? "" : "s"} OUT in Student Manage and sends the BULK PASS slip to the printer.
              </p>
            </div>
            <footer className="bp-modal-foot">
              <button type="button" className="bp-btn bp-btn-ghost" onClick={() => setConfirmOpen(false)}>← Back</button>
              <button type="button" className="bp-btn bp-btn-primary" onClick={handleIssueConfirmed}>🖨 Confirm &amp; Print</button>
            </footer>
          </div>
        </div>
      )}

      {/* ================= EXPANDED PASS VIEW ================= */}
      {expandedPass && (() => {
        const info = passInfoMap.get(expandedPass._id) || { out: 0, total: expandedPass.students.length, done: true };
        const returnedCount = info.total - info.out;
        const pct = info.total > 0 ? Math.round((returnedCount / info.total) * 100) : 100;
        return (
          <div className="bp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setExpandedId(null); }}>
            <ScannerSentinel />
            <div className="bp-modal bp-modal-detail" role="dialog" aria-modal="true" aria-labelledby="bp-detail-title">
              <button type="button" className="bp-modal-x" onClick={() => setExpandedId(null)} aria-label="Close details">✕</button>
              <div className="bp-modal-head">
                <div className="bp-detail-id">
                  <h2 id="bp-detail-title">{expandedPass.slipNo || "Bulk Pass"}</h2>
                  <div className="bp-chips-row">
                    <span className="bp-kindchip">Bulk Pass</span>
                    <span className={`bp-badge ${info.done ? "bp-badge-returned" : "bp-badge-active"}`}>
                      {info.done ? "Returned" : "Active"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="bp-modal-body">
                <div className="bp-grid">
                  <div className="bp-mfield bp-mfield-wide">
                    <span className="bp-mfield-label">Reason</span>
                    <p className="bp-mfield-value">{expandedPass.reason}</p>
                  </div>
                  <div className="bp-mfield">
                    <span className="bp-mfield-label">Exit at</span>
                    <span className="bp-mfield-value">{fmtFull(expandedPass.exitAt)}</span>
                  </div>
                  <div className="bp-mfield">
                    <span className="bp-mfield-label">Issued at</span>
                    <span className="bp-mfield-value">{fmtStamp(expandedPass.issuedAt)}</span>
                  </div>
                  <div className="bp-mfield">
                    <span className="bp-mfield-label">Last printed</span>
                    <span className="bp-mfield-value">{fmtStamp(expandedPass.printedAt)}</span>
                  </div>
                  <div className="bp-mfield">
                    <span className="bp-mfield-label">Incharges</span>
                    <span className="bp-mfield-value">{expandedPass.incharges.join(", ") || "—"}</span>
                  </div>
                  <div className="bp-mfield">
                    <span className="bp-mfield-label">Students</span>
                    <span className="bp-mfield-value">{info.total} total · {returnedCount} returned · {info.out} still out</span>
                  </div>
                </div>

                <div className="bp-progress" title={`${returnedCount} of ${info.total} students are back in campus`}>
                  <div className="bp-progress-track"><span style={{ width: `${pct}%` }} /></div>
                  <span className="bp-progress-label">{returnedCount} of {info.total} returned</span>
                </div>

                <div className="bp-stusearch">
                  <input
                    className="bp-input"
                    value={expandedSearch}
                    onChange={(e) => setExpandedSearch(e.target.value)}
                    placeholder="Search students on this pass…"
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="Search students on this pass"
                  />
                  <button type="button" className="bp-btn bp-btn-ghost" onClick={() => copyStudentList(expandedPass)} title="Copy every Name (Class) to the clipboard">⧉ Copy list</button>
                </div>

                <div className="bp-stulist">
                  {expandedStudents.length === 0 ? (
                    <p className="bp-searchhint">No student on this pass matches “{expandedSearch}”.</p>
                  ) : (
                    expandedStudents.map((s) => (
                      <div key={`${s._id}-${s.studentId}`} className="bp-stu-row">
                        <span className="bp-avatar bp-avatar-sm">{getInitials(s.name)}</span>
                        <div className="bp-stu-main">
                          <span className="bp-stu-name">{s.name}</span>
                          <span className="bp-stu-meta">{s.className} · {s.studentId || "—"}</span>
                        </div>
                        {stChipFor(expandedPass, s)}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <footer className="bp-modal-foot">
                <button type="button" className="bp-btn bp-btn-ghost" onClick={() => setExpandedId(null)}>Close</button>
                <button type="button" className="bp-btn bp-btn-ghost" onClick={() => handleReprint(expandedPass._id)}>🖨 Print Pass</button>
                <button
                  type="button"
                  className="bp-btn bp-btn-primary"
                  disabled={info.out === 0}
                  onClick={() => openMarkIn(expandedPass)}
                >
                  ↩ Bulk Mark In{info.out > 0 ? ` (${info.out})` : ""}
                </button>
              </footer>
            </div>
          </div>
        );
      })()}

      {/* ================= BULK MARK IN ================= */}
      {markInPass && (
        <div className="bp-overlay bp-overlay-top" onMouseDown={(e) => { if (e.target === e.currentTarget) setMarkInId(null); }}>
          <ScannerSentinel />
          <div className="bp-modal bp-modal-mi" role="dialog" aria-modal="true" aria-labelledby="bp-mi-title">
            <div className="bp-modal-head">
              <div>
                <h2 id="bp-mi-title">↩ Bulk Mark In</h2>
                <p className="bp-modal-sub">{markInPass.slipNo} · {markInPass.reason}</p>
              </div>
              <button type="button" className="bp-modal-close" onClick={() => setMarkInId(null)} aria-label="Close">×</button>
            </div>

            <div className="bp-modal-body">
              <div className="bp-mi-bar">
                <span className="bp-mi-note">
                  Only the <strong>{markInList.length}</strong> student{markInList.length === 1 ? "" : "s"} still OUT are listed —{" "}
                  {markInPass.students.length - markInList.length} already in campus (hidden).
                </span>
                <div className="bp-resultbtns">
                  <button type="button" className="bp-linkbtn" onClick={() => setMarkInSelection(new Set(markInList.map((s) => s._id)))}>Select all</button>
                  <button type="button" className="bp-linkbtn" onClick={() => setMarkInSelection(new Set())}>Deselect all</button>
                </div>
              </div>
              <div className="bp-mi-list">
                {markInList.length === 0 ? (
                  <p className="bp-searchhint">Everyone on this pass is back in campus — nothing to mark in.</p>
                ) : (
                  markInList.map((s) => (
                    <label key={s._id} className="bp-mi-row">
                      <input
                        type="checkbox"
                        checked={markInSelection.has(s._id)}
                        onChange={() => toggleMarkIn(s._id)}
                      />
                      <span className="bp-avatar bp-avatar-sm">{getInitials(s.name)}</span>
                      <span className="bp-mi-name">{s.name}</span>
                      <span className="bp-chip">{s.className}</span>
                      <span className="bp-chip bp-chip-mono">{s.studentId || "—"}</span>
                      <span className="bp-stchip bp-st-out">Out</span>
                    </label>
                  ))
                )}
              </div>
            </div>

            <footer className="bp-modal-foot">
              <button type="button" className="bp-btn bp-btn-ghost" onClick={() => setMarkInId(null)}>Cancel</button>
              <button
                type="button"
                className="bp-btn bp-btn-primary"
                disabled={miSelCount === 0}
                onClick={handleBulkMarkIn}
              >
                ✓ Mark Selected In ({miSelCount})
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* ---------- toast ---------- */}
      {toast && (
        <div className={`bp-toast bp-toast-${toast.type}`} role="status">{toast.text}</div>
      )}
    </section>
  );
}