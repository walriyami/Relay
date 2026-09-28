// The frame shared by first-start setup and a new member's welcome: one calm column, a step at a
// time, with progress through the steps that ask something.
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Brand } from "../../app/Brand";

export type WalkthroughStep = { step: string; label: string };

export function Walkthrough({
  step,
  steps,
  label,
  children,
}: {
  /** The step shown. A new value enters with its own animation and takes focus. */
  step: string;
  /** The steps that ask something, shown as progress; others (a welcome, a finish) frame them. */
  steps: readonly WalkthroughStep[];
  /** Names the progress for assistive technology, e.g. "Setup steps". */
  label: string;
  children: ReactNode;
}) {
  const section = useRef<HTMLElement>(null);
  // Before anything else can run: focus recovery would otherwise hand focus from a control the
  // last step removed (its busy submit button) to the first button of this one.
  useLayoutEffect(() => {
    // Each new step is announced by moving focus to its heading, unless it starts typing somewhere.
    const node = section.current;
    if (node && !node.contains(document.activeElement))
      node.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [step]);
  const current = steps.findIndex((s) => s.step === step);
  return (
    <main className="setup" tabIndex={-1}>
      <div className="setup-glow" aria-hidden />
      <header className="setup-head">
        <Brand />
        {current >= 0 && <Progress steps={steps} current={current} label={label} />}
      </header>
      <div className="setup-body">
        {/* Keyed so every step enters with its own animation. */}
        <section key={step} ref={section} className={`setup-step setup-step-${step}`} aria-labelledby="setup-title">
          {children}
        </section>
      </div>
    </main>
  );
}

function Progress({ steps, current, label }: { steps: readonly WalkthroughStep[]; current: number; label: string }) {
  return (
    <div className="setup-progress">
      <p className="setup-progress-count" aria-hidden>
        Step {current + 1} of {steps.length}
      </p>
      <ol aria-label={label}>
        {steps.map((p, i) => (
          <li
            key={p.step}
            className={i < current ? "done" : i === current ? "current" : ""}
            aria-current={i === current ? "step" : undefined}
          >
            <span className="setup-progress-bar" aria-hidden />
            <span className="setup-progress-label">
              {p.label}
              {i < current && <span className="visually-hidden"> (done)</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A step's heading, which the walkthrough focuses when the step opens. */
export function StepTitle({ children }: { children: ReactNode }) {
  return (
    <h1 id="setup-title" tabIndex={-1}>
      {children}
    </h1>
  );
}

/** One line of what Relay does, or of what to try first. */
export function Point({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li>
      <span className="setup-point-icon" aria-hidden>
        {icon}
      </span>
      <span>
        <strong>{title}</strong>
        <span className="muted">{children}</span>
      </span>
    </li>
  );
}

/** One choice in a step's card: an icon, what is being chosen, the control, and what it means. */
export function Question({
  icon,
  title,
  hint,
  htmlFor,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint: ReactNode;
  /** The field the title labels, when the control is a field rather than a labelled group. */
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="setup-question">
      <span className="setup-question-icon" aria-hidden>
        {icon}
      </span>
      <div className="setup-question-body">
        {htmlFor ? (
          <label className="setup-question-title" htmlFor={htmlFor}>
            {title}
          </label>
        ) : (
          <span className="setup-question-title">{title}</span>
        )}
        {children}
        <span className="field-hint">{hint}</span>
      </div>
    </div>
  );
}
