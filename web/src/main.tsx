import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { Accounts } from './pages/Accounts';
import { Budgets } from './pages/Budgets';
import { Dashboard } from './pages/Dashboard';
import { Insights } from './pages/Insights';
import { Recurring } from './pages/Recurring';
import { Settings } from './pages/Settings';
import { Transactions } from './pages/Transactions';
import './styles.css';
import { ErrorNote, Field } from './ui';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5_000 } } });

function AuthGate() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['auth'], queryFn: () => api<{ setup_required: boolean; authenticated: boolean }>('/auth/status') });
  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: ['auth'] });
    window.addEventListener('lq:unauthorized', onUnauthorized);
    return () => window.removeEventListener('lq:unauthorized', onUnauthorized);
  }, [qc]);
  if (status.isLoading) return null;
  if (status.error) return <div className="auth"><ErrorNote error={status.error} /></div>;
  if (!status.data?.authenticated) return <Login setup={status.data!.setup_required} onDone={() => qc.invalidateQueries()} />;
  return <Shell />;
}

function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(setup ? '/auth/setup' : '/auth/login', { body: { password } });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}><i />Liquidity</div>
        <p className="muted">{setup ? 'Welcome. Choose a password to protect your financial data.' : 'Enter your password to continue.'}</p>
        <Field label={setup ? 'New password (at least 8 characters)' : 'Password'}>
          <input type="password" autoFocus required minLength={setup ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? 'new-password' : 'current-password'} />
        </Field>
        <ErrorNote error={error} />
        <button className="btn primary" disabled={busy}>{setup ? 'Set password' : 'Log in'}</button>
      </form>
    </div>
  );
}

const NAV = [
  ['/', 'Dashboard'], ['/transactions', 'Transactions'], ['/budgets', 'Budgets'], ['/recurring', 'Recurring'],
  ['/insights', 'Insights'], ['/accounts', 'Accounts'], ['/settings', 'Settings'],
] as const;

function Shell() {
  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand"><i />Liquidity</div>
        {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
        <div className="spacer" />
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/budgets" element={<Budgets />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
