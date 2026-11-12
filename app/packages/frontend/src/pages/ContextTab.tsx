import { Bot, PenLine, RotateCcw, Save, SkipForward, Sparkles, Send, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { DictationButton, DictationError, OpenInOwnTab } from '@/components/DictationButton';
import { Badge, Button, Card, CardHeader, ErrorState, Field, LoadingBlock, Notice, TextArea, Toggle } from '@/components/ui';
import { api, useAction, useAsync, type Assessment, type InterviewStep, type InterviewTurn } from '@/lib/api';
import { appendContext, appendDictation, clipContext, composeContextText, CONTEXT_TEXT_MAX, INTERVIEW_AREAS } from '@/lib/context';
import { cx } from '@/lib/cx';
import { loadBusinessContext, saveBusinessContext } from '@/lib/data';
import { speak, speechInputSupported, speechOutputSupported, useDictation } from '@/lib/speech';

type Mode = 'write' | 'agent';
type Phase = 'idle' | 'asking' | 'review';

const ANSWER_MAX = 1500;

const MODES: { id: Mode; title: string; body: string; icon: typeof PenLine }[] = [
  { id: 'write', title: 'Write it yourself', body: 'Describe the model in your own words. Type it or dictate it.', icon: PenLine },
  { id: 'agent', title: 'Let the agent ask you', body: 'An agent reads the model, asks you questions and follows up. Answer by typing or speaking.', icon: Bot },
];

export function ContextTab({ assessment, llmConfigured, actor, onSaved }: { assessment: Assessment; llmConfigured: boolean; actor: string; onSaved: () => void }) {
  const { workspaceId, modelId } = assessment;
  const stored = useAsync(() => loadBusinessContext(modelId), [modelId]);

  const [mode, setMode] = useState<Mode>('write');
  const [text, setText] = useState('');
  const [baseline, setBaseline] = useState('');
  const [recordId, setRecordId] = useState<string | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [drafted, setDrafted] = useState(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [turns, setTurns] = useState<InterviewTurn[]>([]);
  const [step, setStep] = useState<InterviewStep | null>(null);
  const [interviewBase, setInterviewBase] = useState('');
  const [answer, setAnswer] = useState('');
  const answerRef = useRef('');
  const [previousText, setPreviousText] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const autoSend = useRef(false);
  const cancelSpeech = useRef<() => void>(() => undefined);
  const lastTurnRef = useRef<HTMLDivElement | null>(null);

  // Sync the editor with the stored record each time a load settles (done while rendering, not in an effect).
  const [syncedFrom, setSyncedFrom] = useState<typeof stored.data | 'none'>('none');
  if (!stored.loading && stored.data !== syncedFrom) {
    const next = stored.data?.text ?? '';
    setSyncedFrom(stored.data);
    setText(next);
    setBaseline(stored.data && !stored.data.legacy ? next.trim() : '');
    setRecordId(stored.data?.id ?? null);
    setLegacy(stored.data?.legacy ?? false);
    setDrafted(false);
    setPhase('idle');
    setTurns([]);
    setStep(null);
    setPreviousText(null);
  }

  const setAnswerBoth = (value: string) => {
    answerRef.current = value;
    setAnswer(value);
  };

  const draft = useAction(() => api.draftBusinessContext(workspaceId, modelId));
  const ask = useAction((asked: InterviewTurn[], existing: string, finish: boolean) => api.interviewBusinessContext(workspaceId, modelId, asked, existing, finish));
  const save = useAction(() => saveBusinessContext(workspaceId, modelId, recordId, text, actor));

  const writeDictation = useDictation({
    continuous: true,
    onText: (phrase) => {
      setSaved(false);
      setText((prev) => clipContext(appendDictation(prev, phrase)));
    },
  });

  const answerDictation = useDictation({
    continuous: false,
    onText: (phrase) => setAnswerBoth(appendDictation(answerRef.current, phrase).slice(0, ANSWER_MAX)),
    onEnd: (heard) => {
      if (!autoSend.current) return;
      autoSend.current = false;
      if (heard.trim()) void sendAnswer(answerRef.current);
    },
  });

  const voiceSupported = speechInputSupported() && speechOutputSupported() && !answerDictation.frameBlocked;
  const micNeedsOwnTab = answerDictation.frameBlocked && speechInputSupported();
  const question = phase === 'asking' ? (step?.question ?? null) : null;
  const startListening = answerDictation.start;

  // Voice conversation: read each new question aloud, then listen for the answer.
  useEffect(() => {
    if (!voiceOn || !question) return undefined;
    const stopSpeaking = speak(question, () => {
      autoSend.current = true;
      startListening();
    });
    cancelSpeech.current = stopSpeaking;
    return () => {
      stopSpeaking();
      autoSend.current = false;
    };
  }, [voiceOn, question, startListening]);

  useEffect(() => {
    lastTurnRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [turns.length, question]);

  const stopAudio = () => {
    autoSend.current = false;
    cancelSpeech.current();
    answerDictation.stop();
    writeDictation.stop();
  };

  const changeMode = (next: Mode) => {
    if (next === mode) return;
    stopAudio();
    setMode(next);
  };

  const edit = (value: string) => {
    setSaved(false);
    setText(clipContext(value));
  };

  const finishWith = (result: InterviewStep) => {
    stopAudio();
    setPreviousText(text);
    setText(clipContext(result.summary));
    setStep(result);
    setPhase('review');
    setSaved(false);
  };

  const begin = async () => {
    const existing = text.trim();
    const first = await ask.run([], existing, false);
    if (!first) return;
    setInterviewBase(existing);
    setTurns([]);
    setAnswerBoth('');
    setPreviousText(null);
    if (first.done) finishWith(first);
    else {
      setStep(first);
      setPhase('asking');
    }
  };

  async function sendAnswer(raw: string) {
    if (!step?.question || ask.busy) return;
    stopAudio();
    const nextTurns = [...turns, { question: step.question, answer: raw.trim() }];
    const result = await ask.run(nextTurns, interviewBase, false);
    if (!result) return;
    setTurns(nextTurns);
    setAnswerBoth('');
    if (result.done) finishWith(result);
    else setStep(result);
  }

  const finishNow = async () => {
    stopAudio();
    const pending = answerRef.current.trim();
    const nextTurns = pending && step?.question ? [...turns, { question: step.question, answer: pending }] : turns;
    const result = await ask.run(nextTurns, interviewBase, true);
    if (!result) return;
    setTurns(nextTurns);
    setAnswerBoth('');
    finishWith(result);
  };

  const restart = () => {
    stopAudio();
    ask.reset();
    setPhase('idle');
    setTurns([]);
    setStep(null);
    setAnswerBoth('');
  };

  const runDraft = async () => {
    const res = await draft.run();
    if (!res) return;
    const addition = composeContextText(res.context);
    if (!addition) return;
    setText((prev) => appendContext(prev, addition));
    setDrafted(true);
    setSaved(false);
  };

  const runSave = async () => {
    const id = await save.run();
    if (id === undefined) return;
    setRecordId(id);
    setBaseline(text.trim());
    setLegacy(false);
    setSaved(true);
    setDrafted(false);
    onSaved();
  };

  const dirty = text.trim() !== baseline.trim();
  const canSave = (dirty || legacy) && assessment.canWrite;
  const hasStoredOrText = text.trim().length > 0;

  if (stored.loading && !stored.data) return <Card><LoadingBlock label="Loading business context" rows={4} /></Card>;
  if (stored.error) return <Card><ErrorState message={stored.error} onRetry={stored.reload} title="Business context unavailable" /></Card>;

  const editor = (
    <div className="space-y-200">
      <Field
        label="Context for the AI"
        htmlFor="ctx-text"
        hint={`${text.length} / ${CONTEXT_TEXT_MAX}. What the model is for, who asks, what terms mean, which measures to prefer, the usual time frame and any data quirks.`}
      >
        <TextArea
          id="ctx-text"
          value={text}
          maxLength={CONTEXT_TEXT_MAX}
          rows={12}
          placeholder="Example: This model covers retail sales for the EMEA region. Net revenue is the main measure. “Orders” means completed orders only. The fiscal year starts in July. Questions come from regional sales managers, who usually ask about the last full quarter."
          onChange={(e) => edit(e.target.value)}
        />
      </Field>
      {mode === 'write' && writeDictation.interim ? <p className="text-200 italic text-muted-foreground" aria-live="polite">Hearing: {writeDictation.interim}</p> : null}
      {mode === 'write' ? <DictationError dictation={writeDictation} /> : null}
    </div>
  );

  return (
    <div className="grid gap-500 xl:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
      <Card className="min-w-0">
        <CardHeader
          title="Business context"
          subtitle="Tell Fabric Weave what this model is about. It uses your words when it drafts descriptions, example prompts and the AI instructions on the Fix tab."
        />
        <div className="space-y-400 px-500 py-400">
          {legacy ? (
            <Notice tone="info" title="Saved as separate fields before">
              Your earlier entries are shown here as one description. Save to keep it in this form. Nothing is lost.
            </Notice>
          ) : null}

          <div role="radiogroup" aria-label="How to provide the context" className="grid gap-300 sm:grid-cols-2">
            {MODES.map((m) => {
              const active = m.id === mode;
              const Icon = m.icon;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => changeMode(m.id)}
                  className={cx(
                    'flex items-start gap-300 rounded-lg border p-400 text-left transition-colors',
                    active ? 'border-primary bg-accent' : 'border-border bg-card hover:bg-accent'
                  )}
                >
                  <Icon className="icon-size-300 mt-100 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-300 font-semibold">{m.title}</span>
                    <span className="block text-200 leading-200 text-muted-foreground">{m.body}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {mode === 'write' ? (
            <div className="space-y-300">
              <div className="flex flex-wrap items-center justify-between gap-200">
                <DictationButton dictation={writeDictation} />
                <Button
                  size="sm"
                  icon={<Sparkles className="icon-size-200" aria-hidden />}
                  busy={draft.busy}
                  disabled={!llmConfigured}
                  title={llmConfigured ? 'Add a first draft from the model’s tables, columns and measures. Your own text stays.' : 'No AI model is configured. See the Status page.'}
                  onClick={runDraft}
                >
                  Start from an AI draft
                </Button>
              </div>
              {draft.error ? <Notice tone="danger" title="The draft failed">{draft.error}</Notice> : null}
              {drafted ? <Notice tone="caution" title="AI draft added. Read it and correct it before saving.">It was added after your own text.</Notice> : null}
              {editor}
            </div>
          ) : (
            <div className="space-y-400">
              {!llmConfigured ? (
                <Notice tone="warning" title="The agent needs an AI model">
                  No AI model is configured for Fabric Weave. See the Status page. You can still write the context yourself.
                </Notice>
              ) : null}

              {phase === 'idle' ? (
                <div className="space-y-300 rounded-lg border border-dashed border-border px-400 py-400">
                  <p className="text-300 leading-300">
                    The agent reads the table, column and measure names, then asks about what the names cannot tell. It asks one question at a time, up to {step?.maxQuestions ?? 8}, and follows up on your answers.
                  </p>
                  {hasStoredOrText ? <p className="text-200 leading-200 text-muted-foreground">It builds on the context you already have, and will not drop it.</p> : null}
                  <Button variant="primary" icon={<Bot className="icon-size-200" aria-hidden />} busy={ask.busy} disabled={!llmConfigured} onClick={begin}>
                    Start the interview
                  </Button>
                  {ask.busy ? (
                    <p className="text-200 leading-200 text-muted-foreground" role="status" aria-live="polite">
                      Reading the model and preparing the first question. This can take about 15 seconds.
                    </p>
                  ) : null}
                  {ask.error ? <Notice tone="danger" title="The agent could not start">{ask.error}</Notice> : null}
                </div>
              ) : null}

              {phase === 'asking' && step ? (
                <div className="space-y-300">
                  <div className="flex flex-wrap items-center justify-between gap-200">
                    <Badge tone="info">Question {Math.min(turns.length + 1, step.maxQuestions)} of up to {step.maxQuestions}</Badge>
                    <Toggle
                      checked={voiceOn}
                      onChange={(next) => {
                        if (!next) stopAudio();
                        setVoiceOn(next);
                      }}
                      disabled={!voiceSupported}
                      label="Voice conversation"
                      description={
                        voiceSupported
                          ? 'The agent reads each question aloud and listens for your answer.'
                          : micNeedsOwnTab
                            ? 'Needs Fabric Weave in its own tab, see below.'
                            : 'This browser has no speech support. Use Edge or Chrome, or type.'
                      }
                    />
                  </div>

                  {micNeedsOwnTab ? (
                    <Notice tone="info" title="Voice needs Fabric Weave in its own tab">
                      Fabric blocks the microphone for apps shown inside its portal, so the browser never asks you for access. Typing works here.{' '}
                      <OpenInOwnTab />
                    </Notice>
                  ) : null}

                  <ol className="space-y-300" aria-label="Interview so far">
                    {turns.map((t, i) => (
                      <li key={i} className="space-y-100 border-l-2 border-border pl-300">
                        <p className="text-300 leading-300 font-medium">{t.question}</p>
                        <p className="text-300 leading-300 text-muted-foreground">{t.answer || 'Skipped'}</p>
                      </li>
                    ))}
                  </ol>

                  <div ref={lastTurnRef} className="space-y-300 rounded-lg border border-primary bg-accent px-400 py-400" aria-live="polite">
                    <p className="flex items-start gap-200 text-300 leading-300 font-semibold">
                      <Bot className="icon-size-300 mt-100 shrink-0" aria-hidden />
                      <span>{step.question}</span>
                    </p>
                    <TextArea
                      aria-label="Your answer"
                      value={answer}
                      maxLength={ANSWER_MAX}
                      rows={3}
                      placeholder="Type your answer, or press Dictate. Ctrl+Enter sends."
                      disabled={ask.busy}
                      onChange={(e) => setAnswerBoth(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && answer.trim()) {
                          e.preventDefault();
                          void sendAnswer(answer);
                        }
                      }}
                    />
                    {answerDictation.interim ? <p className="text-200 italic text-muted-foreground" aria-live="polite">Hearing: {answerDictation.interim}</p> : null}
                    {answerDictation.listening && !answerDictation.interim ? <p className="text-200 text-muted-foreground" aria-live="polite">Listening…</p> : null}
                    <DictationError dictation={answerDictation} />
                    {ask.busy ? <p className="text-200 text-muted-foreground" role="status" aria-live="polite">Working on the next step…</p> : null}
                    <div className="flex flex-wrap items-center gap-200">
                      <Button variant="primary" size="sm" icon={<Send className="icon-size-200" aria-hidden />} busy={ask.busy} disabled={!answer.trim()} onClick={() => sendAnswer(answer)}>
                        Send answer
                      </Button>
                      <DictationButton dictation={answerDictation} disabled={ask.busy} />
                      <Button size="sm" variant="ghost" icon={<SkipForward className="icon-size-200" aria-hidden />} disabled={ask.busy} onClick={() => sendAnswer('')}>
                        Skip
                      </Button>
                      <Button size="sm" variant="secondary" disabled={ask.busy || (turns.length === 0 && !interviewBase && !answer.trim())} onClick={finishNow}>
                        Finish now
                      </Button>
                      <Button size="sm" variant="ghost" icon={<RotateCcw className="icon-size-200" aria-hidden />} disabled={ask.busy} onClick={restart}>
                        Cancel
                      </Button>
                    </div>
                    {ask.error ? <Notice tone="danger" title="That did not go through">{ask.error} Your answer is still here. Try again.</Notice> : null}
                  </div>
                </div>
              ) : null}

              {phase === 'review' ? (
                <div className="space-y-300">
                  <Notice tone="success" title="The interview is done. Read the context, change what is off, then save.">
                    The agent wrote it from your answers{interviewBase ? ' and the context you had before' : ''}. It is only stored when you save.
                  </Notice>
                  {editor}
                  <div className="flex flex-wrap items-center gap-200">
                    {previousText !== null && previousText !== text ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Undo2 className="icon-size-200" aria-hidden />}
                        onClick={() => {
                          edit(previousText);
                          setPreviousText(null);
                        }}
                      >
                        Restore previous text
                      </Button>
                    ) : null}
                    <Button size="sm" variant="secondary" icon={<Bot className="icon-size-200" aria-hidden />} onClick={restart}>
                      Interview again
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-300 border-t border-border px-500 py-300">
          <p className="text-200 text-muted-foreground" role="status">
            {save.error ? <span className="text-destructive">{save.error}</span> : !assessment.canWrite ? 'You need write access to this model in Fabric to save its context.' : saved ? (text.trim() ? 'Saved.' : 'Saved. The context was cleared.') : legacy ? 'Not saved in the new form yet.' : dirty ? 'Unsaved changes.' : 'Up to date.'}
          </p>
          <Button variant="primary" icon={<Save className="icon-size-200" aria-hidden />} busy={save.busy} disabled={!canSave || ask.busy} onClick={runSave}>
            Save context
          </Button>
        </footer>
      </Card>

      <div className="space-y-400 self-start">
        <Card>
          <CardHeader title="What helps most" />
          <ul className="list-inside list-disc space-y-100 px-500 py-400 text-300 leading-300 text-muted-foreground">
            {INTERVIEW_AREAS.map((area) => (
              <li key={area}>{area}</li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="How this is used" />
          <div className="space-y-300 px-500 py-400 text-300 leading-300 text-muted-foreground">
            <p>The context is stored in the app’s own database, never in your model.</p>
            <p>When you draft on the Fix tab, it is sent to the configured AI model, with the model’s names and measure formulas. In the agent interview, your answers go there too.</p>
            <p>Your data rows are never read or sent.</p>
            <p>Dictation and voice use your browser’s speech service, which is run by the browser vendor. Fabric Weave never receives the audio.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
