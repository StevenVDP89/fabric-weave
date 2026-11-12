import { ArrowRight } from 'lucide-react';

import heroDark from '@/assets/weave-ribbons-dark.webp';
import heroLight from '@/assets/weave-ribbons.webp';
import { WeaveMark } from '@/components/WeaveMark';
import { Eyebrow } from '@/components/ui';

const primaryLink =
  'inline-flex h-10 items-center gap-200 rounded-md border border-primary bg-primary px-500 text-300 font-medium text-primary-foreground transition-colors hover:bg-primary/90';
const secondaryLink =
  'inline-flex h-10 items-center rounded-md border border-input bg-card/80 px-500 text-300 font-medium text-foreground backdrop-blur-sm transition-colors hover:bg-card';

/** Landing banner: the product name, a one-line promise and the two ways in, over the ribbon artwork. */
export function WeaveHero() {
  return (
    <section aria-labelledby="weave-title" className="relative isolate mb-700 overflow-hidden rounded-2xl border border-border bg-hero">
      <img
        src={heroLight}
        alt=""
        aria-hidden
        className="absolute inset-y-0 right-0 h-full w-full object-cover object-right md:w-4/5 dark:hidden"
      />
      <img
        src={heroDark}
        alt=""
        aria-hidden
        className="absolute inset-y-0 right-0 hidden h-full w-full object-cover object-right md:w-4/5 dark:block"
      />
      <div className="absolute inset-0 bg-linear-to-r from-hero from-35% via-hero/80 via-55% to-transparent" aria-hidden />

      <div className="relative max-w-xl px-600 py-800 md:px-800 md:py-800 lg:max-w-2xl">
        <div className="flex items-center gap-200">
          <WeaveMark className="h-6 w-6" />
          <Eyebrow tick>Fabric Weave</Eyebrow>
        </div>
        <h1 id="weave-title" className="mt-300 font-heading text-hero-800 leading-hero-800 font-semibold tracking-tight md:text-hero-900 md:leading-hero-900">
          Weave your semantic models into AI-ready artefacts for conversational analytics
        </h1>
        <p className="mt-300 max-w-lg text-400 leading-500 text-foreground/75">
          Score every Power BI semantic model in your estate, fix what holds Copilot back, and roll each change out with a rollback snapshot.
        </p>
        <div className="mt-600 flex flex-wrap gap-300">
          <a href="#/models" className={primaryLink}>
            Browse models
            <ArrowRight className="icon-size-200" aria-hidden />
          </a>
          <a href="#/workspaces" className={secondaryLink}>
            Choose workspaces
          </a>
        </div>
      </div>
    </section>
  );
}
