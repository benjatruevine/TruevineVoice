'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { api } from '../lib/api';

type Organization = {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED';
  campaignCount: number;
};

type DispatchState = 'RUNNING' | 'PAUSED' | 'CANCELLED';

type Campaign = {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  id: string;
  name: string;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'COMPLETED';
  emergencyStoppedAt: string | null;
  dispatchState?: DispatchState;
  dispatchEpoch?: number;
  dispatchStopReason?: string | null;
};

type Health = {
  application: { status: string; dependencies: Record<string, { status: string }> };
  voiceProvider: { status: string; activeCalls: number | null };
};

type Operator = { platformRole: 'PLATFORM_OWNER' | 'OPERATIONS_ADMIN' | 'AUDITOR' };

const REASON_CODES = [
  'security_incident',
  'provider_incident',
  'abuse_suspected',
  'customer_request',
  'other',
] as const;

function statusClass(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === 'active' || normalized === 'ok' || normalized === 'up') return 'status-active';
  if (normalized === 'paused' || normalized === 'degraded') return 'status-paused';
  return 'status-suspended';
}

/** Explicit dispatch state, with a conservative presentation for older rows. */
export function campaignDispatchState(
  campaign: Pick<Campaign, 'status' | 'dispatchState' | 'emergencyStoppedAt'>,
): DispatchState {
  if (campaign.dispatchState) return campaign.dispatchState;
  if (campaign.status === 'CANCELLED') return 'CANCELLED';
  if (campaign.status === 'PAUSED' || campaign.emergencyStoppedAt) return 'PAUSED';
  return 'RUNNING';
}

export function dispatchStopReasonLabel(reason?: string | null): string | null {
  switch (reason) {
    case 'security_incident':
      return 'Security incident';
    case 'provider_incident':
      return 'Provider incident';
    case 'abuse_suspected':
      return 'Abuse suspected';
    case 'customer_request':
      return 'Customer request';
    case 'emergency_stop':
      return 'Platform emergency stop';
    case 'customer_pause':
      return 'Paused by organization member';
    case 'customer_cancel':
      return 'Cancelled by organization member';
    case 'insufficient_balance':
      return 'Insufficient approved reserve';
    case 'dispatch_policy_unavailable':
      return 'No approved cost policy';
    default:
      return null;
  }
}

/** The stop action is only offered when new paid work is not already blocked. */
export function canEmergencyStop(campaign: Campaign, canStop: boolean): boolean {
  return (
    canStop &&
    campaign.status === 'ACTIVE' &&
    campaignDispatchState(campaign) === 'RUNNING' &&
    !campaign.emergencyStoppedAt
  );
}

export function filterOrganizations(
  organizations: Organization[],
  search: string,
  status: 'ALL' | 'ACTIVE' | 'SUSPENDED',
): Organization[] {
  const normalizedSearch = search.trim().toLowerCase();
  return organizations.filter((org) => {
    const matchesSearch =
      normalizedSearch === '' ||
      org.name.toLowerCase().includes(normalizedSearch) ||
      org.slug.toLowerCase().includes(normalizedSearch);
    const matchesStatus = status === 'ALL' || org.status === status;
    return matchesSearch && matchesStatus;
  });
}

export function filterCampaigns(
  campaigns: Campaign[],
  search: string,
  status: 'ALL' | Campaign['status'],
): Campaign[] {
  const normalizedSearch = search.trim().toLowerCase();
  return campaigns.filter((campaign) => {
    const matchesSearch =
      normalizedSearch === '' ||
      campaign.name.toLowerCase().includes(normalizedSearch) ||
      campaign.organizationName.toLowerCase().includes(normalizedSearch) ||
      campaign.organizationSlug.toLowerCase().includes(normalizedSearch);
    const matchesStatus = status === 'ALL' || campaign.status === status;
    return matchesSearch && matchesStatus;
  });
}

