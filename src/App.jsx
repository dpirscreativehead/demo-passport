import {Routes, Route, Navigate } from "react-router-dom";

import MainLayout from "./layouts/MainLayout";

import Login from "./pages/Login/login";
import ProtectedRoute from "../src/components/ProtectedRoute";
import PermissionRoute from "../src/components/PermissionRoute";

import Dashboard from "./pages/Dashboard/dashboard";
import Student from "./pages/Student/student";
import Bulk from "./pages/Bulk/bulk";
import Staff from "./pages/Staff/staff";
import Reports from "./pages/Reports/reports";
import Preferences from "./pages/Preferences/preferences";
import Profile from "./pages/Profile/profile";
import Users from "./pages/Users/users";
import Data from "./pages/Data/data";


function App() {
    return (
       
            <Routes>

                {/* Root */}
                <Route path="/" element={<Navigate to="/dashboard" replace />} />

                {/* Login */}
                <Route path="/login" element={<Login />} />


                {/* Login required for everything below */}
                <Route element={<ProtectedRoute />}>

                    {/* Main application layout */}
                    <Route element={<MainLayout />}>

                        {/* Normal protected pages */}
                        <Route path="/dashboard" element={<Dashboard />} />

                        <Route path="/student" element={<Student />} />

                        <Route path="/bulk" element={<Bulk />} />

                        <Route path="/staff" element={<Staff />} />

                        <Route path="/reports" element={<Reports />} />

                        <Route
                            path="/preferences"
                            element={<Preferences />}
                        />

                        <Route path="/profile" element={<Profile />} />


                        {/* Admin-only Users page */}
                        <Route element={<PermissionRoute permission="Users" />}>
                            <Route
                                path="/users"
                                element={<Users />}
                            />
                        </Route>
                        <Route element={<PermissionRoute permission="Data" />}>
                            <Route
                                path="/data"
                                element={<Data />}
                            />
                        </Route>

                    </Route>

                </Route>


                {/* Unknown URL */}
                <Route path="*" element={<Login />} />

            </Routes>
        
    );
}

export default App;