import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// The Web Speech API is not part of TypeScript's DOM lib, so declare the small part that is used.
interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechInputSupported(): boolean {
  return recognitionCtor() !== null;
}

export function speechOutputSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

interface PolicyLike {
  allowsFeature: (feature: string) => boolean;
}
type PolicyHost = { permissionsPolicy?: PolicyLike; featurePolicy?: PolicyLike };

/**
 * Whether the page that embeds this app lets it use the microphone. A frame only gets the microphone when its
 * host sets allow="microphone" on the iframe. Without it the browser refuses silently and never shows a prompt.
 */
export function microphonePolicy(host: PolicyHost | undefined = typeof document === 'undefined' ? undefined : (document as PolicyHost)): 'allowed' | 'blocked' | 'unknown' {
  const policy = host?.permissionsPolicy ?? host?.featurePolicy;
  if (!policy) return 'unknown';
  try {
    return policy.allowsFeature('microphone') ? 'allowed' : 'blocked';
  } catch {
    return 'unknown';
  }
}

/** True when the app runs inside another page, such as the Fabric portal. */
export function isEmbedded(win: { self: unknown; top: unknown } | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  if (!win) return false;
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}

/** True when the host page is known to stop this app from using the microphone, so the browser cannot ask. */
export function microphoneBlockedByFrame(): boolean {
  return isEmbedded() && microphonePolicy() !== 'allowed';
}

/** The address of this app on its own, for opening it outside the Fabric frame. */
export function standaloneUrl(): string {
  return typeof window === 'undefined' ? '' : window.location.href;
}

export const FRAME_BLOCKED_MESSAGE =
  'Fabric shows this app inside a frame that does not allow the microphone, so the browser cannot ask you for access. Open Fabric Weave in its own tab to dictate, or type your answer.';

/** Plain-language message for a Web Speech error code, or null when it needs no message. */
export function describeSpeechError(code: string, frameBlocked = false): string | null {
  switch (code) {
    case 'aborted':
      return null;
    case 'no-speech':
      return 'I did not hear anything. Try again, or type your answer.';
    case 'not-allowed':
    case 'service-not-allowed':
      return frameBlocked ? FRAME_BLOCKED_MESSAGE : 'The browser blocked the microphone. Allow microphone access for this site, or type your answer.';
    case 'audio-capture':
      return 'No microphone was found. Connect one, or type your answer.';
    case 'network':
      return 'The browser’s speech service could not be reached. Type your answer instead.';
    case 'language-not-supported':
      return 'Your browser does not support dictation in its current language. Type your answer instead.';
    default:
      return 'Dictation stopped unexpectedly. Try again, or type your answer.';
  }
}

export interface DictationOptions {
  /** Keep listening through pauses until stopped. Off means one utterance, which ends on silence. */
  continuous: boolean;
  /** Each finished phrase, as it arrives. */
  onText: (phrase: string) => void;
  /** The session ended (stopped, silence or error) with everything that was heard in it. */
  onEnd?: (heard: string) => void;
}

export interface Dictation {
  supported: boolean;
  /** The host page blocks the microphone for this frame. Dictation only works in the app's own tab. */
  frameBlocked: boolean;
  listening: boolean;
  /** The phrase being recognised right now, not final yet. */
  interim: string;
  error: string | null;
  start: () => void;
  stop: () => void;
}

/** Browser speech-to-text. Audio goes to the browser vendor’s speech service, never to this app. */
export function useDictation({ continuous, onText, onEnd }: DictationOptions): Dictation {
  const Ctor = useMemo(() => recognitionCtor(), []);
  const frameBlocked = useMemo(() => microphoneBlockedByFrame(), []);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognizer = useRef<RecognitionLike | null>(null);
  const handlers = useRef({ onText, onEnd });

  useEffect(() => {
    handlers.current = { onText, onEnd };
  });

  const start = useCallback(() => {
    if (!Ctor || recognizer.current) return;
    setInterim('');
    if (frameBlocked && microphonePolicy() === 'blocked') {
      setError(FRAME_BLOCKED_MESSAGE);
      return;
    }
    setError(null);
    const rec = new Ctor();
    rec.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
    rec.continuous = continuous;
    rec.interimResults = true;
    let heard = '';
    rec.onresult = (event) => {
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const phrase = result[0].transcript;
        if (result.isFinal) {
          heard = heard ? `${heard} ${phrase.trim()}` : phrase.trim();
          if (phrase.trim()) handlers.current.onText(phrase.trim());
        } else {
          pending += phrase;
        }
      }
      setInterim(pending.trim());
    };
    rec.onerror = (event) => setError(describeSpeechError(event.error, frameBlocked));
    rec.onend = () => {
      recognizer.current = null;
      setListening(false);
      setInterim('');
      handlers.current.onEnd?.(heard);
    };
    recognizer.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      recognizer.current = null;
      setError('Dictation could not start. Try again, or type your answer.');
    }
  }, [Ctor, continuous, frameBlocked]);

  const stop = useCallback(() => {
    recognizer.current?.stop();
  }, []);

  // Release the microphone when the component goes away.
  useEffect(
    () => () => {
      const rec = recognizer.current;
      if (rec) {
        rec.onend = null;
        rec.abort();
        recognizer.current = null;
      }
    },
    [],
  );

  return { supported: Ctor !== null, frameBlocked, listening, interim, error, start, stop };
}

/** Reads text aloud with the browser voice. Returns a function that cancels it. */
export function speak(text: string, onEnd: () => void): () => void {
  if (!speechOutputSupported()) {
    onEnd();
    return () => undefined;
  }
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
  let cancelled = false;
  const finish = () => {
    if (!cancelled) onEnd();
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  synth.speak(utterance);
  return () => {
    cancelled = true;
    synth.cancel();
  };
}
