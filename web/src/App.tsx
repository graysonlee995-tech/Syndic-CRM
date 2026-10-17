import { Center, Loader } from '@mantine/core';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useMe } from './api';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { TripsPage } from './pages/TripsPage';
import { TripFormPage } from './pages/TripFormPage';
import { TripDetailPage } from './pages/TripDetailPage';
import { TripAgendaPage } from './pages/TripAgendaPage';
import { CompaniesPage } from './pages/CompaniesPage';
import { CompanyFormPage } from './pages/CompanyFormPage';
import { CompanyDetailPage } from './pages/CompanyDetailPage';
import { ClientsPage } from './pages/ClientsPage';
import { ClientFormPage } from './pages/ClientFormPage';
import { ClientDetailPage } from './pages/ClientDetailPage';
import { EmployeesPage } from './pages/EmployeesPage';
import { SettingsPage } from './pages/SettingsPage';
import { AuditPage } from './pages/AuditPage';
import { AccountPage } from './pages/AccountPage';
import { TrashPage } from './pages/TrashPage';
import { AssistantPage } from './pages/AssistantPage';

/** Old /clients links (bookmarks, earlier alert emails) now open the traveller pages. */
function ClientRedirect({ suffix = '' }: { suffix?: string }) {
  const { id } = useParams();
  return <Navigate to={id ? `/travellers/${id}${suffix}` : '/travellers'} replace />;
}

export function App() {
  const { data: user, isLoading } = useMe();

  if (isLoading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (!user) return <LoginPage />;

  const isAdmin = user.role === 'admin';
  return (
    <Routes>
      {/* Printable page, outside the app shell */}
      <Route path="trips/:id/agenda" element={<TripAgendaPage />} />
      <Route element={<Layout user={user} />}>
        <Route index element={<DashboardPage />} />
        <Route path="assistant" element={<AssistantPage />} />
        <Route path="trips" element={<TripsPage />} />
        <Route path="trips/new" element={<TripFormPage />} />
        <Route path="trips/:id" element={<TripDetailPage />} />
        <Route path="trips/:id/edit" element={<TripFormPage />} />
        <Route path="companies" element={<CompaniesPage />} />
        <Route path="companies/new" element={<CompanyFormPage />} />
        <Route path="companies/:id" element={<CompanyDetailPage />} />
        <Route path="companies/:id/edit" element={<CompanyFormPage />} />
        <Route path="travellers" element={<ClientsPage />} />
        <Route path="travellers/new" element={<ClientFormPage />} />
        <Route path="travellers/:id" element={<ClientDetailPage />} />
        <Route path="travellers/:id/edit" element={<ClientFormPage />} />
        <Route path="clients" element={<ClientRedirect />} />
        <Route path="clients/new" element={<Navigate to="/travellers/new" replace />} />
        <Route path="clients/:id" element={<ClientRedirect />} />
        <Route path="clients/:id/edit" element={<ClientRedirect suffix="/edit" />} />
        <Route path="account" element={<AccountPage />} />
        {isAdmin && <Route path="trash" element={<TrashPage />} />}
        {isAdmin && <Route path="employees" element={<EmployeesPage />} />}
        {isAdmin && <Route path="settings" element={<SettingsPage />} />}
        {isAdmin && <Route path="audit" element={<AuditPage />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
