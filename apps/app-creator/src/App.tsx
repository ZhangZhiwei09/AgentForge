import { Routes, Route } from "react-router-dom";
import { AuthGuard } from "@agentforge/ui";
import { AppShell } from "./components/layout/AppShell";
import { LoginPage } from "./components/auth/LoginPage";
import { AppGenLayout } from "./components/app-gen/AppGenLayout";
import { NewProjectPage } from "./components/app-gen/NewProjectPage";

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/projects/new"
          element={
            <AuthGuard>
              <NewProjectPage />
            </AuthGuard>
          }
        />
        <Route
          path="/projects/:id"
          element={
            <AuthGuard>
              <AppGenLayout />
            </AuthGuard>
          }
        />
        <Route
          path="/projects"
          element={
            <AuthGuard>
              <AppGenLayout />
            </AuthGuard>
          }
        />
        <Route path="/*" element={<AppGenLayout />} />
      </Routes>
    </AppShell>
  );
}
