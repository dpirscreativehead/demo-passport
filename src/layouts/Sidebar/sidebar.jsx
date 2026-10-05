import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import Permission from "../../components/Permission";
import "./sidebar.css";

/* =========================================
   ICONS (inline SVG — Lucide / Feather style)
========================================= */

const IconGlobe = () => (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18" />
        <path d="M12 3a13.5 13.5 0 0 1 4 9 13.5 13.5 0 0 1-4 9 13.5 13.5 0 0 1-4-9 13.5 13.5 0 0 1 4-9z" />
    </svg>
);

const IconGrid = () => (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
        <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
        <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
        <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
    </svg>
);

const IconCap = () => (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M22 9.5 12 4.5 2 9.5l10 5 10-5z" />
        <path d="M6 11.8V17c0 1.7 2.7 2.9 6 2.9s6-1.2 6-2.9v-5.2" />
        <path d="M22 9.5v5.5" />
    </svg>
);

const IconBriefcase = () => (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2.5" y="7" width="19" height="13.5" rx="2.5" />
        <path d="M8.5 7V5.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2V7" />
        <path d="M2.5 12.5h19" />
    </svg>
);

const IconChart = () => (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 4v16h16" />
        <path d="M9 16.5V12" />
        <path d="M13 16.5V7.5" />
        <path d="M17 16.5V10" />
    </svg>
);

const IconSliders = () => (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 21v-7" /><path d="M4 10V3" />
        <path d="M12 21v-9" /><path d="M12 8V3" />
        <path d="M20 21v-5" /><path d="M20 12V3" />
        <path d="M1 14h6" /><path d="M9 8h6" /><path d="M17 16h6" />
    </svg>
);

const IconUsers = () => (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16.5 20.5v-1.9a3.9 3.9 0 0 0-3.9-3.9H6.2a3.9 3.9 0 0 0-3.9 3.9v1.9" />
        <circle cx="9.4" cy="7.4" r="3.9" />
        <path d="M21.7 20.5v-1.9a3.9 3.9 0 0 0-2.9-3.7" />
        <path d="M15.6 3.9a3.9 3.9 0 0 1 0 7.2" />
    </svg>
);

const IconData = () => (
    <svg
        width="19"
        height="19"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
        <path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
    </svg>
);

const IconLogout = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
        <path d="m16 17 5-5-5-5" />
        <path d="M21 12H9" />
    </svg>
);

const IconClose = () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
    </svg>
);


