import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import OperationsDashboard, {
  campaignDispatchState,
  canEmergencyStop,
  dispatchStopReasonLabel,
  filterCampaigns,
  filterOrganizations,
} from './operations-dashboard';

const organizations = [
  { id: 'org-1', name: 'Acme', slug: 'acme', status: 'ACTIVE' as const, campaignCount: 2 },
  { id: 'org-2', name: 'Bravo', slug: 'bravo', status: 'SUSPENDED' as const, campaignCount: 0 },
];

const campaigns = [
  {
    organizationId: 'org-1',
    organizationName: 'Acme',
    organizationSlug: 'acme',
    id: 'cmp-1',
    name: 'Launch',
    status: 'ACTIVE' as const,
    emergencyStoppedAt: null,
    dispatchState: 'RUNNING' as const,
    dispatchEpoch: 1,
    dispatchStopReason: null,
  },
  {
    organizationId: 'org-2',
    organizationName: 'Bravo',
    organizationSlug: 'bravo',
    id: 'cmp-2',
    name: 'Paused',
    status: 'PAUSED' as const,
    emergencyStoppedAt: '2026-01-01T00:00:00.000Z',
    dispatchState: 'PAUSED' as const,
    dispatchEpoch: 4,
    dispatchStopReason: 'emergency_stop',
  },
  {
    organizationId: 'org-1',
    organizationName: 'Acme',
    organizationSlug: 'acme',
    id: 'cmp-3',
    name: 'Cancelled',
    status: 'CANCELLED' as const,
    emergencyStoppedAt: null,
    dispatchState: 'CANCELLED' as const,
    dispatchEpoch: 5,
    dispatchStopReason: 'customer_cancel',
  },
];

describe('OperationsDashboard', () => {
  it('renders the operations workspace shell', () => {
    const markup = renderToStaticMarkup(<OperationsDashboard />);
    expect(markup).toContain('PLATFORM OPERATIONS');
    expect(markup).toContain('Operations');
  });

  it('renders an unauthenticated sign-in state', () => {
    const markup = renderToStaticMarkup(<OperationsDashboard />);
    expect(markup).toContain('Platform sign in');
    // Initial discovery issues the CSRF cookie before a sign-in can be submitted.
    expect(markup).toMatch(/<button\b(?=[^>]*type="submit")(?=[^>]*\bdisabled)[^>]*>/);
  });

  it('keeps the mobile operations table within its container without hiding overflow', () => {
    const local = resolve(process.cwd(), 'src/app');
    const workspace = resolve(process.cwd(), 'apps/admin/src/app');
    const appDir = existsSync(resolve(local, 'globals.css')) ? local : workspace;
    const css = readFileSync(resolve(appDir, 'globals.css'), 'utf8');
    const shellCss = readFileSync(resolve(appDir, 'platform-shell.css'), 'utf8');
    const source = readFileSync(resolve(appDir, 'operations-dashboard.tsx'), 'utf8');
    expect(css).toContain('.platform-admin-shell { width: 100%; min-width: 0; max-width: 100%; padding: 1rem; }');
    expect(css).toContain('.health-grid { grid-template-columns: minmax(0, 1fr); }');
    expect(shellCss).toMatch(/@media \(max-width: 768px\) \{[\s\S]*?\.platform-app-shell \{[\s\S]*?display: block;/);
    expect(css).not.toContain('overflow-x: hidden');
    expect(source).toContain('data-label="Campaign"');
    expect(source).toContain('data-label="Action"');
  });
});

describe('operation filters', () => {
  it('filters organizations by search and status', () => {
    expect(filterOrganizations(organizations, 'ac', 'ALL')).toHaveLength(1);
    expect(filterOrganizations(organizations, '', 'SUSPENDED')).toHaveLength(1);
    expect(filterOrganizations(organizations, 'zzz', 'ALL')).toHaveLength(0);
  });

  it('filters campaigns by organization, name, and status', () => {
    expect(filterCampaigns(campaigns, 'bravo', 'ALL')).toHaveLength(1);
    expect(filterCampaigns(campaigns, '', 'ACTIVE')).toHaveLength(1);
    expect(filterCampaigns(campaigns, '', 'CANCELLED')).toHaveLength(1);
    expect(filterCampaigns(campaigns, 'missing', 'ALL')).toHaveLength(0);
  });
});

describe('campaign dispatch presentation', () => {
  it('prefers the explicit dispatch state and falls back conservatively', () => {
    expect(campaignDispatchState(campaigns[0])).toBe('RUNNING');
    expect(campaignDispatchState(campaigns[1])).toBe('PAUSED');
    expect(campaignDispatchState(campaigns[2])).toBe('CANCELLED');
    expect(
      campaignDispatchState({
        status: 'ACTIVE',
        dispatchState: undefined,
        emergencyStoppedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe('PAUSED');
  });

  it('labels stop reasons without implying a call was placed', () => {
    expect(dispatchStopReasonLabel('emergency_stop')).toBe('Platform emergency stop');
    expect(dispatchStopReasonLabel('customer_cancel')).toBe('Cancelled by organization member');
    expect(dispatchStopReasonLabel(null)).toBeNull();
  });

  it('offers emergency stop only while dispatch is still running', () => {
    expect(canEmergencyStop(campaigns[0], true)).toBe(true);
    expect(canEmergencyStop(campaigns[0], false)).toBe(false);
    expect(canEmergencyStop(campaigns[1], true)).toBe(false);
    expect(canEmergencyStop(campaigns[2], true)).toBe(false);
  });
});
