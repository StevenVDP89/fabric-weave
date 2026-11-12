import { ExternalLink, Mic, Square } from 'lucide-react';

import { Button } from '@/components/ui';
import { standaloneUrl, type Dictation } from '@/lib/speech';

/** Starts and stops browser dictation. Disabled, with the reason, when the browser has no speech recognition. */
export function DictationButton({ dictation, disabled }: { dictation: Dictation; disabled?: boolean }) {
  const { supported, listening, start, stop } = dictation;
  return (
    <Button
      size="sm"
      variant={listening ? 'primary' : 'secondary'}
      icon={listening ? <Square className="icon-size-200" aria-hidden /> : <Mic className="icon-size-200" aria-hidden />}
      aria-pressed={listening}
      disabled={disabled || !supported}
      title={supported ? 'Dictate with your microphone' : 'This browser has no speech recognition. Type instead, or use Edge or Chrome.'}
      onClick={listening ? stop : start}
    >
      {listening ? 'Stop' : 'Dictate'}
    </Button>
  );
}

/** A link that opens the app outside the Fabric frame, where the browser is able to ask for the microphone. */
export function OpenInOwnTab() {
  return (
    <a
      href={standaloneUrl()}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-100 font-medium text-primary underline underline-offset-2"
    >
      Open Fabric Weave in its own tab
      <ExternalLink className="icon-size-200" aria-hidden />
    </a>
  );
}

/** The dictation error, with the way out when the cause is the Fabric frame. */
export function DictationError({ dictation }: { dictation: Dictation }) {
  if (!dictation.error) return null;
  return (
    <div className="space-y-100 text-200 text-destructive" role="alert">
      <p>{dictation.error}</p>
      {dictation.frameBlocked ? (
        <p className="text-foreground">
          <OpenInOwnTab />
        </p>
      ) : null}
    </div>
  );
}