function Sidebar() {
    const navigate = useNavigate();
    const location = useLocation();

    /* ---------- MOBILE MENU STATE ---------- */
    const [menuOpen, setMenuOpen] = useState(false);

    /* ---------- LIQUID SLIDING PILL ---------- */
    const navRef = useRef(null);
    const pillRef = useRef(null);
    const firstMeasure = useRef(true);

    const measurePill = (animate) => {
        const nav = navRef.current;
        const pill = pillRef.current;
        if (!nav || !pill) return;

        const active =
            nav.querySelector("a.active") ||
            nav.querySelector('a[aria-current="page"]');

        if (!active) {
            pill.style.opacity = "0";
            return;
        }

        pill.style.opacity = "1";
        pill.style.height = `${active.offsetHeight}px`;
        pill.style.width = `${active.offsetWidth}px`;

        if (!animate) {
            /* first paint — jump straight into place, no slide */
            pill.style.transition = "none";
            pill.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
            void pill.offsetHeight; /* force reflow */
            requestAnimationFrame(() => { pill.style.transition = ""; });
        } else {
            pill.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
        }
    };

    /* slide the pill whenever the route changes */
    useLayoutEffect(() => {
        measurePill(!firstMeasure.current);
        firstMeasure.current = false;
    }, [location.pathname]);

    /* keep it aligned on resize (desktop <-> tablet <-> mobile) */
    useEffect(() => {
        const onResize = () => measurePill(false);
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    /* re-align when the mobile dropdown opens */
    useEffect(() => {
        if (menuOpen) requestAnimationFrame(() => measurePill(false));
    }, [menuOpen]);

    const userName = localStorage.getItem("name") || "User";
    const role = localStorage.getItem("role") || "Member";

    const initials =
        userName
            .trim()
            .split(/\s+/)
            .map((word) => word[0])
            .filter(Boolean)
            .slice(0, 2)
            .join("")
            .toUpperCase() || "U";

    /* auto-close the menu whenever the route changes */
    useEffect(() => {
        setMenuOpen(false);
    }, [location.pathname]);

    /* lock page scroll while the menu is open */
    useEffect(() => {
        document.body.classList.toggle("menu-locked", menuOpen);
        return () => document.body.classList.remove("menu-locked");
    }, [menuOpen]);

    /* close with the ESC key */
    useEffect(() => {
        if (!menuOpen) return;

        const onKeyDown = (event) => {
            if (event.key === "Escape") setMenuOpen(false);
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [menuOpen]);

    /* close when resizing up to tablet / desktop */
    useEffect(() => {
        const onResize = () => {
            if (window.innerWidth > 768) setMenuOpen(false);
        };

        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    const handleLogout = () => {
        localStorage.removeItem("dpirsUser");
        localStorage.removeItem("username");
        localStorage.removeItem("name");
        localStorage.removeItem("role");
        localStorage.removeItem("userid");

        navigate("/login", { replace: true });
    };

    return (
        <aside className={`sidebar${menuOpen ? " menu-open" : ""}`}>

            <div className="sidebar-bar">

                <div className="sidebar-brand">
                    <span className="sidebar-brand-mark">
                        <IconGlobe />
                    </span>

                    <div className="sidebar-brand-text">
                        <span className="sidebar-brand-name">PassPort</span>
                        <span className="sidebar-brand-sub">DPIRS</span>
                    </div>
                </div>

                <button
                    type="button"
                    className="sidebar-burger"
                    aria-label={menuOpen ? "Close menu" : "Open menu"}
                    aria-expanded={menuOpen}
                    aria-controls="sidebar-menu"
                    onClick={() => setMenuOpen((open) => !open)}
                >
                    <span />
                    <span />
                    <span />
                </button>

            </div>

            <div
                className="sidebar-backdrop"
                aria-hidden="true"
                onClick={() => setMenuOpen(false)}
            />

            <div className="sidebar-body" id="sidebar-menu">

                <div className="sidebar-menu-head">
                    <span className="sidebar-menu-title">Menu</span>

                    <button
                        type="button"
                        className="sidebar-close"
                        aria-label="Close menu"
                        onClick={() => setMenuOpen(false)}
                    >
                        <IconClose />
                    </button>
                </div>

                <nav className="sidebar-nav" ref={navRef}>

                    {/* the liquid highlight — glides between tabs */}
                    <div className="nav-pill" ref={pillRef} aria-hidden="true" />

                    <NavLink to="/dashboard">
                        <span className="nav-icon"><IconGrid /></span>
                        <span className="nav-label">Dashboard</span>
                    </NavLink>

                    <NavLink to="/student">
                        <span className="nav-icon"><IconCap /></span>
                        <span className="nav-label">Student</span>
                    </NavLink>

                    <NavLink to="/bulk">
                        <span className="nav-icon"><IconCap /></span>
                        <span className="nav-label">Bulk</span>
                    </NavLink>

                    <NavLink to="/staff">
                        <span className="nav-icon"><IconBriefcase /></span>
                        <span className="nav-label">Staff</span>
                    </NavLink>

                    <Permission permission="Reports">
                    <NavLink to="/reports">
                        <span className="nav-icon"><IconChart /></span>
                        <span className="nav-label">Reports</span>
                    </NavLink>
                    </Permission>

                    <Permission permission="Preferences">
                    <NavLink to="/preferences">
                        <span className="nav-icon"><IconSliders /></span>
                        <span className="nav-label">Preferences</span>
                    </NavLink>
                    </Permission>

                    <Permission permission="Users">
                        <NavLink to="/users">
                            <span className="nav-icon"><IconUsers /></span>
                            <span className="nav-label">Users</span>
                        </NavLink>
                    </Permission>

                    <Permission permission="Data">
                        <NavLink to="/data">
                            <span className="nav-icon"><IconData /></span>
                            <span className="nav-label">Data</span>
                        </NavLink>
                    </Permission>

                </nav>

                <div className="sidebar-footer">

                    <div className="sidebar-user">
                        <span className="sidebar-user-avatar">{initials}</span>

                        <div className="sidebar-user-info">
                            <span className="sidebar-user-name">{userName}</span>
                            <span className="sidebar-user-role">{role}</span>
                        </div>
                    </div>

                    <button
                        type="button"
                        className="sidebar-logout"
                        onClick={handleLogout}
                    >
                        <IconLogout />
                        <span>Logout</span>
                    </button>

                </div>

            </div>

        </aside>
    );
}

export default Sidebar;