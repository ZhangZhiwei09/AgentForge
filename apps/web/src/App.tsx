import { Routes, Route, Navigate } from "react-router-dom";
import { ChatLayout } from "./components/layout/ChatLayout";

export default function App() {
    return (
        <Routes>
            <Route path="/" element={<ChatLayout />} />
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}