export default function OperationsDashboard() {
  const router = useRouter();
  const [operator, setOperator] = useState<Operator | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [busy, setBusy] = useState(false);
  const [orgSearch, setOrgSearch] = useState('');
  const [orgStatus, setOrgStatus] = useState<'ALL' | 'ACTIVE' | 'SUSPENDED'>('ALL');
  const [campaignSearch, setCampaignSearch] = useState('');
  const [campaignStatus, setCampaignStatus] = useState<'ALL' | Campaign['status']>('ALL');
  const [stopTarget, setStopTarget] = useState<Campaign | null>(null);
  const [reasonCode, setReasonCode] = useState<string>(REASON_CODES[0]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const me = await api<Operator>('/platform/operations/me');
      const [orgRows, campaignRows, healthReport] = await Promise.all([
        api<Organization[]>('/platform/operations/organizations'),
        api<Campaign[]>('/platform/operations/campaigns'),
        api<Health>('/platform/operations/health'),
      ]);
      setOperator(me);
      setOrganizations(orgRows);
      setCampaigns(campaignRows);
      setHealth(healthReport);
      setLastUpdated(new Date().toLocaleString());
      setMessage('');
    } catch (caught) {
      const status = (caught as Error & { status?: number }).status;
      setOperator(null);
      if (status === 403) {
        const supportAccess = await api<{ platformRole: string } | null>('/platform/support/me').catch(() => null);
        if (supportAccess) {
          router.push('/support');
          return;
        }
        const technicalAccess = await api<{ platformRole: string } | null>('/platform/technical/me').catch(() => null);
        if (technicalAccess) {
          router.push('/technical');
          return;
        }
        const auditorAccess = await api<{ platformRole: string } | null>('/platform/audit/me').catch(() => null);
        if (auditorAccess) {
          router.push('/auditor');
          return;
        }
      }
      setError(
        status === 401
          ? 'Sign in with an approved platform account.'
          : status === 403
            ? 'This account does not have Operations Admin access.'
            : 'Operations data is temporarily unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('Signing in…');
    try {
      await api('/auth/sign-in', { method: 'POST', body: JSON.stringify({ email, password }) });
      setPassword('');
      window.dispatchEvent(new Event('truevine:session-changed'));
      await load();
    } catch {
      setMessage('Sign-in failed. Check the credentials and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmStop() {
    if (!stopTarget) return;
    setBusy(true);
    try {
      await api(
        `/platform/operations/organizations/${encodeURIComponent(stopTarget.organizationId)}/campaigns/${encodeURIComponent(stopTarget.id)}/emergency-stop`,
        {
          method: 'POST',
          body: JSON.stringify({ reasonCode }),
        },
      );
      setMessage('Campaign stopped and the action was recorded.');
      setStopTarget(null);
      await load();
    } catch {
      setMessage('Emergency stop failed. Refresh and verify the campaign state.');
    } finally {
      setBusy(false);
    }
  }

  const filteredOrganizations = filterOrganizations(organizations, orgSearch, orgStatus);
  const filteredCampaigns = filterCampaigns(campaigns, campaignSearch, campaignStatus);

  const canStop =
    operator?.platformRole === 'OPERATIONS_ADMIN' || operator?.platformRole === 'PLATFORM_OWNER';

  return (
    <main className="operations-shell platform-admin-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">TRUEVINE VOICE · PLATFORM OPERATIONS</span>
          <h1>Operations</h1>
          <p className="subtitle">Monitor service health, organizations, campaigns, and authorized emergency operations.</p>
        </div>
        {operator && (
          <button type="button" className="quiet-button" disabled={loading} onClick={() => void load()}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </header>

      {message && <p className="notice" role="status">{message}</p>}
      {error && <p className="notice form-error" role="alert">{error}</p>}

      {!operator ? (
        <form className="card sign-in" onSubmit={(event) => void signIn(event)}>
          <h2>Platform sign in</h2>
          <label>
            Email
            <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label>
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          <button disabled={busy || loading} type="submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      ) : (
        <>
          <section className="health-grid" aria-label="Service health">
            <HealthCard label="API" value={health?.application.status ?? 'unknown'} />
            <HealthCard label="PostgreSQL" value={health?.application.dependencies.postgres?.status ?? 'unknown'} />
            <HealthCard label="Redis" value={health?.application.dependencies.redis?.status ?? 'unknown'} />
            <HealthCard label="Voice provider" value={health?.voiceProvider.status ?? 'unknown'} detail="No provider integration is configured." />
          </section>

          <section className="card">
            <div className="section-heading">
              <h2>Operational summary</h2>
              <span>Updated {lastUpdated || 'not yet loaded'}</span>
            </div>
            <div className="health-grid">
              <div className="health-card">
                <span>Organizations</span>
                <strong>{organizations.length}</strong>
              </div>
              <div className="health-card">
                <span>Campaigns</span>
                <strong>{campaigns.length}</strong>
              </div>
              <div className="health-card">
                <span>Active campaigns</span>
                <strong>{campaigns.filter((campaign) => campaign.status === 'ACTIVE').length}</strong>
              </div>
              <div className="health-card">
                <span>Emergency stopped</span>
                <strong>{campaigns.filter((campaign) => campaign.emergencyStoppedAt).length}</strong>
              </div>
            </div>
            {health && (health.application.status.toLowerCase() !== 'ok' || health.voiceProvider.status.toLowerCase() !== 'up') && (
              <p className="notice form-error" role="alert">
                One or more operational dependencies are degraded. Review provider and service status before taking action.
              </p>
            )}
          </section>

          <section className="card">
            <div className="section-heading">
              <h2>Organizations</h2>
              <span>{filteredOrganizations.length} shown</span>
            </div>
            <div className="search-bar">
              <label>
                Search
                <input value={orgSearch} onChange={(event) => setOrgSearch(event.target.value)} placeholder="Name or slug" />
              </label>
              <label>
                Status
                <select value={orgStatus} onChange={(event) => setOrgStatus(event.target.value as 'ALL' | 'ACTIVE' | 'SUSPENDED')}>
                  <option value="ALL">All</option>
                  <option value="ACTIVE">Active</option>
                  <option value="SUSPENDED">Suspended</option>
                </select>
              </label>
            </div>
            {loading ? (
              <p>Loading organizations…</p>
            ) : filteredOrganizations.length === 0 ? (
              <p>No organizations match the current filters.</p>
            ) : (
              <div className="table-wrap">
                <table className="platform-admin-table">
                  <thead>
                    <tr>
                      <th>Organization</th>
                      <th>Status</th>
                      <th>Campaigns</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredOrganizations.map((org) => (
                      <tr key={org.id}>
                        <td className="email-cell" data-label="Organization">
                          {org.name}
                          <small>{org.slug}</small>
                        </td>
                        <td data-label="Status">
                          <span className={`status ${statusClass(org.status)}`}>{org.status}</span>
                        </td>
                        <td data-label="Campaigns">{org.campaignCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <div className="section-heading">
              <h2>Campaign operations</h2>
              <span>Latest {filteredCampaigns.length}</span>
            </div>
            <div className="search-bar">
              <label>
                Search
                <input value={campaignSearch} onChange={(event) => setCampaignSearch(event.target.value)} placeholder="Campaign, organization, or slug" />
              </label>
              <label>
                Status
                <select value={campaignStatus} onChange={(event) => setCampaignStatus(event.target.value as 'ALL' | Campaign['status'])}>
                  <option value="ALL">All</option>
                  <option value="DRAFT">Draft</option>
                  <option value="ACTIVE">Active</option>
                  <option value="PAUSED">Paused</option>
                  <option value="CANCELLED">Cancelled</option>
                  <option value="COMPLETED">Completed</option>
                </select>
              </label>
            </div>
            {loading ? (
              <p>Loading campaigns…</p>
            ) : filteredCampaigns.length === 0 ? (
              <p>No campaigns match the current filters.</p>
            ) : (
              <div className="table-wrap">
                <table className="platform-admin-table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Organization</th>
                      <th>Status</th>
                      <th>Dispatch</th>
                      <th>Stop detail</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCampaigns.map((campaign) => (
                      <tr key={`${campaign.organizationId}:${campaign.id}`}>
                        <td className="email-cell" data-label="Campaign">{campaign.name}</td>
                        <td data-label="Organization">
                          {campaign.organizationName}
                          <small>{campaign.organizationSlug}</small>
                        </td>
                        <td data-label="Status">
                          <span className={`status ${statusClass(campaign.status)}`}>{campaign.status}</span>
                          {campaign.emergencyStoppedAt && <small>Stopped {new Date(campaign.emergencyStoppedAt).toLocaleString()}</small>}
                        </td>
                        <td data-label="Dispatch">
                          <span className={`status ${statusClass(campaignDispatchState(campaign))}`}>
                            {campaignDispatchState(campaign)}
                          </span>
                          <small>Epoch {campaign.dispatchEpoch ?? 'unknown'}</small>
                        </td>
                        <td data-label="Stop detail">
                          {dispatchStopReasonLabel(campaign.dispatchStopReason) ?? '—'}
                        </td>
                        <td data-label="Action">
                          {canEmergencyStop(campaign, canStop) && (
                            <button
                              type="button"
                              className="danger-button platform-admin-action"
                              disabled={busy}
                              onClick={() => {
                                setStopTarget(campaign);
                                setReasonCode(REASON_CODES[0]);
                              }}
                            >
                              Emergency stop
                            </button>
                          )}
                          {campaignDispatchState(campaign) !== 'RUNNING' && (
                            <span className="status status-suspended">
                              {campaign.emergencyStoppedAt ? 'Emergency stopped' : 'Dispatch stopped'}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="footnote">
            Emergency stop sets a terminal dispatch block for the campaign. The worker rechecks it under a shared advisory lock before any paid provider work; calls the provider already accepted are still reconciled.
          </p>
        </>
      )}

      {stopTarget && (
        <div className="inline-confirm" role="dialog" aria-modal="true" aria-labelledby="emergency-stop-title">
          <p id="emergency-stop-title">
            Emergency stop {stopTarget.name} for {stopTarget.organizationName}?
          </p>
          <label>
            Reason code
            <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>
              {REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button type="button" className="danger-button platform-admin-action" disabled={busy} onClick={() => void confirmStop()}>
              {busy ? 'Stopping…' : 'Confirm emergency stop'}
            </button>
            <button type="button" className="quiet-button platform-admin-action" disabled={busy} onClick={() => setStopTarget(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function HealthCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="health-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}
