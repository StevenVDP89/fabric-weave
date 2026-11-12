//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '@/App';
import { ThemeContext } from '@/hooks/theme.context';

const stubs = vi.hoisted(() => ({ status: undefined as unknown }));

// Every Rayfin call stays pending, so the pages render their loading states and nothing settles after the test.
// A test can make the service status resolve by setting stubs.status.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const pending = () => new Promise<never>(() => {});
  const api = Object.fromEntries(Object.keys(actual.api).map((name) => [name, pending]));
  return { ...actual, api: { ...api, getServiceStatus: () => (stubs.status ? Promise.resolve(stubs.status) : pending()) } };
});

function renderApp() {
  return render(
    <ThemeContext.Provider value={{ isDark: false, toggleTheme: vi.fn() }}>
      <App />
    </ThemeContext.Provider>
  );
}

describe('App shell', () => {
  beforeEach(() => {
    window.location.hash = '';
    stubs.status = undefined;
  });

  afterEach(() => {
    window.location.hash = '';
    stubs.status = undefined;
  });

  it('does not render the portfolio tab while the service status is still loading', () => {
    renderApp();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Portfolio' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Models' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Fabric Weave home' })).toHaveAttribute('href', '#/models');
    expect(window.location.hash).not.toBe('#/models');
  });

  it('keeps the portfolio when the estate scan is installed', async () => {
    stubs.status = { portfolio: { configured: true, available: true, generatedAt: null } };
    renderApp();
    await screen.findByRole('link', { name: 'Portfolio' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole('link', { name: 'Portfolio' })).toHaveAttribute('aria-current', 'page');
    expect(window.location.hash).not.toBe('#/models');
  });

  it('never renders the portfolio tab when the estate scan is not installed', async () => {
    stubs.status = { portfolio: { configured: false, available: false, generatedAt: null } };
    const seen: boolean[] = [];
    const observer = new MutationObserver(() => seen.push(screen.queryByRole('link', { name: 'Portfolio' }) !== null));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    renderApp();
    seen.push(screen.queryByRole('link', { name: 'Portfolio' }) !== null);
    await waitFor(() => expect(window.location.hash).toBe('#/models'));
    observer.disconnect();
    expect(seen).not.toContain(true);
    expect(screen.queryByRole('link', { name: 'Portfolio' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Models' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Inspect a semantic model' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Fabric Weave home' })).toHaveAttribute('href', '#/models');
  });

  it('leaves the other pages alone when the estate scan is not installed', async () => {
    stubs.status = { portfolio: { configured: false, available: false, generatedAt: null } };
    window.location.hash = '#/workspaces';
    renderApp();
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Portfolio' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveAttribute('aria-current', 'page');
    expect(window.location.hash).toBe('#/workspaces');
  });

  it('shows the models page for the models route', () => {
    window.location.hash = '#/models';
    renderApp();
    expect(screen.getByRole('heading', { name: 'Inspect a semantic model' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Models' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the models section selected while a single model is open', () => {
    window.location.hash = '#/model/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/fix';
    renderApp();
    expect(screen.getByRole('link', { name: 'Models' })).toHaveAttribute('aria-current', 'page');
  });
});