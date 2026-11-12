//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { useEffect } from 'react';
import { Activity, Database, LayoutDashboard, Moon, Settings2, Sun, type LucideIcon } from 'lucide-react';

import { WeaveMark } from '@/components/WeaveMark';
import { LoadingBlock } from '@/components/ui';
import { cx } from '@/lib/cx';
import { useTheme } from '@/hooks/theme.context';
import { AppProvider } from '@/lib/app-context';
import { useRoute, type Route } from '@/lib/route';
import { portfolioVisibility } from '@/lib/scan';
import { useApp } from '@/lib/use-app';
import { ModelPage } from '@/pages/ModelPage';
import { ModelsPage } from '@/pages/ModelsPage';
import { PortfolioPage } from '@/pages/PortfolioPage';
import { StatusPage } from '@/pages/StatusPage';
import { WorkspacesPage } from '@/pages/WorkspacesPage';

const NAV: { page: Route['page']; label: string; href: string; icon: LucideIcon }[] = [
  { page: 'portfolio', label: 'Portfolio', href: '#/portfolio', icon: LayoutDashboard },
  { page: 'models', label: 'Models', href: '#/models', icon: Database },
  { page: 'workspaces', label: 'Workspaces', href: '#/workspaces', icon: Settings2 },
  { page: 'status', label: 'Status', href: '#/status', icon: Activity },
];

function Shell() {
  const [route, go] = useRoute();
  const { isDark, toggleTheme } = useTheme();
  const { status, statusError } = useApp();
  // The Portfolio page needs the optional estate scan, which the status tells us. Until it is known the tab is not
  // rendered at all, so an app-only install never sees it flash in and out.
  const visibility = portfolioVisibility(status, statusError);
  const portfolioOn = visibility === 'on';
  const page: Route['page'] = route.page === 'portfolio' && visibility === 'off' ? 'models' : route.page;
  const section = page === 'model' ? 'models' : page;
  const nav = portfolioOn ? NAV : NAV.filter((item) => item.page !== 'portfolio');

  useEffect(() => {
    // replace, not assign, so the back button does not return to a page that only redirects again
    if (route.page === 'portfolio' && visibility === 'off') window.location.replace('#/models');
  }, [route.page, visibility]);

  return (
    <div className="min-h-screen bg-background text-foreground md:grid md:grid-cols-[14.5rem_minmax(0,1fr)]">
      <a
        href="#/"
        onClick={(e) => {
          // A plain #main link would change the hash, which is the router's state.
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
        className="sr-only rounded-md bg-card px-400 py-200 focus:not-sr-only focus:fixed focus:top-200 focus:left-200 focus:z-50"
      >
        Skip to content
      </a>

      <aside className="border-b border-border bg-card md:sticky md:top-0 md:h-screen md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-300 px-500 py-400 md:h-full md:flex-col md:items-stretch md:justify-start md:gap-600 md:py-600">
          <a href={portfolioOn ? '#/portfolio' : '#/models'} className="flex items-center gap-300" aria-label="Fabric Weave home">
            <WeaveMark className="h-9 w-9" />
            <span className="font-heading text-500 leading-500 font-semibold tracking-tight">
              Fabric Weave
              <span className="block font-numeric text-100 leading-100 font-normal tracking-[0.18em] text-muted-foreground uppercase">AI-readiness</span>
            </span>
          </a>

          <nav aria-label="Primary" className="flex gap-100 overflow-x-auto md:flex-col md:overflow-visible">
            {nav.map(({ page: target, label, href, icon: Icon }) => {
              const active = section === target;
              return (
                <a
                  key={target}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'relative flex items-center gap-300 rounded-md px-300 py-200 text-300 leading-300 font-medium whitespace-nowrap transition-colors',
                    active
                      ? 'bg-primary/10 text-primary before:absolute before:inset-y-200 before:left-0 before:w-[3px] before:rounded-full before:bg-signal'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  <Icon className="icon-size-300" aria-hidden />
                  {label}
                </a>
              );
            })}
          </nav>

          <div className="hidden md:mt-auto md:block md:space-y-300">
            <button
              type="button"
              onClick={toggleTheme}
              className="flex w-full items-center gap-300 rounded-md px-300 py-200 text-300 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {isDark ? <Sun className="icon-size-300" aria-hidden /> : <Moon className="icon-size-300" aria-hidden />}
              {isDark ? 'Light theme' : 'Dark theme'}
            </button>
          </div>
        </div>
      </aside>

      <main id="main" tabIndex={-1} className="min-w-0 px-500 py-600 outline-none md:px-800 md:py-700">
        <div className="mx-auto max-w-7xl">
          {page === 'portfolio' ? portfolioOn ? <PortfolioPage /> : <LoadingBlock label="Loading" /> : null}
          {page === 'models' ? <ModelsPage /> : null}
          {page === 'workspaces' ? <WorkspacesPage /> : null}
          {page === 'status' ? <StatusPage /> : null}
          {route.page === 'model' ? <ModelPage key={`${route.workspaceId}/${route.modelId}`} workspaceId={route.workspaceId} modelId={route.modelId} tab={route.tab} go={go} /> : null}
        </div>
      </main>
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

export default App;