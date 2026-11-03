import { Center, Loader } from '@mantine/core';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useMe } from './api';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { TripsPage } from './pages/TripsPage';
import { OpenCreditsPage } from './pages/OpenCreditsPage';
import { QualityPage } from './pages/QualityPage';
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
import { Allowed } from './permissions';

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

  return (
    <Routes>
      {/* Printable page, outside the app shell */}
      <Route path="trips/:id/agenda" element={<Allowed section="trips"><TripAgendaPage /></Allowed>} />
      <Route element={<Layout user={user} />}>
        <Route index element={<Allowed section="dashboard"><DashboardPage /></Allowed>} />
        <Route path="assistant" element={<Allowed section="assistant"><AssistantPage /></Allowed>} />
        <Route path="trips" element={<Allowed section="trips"><TripsPage /></Allowed>} />
        <Route path="trips/new" element={<Allowed section="trips" action="add"><TripFormPage /></Allowed>} />
        <Route path="trips/:id" element={<Allowed section="trips"><TripDetailPage /></Allowed>} />
        <Route path="trips/:id/edit" element={<Allowed section="trips" action="edit"><TripFormPage /></Allowed>} />
        <Route path="open-credits" element={<Allowed section="open_credits"><OpenCreditsPage /></Allowed>} />
        <Route path="quality" element={<Allowed section="quality"><QualityPage /></Allowed>} />
        <Route path="companies" element={<Allowed section="companies"><CompaniesPage /></Allowed>} />
        <Route path="companies/new" element={<Allowed section="companies" action="add"><CompanyFormPage /></Allowed>} />
        <Route path="companies/:id" element={<Allowed section="companies"><CompanyDetailPage /></Allowed>} />
        <Route path="companies/:id/edit" element={<Allowed section="companies" action="edit"><CompanyFormPage /></Allowed>} />
        <Route path="travellers" element={<Allowed section="travellers"><ClientsPage /></Allowed>} />
        <Route path="travellers/new" element={<Allowed section="travellers" action="add"><ClientFormPage /></Allowed>} />
        <Route path="travellers/:id" element={<Allowed section="travellers"><ClientDetailPage /></Allowed>} />
        <Route path="travellers/:id/edit" element={<Allowed section="travellers" action="edit"><ClientFormPage /></Allowed>} />
        <Route path="clients" element={<ClientRedirect />} />
        <Route path="clients/new" element={<Navigate to="/travellers/new" replace />} />
        <Route path="clients/:id" element={<ClientRedirect />} />
        <Route path="clients/:id/edit" element={<ClientRedirect suffix="/edit" />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="trash" element={<Allowed section="trash"><TrashPage /></Allowed>} />
        <Route path="employees" element={<Allowed section="employees"><EmployeesPage /></Allowed>} />
        <Route path="settings" element={<Allowed section="settings"><SettingsPage /></Allowed>} />
        <Route path="audit" element={<Allowed section="audit"><AuditPage /></Allowed>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
